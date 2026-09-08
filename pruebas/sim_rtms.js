// ZOOM SIN BOT (Realtime Media Streams), de punta a punta contra un Zoom
// FALSO que habla el protocolo real: el webhook firmado, el handshake de
// señalización con la firma HMAC, el handshake de medios, el CLIENT_READY_ACK,
// los keep-alive, las frases de transcripción (17), los eventos de
// participantes (6), el corte (rtms_stopped) y la reconexión.
//
// Lo que NO se puede probar acá: Zoom de verdad (no hay salida a zoom.us).
// Todo lo demás es el servidor REAL (puerto 4003, con las variables de RTMS
// puestas) y el puente real: las frases tienen que caer EN VIVO en la sala
// companion «zoom:<número>» y en el historial, a nombre del anfitrión.
const { spawn } = require("child_process");
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("/home/user/Taller-0/server/node_modules/ws");
const { io } = require("/home/user/Taller-0/client/node_modules/socket.io-client");
const { Client } = require("/home/user/Taller-0/server/node_modules/pg");

const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esperar = async (cond, ms = 15_000) => {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) { if (await cond()) return true; await sleep(200); }
  return false;
};

const CLIENT_ID = "cid-de-prueba";
const CLIENT_SECRET = "secreto-rtms-de-prueba";
const TOKEN_WEBHOOK = "token-webhook-de-prueba";
const S2S = { account: "cuenta-s2s", id: "s2s-id", secret: "s2s-secreto" };
const HOST_EMAIL = `anfitriona${Date.now()}@test.com`;
const NUMERO = "89123456789";
const API3 = "http://127.0.0.1:4003"; // 127.0.0.1 a propósito: "localhost" a veces resuelve a ::1 y el socket no entra
const PUERTO_ZOOM_API = 4197; // 4190 está en la lista de "bad ports" de fetch: undici lo rechaza
const PUERTO_RTMS = 4191;

const firmaRtms = (uuid, stream) => crypto.createHmac("sha256", CLIENT_SECRET).update(`${CLIENT_ID},${uuid},${stream}`).digest("hex");
const firmaWebhook = (ts, cuerpo) => `v0=${crypto.createHmac("sha256", TOKEN_WEBHOOK).update(`v0:${ts}:${cuerpo}`).digest("hex")}`;
async function webhook(evento, payload, opciones = {}) {
  // Con sangría y espacios A PROPÓSITO: la firma de Zoom cubre los bytes tal
  // cual llegan, y un servidor que la calculara sobre el JSON re-serializado
  // (compacto) la rechazaría. Así la suite lo detecta.
  const cuerpo = JSON.stringify({ event: evento, event_ts: Date.now(), payload }, null, 2);
  const ts = String(opciones.ts ?? Math.floor(Date.now() / 1000));
  const firma = opciones.firma ?? firmaWebhook(ts, cuerpo);
  const r = await fetch(`${opciones.base ?? API3}/api/zoom/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-zm-request-timestamp": ts, "x-zm-signature": firma },
    body: cuerpo,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

(async () => {
  // ── El Zoom falso: la API REST (S2S) ──
  const llamadasApi = [];
  const zoomApi = http.createServer((req, res) => {
    llamadasApi.push(`${req.method} ${req.url} auth=${req.headers.authorization || "-"}`);
    if (req.method === "POST" && req.url.startsWith("/oauth/token")) {
      const basic = Buffer.from(`${S2S.id}:${S2S.secret}`).toString("base64");
      const ok = req.headers.authorization === `Basic ${basic}` && /grant_type=account_credentials/.test(req.url) && req.url.includes(`account_id=${S2S.account}`);
      res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ok ? { access_token: "tok-s2s", expires_in: 3600 } : { error: "bad creds" }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/v2/meetings/")) {
      const ok = req.headers.authorization === "Bearer tok-s2s";
      res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ok ? { id: Number(NUMERO), topic: "Reunión de prueba RTMS", host_email: HOST_EMAIL, password: "482113" } : {}));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => zoomApi.listen(PUERTO_ZOOM_API, r));

  // ── El Zoom falso: los servidores de señalización y de medios ──
  const vistos = { senal: [], medios: [], listos: [], suscripciones: [], keepAlive: { senal: null, medios: null } };
  let cerrarMediosUnaVez = new Set(); // streams a los que se les corta la primera conexión de medios
  const rtms = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  rtms.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req)));
  wss.on("connection", (ws, req) => {
    const camino = req.url;
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (camino === "/senal") {
        if (m.msg_type === 1) {
          const ok = m.signature === firmaRtms(m.meeting_uuid, m.rtms_stream_id) && m.protocol_version === 1;
          vistos.senal.push({ stream: m.rtms_stream_id, ok, m });
          const rechazar = /rechazar/.test(m.meeting_uuid);
          if (!ok || rechazar) { ws.send(JSON.stringify({ msg_type: 2, status_code: 1, reason: ok ? "app no autorizada en esta cuenta" : "firma inválida" })); return; }
          ws.send(JSON.stringify({ msg_type: 2, status_code: 0, media_server: { server_urls: { all: `ws://localhost:${PUERTO_RTMS}/medios`, audio: `ws://localhost:${PUERTO_RTMS}/medios`, transcript: `ws://localhost:${PUERTO_RTMS}/medios` } } }));
        } else if (m.msg_type === 5) {
          vistos.suscripciones.push(m.events);
        } else if (m.msg_type === 7) {
          vistos.listos.push(m.rtms_stream_id);
          // Keep-alive: sin respuesta con el MISMO timestamp Zoom corta.
          const ts = Date.now();
          ws.send(JSON.stringify({ msg_type: 12, timestamp: ts }));
          ws.once("message", (r2) => { try { const k = JSON.parse(r2.toString()); if (k.msg_type === 13) vistos.keepAlive.senal = k.timestamp === ts; } catch {} });
          // Quién está: el evento de participantes.
          setTimeout(() => ws.send(JSON.stringify({ msg_type: 6, event: { event_type: 2, timestamp: Date.now(), participants: [{ user_id: 1, user_name: "Ana García" }, { user_id: 2, user_name: "Bruno Pérez" }] } })), 200);
        }
      } else if (camino === "/medios") {
        if (m.msg_type === 3) {
          const ok = m.signature === firmaRtms(m.meeting_uuid, m.rtms_stream_id) && (Number(m.media_type) & 8) === 8;
          vistos.medios.push({ stream: m.rtms_stream_id, ok, media_type: m.media_type });
          if (!ok) { ws.send(JSON.stringify({ msg_type: 4, status_code: 1, reason: "medios rechazados" })); return; }
          if (cerrarMediosUnaVez.has(m.rtms_stream_id)) {
            // La primera conexión de medios se cae (como una red que parpadea).
            cerrarMediosUnaVez.delete(m.rtms_stream_id);
            ws.terminate();
            return;
          }
          ws.send(JSON.stringify({ msg_type: 4, status_code: 0 }));
          const ts = Date.now() + 1;
          setTimeout(() => {
            ws.send(JSON.stringify({ msg_type: 12, timestamp: ts }));
            ws.once("message", (r2) => { try { const k = JSON.parse(r2.toString()); if (k.msg_type === 13) vistos.keepAlive.medios = k.timestamp === ts; } catch {} });
          }, 100);
          // Las frases, como las manda Zoom (17): texto plano, con quién habló.
          const frases = [
            ["Ana García", "buenos días equipo, arrancamos con el presupuesto del trimestre"],
            ["Bruno Pérez", "yo tengo los números listos para revisar el jueves a la tarde"],
          ];
          frases.forEach(([quien, texto], i) => setTimeout(() => ws.send(JSON.stringify({ msg_type: 17, content: { user_id: i + 1, user_name: quien, data: texto, timestamp: Date.now() } })), 400 + i * 300));
        }
      }
    });
  });
  await new Promise((r) => rtms.listen(PUERTO_RTMS, r));

  // ── El servidor REAL, con RTMS configurado, en 4003 ──
  const srv = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: "/home/user/Taller-0/server",
    env: {
      ...process.env,
      DATABASE_URL: "postgres://postgres@localhost:5433/unify",
      AUTH_SECRET: "clave-de-pruebas-local-larga-1234567890",
      PORT: "4003", CLIENT_ORIGIN: "http://localhost:4174", MAIL_LOG: "1", LIMITE_BRIDGE: "240",
      ZOOM_RTMS_CLIENT_ID: CLIENT_ID, ZOOM_RTMS_CLIENT_SECRET: CLIENT_SECRET, ZOOM_WEBHOOK_SECRET_TOKEN: TOKEN_WEBHOOK,
      ZOOM_SDK_KEY: "sdk-key-de-prueba", ZOOM_SDK_SECRET: "sdk-secreto-de-prueba",
      ZOOM_S2S_ACCOUNT_ID: S2S.account, ZOOM_S2S_CLIENT_ID: S2S.id, ZOOM_S2S_CLIENT_SECRET: S2S.secret,
      ZOOM_OAUTH_BASE: `http://127.0.0.1:${PUERTO_ZOOM_API}`, ZOOM_API_BASE: `http://127.0.0.1:${PUERTO_ZOOM_API}`,
    },
    stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  let logSrv = "";
  srv.stdout.on("data", (d) => { logSrv += d.toString(); });
  srv.stderr.on("data", (d) => { logSrv += d.toString(); });
  const vivo = await esperar(async () => { try { return (await fetch(`${API3}/api/health`)).ok; } catch { return false; } }, 40_000);
  check("el servidor con RTMS configurado levanta", vivo);
  const pg = new Client({ connectionString: "postgres://postgres@localhost:5433/unify" });
  await pg.connect();

  try {
    const plat = await fetch(`${API3}/api/platforms`).then((r) => r.json());
    check("/api/platforms dice que Zoom sin bot está disponible (zoomRtms)", plat.zoomRtms === true, JSON.stringify(plat));
    // La vuelta de la autorización (OAuth Redirect URL del Marketplace) no es un 404.
    const vuelta = await fetch(`${API3}/api/zoom/oauth/callback?code=abc123`);
    const vueltaHtml = await vuelta.text();
    check("la vuelta de la autorización en Zoom es una página clara (no un 404)", vuelta.status === 200 && /quedó autorizado/.test(vueltaHtml) && /Podés cerrar/.test(vueltaHtml), `HTTP ${vuelta.status}`);
    const sinCodigo = await fetch(`${API3}/api/zoom/oauth/callback`).then((r) => r.text());
    check("y sin código explica que se reintente desde el Marketplace", /Volvé a intentarlo/.test(sinCodigo));

    // La anfitriona tiene cuenta en Unify (con el MISMO mail que en Zoom).
    const reg = await fetch(`${API3}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: HOST_EMAIL, password: "melon42Trueno", name: "Anfitriona" }),
    }).then((r) => r.json());
    const { rows: [usuaria] } = await pg.query(`SELECT id FROM users WHERE email = $1`, [HOST_EMAIL]);
    check("la anfitriona tiene cuenta en Unify", Boolean(reg.token && usuaria?.id));

    console.log("── 0. La contraseña real de una reunión propia, sin escribirla ──");
    {
      const firmar = (headers = {}) => fetch(`${API3}/api/zoom/signature`, {
        method: "POST", headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ meetingNumber: NUMERO }),
      }).then((r) => r.json());
      const comoAnfitriona = await firmar({ Authorization: `Bearer ${reg.token}` });
      check("la anfitriona (sesión + mismo mail que en Zoom) recibe la contraseña real junto con la firma",
        Boolean(comoAnfitriona.signature) && comoAnfitriona.passcode === "482113", JSON.stringify(comoAnfitriona).slice(0, 120));
      const anonimo = await firmar();
      check("sin sesión, sólo la firma (la contraseña no se regala)", Boolean(anonimo.signature) && anonimo.passcode === undefined, JSON.stringify(anonimo).slice(0, 100));
      const otra = await fetch(`${API3}/api/auth/register`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: `otra${Date.now()}@test.com`, password: "melon42Trueno", name: "Otra" }),
      }).then((r) => r.json());
      const comoOtra = await firmar({ Authorization: `Bearer ${otra.token}` });
      check("otra persona con sesión tampoco la recibe", Boolean(comoOtra.signature) && comoOtra.passcode === undefined, JSON.stringify(comoOtra).slice(0, 100));
    }

    console.log("── 1. El webhook: validación de URL y firma ──");
    {
      const v = await webhook("endpoint.url_validation", { plainToken: "reto-123" });
      check("el reto de validación de la URL se contesta con el HMAC del secret token",
        v.status === 200 && v.json.plainToken === "reto-123" && v.json.encryptedToken === crypto.createHmac("sha256", TOKEN_WEBHOOK).update("reto-123").digest("hex"),
        JSON.stringify(v.json));
      const mala = await webhook("meeting.rtms_started", { meeting_uuid: "x", rtms_stream_id: "y", server_urls: `ws://localhost:${PUERTO_RTMS}/senal` }, { firma: "v0=deadbeef" });
      check("un webhook con firma falsa se rechaza (401) y no abre nada", mala.status === 401 && vistos.senal.length === 0, `HTTP ${mala.status}`);
      const vieja = await webhook("meeting.rtms_started", { meeting_uuid: "x", rtms_stream_id: "y", server_urls: `ws://localhost:${PUERTO_RTMS}/senal` }, { ts: String(Math.floor(Date.now() / 1000) - 900) });
      check("un webhook firmado pero de hace 15 minutos se rechaza (anti-replay)", vieja.status === 401, `HTTP ${vieja.status}`);
      const sinConfig = await fetch(`http://localhost:4001/api/zoom/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const cuerpo = await sinConfig.json().catch(() => ({}));
      check("en un servidor SIN las variables, el webhook dice 503 y nombra qué falta", sinConfig.status === 503 && /ZOOM_WEBHOOK_SECRET_TOKEN/.test(cuerpo.error || ""), `HTTP ${sinConfig.status}`);
    }

    console.log("── 2. rtms_started: Zoom transmite y las frases caen en vivo ──");
    // La sala companion, como la abriría alguien con Unify al lado, ANTES.
    const socket = io(API3, { transports: ["websocket"], forceNew: true, reconnection: false });
    const lineasVivo = [];
    const estados = [];
    socket.on("transcript-line", (p) => lineasVivo.push(p.line));
    socket.on("meet-state", (s) => estados.push(s));
    const unido = await new Promise((resolve) => {
      socket.emit("join-companion", { externalKey: `zoom:${NUMERO}`, name: "Testigo Web", language: "es-AR" }, () => resolve(true));
      setTimeout(() => resolve(false), 8000);
    });
    check("un testigo con Unify al lado se une a la sala «zoom:<número>» antes de que Zoom transmita", unido === true, `conectado=${socket.connected}`);

    const UUID = "AbC12/xyz==";
    const STREAM = "stream-uno";
    const inicio = await webhook("meeting.rtms_started", { meeting_uuid: UUID, rtms_stream_id: STREAM, operator_id: "op1", server_urls: `ws://localhost:${PUERTO_RTMS}/senal` });
    check("Zoom recibe 200 al instante", inicio.status === 200 && inicio.json.ok === true, JSON.stringify(inicio.json));

    const listo = await esperar(async () => vistos.listos.includes(STREAM), 15_000);
    check("el servidor hizo el handshake de señalización con la firma HMAC correcta",
      vistos.senal.some((s) => s.stream === STREAM && s.ok), JSON.stringify(vistos.senal.map((s) => [s.stream, s.ok])));
    check("y el de medios pidiendo la TRANSCRIPCIÓN (media_type 8)", vistos.medios.some((s) => s.stream === STREAM && s.ok), JSON.stringify(vistos.medios));
    check("y avisó CLIENT_READY_ACK por la señalización", listo);
    check("se suscribió a los eventos de participantes (entra/sale)", vistos.suscripciones.some((e) => Array.isArray(e) && e.some((x) => x.event_type === 2)), JSON.stringify(vistos.suscripciones));
    await esperar(async () => vistos.keepAlive.senal !== null && vistos.keepAlive.medios !== null, 5_000);
    check("contesta los keep-alive de LOS DOS sockets con el mismo timestamp", vistos.keepAlive.senal === true && vistos.keepAlive.medios === true, JSON.stringify(vistos.keepAlive));

    check("el UUID se tradujo a NÚMERO y anfitriona por la API de Zoom (Server-to-Server)",
      llamadasApi.some((l) => l.startsWith("POST /oauth/token")) && llamadasApi.some((l) => l.startsWith("GET /v2/meetings/")), llamadasApi.join(" | ").slice(0, 160));
    check("el UUID con «/» viaja codificado dos veces (como pide Zoom)", llamadasApi.some((l) => l.includes(encodeURIComponent(encodeURIComponent(UUID)))), llamadasApi.filter((l) => l.startsWith("GET")).join(" | "));

    const llegaron = await esperar(async () => lineasVivo.length >= 2, 15_000);
    check("las frases llegan EN VIVO a la sala «zoom:<número>» (la misma de la web)", llegaron, `recibidas=${lineasVivo.length}`);
    check("con el nombre de QUIEN habló (no un bot)", lineasVivo.some((l) => l.speakerName === "Ana García" && /presupuesto/.test(l.text)) && lineasVivo.some((l) => l.speakerName === "Bruno Pérez"),
      JSON.stringify(lineasVivo.map((l) => [l.speakerName, l.text.slice(0, 30)])));
    const enLlamada = await esperar(async () => estados.some((s) => s.inCall === true), 5_000);
    check("la sala sabe que la reunión está EN CURSO (estado en vivo)", enLlamada, JSON.stringify(estados.slice(-1)));
    const conGente = await esperar(async () => estados.some((s) => Array.isArray(s.participants) && s.participants.includes("Ana García")), 5_000);
    check("y quiénes están (por los eventos de participantes de Zoom)", conGente, JSON.stringify(estados.slice(-1)[0]?.participants));

    const sesion = await fetch(`${API3}/api/meet-bridge/${encodeURIComponent(`zoom:${NUMERO}`)}/session`).then((r) => r.json());
    check("la fase se puede sondear en /session («adentro»)", sesion?.bot?.fase === "adentro", JSON.stringify(sesion?.bot));
    let dueño = null;
    for (let i = 0; i < 12 && !dueño; i++) {
      const { rows } = await pg.query(`SELECT owner_id FROM meetings WHERE id = $1`, [sesion.dbId]);
      dueño = rows[0]?.owner_id || null;
      if (!dueño) await sleep(500);
    }
    check("la reunión queda A NOMBRE de la anfitriona (por su mail de Zoom)", dueño === usuaria?.id, `owner=${String(dueño).slice(0, 8)}… esperado=${String(usuaria?.id).slice(0, 8)}…`);
    await sleep(800);
    const { rows: guardadas } = await pg.query(`SELECT sender_name, text FROM messages WHERE meeting_id = $1 AND kind = 'transcript'`, [sesion.dbId]);
    check("y todo quedó en el historial con cada nombre", guardadas.length >= 2 && guardadas.some((g) => g.sender_name === "Ana García"), `guardadas=${guardadas.length}`);

    const estado = await fetch(`${API3}/api/zoom/rtms/estado`, { headers: { Authorization: `Bearer ${reg.token}` } }).then((r) => r.json());
    check("/api/zoom/rtms/estado (con sesión) muestra la transmisión en curso",
      estado.habilitado === true && Array.isArray(estado.sesiones) && estado.sesiones.some((s) => s.roomKey === `zoom:${NUMERO}` && s.fase === "adentro" && s.lineas >= 2 && /prueba RTMS/.test(s.etiqueta)),
      JSON.stringify(estado.sesiones));
    const sinSesion = await fetch(`${API3}/api/zoom/rtms/estado`);
    check("y sin sesión no se ve (401)", sinSesion.status === 401, `HTTP ${sinSesion.status}`);

    const antes = vistos.senal.length;
    const repetido = await webhook("meeting.rtms_started", { meeting_uuid: UUID, rtms_stream_id: STREAM, server_urls: `ws://localhost:${PUERTO_RTMS}/senal` });
    await sleep(1200);
    check("el mismo webhook repetido (Zoom reintenta) NO abre una segunda conexión", repetido.status === 200 && vistos.senal.length === antes, `handshakes=${vistos.senal.length}`);

    console.log("── 3. rtms_stopped: se cierra prolijo ──");
    const fin = await webhook("meeting.rtms_stopped", { meeting_uuid: UUID, rtms_stream_id: STREAM });
    const cerrada = await esperar(async () => {
      const e = await fetch(`${API3}/api/zoom/rtms/estado`, { headers: { Authorization: `Bearer ${reg.token}` } }).then((r) => r.json());
      return !e.sesiones.some((s) => s.streamId === STREAM);
    }, 8_000);
    check("al terminar, la sesión desaparece del estado", fin.status === 200 && cerrada);
    const fuera = await esperar(async () => estados.some((s) => s.inCall === false), 5_000);
    check("y la sala se entera de que la reunión terminó (inCall false)", fuera);

    console.log("── 4. Zoom rechaza la firma/app: se informa, no se cuelga ──");
    {
      const KEY2 = "zoom:rtms-" + crypto.createHash("sha1").update("uuid-rechazar-2").digest("hex").slice(0, 16);
      // Sin número (la API falsa no lo sabe? sí lo sabe: se usa igual). Para
      // aislar el caso, la API devuelve lo mismo; lo que cambia es Zoom
      // rechazando la señalización.
      await webhook("meeting.rtms_started", { meeting_uuid: "uuid-rechazar-2", rtms_stream_id: "stream-dos", server_urls: `ws://localhost:${PUERTO_RTMS}/senal` });
      const fallo = await esperar(async () => {
        const s = await fetch(`${API3}/api/meet-bridge/${encodeURIComponent(`zoom:${NUMERO}`)}/session`).then((r) => r.json()).catch(() => ({}));
        return s?.bot?.fase === "fallo";
      }, 10_000);
      const s = await fetch(`${API3}/api/meet-bridge/${encodeURIComponent(`zoom:${NUMERO}`)}/session`).then((r) => r.json()).catch(() => ({}));
      check("cuando Zoom rechaza la señalización, la sala muestra el fallo con su motivo", fallo && /rechazó/.test(s?.bot?.detalle || ""), JSON.stringify(s?.bot));
      void KEY2;
    }

    console.log("── 5. Se cae la conexión de medios: reconecta solo ──");
    {
      cerrarMediosUnaVez.add("stream-tres");
      const antes3 = vistos.senal.filter((s) => s.stream === "stream-tres").length;
      await webhook("meeting.rtms_started", { meeting_uuid: "uuid-tres", rtms_stream_id: "stream-tres", server_urls: `ws://localhost:${PUERTO_RTMS}/senal` });
      const volvio = await esperar(async () => vistos.listos.filter((x) => x === "stream-tres").length >= 1 && vistos.senal.filter((s) => s.stream === "stream-tres").length >= antes3 + 2, 20_000);
      check("tras un corte del servidor de medios, vuelve a hacer el handshake y entra", volvio, `handshakes=${vistos.senal.filter((s) => s.stream === "stream-tres").length} listos=${vistos.listos.filter((x) => x === "stream-tres").length}`);
      await webhook("meeting.rtms_stopped", { meeting_uuid: "uuid-tres", rtms_stream_id: "stream-tres" });
    }

    check("el servidor no tiró errores sin manejar", !/Unhandled|TypeError|ReferenceError/.test(logSrv), logSrv.split("\n").filter((l) => /Unhandled|TypeError|ReferenceError/.test(l)).slice(0, 2).join(" | "));
    socket.close();
  } finally {
    // El diario del módulo, para leer QUÉ pasó cuando algo falla.
    console.log("── [rtms] en el servidor ──");
    for (const l of logSrv.split("\n").filter((l) => /\[rtms\]/.test(l)).slice(0, 40)) console.log("  " + l.slice(0, 160));
    try { process.kill(-srv.pid, "SIGTERM"); } catch { try { srv.kill("SIGTERM"); } catch {} }
    await pg.end().catch(() => {});
    rtms.close(); zoomApi.close();
  }

  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} OK`);
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exit(1); });
