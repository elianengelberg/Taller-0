// El código de 6 dígitos del correo, atacado.
//
// Un código corto es cómodo y, mal hecho, es una puerta: seis dígitos son un
// millón de combinaciones y una máquina las prueba en minutos. Lo que lo hace
// seguro no es el código sino lo que lo rodea, y ESO es lo que se prueba acá:
// el contador de intentos que quema el token, que un código nuevo mate al
// anterior, que no se pueda reusar, y que el servidor no revele qué emails
// tienen cuenta.
//
// Requiere: servidor real en 4001 con MAIL_LOG=1 (los correos se imprimen en
// /tmp/unify-server.log, que acá hace de bandeja de entrada) y Postgres.
const fs = require("fs");
const { Client } = require("/home/user/Taller-0/server/node_modules/pg");

const API = "http://localhost:4001";
const LOG = "/tmp/unify-server.log";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Math.random().toString(36).slice(2, 10);

const json = (b) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(b),
});
async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, opts);
  let body = {};
  try { body = JSON.parse(await res.text()); } catch {}
  return { status: res.status, body, headers: res.headers };
}

// El código que salió por correo: se lee del log, que es la bandeja de
// entrada en desarrollo. Buscar el ÚLTIMO es lo correcto -- un reenvío deja
// dos códigos en el log y el que vale es el nuevo.
function codigoDelCorreo(email) {
  const log = fs.readFileSync(LOG, "utf8");
  const bloques = log.split("[mail] ─────────────────────────────────────────");
  const mios = bloques.filter((b) => b.includes(email) && /código de verificación/i.test(b));
  const ultimo = mios[mios.length - 1] ?? "";
  return ultimo.match(/Tu código de verificación:\s*(\d{6})/)?.[1] ?? null;
}

async function registrar() {
  const email = `codigo-${rnd()}@prueba.local`;
  const r = await api("/api/auth/register", json({
    email, password: "ContraseñaLarga123!", name: "Ana Prueba",
  }));
  if (r.status !== 200 && r.status !== 201) throw new Error(`registro falló: ${r.status} ${JSON.stringify(r.body)}`);
  await sleep(700); // el correo sale en segundo plano
  return email;
}

(async () => {
  const pg = new Client({ connectionString: "postgres://postgres@localhost:5433/unify" });
  await pg.connect();

  // ═══════ 1. El camino feliz ═══════
  console.log("\n── 1. El código que llega por correo funciona ──");
  const email1 = await registrar();
  const code1 = codigoDelCorreo(email1);
  check("el correo trae un código de 6 dígitos", /^\d{6}$/.test(code1 ?? ""), String(code1));
  {
    const { rows } = await pg.query(
      `SELECT code_hash, token_hash FROM auth_tokens WHERE lower(email) = lower($1)`, [email1]
    );
    check("la base guarda el código HASHEADO, nunca en claro",
      rows.length === 1 && rows[0].code_hash && !rows[0].code_hash.includes(code1 ?? "xxxxxx"),
      `hash=${String(rows[0]?.code_hash).slice(0, 16)}…`);
    check("y es un hash distinto del token del enlace",
      rows[0]?.code_hash !== rows[0]?.token_hash);
  }
  {
    const r = await api("/api/auth/verify-email/code", json({ email: email1, code: code1 }));
    check("con el código correcto, la cuenta queda verificada", r.status === 200, `HTTP ${r.status}`);
    check("y devuelve sesión iniciada (no te hace escribir la clave otra vez)",
      typeof r.body.token === "string" && r.body.user?.emailVerified === true);
    const { rows } = await pg.query(`SELECT email_verified FROM users WHERE lower(email) = lower($1)`, [email1]);
    check("la base lo confirma", rows[0]?.email_verified === true);
  }
  {
    const r = await api("/api/auth/verify-email/code", json({ email: email1, code: code1 }));
    check("el MISMO código no sirve dos veces", r.status === 400, `HTTP ${r.status}`);
  }

  // ═══════ 2. Fuerza bruta ═══════
  console.log("\n── 2. Fuerza bruta: 6 dígitos, 5 intentos ──");
  const email2 = await registrar();
  const code2 = codigoDelCorreo(email2);
  {
    // Cinco intentos equivocados a propósito (evitando pegarle al verdadero).
    const malos = ["000001", "000002", "000003", "000004", "000005"].map((c) => (c === code2 ? "999999" : c));
    const mensajes = [];
    for (const malo of malos) {
      const r = await api("/api/auth/verify-email/code", json({ email: email2, code: malo }));
      mensajes.push(r.body.error ?? "");
    }
    check("cada intento fallido avisa cuántos quedan (sin mentir)",
      /quedan 4 intentos/.test(mensajes[0]) && /queda 1 intento/.test(mensajes[3]),
      mensajes[0]?.slice(0, 60));
    check("al quinto fallo el código se agota", /demasiadas veces/i.test(mensajes[4]), mensajes[4]?.slice(0, 60));

    // Y ahora lo importante: el código VERDADERO ya no sirve. Sin esto, un
    // atacante probaría de a 5 sin consecuencias hasta acertar.
    const r = await api("/api/auth/verify-email/code", json({ email: email2, code: code2 }));
    check("y el código correcto TAMBIÉN muere (el token se quemó)",
      r.status === 400, `HTTP ${r.status} ${r.body.error ?? ""}`.slice(0, 70));
    const { rows } = await pg.query(
      `SELECT used_at, attempts FROM auth_tokens WHERE lower(email) = lower($1)`, [email2]
    );
    check("la base lo deja marcado como usado, con los intentos contados",
      rows[0]?.used_at !== null && rows[0]?.attempts >= 5, `intentos=${rows[0]?.attempts}`);
  }

  // ═══════ 3. Un código nuevo mata al anterior ═══════
  console.log("\n── 3. Reenviar invalida el código viejo ──");
  const email3 = await registrar();
  const viejo = codigoDelCorreo(email3);
  {
    const r = await api("/api/auth/verify-email/request", json({ email: email3 }));
    check("se puede pedir un código nuevo", r.status === 200, `HTTP ${r.status}`);
    await sleep(900);
    const nuevo = codigoDelCorreo(email3);
    check("y llega uno DISTINTO", /^\d{6}$/.test(nuevo ?? "") && nuevo !== viejo, `${viejo} -> ${nuevo}`);

    const conViejo = await api("/api/auth/verify-email/code", json({ email: email3, code: viejo }));
    check("el código viejo ya no sirve (si no, cada reenvío sumaría chances)",
      conViejo.status === 400, `HTTP ${conViejo.status}`);
    const conNuevo = await api("/api/auth/verify-email/code", json({ email: email3, code: nuevo }));
    check("el nuevo sí", conNuevo.status === 200, `HTTP ${conNuevo.status}`);
  }

  // ═══════ 4. No delatar quién tiene cuenta ═══════
  console.log("\n── 4. El servidor no cuenta quién tiene cuenta ──");
  {
    const inexistente = await api("/api/auth/verify-email/code",
      json({ email: `nadie-${rnd()}@prueba.local`, code: "123456" }));
    const email4 = await registrar();
    const existente = await api("/api/auth/verify-email/code", json({ email: email4, code: "000000" }));
    check("un email sin cuenta y uno con cuenta fallan igual (mismo status)",
      inexistente.status === existente.status, `${inexistente.status} vs ${existente.status}`);
    // El mensaje puede variar (intentos restantes), pero NUNCA debe hablar de
    // la cuenta: eso es lo que convertiría el endpoint en un detector.
    const hablaDeCuenta = /no existe|no encontramos|sin cuenta|no registrad/i;
    check("y ningún mensaje revela si la cuenta existe",
      !hablaDeCuenta.test(inexistente.body.error ?? "") && !hablaDeCuenta.test(existente.body.error ?? ""),
      `${inexistente.body.error ?? ""} | ${existente.body.error ?? ""}`.slice(0, 80));
  }

  // ═══════ 5. Entradas basura ═══════
  console.log("\n── 5. Entradas basura ──");
  for (const [nombre, cuerpo] of [
    ["sin nada", {}],
    ["código de 5 dígitos", { email: email1, code: "12345" }],
    ["código con letras", { email: email1, code: "12a456" }],
    ["email inválido", { email: "no-es-un-email", code: "123456" }],
    ["código gigante (desborde)", { email: email1, code: "9".repeat(5000) }],
    ["tipos equivocados", { email: { $ne: null }, code: ["123456"] }],
  ]) {
    const r = await api("/api/auth/verify-email/code", json(cuerpo));
    check(`${nombre} -> 400, sin romper el servidor`, r.status === 400, `HTTP ${r.status}`);
  }
  {
    const vivo = await api("/api/auth/config");
    check("y el servidor sigue en pie después de todo eso", vivo.status === 200, `HTTP ${vivo.status}`);
  }

  // ═══════ 6. Las respuestas de sesión no se guardan en caché ═══════
  console.log("\n── 6. Cabeceras de seguridad ──");
  {
    const r = await api("/api/auth/config");
    check("las respuestas de /api/auth dicen no-store (no quedan en un proxy)",
      /no-store/.test(r.headers.get("cache-control") ?? ""), r.headers.get("cache-control") ?? "(nada)");
    check("sin sniffing de tipos", r.headers.get("x-content-type-options") === "nosniff");
    check("sin enmarcado", r.headers.get("x-frame-options") === "DENY");
    check("con CSP que no deja ejecutar nada", /default-src 'none'/.test(r.headers.get("content-security-policy") ?? ""));
    check("y sin delatar la tecnología del servidor", !r.headers.get("x-powered-by"));
  }

  await pg.end();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 400)); process.exit(1); });
