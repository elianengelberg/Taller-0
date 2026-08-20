// Verificación de email y recuperación de contraseña, contra el servidor real
// (Postgres + index.ts, sin mocks). El servidor corre con MAIL_LOG=1, así que
// "la bandeja de entrada" es su propia salida: los correos se leen del log
// igual que los leería una persona mirando la consola.
const { Client } = require("/home/user/Taller-0/server/node_modules/pg");
const { createHash, randomUUID } = require("crypto");
const fs = require("fs");

const API = "http://localhost:4001";
const LOG = "/tmp/unify-server.log";
const results = [];
const check = (n, ok, d = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`);
};
const rnd = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function raw(path, opts = {}) {
  const res = await fetch(`${API}${path}`, opts);
  let body = {};
  try {
    body = JSON.parse(await res.text());
  } catch {}
  return { status: res.status, body };
}

// El servidor frena por IP toda la superficie de auth (30/min). Este test hace
// decenas de pedidos desde una sola IP, así que topea ese freno -- que NO es lo
// que quiere medir. Cuando pasa, espera la ventana y reintenta. Los frenos que
// sí se están probando (por cuenta, por enlace) nunca se reintentan.
async function api(path, opts = {}) {
  let r = await raw(path, opts);
  if (r.status === 429 && /^Demasiados intentos\./.test(r.body?.error ?? "")) {
    await sleep(61_000);
    r = await raw(path, opts);
  }
  if (r.status === 429 && /demasiados correos/i.test(r.body?.error ?? "")) {
    throw new Error("El test agotó el límite de correos por IP: hay que pedir menos veces.");
  }
  return r;
}
const json = (b, extra = {}) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...extra },
  body: JSON.stringify(b),
});

// --- La bandeja de entrada ---------------------------------------------------

function logSize() {
  try {
    return fs.statSync(LOG).size;
  } catch {
    return 0;
  }
}

/** Los correos impresos después de `since` bytes del log. */
function mailsSince(since) {
  const from = Math.max(0, since);
  const fd = fs.openSync(LOG, "r");
  const size = fs.statSync(LOG).size;
  const buf = Buffer.alloc(Math.max(0, size - from));
  if (buf.length) fs.readSync(fd, buf, 0, buf.length, from);
  fs.closeSync(fd);
  const text = buf.toString("utf8");
  const out = [];
  const re = /\[mail\] Para: (.+)\n\[mail\] Asunto: (.+)\n([\s\S]*?)\[mail\] ─/g;
  let m;
  while ((m = re.exec(text))) {
    const body = m[3].replace(/^\[mail\] ?/gm, "");
    out.push({
      to: m[1].trim(),
      subject: m[2].trim(),
      body,
      links: body.match(/https?:\/\/\S+/g) ?? [],
    });
  }
  return out;
}

/**
 * Espera un correo para esa dirección. `path` filtra por el TIPO de enlace que
 * tiene que traer, y no es un detalle: una misma dirección puede recibir dos
 * correos casi juntos (por ejemplo, el reenvío automático de verificación que
 * dispara un login bloqueado, y enseguida el de recuperación). Sin el filtro,
 * el test podría agarrar el otro y culpar al producto de su propia carrera.
 */
async function waitForMail(since, to, { path = null, timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = mailsSince(since).filter(
      (mail) => mail.to === to && (!path || mail.links.some((l) => l.includes(path)))
    );
    if (found.length) return found[found.length - 1];
    await sleep(120);
  }
  return null;
}

const tokenFrom = (mail, path) => {
  const link = (mail?.links ?? []).find((l) => l.includes(path));
  return link ? decodeURIComponent(link.split("#token=")[1] ?? "") : null;
};

(async () => {
  const pg = new Client({ connectionString: "postgres://postgres@localhost:5433/unify" });
  await pg.connect();
  const GOOD = "melon42Trueno";

  // ═══════ 1. Registrarse manda el enlace ═══════
  console.log("\n── 1. Al registrarse llega el correo ──");
  const email1 = `verif${Date.now()}${rnd(4)}@test.com`;
  let mark = logSize();
  const reg1 = await api("/api/auth/register", json({ email: email1, password: GOOD, name: "Ana Luz" }));
  check("el registro sale bien", reg1.status === 200, `HTTP ${reg1.status}`);
  check("el servidor avisa que mandó el correo", reg1.body.verificationSent === true);
  const mail1 = await waitForMail(mark, email1, { path: "/verificar-email" });
  check("llega un correo a esa dirección", Boolean(mail1), mail1?.subject ?? "no llegó");
  const verifyToken1 = tokenFrom(mail1, "/verificar-email");
  check("el correo trae un enlace de verificación", Boolean(verifyToken1), verifyToken1?.slice(0, 12) ?? "");
  check(
    "el correo avisa qué hacer si no fuiste vos quien se registró",
    /no creaste ninguna cuenta/i.test(mail1?.body ?? "")
  );

  // El token en claro NO puede estar guardado: si alguien se lleva una copia de
  // la base, los enlaces en vuelo tienen que ser inservibles.
  {
    const hash = createHash("sha256").update(verifyToken1).digest("hex");
    const enClaro = await pg.query(`SELECT 1 FROM auth_tokens WHERE token_hash = $1`, [verifyToken1]);
    const porHash = await pg.query(`SELECT purpose FROM auth_tokens WHERE token_hash = $1`, [hash]);
    check(
      "en la base está el hash del enlace, nunca el enlace",
      enClaro.rowCount === 0 && porHash.rowCount === 1 && porHash.rows[0].purpose === "verify-email"
    );
  }

  // ═══════ 2. Sin confirmar no se vuelve a entrar ═══════
  console.log("\n── 2. Hasta confirmar, no se entra ──");
  {
    const me = await api("/api/auth/me", { headers: { Authorization: `Bearer ${reg1.body.token}` } });
    check("la cuenta recién creada figura SIN verificar", me.body?.user?.emailVerified === false);

    const login = await api("/api/auth/login", json({ email: email1, password: GOOD }));
    check("con la contraseña correcta pero sin confirmar, no deja entrar", login.status === 403, `HTTP ${login.status}`);
    check("y avisa que el problema es el email, no la contraseña", login.body.needsVerification === true);
    check("no entrega sesión", typeof login.body.token !== "string");

    // Contraseña equivocada: el mensaje NO puede delatar que la cuenta existe.
    const malaClave = await api("/api/auth/login", json({ email: email1, password: "otraCosa99Xy" }));
    check(
      "con la contraseña equivocada el mensaje no delata el estado de la cuenta",
      malaClave.status === 401 && !/confirm/i.test(malaClave.body.error ?? ""),
      `HTTP ${malaClave.status}`
    );
  }

  // ═══════ 3. El enlace confirma ═══════
  console.log("\n── 3. El enlace del correo ──");
  {
    const bad = await api("/api/auth/verify-email/confirm", json({ token: "inventado-por-mi" }));
    check("un enlace inventado se rechaza", bad.status === 400, `HTTP ${bad.status}`);

    const ok = await api("/api/auth/verify-email/confirm", json({ token: verifyToken1 }));
    check("el enlace real confirma el email", ok.status === 200 && ok.body.user?.emailVerified === true);
    check("y devuelve sesión, sin pedir la contraseña de nuevo", typeof ok.body.token === "string");

    const me = await api("/api/auth/me", { headers: { Authorization: `Bearer ${ok.body.token}` } });
    check("esa sesión sirve", me.status === 200 && me.body.user?.emailVerified === true, `HTTP ${me.status}`);

    const login = await api("/api/auth/login", json({ email: email1, password: GOOD }));
    check("ahora sí se puede iniciar sesión normalmente", login.status === 200, `HTTP ${login.status}`);

    // Segundo clic / botón atrás / el escáner de enlaces del trabajo.
    const otraVez = await api("/api/auth/verify-email/confirm", json({ token: verifyToken1 }));
    check(
      "volver a abrir el mismo enlace dice “ya está”, no un error",
      otraVez.status === 200 && otraVez.body.alreadyVerified === true,
      `HTTP ${otraVez.status}`
    );
    check("pero esa segunda vez ya no entrega sesión", typeof otraVez.body.token !== "string");

    // Una cuenta ya verificada no tiene por qué recibir más correos.
    const antes = logSize();
    await api("/api/auth/verify-email/request", json({ email: email1 }));
    await sleep(700);
    check("a una cuenta ya confirmada no se le manda otro enlace", mailsSince(antes).length === 0);
  }

  // ═══════ 4. Enlaces vencidos y cruzados ═══════
  console.log("\n── 4. Enlaces que no deberían servir ──");
  {
    const email = `vencido${Date.now()}${rnd(4)}@test.com`;
    mark = logSize();
    await api("/api/auth/register", json({ email, password: GOOD, name: "Vence Pronto" }));
    const mail = await waitForMail(mark, email, { path: "/verificar-email" });
    const token = tokenFrom(mail, "/verificar-email");
    // Se corre el vencimiento en la base, que es exactamente lo que pasa cuando
    // el enlace queda un día en el buzón.
    await pg.query(`UPDATE auth_tokens SET expires_at = now() - INTERVAL '1 minute' WHERE token_hash = $1`, [
      createHash("sha256").update(token).digest("hex"),
    ]);
    const res = await api("/api/auth/verify-email/confirm", json({ token }));
    check("un enlace vencido no confirma nada", res.status === 400, `HTTP ${res.status}`);
    const row = await pg.query(`SELECT email_verified FROM users WHERE email = $1`, [email]);
    check("y la cuenta sigue sin verificar", row.rows[0].email_verified === false);
  }

  // ═══════ 5. Recuperar la contraseña ═══════
  console.log("\n── 5. Olvidé mi contraseña ──");
  const email2 = `olvido${Date.now()}${rnd(4)}@test.com`;
  {
    mark = logSize();
    const reg = await api("/api/auth/register", json({ email: email2, password: GOOD, name: "Beto Sol" }));
    const bienvenida = await waitForMail(mark, email2, { path: "/verificar-email" });
    const tokenVerif = tokenFrom(bienvenida, "/verificar-email");
    await api("/api/auth/verify-email/confirm", json({ token: tokenVerif }));
    const sesionVieja = reg.body.token;

    // Preguntar por un email desconocido no puede distinguirse de preguntar por
    // uno real: si no, esto sería un buscador de quién usa Unify.
    const desconocido = `nadie${Date.now()}${rnd(6)}@test.com`;
    const antes = logSize();
    const rNo = await api("/api/auth/password-reset/request", json({ email: desconocido }));
    await sleep(700);
    const rSi = await api("/api/auth/password-reset/request", json({ email: email2 }));
    check(
      "pedir recuperación de un email inexistente responde igual que uno real",
      rNo.status === rSi.status && JSON.stringify(rNo.body) === JSON.stringify(rSi.body),
      `${rNo.status} ${JSON.stringify(rNo.body)}`
    );
    check(
      "pero al email inexistente no se le manda nada",
      mailsSince(antes).every((m) => m.to !== desconocido)
    );

    const mail = await waitForMail(antes, email2, { path: "/restablecer" });
    const tokenReset = tokenFrom(mail, "/restablecer");
    check("llega el enlace para elegir contraseña nueva", Boolean(tokenReset), mail?.subject ?? "no llegó");

    // Una contraseña débil se rechaza SIN gastar el enlace: si lo quemara,
    // equivocarse una vez te dejaría sin enlace y sin contraseña.
    const debil = await api("/api/auth/password-reset/confirm", json({ token: tokenReset, password: "12345678" }));
    check("una contraseña débil se rechaza", debil.status === 400, `HTTP ${debil.status}`);
    const conEmail = await api(
      "/api/auth/password-reset/confirm",
      json({ token: tokenReset, password: `${email2.split("@")[0]}X1` })
    );
    check("una contraseña que contiene el propio email se rechaza", conEmail.status === 400, `HTTP ${conEmail.status}`);

    const NUEVA = "cerezo88Viento";
    const ok = await api("/api/auth/password-reset/confirm", json({ token: tokenReset, password: NUEVA }));
    check(
      "después de esos rechazos el enlace SIGUE sirviendo",
      ok.status === 200,
      `HTTP ${ok.status} ${ok.body.error ?? ""}`
    );
    check("y devuelve sesión, así no hay que volver a entrar", typeof ok.body.token === "string");

    const vieja = await api("/api/auth/login", json({ email: email2, password: GOOD }));
    check("la contraseña vieja deja de funcionar", vieja.status === 401, `HTTP ${vieja.status}`);
    const nueva = await api("/api/auth/login", json({ email: email2, password: NUEVA }));
    check("la nueva funciona", nueva.status === 200, `HTTP ${nueva.status}`);

    const conSesionVieja = await api("/api/auth/me", { headers: { Authorization: `Bearer ${sesionVieja}` } });
    check(
      "recuperar la contraseña ECHA a cualquier sesión que estuviera abierta",
      conSesionVieja.status === 401,
      `HTTP ${conSesionVieja.status}`
    );

    const reuso = await api("/api/auth/password-reset/confirm", json({ token: tokenReset, password: "otroBosque31" }));
    check("el enlace de recuperación sirve UNA sola vez", reuso.status === 400, `HTTP ${reuso.status}`);
  }

  // ═══════ 6. Cuentas de Google ═══════
  console.log("\n── 6. La cuenta que entra con Google ──");
  {
    const email = `google${Date.now()}${rnd(4)}@test.com`;
    const id = randomUUID();
    await pg.query(
      `INSERT INTO users (id, email, password_hash, name, google_id, email_verified)
       VALUES ($1, $2, NULL, 'Caro Vega', $3, TRUE)`,
      [id, email, `google-${rnd(10)}`]
    );
    mark = logSize();
    const res = await api("/api/auth/password-reset/request", json({ email }));
    check("pedir recuperación responde igual que para cualquier otra cuenta", res.status === 200);
    const mail = await waitForMail(mark, email);
    check("llega un correo (callarse delataría qué cuentas usan Google)", Boolean(mail));
    check(
      "el correo explica que esa cuenta entra con Google",
      /entra con .?Continuar con Google|entra con Google/i.test(mail?.body ?? ""),
      mail?.subject ?? ""
    );
    check(
      "NO trae enlace para ponerle contraseña a una cuenta que hoy sólo abre Google",
      !(mail?.links ?? []).some((l) => l.includes("/restablecer"))
    );
    check(
      "y apunta a Google para la contraseña de Google",
      /accounts\.google\.com/.test(mail?.body ?? "")
    );
    const enBase = await pg.query(`SELECT count(*)::int n FROM auth_tokens WHERE user_id = $1`, [id]);
    check("no se emitió ningún enlace para esa cuenta", enBase.rows[0].n === 0);
  }

  // ═══════ 7. Recuperar destraba una cuenta bloqueada ═══════
  console.log("\n── 7. Fuerza bruta + recuperación ──");
  {
    const email = `trabada${Date.now()}${rnd(4)}@test.com`;
    mark = logSize();
    const reg = await api("/api/auth/register", json({ email, password: GOOD, name: "Delia Paz" }));
    const bienvenida = await waitForMail(mark, email, { path: "/verificar-email" });
    await api("/api/auth/verify-email/confirm", json({ token: tokenFrom(bienvenida, "/verificar-email") }));

    let trabada = false;
    for (let i = 0; i < 12; i++) {
      const r = await raw("/api/auth/login", json({ email, password: `mal${i}` }));
      if (r.status === 429 && /con este email/.test(r.body?.error ?? "")) {
        trabada = true;
        break;
      }
      if (r.status === 429) await sleep(61_000);
    }
    check("adivinar contraseñas traba la cuenta", trabada);

    mark = logSize();
    await api("/api/auth/password-reset/request", json({ email }));
    const mail = await waitForMail(mark, email, { path: "/restablecer" });
    const token = tokenFrom(mail, "/restablecer");
    const NUEVA = "roble77Marea";
    const ok = await api("/api/auth/password-reset/confirm", json({ token, password: NUEVA }));
    check("se puede recuperar aunque la cuenta esté trabada", ok.status === 200, `HTTP ${ok.status}`);
    const login = await api("/api/auth/login", json({ email, password: NUEVA }));
    check(
      "y entrar enseguida: la traba era contra quien adivinaba, no contra la dueña",
      login.status === 200,
      `HTTP ${login.status}`
    );
  }

  // ═══════ 8. Cambiar la contraseña quema los enlaces pendientes ═══════
  console.log("\n── 8. Enlaces que quedaron dando vueltas ──");
  {
    const email = `pendiente${Date.now()}${rnd(4)}@test.com`;
    mark = logSize();
    const reg = await api("/api/auth/register", json({ email, password: GOOD, name: "Eli Nova" }));
    const bienvenida = await waitForMail(mark, email, { path: "/verificar-email" });
    const sesion = await api("/api/auth/verify-email/confirm", json({ token: tokenFrom(bienvenida, "/verificar-email") }));

    mark = logSize();
    await api("/api/auth/password-reset/request", json({ email }));
    const mail = await waitForMail(mark, email, { path: "/restablecer" });
    const tokenReset = tokenFrom(mail, "/restablecer");

    // La dueña, en vez de usar el enlace, cambia la contraseña desde la app.
    const cambio = await api(
      "/api/auth/change-password",
      json({ currentPassword: GOOD, newPassword: "laguna55Trigo" }, { Authorization: `Bearer ${sesion.body.token}` })
    );
    check("cambia la contraseña desde la app", cambio.status === 200, `HTTP ${cambio.status}`);

    const usarViejo = await api("/api/auth/password-reset/confirm", json({ token: tokenReset, password: "intruso99Zafiro" }));
    check(
      "el enlace de recuperación que había pedido antes ya no sirve",
      usarViejo.status === 400,
      `HTTP ${usarViejo.status}`
    );
  }

  // ═══════ 9. Tope de correos por cuenta ═══════
  console.log("\n── 9. Nadie inunda un buzón ajeno ──");
  {
    const email = `tope${Date.now()}${rnd(4)}@test.com`;
    await api("/api/auth/register", json({ email, password: GOOD, name: "Fede Ríos" }));
    const { rows } = await pg.query(`SELECT id FROM users WHERE email = $1`, [email]);
    const userId = rows[0].id;
    // Se siembran los 5 de la hora en la base -- que es lo que el servidor
    // cuenta -- en vez de pedirlos por HTTP, para no gastar el freno por IP
    // (que es otro, y no es el que se está probando acá).
    for (let i = 0; i < 5; i++) {
      await pg.query(
        `INSERT INTO auth_tokens (id, user_id, purpose, token_hash, email, expires_at)
         VALUES ($1, $2, 'verify-email', $3, $4, now() + INTERVAL '1 day')`,
        [randomUUID(), userId, `sembrado-${rnd(20)}`, email]
      );
    }
    mark = logSize();
    const res = await api("/api/auth/verify-email/request", json({ email }));
    await sleep(900);
    check("el pedido responde lo mismo de siempre (no delata el tope)", res.status === 200);
    check(
      "pero pasado el tope por hora ya no sale otro correo",
      mailsSince(mark).filter((m) => m.to === email).length === 0
    );
  }

  // ═══════ 10. El secuestro previo, ahora con verificación ═══════
  console.log("\n── 10. Alguien se registró con TU email ──");
  {
    const victima = `duena${Date.now()}${rnd(4)}@test.com`;
    // El atacante se registra primero con el email ajeno.
    const atacante = await api("/api/auth/register", json({ email: victima, password: "atacante77Nube", name: "Atacante" }));
    const sesionAtacante = atacante.body.token;
    check("registrarse con el email de otro sigue siendo posible…", atacante.status === 200);
    const loginAtacante = await api("/api/auth/login", json({ email: victima, password: "atacante77Nube" }));
    check("…pero el atacante no puede volver a entrar sin el buzón", loginAtacante.status === 403, `HTTP ${loginAtacante.status}`);

    // La dueña real, que sí tiene el buzón, recupera la cuenta.
    mark = logSize();
    await api("/api/auth/password-reset/request", json({ email: victima }));
    const mail = await waitForMail(mark, victima, { path: "/restablecer" });
    const token = tokenFrom(mail, "/restablecer");
    const MIA = "salvia31Puerto";
    const ok = await api("/api/auth/password-reset/confirm", json({ token, password: MIA }));
    check("la dueña del buzón se queda con la cuenta", ok.status === 200, `HTTP ${ok.status}`);

    const conAtacante = await api("/api/auth/login", json({ email: victima, password: "atacante77Nube" }));
    check("la contraseña del atacante ya no entra", conAtacante.status === 401, `HTTP ${conAtacante.status}`);
    const sesionVieja = await api("/api/auth/me", { headers: { Authorization: `Bearer ${sesionAtacante}` } });
    check("y su sesión abierta muere", sesionVieja.status === 401, `HTTP ${sesionVieja.status}`);
    const row = await pg.query(`SELECT email_verified FROM users WHERE email = $1`, [victima]);
    check("la cuenta queda con el email verificado", row.rows[0].email_verified === true);
    const login = await api("/api/auth/login", json({ email: victima, password: MIA }));
    check("y la dueña entra normalmente", login.status === 200, `HTTP ${login.status}`);
  }

  // ═══════ 11. Verificar protege la contraseña frente al reclamo de Google ═══════
  console.log("\n── 11. Verificar y después entrar con Google ──");
  {
    const email = `ambos${Date.now()}${rnd(4)}@test.com`;
    mark = logSize();
    await api("/api/auth/register", json({ email, password: GOOD, name: "Gala Ruiz" }));
    const bienvenida = await waitForMail(mark, email, { path: "/verificar-email" });
    await api("/api/auth/verify-email/confirm", json({ token: tokenFrom(bienvenida, "/verificar-email") }));
    const { rows } = await pg.query(`SELECT id FROM users WHERE email = $1`, [email]);

    // Se llama a la función REAL que corre en el callback de Google.
    const { execFileSync } = require("child_process");
    const out = execFileSync(
      "npx",
      [
        "tsx",
        "/home/user/Taller-0/pruebas/claim_helper.ts",
        rows[0].id,
        `google-${rnd(8)}`,
      ],
      {
        cwd: "/home/user/Taller-0/server",
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: "postgres://postgres@localhost:5433/unify" },
      }
    );
    check("al entrar con Google no se borra nada", /"passwordCleared":false/.test(out), out.trim().slice(-30));
    const login = await api("/api/auth/login", json({ email, password: GOOD }));
    check(
      "haber verificado el email conserva tu contraseña de Unify",
      login.status === 200,
      `HTTP ${login.status}`
    );
  }

  await pg.end();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("ERROR:", e.message, e.stack?.slice(0, 400));
  process.exit(1);
});
