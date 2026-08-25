// El servidor se reinicia EN PLENA reunión (un deploy, el plan gratuito que
// recicla la instancia): antes, cada participante veía "No encontramos una
// reunión con ese código" y era EXPULSADO al inicio -- un corte total por un
// reinicio de segundos. Ahora la reunión RENACE desde la base de datos:
// mismo código, MISMO dbId (el historial sigue siendo uno solo), y el
// primero en volver queda de anfitrión.
//
// Esta suite mata el servidor DE VERDAD en plena reunión, dos veces.
// Maneja su propio servidor en 4001: correrla con el puerto libre.
const { spawn } = require("child_process");
const { io } = require("/home/user/Taller-0/client/node_modules/socket.io-client");
const { Client } = require("/home/user/Taller-0/server/node_modules/pg");
const API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    },
    stdio: "ignore",
    // Grupo propio: matar sólo el npx dejaría al tsx huérfano con el puerto.
    detached: true,
  });
}
function matar(server) {
  try { process.kill(-server.pid); } catch { try { server.kill(); } catch { /* ya muerto */ } }
}
async function esperarSalud() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${API}/api/health`)).ok) return true; } catch { /* levantando */ }
    await sleep(500);
  }
  return false;
}
function conectar() {
  return io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
}
function entrar(socket, payload) {
  return new Promise((res) => {
    socket.timeout(8000).emit("join-meeting", payload, (e, r) => res(e ? null : r));
  });
}

(async () => {
  // Puerto limpio: si la corrida anterior dejó un servidor, se baja acá.
  const { execSync } = require("child_process");
  try {
    const pids = execSync('ps aux | grep "tsx src/index.ts" | grep -v grep | awk \'{print $2}\'', { encoding: "utf8" }).trim();
    for (const p of pids.split("\n").filter(Boolean)) { try { process.kill(Number(p)); } catch { /* ajeno */ } }
  } catch { /* nada corriendo */ }
  await sleep(1000);

  const pg = new Client({ connectionString: "postgres://postgres@localhost:5433/unify" });
  await pg.connect();

  console.log("── 1. Una reunión viva, con conversación ──");
  let server = arrancarServidor();
  check("el servidor arranca", await esperarSalud());

  const creador = conectar();
  await new Promise((r, x) => { creador.on("connect", r); creador.on("connect_error", x); });
  const creada = await new Promise((res) => creador.timeout(8000).emit("create-meeting",
    { hostName: "Ana", hostLanguage: "es-AR", roles: [] }, (e, r) => res(r)));
  const code = creada?.meeting?.id;
  const dbId = creada?.meeting?.dbId;
  const anaId = creada?.selfId ?? creada?.self?.id;
  check("Ana crea la reunión (código y dbId)", Boolean(code && dbId), `${code} / ${dbId}`);

  const bruno = conectar();
  await new Promise((r, x) => { bruno.on("connect", r); bruno.on("connect_error", x); });
  const b1 = await entrar(bruno, { meetingId: code, name: "Bruno", language: "en-US" });
  check("Bruno entra", Boolean(b1?.ok), JSON.stringify(b1)?.slice(0, 60));

  creador.emit("transcript-line", { alternatives: ["esto se dijo antes del reinicio"], lang: "es-AR" });
  await sleep(2000);
  const antes = await pg.query(`SELECT count(*)::int AS n FROM messages WHERE meeting_id = $1 AND kind = 'transcript'`, [dbId]);
  check("lo dicho quedó en la base", antes.rows[0].n >= 1, `líneas=${antes.rows[0].n}`);

  console.log("\n── 2. El servidor MUERE en plena reunión y vuelve ──");
  matar(server);
  creador.close(); bruno.close();
  await sleep(1500);
  server = arrancarServidor();
  check("el servidor de reemplazo levanta (memoria VACÍA)", await esperarSalud());

  console.log("\n── 3. La gente vuelve con su código, como hace la app sola ──");
  const ana2 = conectar();
  await new Promise((r, x) => { ana2.on("connect", r); ana2.on("connect_error", x); });
  const rejAna = await entrar(ana2, { meetingId: code, name: "Ana", language: "es-AR", resumeParticipantId: anaId ?? undefined });
  check("Ana NO es expulsada: la reunión renace", Boolean(rejAna?.ok), JSON.stringify(rejAna)?.slice(0, 80));
  check("con el MISMO dbId (el historial sigue siendo uno solo)",
    rejAna?.meeting?.dbId === dbId, `${rejAna?.meeting?.dbId} vs ${dbId}`);
  const anaSelf = (rejAna?.meeting?.participants ?? []).find((p) => p.id === rejAna?.selfId);
  check("y la primera en volver queda de anfitriona", Boolean(anaSelf?.isHost), JSON.stringify(anaSelf)?.slice(0, 70));

  const bruno2 = conectar();
  await new Promise((r, x) => { bruno2.on("connect", r); bruno2.on("connect_error", x); });
  const rejBruno = await entrar(bruno2, { meetingId: code, name: "Bruno", language: "en-US" });
  check("Bruno también vuelve, a la MISMA sala",
    Boolean(rejBruno?.ok) && rejBruno?.meeting?.dbId === dbId);
  check("y son dos otra vez", (rejBruno?.meeting?.participants ?? []).length === 2,
    String((rejBruno?.meeting?.participants ?? []).length));

  ana2.emit("transcript-line", { alternatives: ["y esto se dijo después de renacer"], lang: "es-AR" });
  await sleep(2000);
  const despues = await pg.query(
    `SELECT count(*)::int AS n FROM messages WHERE meeting_id = $1 AND kind = 'transcript'`, [dbId]);
  check("la conversación sigue en el MISMO historial", despues.rows[0].n > antes.rows[0].n,
    `antes=${antes.rows[0].n} después=${despues.rows[0].n}`);

  console.log("\n── 4. Renacer no abre puertas que no van ──");
  const intruso = conectar();
  await new Promise((r, x) => { intruso.on("connect", r); intruso.on("connect_error", x); });
  const falso = await entrar(intruso, { meetingId: "ZZZ999", name: "Intruso", language: "es-AR" });
  check("un código inventado sigue rechazado", falso?.ok === false && /No encontramos/.test(falso?.error ?? ""),
    JSON.stringify(falso)?.slice(0, 70));

  // Una reunión VIEJA no revive: el código del historial de hace 13 horas ya
  // no es una puerta de entrada (la ventana es de 12).
  await pg.query(`UPDATE meetings SET started_at = now() - interval '13 hours' WHERE id = $1`, [dbId]);
  ana2.close(); bruno2.close(); intruso.close();
  matar(server);
  await sleep(1500);
  server = arrancarServidor();
  check("tercer servidor levanta", await esperarSalud());
  const tarde = conectar();
  await new Promise((r, x) => { tarde.on("connect", r); tarde.on("connect_error", x); });
  const viejo = await entrar(tarde, { meetingId: code, name: "Ana", language: "es-AR" });
  check("un código de hace 13 horas ya NO revive nada", viejo?.ok === false,
    JSON.stringify(viejo)?.slice(0, 70));
  tarde.close();

  matar(server);
  await pg.end();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 400)); process.exit(1); });
