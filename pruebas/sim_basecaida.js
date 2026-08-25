// Qué pasa cuando la base de datos se cae y vuelve.
//
// Es la prueba que faltaba, y la que cubre los tres errores más caros del
// servidor -- los tres invisibles hasta que pasan en producción:
//
//  1. Una conexión OCIOSA que se corta (mantenimiento de Render, un reinicio,
//     un parpadeo de red) emite "error" en el pool. Sin un oyente, eso llega
//     al proceso como excepción no capturada y el servidor SE MUERE con todas
//     las reuniones en vivo adentro.
//  2. Con la base caída, una consulta sin timeout espera para siempre: el
//     pedido queda colgado y el navegador gira sin decir nada.
//  3. Si la migración falla al arrancar, el resultado quedaba cacheado: el
//     servidor seguía en pie pero hablándole a una base sin tablas PARA
//     SIEMPRE, guardando nada y sin avisar.
//
// Cómo se prueba: se apaga Postgres de verdad (pg_ctl stop), se golpea el
// servidor, se lo vuelve a levantar y se exige que el servidor siga siendo el
// mismo proceso (no un reinicio) y que vuelva a guardar.
const { execSync } = require("child_process"); // sólo para prender y apagar Postgres

const API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Math.random().toString(36).slice(2, 10);

const json = (b) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
async function api(path, opts = {}, timeoutMs = 20_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}${path}`, { ...opts, signal: ctl.signal });
    let body = {};
    try { body = JSON.parse(await res.text()); } catch {}
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: {}, abortado: e.name === "AbortError" };
  } finally {
    clearTimeout(t);
  }
}

const pg = (accion) =>
  execSync(
    `su postgres -s /bin/bash -c '/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgdata -o "-p 5433 -k /tmp" -l /tmp/pglog.txt ${accion}'`,
    { stdio: "pipe" }
  ).toString();

/**
 * Cuándo arrancó el proceso que está sirviendo. Si cambia, se reinició (o
 * sea: se murió). Se le pregunta AL SERVIDOR en vez de buscar su PID con
 * pgrep, que es lo que hacía antes y estaba mal: el patrón "tsx src/index.ts"
 * matcheaba cinco procesos -- npm exec, sh, node y hasta los shells de este
 * mismo banco de pruebas -- así que el "PID del servidor" cambiaba solo y la
 * prueba acusaba una caída que nunca ocurrió.
 */
async function arranqueServidor() {
  const r = await api("/api/health", {}, 5000);
  return r.body?.startedAt ?? "";
}

(async () => {
  // ═══════ 0b. La URL con sslmode ya no dispara la falsa alarma ═══════
  console.log("── 0b. sslmode fuera de la URL (la opción ssl explícita es la que manda) ──");
  {
    // pg 8.16 imprime un "SECURITY WARNING" en cada arranque si la URL trae
    // sslmode -- un parámetro que acá no gobierna nada (la opción ssl
    // explícita gana). Se prueba la cirugía REAL de db.ts, exportada.
    const { execFileSync } = require("child_process");
    const out = execFileSync("npx", ["tsx", "-e", `
      import { sinSslmode } from "/home/user/Taller-0/server/src/db";
      const casos = [
        "postgres://u:p@host/db?sslmode=require",
        "postgres://u:p@host/db?sslmode=require&application_name=unify",
        "postgres://u:cl%40ve%23rara@host:5432/db?a=1&ssl=true&b=2",
        "postgres://u:p@host/db",
      ];
      console.log("R:" + JSON.stringify(casos.map(sinSslmode)));
    `], { cwd: "/home/user/Taller-0/server", encoding: "utf8" });
    const r = JSON.parse(out.split("R:")[1].trim().split("\n")[0]);
    check("sslmode solo: query entero fuera", r[0] === "postgres://u:p@host/db");
    check("sslmode acompañado: los demás parámetros quedan",
      r[1] === "postgres://u:p@host/db?application_name=unify", r[1]);
    check("ssl=true también sale y la clave rara NO se toca",
      r[2] === "postgres://u:cl%40ve%23rara@host:5432/db?a=1&b=2", r[2]);
    check("sin query, la URL queda idéntica", r[3] === "postgres://u:p@host/db");
  }

  const arranqueAntes = await arranqueServidor();
  check("el servidor está corriendo antes de empezar", Boolean(arranqueAntes), arranqueAntes);

  // Una cuenta que ya existe, para poder comprobar después que la base volvió
  // a guardar de verdad (no que "responde 200" y pierde los datos).
  const email = `caida-${rnd()}@prueba.local`;
  {
    const r = await api("/api/auth/register", json({ email, password: "ContraseñaLarga123!", name: "Ana" }));
    check("con la base viva, registrarse funciona", r.status === 200 || r.status === 201, `HTTP ${r.status}`);
  }

  // ═══════ 1. Se cae la base ═══════
  console.log("\n── 1. Se cae la base de datos ──");
  pg("stop");
  await sleep(2500);

  {
    // Las conexiones ociosas del pool se cortaron recién: acá es donde el
    // servidor moría por el evento "error" sin oyente.
    const t0 = Date.now();
    const r = await api("/api/auth/register", json({ email: `x-${rnd()}@prueba.local`, password: "ContraseñaLarga123!", name: "B" }));
    const tardo = Date.now() - t0;
    check("con la base caída, el pedido RESPONDE (no queda colgado para siempre)",
      !r.abortado, r.abortado ? "se colgó >20s" : `HTTP ${r.status} en ${tardo}ms`);
    check("y responde en tiempo humano (hay timeout de conexión)", tardo < 15_000, `${tardo}ms`);
  }
  {
    // Lo que NO depende de la base tiene que seguir andando.
    const r = await api("/api/auth/config");
    check("lo que no toca la base sigue respondiendo", r.status === 200, `HTTP ${r.status}`);
  }

  await sleep(2000);
  const arranqueDurante = await arranqueServidor();
  check("EL SERVIDOR SIGUE VIVO: una caída de la base no lo mata",
    arranqueDurante === arranqueAntes && Boolean(arranqueDurante),
    `antes=${arranqueAntes} ahora=${arranqueDurante}`);

  // ═══════ 2. Vuelve la base ═══════
  console.log("\n── 2. Vuelve la base de datos ──");
  pg("start");
  await sleep(4000);

  {
    // El momento de la verdad del bug 3: si la migración quedó cacheada como
    // "fallida", el servidor seguiría sin poder guardar aunque la base esté
    // sana, hasta que alguien lo reinicie.
    let ok = false;
    for (let i = 0; i < 8 && !ok; i++) {
      const r = await api("/api/auth/register",
        json({ email: `vuelta-${rnd()}@prueba.local`, password: "ContraseñaLarga123!", name: "C" }));
      ok = r.status === 200 || r.status === 201;
      if (!ok) await sleep(1500);
    }
    check("el servidor SE CURA SOLO y vuelve a guardar (sin reiniciarlo)", ok);
  }
  {
    const r = await api("/api/auth/login", json({ email, password: "ContraseñaLarga123!" }));
    // 403 = "verificá tu email": es una respuesta válida y prueba que la
    // cuenta creada ANTES de la caída sigue ahí.
    check("y la cuenta creada antes de la caída sigue existiendo",
      r.status === 200 || r.status === 403, `HTTP ${r.status}`);
  }

  const arranqueDespues = await arranqueServidor();
  check("y sigue siendo el MISMO proceso de principio a fin (nunca se cayó)",
    arranqueDespues === arranqueAntes && Boolean(arranqueDespues),
    `${arranqueAntes} -> ${arranqueDespues}`);

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("ERROR:", e.message);
  try { pg("start"); } catch { /* ya estaba */ }
  process.exit(1);
});
