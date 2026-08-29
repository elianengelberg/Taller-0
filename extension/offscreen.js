// Documento offscreen: acá ocurre la grabación real.
//
// En Manifest V3 el service worker no tiene acceso a MediaRecorder ni a
// AudioContext, así que la extensión abre este documento invisible para grabar.
//
// Lo importante: la captura de pestaña trae el audio de TODOS los participantes
// (es lo que la pestaña reproduce) pero NO tu micrófono, porque tu propia voz
// nunca se reproduce en tu pestaña. Por eso mezclamos las dos fuentes: la
// pestaña + tu micrófono. Resultado: la reunión completa, con todas las voces.
//
// Detalle que arruina la experiencia si se olvida: al capturar una pestaña, el
// navegador la silencia para vos. Por eso volvemos a reproducir el audio
// capturado hacia los parlantes -- si no, quien graba deja de escuchar la
// reunión.

let recorder = null;
let chunks = [];
let ctx = null;
let tracks = [];
let startedAt = 0;
let target = { dbId: null, serverBase: "", token: null, roomKey: null };
let vozDePestana = null;

function cleanup() {
  try { vozDePestana?.stop(); } catch { /* ya parada */ }
  vozDePestana = null;
  tracks.forEach((t) => {
    try { t.stop(); } catch { /* ya detenido */ }
  });
  tracks = [];
  try { ctx?.close(); } catch { /* noop */ }
  ctx = null;
  recorder = null;
}

function pickMime() {
  // VP8 PRIMERO, a propósito: VP9 comprime mejor pero codificar VP9 en vivo
  // come CPU que la compu no tiene de sobra mientras corre la reunión -- el
  // resultado eran videos a los saltos (mismo diagnóstico que ya se corrigió
  // en el bot). VP8 en tiempo real es liviano y se ve parejo.
  const candidates = [
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm",
  ];
  for (const m of candidates) if (MediaRecorder.isTypeSupported(m)) return m;
  return "video/webm";
}

async function start({ streamId, dbId, serverBase, token, roomKey }) {
  target = { dbId, serverBase: String(serverBase || "").replace(/\/+$/, ""), token: token || null, roomKey: roomKey || null };

  // Audio + video de la pestaña de Meet.
  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        // Techo de captura: una pestaña en un monitor retina entrega 4K y el
        // codificador se ahoga (video trabado). 1080p a 30 es lo que un vivo
        // aguanta parejo.
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30,
      },
    },
  });
  // La reunión es GENTE moviéndose, no texto quieto: "motion" le dice al
  // codificador que gaste sus bits en fluidez.
  const pistaVideo = tabStream.getVideoTracks()[0];
  if (pistaVideo) pistaVideo.contentHint = "motion";

  // Tu micrófono (best-effort: si no hay permiso, se graba igual la reunión).
  let micStream = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    /* sin micrófono: queda la voz de los demás, que es lo que más importa */
  }

  ctx = new AudioContext();
  const mixed = ctx.createMediaStreamDestination();
  // Cada fuente entra con algo de margen para que la suma no sature cuando
  // hablan varios a la vez; un limitador corta los picos.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.2;
  limiter.connect(mixed);

  const addAudio = (stream, gainValue) => {
    if (!stream || stream.getAudioTracks().length === 0) return;
    const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const g = ctx.createGain();
    g.gain.value = gainValue;
    src.connect(g).connect(limiter);
  };
  addAudio(tabStream, 0.85);
  addAudio(micStream, 0.85);

  // Devolver el audio de la pestaña a los parlantes: al capturarla, el
  // navegador la silencia y quien graba se quedaría sin escuchar la reunión.
  const playback = ctx.createMediaStreamSource(new MediaStream(tabStream.getAudioTracks()));
  playback.connect(ctx.destination);

  const combined = new MediaStream([
    ...tabStream.getVideoTracks(),
    ...mixed.stream.getAudioTracks(),
  ]);
  tracks = [...tabStream.getTracks(), ...(micStream?.getTracks() ?? [])];

  const mimeType = pickMime();
  // 3,5 Mb/s de video (1080p VP8 parejo sin ahogar la CPU) + 192 kb/s de
  // audio opus, que para voces es transparente. Con 5 Mb/s en VP9 el
  // codificador no llegaba y el video salía a los saltos.
  recorder = new MediaRecorder(combined, {
    mimeType,
    videoBitsPerSecond: 3_500_000,
    audioBitsPerSecond: 192_000,
  });
  chunks = [];
  recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
  recorder.onstop = () => void finish(mimeType.split(";")[0]);
  recorder.onerror = () => {
    cleanup();
    chrome.runtime.sendMessage({ kind: "offscreen-finished", ok: false, error: "Se cortó la grabación." });
  };

  // Si el usuario termina la llamada o cierra la pestaña, la pista de video se
  // corta sola: cerramos la grabación en vez de quedar colgados.
  tabStream.getVideoTracks()[0]?.addEventListener("ended", () => stop());

  startedAt = Date.now();
  recorder.start(1000);

  // La grabación de una reunión externa además TRANSCRIBE lo que la pestaña
  // reproduce (todas las voces, un video compartido): la pista de audio de la
  // captura entra al reconocimiento de voz (Chrome 139+ acepta una pista como
  // entrada) y las líneas van al bridge de esa sala. Best-effort: si el
  // navegador no lo soporta, la grabación sigue igual.
  if (target.roomKey) empezarVozDePestana(tabStream.getAudioTracks()[0] ?? null);
}

function empezarVozDePestana(track) {
  const Ctor = self.SpeechRecognition || self.webkitSpeechRecognition;
  // start(pista) llegó con available() (Chrome 139): sin eso, un Chrome viejo
  // ignoraría el argumento y transcribiría el micrófono del documento.
  if (!track || !Ctor || typeof Ctor.available !== "function") return;
  let activa = true;
  let fallas = 0;
  const r = new Ctor();
  r.lang = navigator.language || "es-AR";
  r.continuous = true;
  r.interimResults = false;
  r.maxAlternatives = 3;
  r.onresult = (ev) => {
    fallas = 0;
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      if (!res.isFinal) continue;
      const alts = [];
      for (let j = 0; j < res.length && j < 3; j++) {
        const t = res[j]?.transcript?.trim();
        if (t) alts.push(t);
      }
      if (alts.length) void publicarLineaDePestana(alts[0], alts.slice(1));
    }
  };
  r.onerror = (ev) => {
    if (ev.error !== "no-speech" && ev.error !== "aborted") fallas += 1;
  };
  r.onend = () => {
    if (!activa || fallas >= 8 || track.readyState !== "live") return;
    setTimeout(() => {
      if (activa) { try { r.start(track); } catch { /* ya arrancando */ } }
    }, fallas ? 1000 : 0);
  };
  try { r.start(track); } catch { return; }
  vozDePestana = { stop() { activa = false; try { r.stop(); } catch { /* noop */ } } };
}

async function publicarLineaDePestana(texto, alts) {
  try {
    await fetch(`${target.serverBase}/api/meet-bridge/${encodeURIComponent(target.roomKey)}/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speaker: "Voces de la reunión", text: texto, lang: navigator.language || "es-AR", alts }),
    });
  } catch { /* sin red: la próxima línea reintenta sola */ }
}

function stop() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
  else chrome.runtime.sendMessage({ kind: "offscreen-finished", ok: true });
}

async function finish(contentType) {
  const durationMs = Date.now() - startedAt;
  const blob = new Blob(chunks, { type: contentType });
  chunks = [];
  cleanup();

  if (blob.size < 20_000) {
    chrome.runtime.sendMessage({
      kind: "offscreen-finished",
      ok: false,
      error: "La grabación quedó vacía. Probá de nuevo.",
    });
    return;
  }
  if (!target.dbId) {
    chrome.runtime.sendMessage({
      kind: "offscreen-finished",
      ok: false,
      error: "No pudimos vincular la grabación con la reunión de Unify.",
    });
    return;
  }

  try {
    // Subida a través del servidor de Unify: la extensión tiene permiso para
    // este origen, así que no hay problemas de CORS ni hace falta firmar nada.
    const res = await fetch(
      `${target.serverBase}/api/meetings/${target.dbId}/recording-upload?durationMs=${Math.round(durationMs)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": contentType,
          ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}),
        },
        body: blob,
      }
    );
    if (!res.ok) throw new Error(String(res.status));
    chrome.runtime.sendMessage({ kind: "offscreen-finished", ok: true });
  } catch {
    chrome.runtime.sendMessage({
      kind: "offscreen-finished",
      ok: false,
      error: "Grabamos la reunión pero no pudimos subirla. Revisá tu conexión.",
    });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;
  if (msg.kind === "start") {
    start(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        cleanup();
        sendResponse({ ok: false, error: String(e?.message || e) });
      });
    return true;
  }
  if (msg.kind === "stop") {
    stop();
    sendResponse({ ok: true });
    return true;
  }
  return false;
});
