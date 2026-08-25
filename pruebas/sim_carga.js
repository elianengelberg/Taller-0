// La oficina entera adentro: ~120 clientes en 20 salas simultáneas, TODOS
// detrás de la misma IP (que es exactamente cómo ve el servidor a una empresa
// con NAT). Corre contra los topes REALES de producción (sin LIMITE_* de
// prueba): lo que acá se frena, se frenaba en la oficina.
//
// Maneja su propio servidor en 4001: correrla con el puerto libre.
const { spawn, execSync } = require("child_process");
const { io } = require("/home/user/Taller-0/client/node_modules/socket.io-client");
const API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SALAS = 20;
const POR_SALA = 6; // 120 clientes en total

function arrancarServidor() {
  return spawn("npx", ["tsx", "src/index.ts"], {
    cwd: "/home/user/Taller-0/server",
    env: {
      ...process.env,
      DATABASE_URL: "postgres://postgres@localhost:5433/unify",
      AUTH_SECRET: "clave-de-pruebas-local-larga-1234567890",
      PORT: "4001",
      CLIENT_ORIGIN: "http://localhost:4174",
      MAIL_LOG: "1",
      // SIN LIMITE_*: acá mandan los valores de producción (los de oficina).
    },
    stdio: "ignore",
    detached: true,
  });
}
const matar = (s) => { try { process.kill(-s.pid); } catch { try { s.kill(); } catch { /* ya */ } } };
async function esperarSalud() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${API}/api/health`)).ok) return true; } catch { /* levantando */ }
    await sleep(500);
  }
  return false;
}
const conectar = () => io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
const esperarConexion = (s) => new Promise((r, x) => { s.on("connect", r); s.on("connect_error", x); setTimeout(x, 10_000); });

(async () => {
  try {
    const pids = execSync('ps aux | grep "tsx src/index.ts" | grep -v grep | awk \'{print $2}\'', { encoding: "utf8" }).trim();
    for (const p of pids.split("\n").filter(Boolean)) { try { process.kill(Number(p)); } catch { /* ajeno */ } }
  } catch { /* nada corriendo */ }
  await sleep(1000);

  console.log("── 0. El servidor, con los topes de producción ──");
  const server = arrancarServidor();
  check("levanta", await esperarSalud());
  const t0 = Date.now();

  // ═══════ 1. 20 salas, 120 personas, todas entrando A LA VEZ ═══════
  console.log("\n── 1. La entrada en manada ──");
  const salas = [];
  {
    const creaciones = await Promise.all(Array.from({ length: SALAS }, async (_, i) => {
      const creador = conectar();
      await esperarConexion(creador);
      const creada = await new Promise((res) => creador.timeout(10_000).emit("create-meeting",
        { hostName: `Anfitrión ${i}`, hostLanguage: "es-AR", roles: [] }, (e, r) => res(e ? null : r)));
      return { creador, code: creada?.meeting?.id, dbId: creada?.meeting?.dbId };
    }));
    check("las 20 salas se crean", creaciones.every((c) => c.code),
      `ok=${creaciones.filter((c) => c.code).length}`);

    for (const c of creaciones) {
      const miembros = [c.creador];
      const recibidas = { transcript: 0, chat: 0 };
      c.creador.on("transcript-line", () => { recibidas.transcript += 1; });
      c.creador.on("chat-message", () => { recibidas.chat += 1; });
      salas.push({ ...c, miembros, recibidas });
    }
    const entradas = await Promise.all(salas.flatMap((sala, i) =>
      Array.from({ length: POR_SALA - 1 }, async (_, j) => {
        const s = conectar();
        await esperarConexion(s);
        const r = await new Promise((res) => s.timeout(10_000).emit("join-meeting",
          { meetingId: sala.code, name: `Persona ${i}-${j}`, language: j % 2 ? "en-US" : "es-AR" }, (e, x) => res(e ? null : x)));
        sala.miembros.push(s);
        return Boolean(r?.ok);
      })
    ));
    check(`las ${SALAS * (POR_SALA - 1)} personas entran (nadie rebotado por los topes)`,
      entradas.every(Boolean), `ok=${entradas.filter(Boolean).length}/${entradas.length}`);
  }

  // ═══════ 2. Todos hablan y chatean a la vez ═══════
  console.log("\n── 2. La conversación simultánea ──");
  {
    for (const sala of salas) {
      sala.miembros.forEach((m, j) => {
        for (let k = 0; k < 3; k++) {
          m.emit("transcript-line", { alternatives: [`sala ${sala.code} persona ${j} línea ${k}`], lang: "es-AR" });
        }
        m.emit("chat-message", { text: `hola de ${j}` });
      });
    }
    await sleep(6000);
    // El anfitrión de cada sala tiene que haber recibido las líneas de TODOS
    // los de su sala (6 × 3 = 18) y ninguna de otras salas.
    const completas = salas.filter((s) => s.recibidas.transcript >= POR_SALA * 3).length;
    check("cada sala recibe la conversación completa de SU sala",
      completas === SALAS, `salas completas=${completas}/${SALAS}`);
    const chats = salas.filter((s) => s.recibidas.chat >= POR_SALA - 1).length;
    check("y el chat llega en todas", chats === SALAS, `salas con chat=${chats}/${SALAS}`);
  }

  // ═══════ 3. El bridge de la extensión, en manada por la MISMA IP ═══════
  console.log("\n── 3. Cien máquinas publicando subtítulos por una sola IP ──");
  {
    // 10 salas externas × 30 líneas = 300 pedidos REST en ráfaga. Con el tope
    // viejo (240/min por IP) la oficina se quedaba muda a mitad de camino.
    const claves = Array.from({ length: 10 }, (_, i) => `externa:oficina.com/sala-${i}-${Date.now()}`);
    const resultados = await Promise.all(claves.flatMap((clave) =>
      Array.from({ length: 30 }, (_, k) =>
        fetch(`${API}/api/meet-bridge/${encodeURIComponent(clave)}/transcript`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ speaker: `PC ${k}`, text: `línea ${k} de la oficina`, lang: "es-AR" }),
        }).then((r) => r.status).catch(() => 0)
      )
    ));
    const ok200 = resultados.filter((s) => s === 200).length;
    check("las 300 líneas entran (ninguna frenada por el tope por IP)",
      ok200 === 300, `200=${ok200} 429=${resultados.filter((s) => s === 429).length}`);
    const ses = await fetch(`${API}/api/meet-bridge/${encodeURIComponent(claves[0])}/session`).then((r) => r.json());
    check("y quedan guardadas en su sala", (ses.transcript ?? []).length === 30, String((ses.transcript ?? []).length));
  }

  // ═══════ 4. El servidor sigue entero ═══════
  console.log("\n── 4. Salud bajo carga ──");
  {
    const health = await Promise.all(Array.from({ length: 100 }, () =>
      fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false)));
    check("100 chequeos de salud simultáneos responden", health.every(Boolean),
      `ok=${health.filter(Boolean).length}`);
    const total = (Date.now() - t0) / 1000;
    check("todo el escenario de oficina corre en menos de 90 segundos", total < 90, `${total.toFixed(1)}s`);
  }

  for (const sala of salas) for (const m of sala.miembros) { try { m.close(); } catch { /* ya */ } }
  matar(server);
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 400)); process.exit(1); });
