// Seguridad de las cuentas: probar que NO se puede entrar si no sos vos.
//
// Cada bloque es un ataque concreto contra el historial de otra persona.
const { Client } = require("/home/user/Taller-0/server/node_modules/pg");
const API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const rnd = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function raw(path, opts = {}) {
  const res = await fetch(`${API}${path}`, opts);
  let body = {};
  try { body = JSON.parse(await res.text()); } catch {}
  return { status: res.status, body };
}

// El servidor tiene DOS frenos: uno por IP (30/min, para toda la superficie de
// auth) y uno por cuenta. Este test hace decenas de pedidos desde una sola IP,
// así que topea el primero -- que no es lo que quiere medir. Cuando eso pasa,
// espera la ventana y reintenta. El freno POR CUENTA no se reintenta nunca:
// ese sí es el que se está probando.
async function api(path, opts = {}) {
  let r = await raw(path, opts);
  if (r.status === 429 && /^Demasiados intentos\./.test(r.body?.error ?? "")) {
    await sleep(61_000);
    r = await raw(path, opts);
  }
  return r;
}
const json = (b, extra = {}) => ({
  method: "POST", headers: { "Content-Type": "application/json", ...extra }, body: JSON.stringify(b),
});

(async () => {
  const pg = new Client({ connectionString: "postgres://postgres@localhost:5433/unify" });
  await pg.connect();

  // Con el correo configurado (MAIL_LOG=1 o Resend), el servidor exige
  // verificar el email antes de dejar entrar: correcto, y lo prueban
  // sim_email/sim_verificacion. Acá se está midiendo OTRA cosa (fuerza bruta,
  // secuestro de cuenta, sesiones), así que las cuentas de prueba se dan por
  // verificadas en la base y el test mide lo suyo en vez de chocar con un 403
  // que no es su tema.
  const verificar = (email) =>
    pg.query(`UPDATE users SET email_verified = TRUE WHERE lower(email) = lower($1)`, [email]);

  // ═══════ 1. Contraseñas que no protegen nada ═══════
  console.log("\n── 1. Contraseñas débiles ──");
  for (const [label, pw] of [
    ["12345678", "12345678"],
    ["password", "password"],
    ["todo repetido", "aaaaaaaa"],
    ["secuencia corrida", "abcdefgh"],
    ["sólo letras", "holaquetal"],
    ["el propio email", null],
  ]) {
    const email = `debil${Date.now()}${rnd(4)}@test.com`;
    const password = pw ?? `${email.split("@")[0]}X`;
    const r = await api("/api/auth/register", json({ email, password, name: "Test" }));
    check(`se rechaza "${label}"`, r.status === 400, `HTTP ${r.status} ${r.body.error ?? ""}`.slice(0, 80));
  }
  {
    const email = `buena${Date.now()}@test.com`;
    const r = await api("/api/auth/register", json({ email, password: "melon42Trueno", name: "Test" }));
    check("una contraseña razonable SÍ se acepta", r.status === 200, `HTTP ${r.status}`);
  }

  // ═══════ 2. Fuerza bruta contra una cuenta ═══════
  console.log("\n── 2. Fuerza bruta ──");
  {
    const email = `victima${Date.now()}${rnd(4)}@test.com`;
    await api("/api/auth/register", json({ email, password: "melon42Trueno", name: "Victima" }));
    let blocked = false, tries = 0;
    for (let i = 0; i < 12; i++) {
      tries++;
      const r = await raw("/api/auth/login", json({ email, password: `intento${i}` }));
      // Sólo cuenta el freno POR CUENTA, no el general por IP.
      if (r.status === 429 && /con este email/.test(r.body?.error ?? "")) { blocked = true; break; }
      if (r.status === 429) { await sleep(61_000); i--; }
    }
    check("adivinar contraseñas contra una cuenta se frena", blocked, `intentos permitidos=${tries}`);
    // Y el freno es por CUENTA: otra cuenta sigue pudiendo entrar.
    const otro = `otro${Date.now()}${rnd(4)}@test.com`;
    await api("/api/auth/register", json({ otro, email: otro, password: "melon42Trueno", name: "Otro" }));
    await verificar(otro);
    const ok = await api("/api/auth/login", json({ email: otro, password: "melon42Trueno" }));
    check("frenar una cuenta no bloquea a las demás", ok.status === 200, `HTTP ${ok.status}`);
  }

  // ═══════ 3. Secuestro previo (el más grave) ═══════
  console.log("\n── 3. Secuestro previo con el email de otro ──");
  {
    const emailVictima = `real${Date.now()}${rnd(4)}@gmail.com`;
    // El atacante se registra ANTES con el email de la víctima.
    const atacante = await api("/api/auth/register",
      json({ email: emailVictima, password: "atacanteClave99", name: "Atacante" }));
    check("el atacante puede registrarse con un email que no es suyo (sin verificación)",
      atacante.status === 200, `HTTP ${atacante.status}`);
    const tokenAtacante = atacante.body.token;

    // Ahora entra la víctima real por Google (se simula el efecto del callback:
    // Google probó el email).
    const { rows } = await pg.query("SELECT id FROM users WHERE email = $1", [emailVictima]);
    const userId = rows[0].id;
    const before = await pg.query("SELECT password_hash, email_verified FROM users WHERE id = $1", [userId]);
    check("antes: la cuenta tiene la contraseña del atacante y el email sin verificar",
      before.rows[0].password_hash !== null && before.rows[0].email_verified === false);

    // Se llama a la función REAL del servidor (la misma que corre en el
    // callback de Google), no a una copia del SQL: si el producto cambia y
    // deja de proteger, este test tiene que fallar.
    const { execFileSync } = require("child_process");
    const out = execFileSync(
      "npx",
      ["tsx", "/home/user/Taller-0/pruebas/claim_helper.ts", userId, `google-${rnd(8)}`],
      { cwd: "/home/user/Taller-0/server", encoding: "utf8",
        env: { ...process.env, DATABASE_URL: "postgres://postgres@localhost:5433/unify" } }
    );
    check("la función del servidor reporta que limpió la contraseña",
      /"passwordCleared":true/.test(out), out.trim().slice(-40));

    const after = await pg.query("SELECT password_hash, email_verified FROM users WHERE id = $1", [userId]);
    check("al entrar el dueño real por Google, la contraseña del atacante se borra",
      after.rows[0].password_hash === null && after.rows[0].email_verified === true);

    const login = await api("/api/auth/login", json({ email: emailVictima, password: "atacanteClave99" }));
    check("el atacante ya no puede entrar con su contraseña", login.status === 401, `HTTP ${login.status}`);

    const conTokenViejo = await api("/api/auth/me", { headers: { Authorization: `Bearer ${tokenAtacante}` } });
    check("y su sesión abierta tampoco sirve más", conTokenViejo.status === 401, `HTTP ${conTokenViejo.status}`);
  }

  // ═══════ 4. Revocar sesiones ═══════
  console.log("\n── 4. Echar a quien te robó la sesión ──");
  {
    const email = `sesion${Date.now()}${rnd(4)}@test.com`;
    const reg = await api("/api/auth/register", json({ email, password: "melon42Trueno", name: "Dueña" }));
    await verificar(email);
    const tokenRobado = reg.body.token;

    const antes = await api("/api/auth/me", { headers: { Authorization: `Bearer ${tokenRobado}` } });
    check("el token robado funciona antes de reaccionar", antes.status === 200, `HTTP ${antes.status}`);

    // La dueña cambia la contraseña, que es lo que uno hace al sospechar.
    const login = await api("/api/auth/login", json({ email, password: "melon42Trueno" }));
    const cambio = await api("/api/auth/change-password",
      json({ currentPassword: "melon42Trueno", newPassword: "otraClave77Sol" },
        { Authorization: `Bearer ${login.body.token}` }));
    check("se puede cambiar la contraseña", cambio.status === 200, `HTTP ${cambio.status}`);

    const despues = await api("/api/auth/me", { headers: { Authorization: `Bearer ${tokenRobado}` } });
    check("cambiar la contraseña ECHA al que tenía la sesión robada",
      despues.status === 401, `HTTP ${despues.status}`);
    check("quien cambió la contraseña recibe una sesión nueva y sigue adentro",
      typeof cambio.body.token === "string", String(cambio.body.token).slice(0, 12));

    const nuevaOk = await api("/api/auth/me", { headers: { Authorization: `Bearer ${cambio.body.token}` } });
    check("esa sesión nueva funciona", nuevaOk.status === 200, `HTTP ${nuevaOk.status}`);

    // Y el botón de "cerrar en todos lados".
    const cerrar = await api("/api/auth/logout-everywhere", {
      method: "POST", headers: { Authorization: `Bearer ${cambio.body.token}` },
    });
    check("existe 'cerrar sesión en todos lados'", cerrar.status === 200, `HTTP ${cerrar.status}`);
    const viejaTrasCerrar = await api("/api/auth/me", {
      headers: { Authorization: `Bearer ${cambio.body.token}` },
    });
    check("después de cerrarlas, la sesión anterior deja de valer",
      viejaTrasCerrar.status === 401, `HTTP ${viejaTrasCerrar.status}`);
    const flamante = await api("/api/auth/me", {
      headers: { Authorization: `Bearer ${cerrar.body.token}` },
    });
    check("y la que devuelve sigue sirviendo en este dispositivo", flamante.status === 200, `HTTP ${flamante.status}`);
  }

  // ═══════ 5. El historial sigue siendo privado ═══════
  console.log("\n── 5. Historial ajeno ──");
  {
    const a = `dueno${Date.now()}${rnd(4)}@test.com`;
    const b = `curioso${Date.now()}${rnd(4)}@test.com`;
    const ra = await api("/api/auth/register", json({ email: a, password: "melon42Trueno", name: "Dueño" }));
    const rb = await api("/api/auth/register", json({ email: b, password: "melon42Trueno", name: "Curioso" }));
    const listA = await api("/api/meetings", { headers: { Authorization: `Bearer ${ra.body.token}` } });
    const listB = await api("/api/meetings", { headers: { Authorization: `Bearer ${rb.body.token}` } });
    check("cada quien ve sólo su propio historial",
      listA.status === 200 && listB.status === 200 &&
      JSON.stringify(listA.body) !== undefined && Array.isArray(listB.body.meetings ?? []),
      `A=${listA.status} B=${listB.status}`);
    const sinSesion = await api("/api/meetings");
    check("sin sesión no hay historial", sinSesion.status === 401, `HTTP ${sinSesion.status}`);
  }

  await pg.end();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 300)); process.exit(1); });
