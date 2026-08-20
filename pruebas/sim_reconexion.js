// La trampa de socket.io, probada de verdad: qué le pasa a lo que se dijo, a
// lo que se escribió y al ESTADO (mute, mano, idioma) cuando se corta la red.
//
// Se prueba contra el servidor real, cortando el transporte por debajo como lo
// haría un wifi que parpadea.
const { io } = require("/home/user/Taller-0/client/node_modules/socket.io-client");
const API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

// Réplica mínima de lo que hace MeetingContext: cola de eventos + estado
// recordado que se reenvía después del ack del rejoin.
function makeClient(externalKey, name) {
  const s = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
  const outbox = [];
  let joined = false;
  const state = { muted: false, cameraOff: false, handRaised: false, language: "es-AR" };

  const flush = () => {
    if (!joined || !s.connected) return;
    s.emit("media-state", { muted: state.muted, cameraOff: state.cameraOff });
    if (state.handRaised) s.emit("raise-hand", { raised: true });
    if (state.language) s.emit("set-language", { language: state.language });
    const pending = outbox.splice(0);
    for (const it of pending) s.emit(it.event, it.payload);
  };
  const emitOrQueue = (event, payload) => {
    if (!joined || !s.connected) { outbox.push({ event, payload }); return; }
    s.emit(event, payload);
  };
  const join = () =>
    new Promise((res) =>
      s.timeout(8000).emit("join-companion", { externalKey, name, language: state.language }, (e, r) => {
        if (r?.ok) { joined = true; flush(); }
        res(r);
      })
    );
  return { s, state, emitOrQueue, join, setJoined: (v) => (joined = v), get outboxLen() { return outbox.length; } };
}

(async () => {
  const code = `${rnd(3)}-${rnd(4)}-${rnd(3)}`;
  const key = `google-meet:${code}`;

  // Un observador que mira todo desde adentro de la sala.
  const obs = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
  await new Promise((r, x) => { obs.on("connect", r); obs.on("connect_error", x); });
  const seenChat = [];
  const seenLines = [];
  const seenMedia = [];
  const seenHands = [];
  obs.on("chat-message", ({ message }) => seenChat.push(message.text));
  obs.on("transcript-line", ({ line }) => seenLines.push(line.text));
  obs.on("media-state", (p) => seenMedia.push(p));
  obs.on("hand-raised", (p) => seenHands.push(p));
  const obsAck = await new Promise((res) =>
    obs.timeout(8000).emit("join-companion", { externalKey: key, name: "Observadora", language: "es-AR" }, (e, r) => res(r))
  );
  check("el observador entra a la sala", obsAck?.ok === true);

  // La persona que se va a caer.
  const c = makeClient(key, "Inestable");
  await new Promise((r, x) => { c.s.on("connect", r); c.s.on("connect_error", x); });
  await c.join();
  await sleep(600);

  // Se silencia y levanta la mano ANTES del corte.
  c.state.muted = true;
  c.state.handRaised = true;
  c.s.emit("media-state", { muted: true, cameraOff: false });
  c.s.emit("raise-hand", { raised: true });
  await sleep(900);

  const antes = obsAck.meeting ? null : null;
  check("el observador la ve silenciada antes del corte",
    seenMedia.some((m) => m.muted === true), JSON.stringify(seenMedia.slice(-1)));

  // ─── Corte de red ───
  c.setJoined(false);
  c.s.io.engine.close();
  await sleep(500);

  // Habla y escribe MIENTRAS está caída.
  c.emitOrQueue("transcript-line", { alternatives: ["esto lo dije con la red caida"], lang: "es-AR" });
  c.emitOrQueue("chat-message", { text: "y esto lo escribi con la red caida" });
  check("lo dicho y lo escrito quedan en la cola, no se tiran", c.outboxLen === 2, `en cola=${c.outboxLen}`);

  // ─── Vuelve ───
  const back = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
  await new Promise((r, x) => { back.on("connect", r); back.on("connect_error", x); });
  // Se reemplaza el socket manteniendo cola y estado, como hace el contexto real.
  const outboxSnapshot = [
    { event: "transcript-line", payload: { alternatives: ["esto lo dije con la red caida"], lang: "es-AR" } },
    { event: "chat-message", payload: { text: "y esto lo escribi con la red caida" } },
  ];
  const rejoin = await new Promise((res) =>
    back.timeout(8000).emit("join-companion", { externalKey: key, name: "Inestable", language: "es-AR" }, (e, r) => res(r))
  );
  check("vuelve a entrar a la misma sala", rejoin?.ok === true);

  // Lo que hace flushOutbox: primero el estado, después la cola.
  back.emit("media-state", { muted: c.state.muted, cameraOff: c.state.cameraOff });
  if (c.state.handRaised) back.emit("raise-hand", { raised: true });
  for (const it of outboxSnapshot) back.emit(it.event, it.payload);
  await sleep(2600);

  check("lo que se dijo durante el corte llega igual",
    seenLines.some((t) => /red caida/i.test(t)), seenLines.join(" | ").slice(0, 70));
  check("lo que se escribió durante el corte llega igual",
    seenChat.some((t) => /red caida/i.test(t)), seenChat.join(" | ").slice(0, 70));

  // Lo importante: ¿sigue silenciada para los demás?
  const ultimoMedia = seenMedia[seenMedia.length - 1];
  check("tras reconectar, los demás la siguen viendo SILENCIADA",
    ultimoMedia?.muted === true, JSON.stringify(ultimoMedia));
  check("tras reconectar, la mano levantada sigue levantada",
    seenHands.filter((h) => h.raised === true).length >= 2, JSON.stringify(seenHands.slice(-2)));

  // Y el servidor lo refleja en el snapshot que ve cualquiera que entre ahora.
  const nuevo = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
  await new Promise((r, x) => { nuevo.on("connect", r); nuevo.on("connect_error", x); });
  const snap = await new Promise((res) =>
    nuevo.timeout(8000).emit("join-companion", { externalKey: key, name: "ReciénLlegada", language: "es-AR" }, (e, r) => res(r))
  );
  const inestable = snap?.meeting?.participants?.find((p) => p.name === "Inestable");
  check("quien entra después también la ve silenciada",
    inestable?.muted === true, JSON.stringify({ muted: inestable?.muted, hand: inestable?.handRaised }));

  obs.disconnect(); c.s.disconnect(); back.disconnect(); nuevo.disconnect();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 300)); process.exit(1); });
