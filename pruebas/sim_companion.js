// Live simulation of the COMPANION layer that rides on every external platform
// (Zoom/Meet/Teams/Jitsi). Platform-independent substrate: shared room by
// external key, transcript/chat sync, persistence, and the AI/history access
// model. Real server + Postgres.
const { io } = require("/home/user/Taller-0/client/node_modules/socket.io-client");
const API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const conn = () => io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
const once = (s, ev, ms = 8000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout " + ev)), ms); s.once(ev, (d) => { clearTimeout(t); res(d); }); });
async function register(name) {
  const r = await fetch(`${API}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${name}${Date.now()}${Math.floor(Math.random()*1e6)}@t.com`, name, password: "password123" }) });
  return (await r.json()).token;
}
async function get(path, token) {
  const r = await fetch(API + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
function joinCompanion(s, externalKey, name, token) {
  return new Promise((res, rej) => {
    s.timeout(8000).emit("join-companion", { externalKey, name, language: "es-AR", token }, (e, r) => e ? rej(e) : res(r));
  });
}

(async () => {
  const tokenA = await register("Ana");
  const tokenB = await register("Beto");
  const key = "zoom:" + Date.now(); // simulate a Zoom companion key

  // ---- Two people open the same external link -> same companion room ----
  const a = conn(); await once(a, "connect");
  const ra = await joinCompanion(a, key, "Ana", tokenA);
  check("A entra a la sala companion", ra.ok === true);
  const dbId = ra.meeting?.dbId;

  let aSawJoin = false;
  a.on("participant-joined", () => { aSawJoin = true; });
  const b = conn(); await once(b, "connect");
  const rb = await joinCompanion(b, key, "Beto", tokenB);
  await sleep(300);
  check("B entra a la MISMA sala (misma key)", rb.ok === true && rb.meeting?.dbId === dbId, `dbId A=${dbId} B=${rb.meeting?.dbId}`);
  check("A ve entrar a B (roster compartido)", aSawJoin && rb.meeting.participants.length === 2, `count=${rb.meeting?.participants?.length}`);

  // ---- Transcript syncs A -> B ----
  let bGotLine = null;
  b.on("transcript-line", (d) => { bGotLine = d.line; });
  a.emit("transcript-line", { alternatives: ["hola esto es una prueba de subtitulos"], lang: "es-AR" });
  await sleep(1200);
  check("la transcripción de A llega a B (subtítulos compartidos)", bGotLine && /prueba de subtitulos/.test(bGotLine.text || ""), bGotLine?.text || "sin línea");

  // ---- Chat syncs B -> A ----
  let aGotChat = null;
  a.on("chat-message", (d) => { aGotChat = d.message; });
  b.emit("chat-message", { text: "mensaje de chat externo" });
  await sleep(500);
  check("el chat de B llega a A", aGotChat && /mensaje de chat externo/.test(aGotChat.text || ""));

  // ---- Isolation: a different key is a different room ----
  const c = conn(); await once(c, "connect");
  let cSawOthers = 0;
  c.on("participant-joined", () => cSawOthers++);
  const rc = await joinCompanion(c, "zoom:otra-" + Date.now(), "Caro", null);
  check("otra key = otra sala (aislada de A/B)", rc.ok && rc.meeting.participants.length === 1, `count=${rc.meeting?.participants?.length}`);

  // ---- Reconnection: A drops and rejoins the same key ----
  a.disconnect();
  await sleep(300);
  const a2 = conn(); await once(a2, "connect");
  const ra2 = await joinCompanion(a2, key, "Ana", tokenA);
  await sleep(200);
  check("A reconecta a la companion por la misma key", ra2.ok && ra2.meeting.participants.some((p) => p.name === "Beto"), `roster=${ra2.meeting?.participants?.map(p=>p.name).join(",")}`);

  // ---- Persistence + access model ----
  const ownerView = await get(`/api/meetings/${dbId}`, tokenA);
  check("la reunión externa queda en el historial del dueño (A, 200)", ownerView.status === 200);
  check("la transcripción externa se persiste (mensajes guardados)", (ownerView.body?.meeting?.messages?.length ?? 0) >= 1, `msgs=${ownerView.body?.meeting?.messages?.length}`);
  check("el historial muestra la fuente externa (Zoom)", (ownerView.body?.meeting?.joinCode || "").toLowerCase().startsWith("zoom:"), ownerView.body?.meeting?.joinCode);

  // FIX: a non-owner who is a CURRENT participant of the live companion room can
  // now reach the shared transcript + AI (the "IA" button works for everyone).
  const nonOwnerView = await get(`/api/meetings/${dbId}`, tokenB);
  check("participante no-dueño (B) SÍ ve la transcripción compartida en vivo (200)", nonOwnerView.status === 200, `status=${nonOwnerView.status}`);
  check("B ve los mensajes compartidos", (nonOwnerView.body?.meeting?.messages?.length ?? 0) >= 1);
  // B asks the AI: it must get PAST the access check (fails only because the AI
  // isn't configured in this sandbox -- NOT because "no encontramos esa reunión").
  const bAsk = await fetch(`${API}/api/meetings/${dbId}/ask`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenB}` }, body: JSON.stringify({ question: "resumime" }) });
  const bAskBody = await bAsk.json().catch(() => ({}));
  check("B puede usar la IA (pasa el control de acceso, no 'no encontramos esa reunión')", !/no encontramos esa reuni/i.test(bAskBody.error || ""), bAskBody.error || "ok");

  // Isolation preserved: a logged-in user NOT in the room still can't read it.
  const tokenD = await register("Draco");
  const strangerView = await get(`/api/meetings/${dbId}`, tokenD);
  check("un usuario que NO está en la reunión sigue sin acceso (404)", strangerView.status === 404, `status=${strangerView.status}`);

  // Access is only WHILE live: once B leaves, B loses access again.
  b.disconnect();
  await sleep(400);
  const bAfterLeave = await get(`/api/meetings/${dbId}`, tokenB);
  check("al salir, B pierde el acceso (404) — el acceso es solo mientras está en la sala", bAfterLeave.status === 404, `status=${bAfterLeave.status}`);

  a2.disconnect(); c.disconnect();
  await sleep(200);
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("SIM ERROR:", e.message, e.stack); process.exit(1); });
