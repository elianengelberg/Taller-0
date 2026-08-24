// Service worker de Unify.
//
// Hay DOS maneras de grabar una reunión, según cómo llegó el permiso:
//
//   CARRIL A -- captura de pestaña (tabCapture). Chrome exige que la extensión
//   haya sido INVOCADA (ícono de la barra, atajo o menú contextual): un clic
//   dentro de la página NO alcanza, Chrome lo define así y no hay forma de
//   rodearlo. A cambio: cero selector, audio de pestaña garantizado, y la
//   grabación vive en el documento offscreen (en Manifest V3 este service
//   worker no puede usar MediaRecorder), que sobrevive a lo que le pase a la
//   página. Es el camino de siempre en Meet, y ahora también en las pestañas
//   externas detectadas por prompt-injector.js.
//
//   CARRIL B -- getDisplayMedia desde el content script. El clic en el toast
//   de la página sí lo habilita (activación de usuario en la página). El
//   MediaRecorder corre en la página, así que los chunks viajan hasta acá
//   apenas existen: lo ya enviado se salva aunque la pestaña muera. El Port
//   abierto además mantiene despierto este service worker (Chrome >= 116
//   reinicia el reloj de inactividad con cada mensaje).
//
// Los dos carriles terminan igual: pedirle al bridge el dbId de la reunión
// companion -- con la MISMA clave de sala que deriva la web, así el overlay y
// el companion web caen en la misma sala -- y subir el video al endpoint de
// grabaciones que ya usa la web como respaldo.

const OFFSCREEN = "offscreen.html";
const DEFAULT_SERVER = "https://taller-0.onrender.com";
const DEFAULT_APP = "https://www.unify-meet.com";
// La ficha publicada en la Chrome Web Store. Instalada desde ahí, Chrome
// actualiza la extensión solo; instalada por ZIP no hay tienda detrás y las
// versiones nuevas habría que ponerlas a mano -- que es justo lo que no
// queremos. De ese lado el aviso lleva a la tienda, una vez, y listo.
const TIENDA_ID = "elnehilolmbolklgagfegbkibmdjgpbb";
const DE_LA_TIENDA = chrome.runtime.id === TIENDA_ID;
let recordingTabId = null;

const lastMeet = new Map(); // tabId -> { dbId, serverBase, token }  (Meet, como siempre)
const lastExternal = new Map(); // tabId -> { roomKey, plataforma, url }  (Zoom/Teams/Jitsi/Webex)

async function config() {
  const v = await chrome.storage.local.get({ serverBase: DEFAULT_SERVER, token: null });
  const serverBase = String(v.serverBase || DEFAULT_SERVER).replace(/\/+$/, "");
  return { serverBase: /^https?:\/\//.test(serverBase) ? serverBase : DEFAULT_SERVER, token: v.token ?? null };
}

async function hasOffscreen() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return ctxs.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN,
    reasons: ["USER_MEDIA"],
    justification: "Grabar el audio y el video de la pestaña de la reunión.",
  });
}

function notify(tabId, msg) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

// El badge cuenta dos historias que no pueden pisarse: REC (rojo) mientras se
// graba, y ↑ (violeta) cuando hay una versión nueva de la extensión esperando
// en unify-meet.com. Grabar gana; al terminar, el aviso de versión vuelve.
let hayVersionNueva = false;
function badge(on) {
  if (on) {
    chrome.action.setBadgeText({ text: "REC" });
    chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    return;
  }
  chrome.action.setBadgeText({ text: hayVersionNueva ? "↑" : "" });
  if (hayVersionNueva) chrome.action.setBadgeBackgroundColor({ color: "#6366f1" });
}

// --- Actualización de la extensión --------------------------------------------
// La web publica dist/version-extension.json en cada deploy (lo escribe
// pack-extension.mjs junto al ZIP). Compararlo con el manifest local avisa
// "hay una versión nueva" sin pedir ni un permiso más: unify-meet.com ya es
// nuestro origen. La Web Store actualiza sola; esto cubre a quien instaló por
// ZIP/instalador, que no tiene otra campana.
function esMasNueva(remota, local) {
  const a = String(remota).split(".").map((n) => parseInt(n, 10));
  const b = String(local).split(".").map((n) => parseInt(n, 10));
  if (a.some((n) => Number.isNaN(n)) || a.length === 0) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

const CADA_CUANTO_MS = 6 * 60 * 60 * 1000; // 6 horas: sobra para un aviso
async function checkVersion() {
  try {
    const v = await chrome.storage.local.get({ appBase: DEFAULT_APP, lastVersionCheck: 0, updateAvailable: null });
    // El badge ↑ es un pedido de acción manual: sólo tiene sentido donde la
    // actualización NO puede ser automática (instalación por ZIP).
    hayVersionNueva = Boolean(v.updateAvailable && !DE_LA_TIENDA && esMasNueva(v.updateAvailable, chrome.runtime.getManifest().version));
    if (recordingTabId == null) badge(false); // re-pintar tras el arranque del SW
    if (Date.now() - Number(v.lastVersionCheck || 0) < CADA_CUANTO_MS) return;
    await chrome.storage.local.set({ lastVersionCheck: Date.now() });
    const appBase = String(v.appBase || DEFAULT_APP).replace(/\/+$/, "");
    const res = await fetch(`${appBase}/version-extension.json`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const remota = typeof data?.version === "string" ? data.version : "";
    const atrasada = esMasNueva(remota, chrome.runtime.getManifest().version);
    hayVersionNueva = atrasada && !DE_LA_TIENDA;
    await chrome.storage.local.set({ updateAvailable: atrasada ? remota : null });
    if (recordingTabId == null) badge(false); // pinta ↑ o lo borra
    // Desde la tienda no hay nada que pedirle a la persona: se le pide a
    // Chrome, que si no lo empujan mira si hay versión nueva cada varias horas.
    if (atrasada && DE_LA_TIENDA) void pedirActualizacionYa();
  } catch { /* sin red: el próximo arranque reintenta */ }
}
void checkVersion();

// --- La extensión se pone al día sola -----------------------------------------
// Chrome baja la versión nueva de la tienda por su cuenta, pero la APLICA
// recién cuando la extensión queda quieta o se reinicia el navegador, y hay
// gente que no lo reinicia en semanas. Estas tres piezas cierran el círculo:
// pedirla ahora, y aplicarla apenas haya un momento tranquilo.
//
// "Tranquilo" es literal: recargar la extensión deja HUÉRFANOS a los content
// scripts de las pestañas abiertas (el overlay se congelaría hasta recargar
// la página), así que con una grabación o una reunión abierta no se toca nada
// -- Chrome la aplicará igual cuando este service worker se duerma.
let updatePendiente = false;

async function pedirActualizacionYa() {
  try {
    await chrome.runtime.requestUpdateCheck();
  } catch {
    /* instalación por ZIP: no hay tienda detrás, y el badge ↑ ya avisa */
  }
}

function hayReunionEnCurso() {
  return recordingTabId != null || lastMeet.size > 0 || lastExternal.size > 0;
}

function aplicarUpdateSiSePuede() {
  if (!updatePendiente || hayReunionEnCurso()) return;
  updatePendiente = false;
  chrome.runtime.reload(); // vuelve sola, ya con la versión nueva
}

chrome.runtime.onUpdateAvailable.addListener(() => {
  updatePendiente = true;
  aplicarUpdateSiSePuede();
});

// La reunión companion que respalda esa clave de sala. El bridge la crea si
// no existe, con la MISMA clave que derivaría la web: de ahí sale que las
// superficies se encuentren en una sola sala en vez de fabricar islas.
async function sesionDeSala(roomKey) {
  const { serverBase } = await config();
  const res = await fetch(`${serverBase}/api/meet-bridge/${encodeURIComponent(roomKey)}/session`);
  if (!res.ok) throw new Error("El bridge no reconoció esta sala.");
  const s = await res.json();
  if (!s?.dbId) throw new Error("La sala no tiene reunión de respaldo.");
  return s;
}

// --- CARRIL A: tabCapture tras una invocación real ---------------------------

async function startRecording(tabId, payload) {
  // Id de captura de ESTA pestaña: lo que se grabe es exactamente lo que la
  // pestaña reproduce (todas las voces y el video de la reunión).
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: "offscreen",
    kind: "start",
    streamId,
    dbId: payload.dbId,
    serverBase: payload.serverBase,
    token: payload.token ?? null,
  });
  if (!res?.ok) throw new Error(res?.error || "No se pudo iniciar la grabación.");
  recordingTabId = tabId;
  badge(true);
}

async function stopRecording() {
  if (await hasOffscreen()) {
    await chrome.runtime.sendMessage({ target: "offscreen", kind: "stop" }).catch(() => {});
  }
  badge(false);
}

// Un solo toggle para las tres puertas de invocación (atajo, popup, ícono),
// que ahora también entiende pestañas externas, no sólo Meet.
async function toggleForTab(tabId) {
  if (recordingTabId === tabId) {
    await stopRecording();
    return { ok: true, recording: false };
  }
  let payload = lastMeet.get(tabId);
  if (!payload?.dbId) {
    const ext = lastExternal.get(tabId);
    if (ext?.roomKey) {
      const s = await sesionDeSala(ext.roomKey);
      const { serverBase, token } = await config();
      payload = { dbId: s.dbId, serverBase, token };
    }
  }
  if (!payload?.dbId) return { ok: false, error: "Abrí una reunión y probá de nuevo." };
  await startRecording(tabId, payload);
  notify(tabId, { kind: "unify-record-state", recording: true });
  return { ok: true, recording: true };
}

// Atajo de teclado: cuenta como invocación, así que la captura queda habilitada.
chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== "toggle-recording") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await toggleForTab(tab.id);
  } catch {
    notify(tab.id, { kind: "unify-record-error", message: "No pudimos empezar a grabar." });
  }
});

// --- CARRIL B: recibir la grabación que corre en la página --------------------

chrome.runtime.onConnect.addListener((puerto) => {
  if (puerto.name !== "unify-ext-rec") return;
  const tabId = puerto.sender?.tab?.id ?? null;
  let chunks = [];
  let bytes = 0;
  let roomKey = null;
  let empezoEn = 0;
  let finalizado = false; // "fin" + tope + onDisconnect pueden solaparse: una sola subida
  // Tope de memoria: una reunión de horas en alta calidad no puede vivir en la
  // RAM del service worker. 700 MB ~ 25 minutos a 3,5 Mb/s; pasado eso se
  // corta la grabación con aviso, en vez de tumbar el proceso sin explicación.
  const MAX_BYTES = 700 * 1024 * 1024;

  puerto.onMessage.addListener(async (msg) => {
    if (msg?.kind === "inicio") {
      roomKey = String(msg.roomKey ?? "");
      chunks = [];
      bytes = 0;
      empezoEn = Date.now();
      badge(true);
      return;
    }
    if (msg?.kind === "chunk" && typeof msg.b64 === "string") {
      // Los Ports serializan JSON, así que el chunk llega en base64 (ver
      // prompt-injector.js). Acá vuelve a bytes de una, para no acumular
      // strings gigantes.
      const bin = atob(msg.b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      chunks.push(arr);
      bytes += arr.byteLength;
      if (bytes > MAX_BYTES) {
        puerto.postMessage({
          kind: "subida-error",
          message: "La grabación superó el tamaño máximo y se cortó acá. Lo grabado hasta ahora se está subiendo.",
        });
        try { puerto.postMessage({ kind: "cortar" }); } catch { /* página cerrada */ }
        void finalizarCarrilB();
      }
      return;
    }
    if (msg?.kind === "fin") {
      void finalizarCarrilB();
    }
  });

  async function finalizarCarrilB() {
    if (finalizado) return;
    finalizado = true;
    badge(false);
    const durationMs = empezoEn ? Date.now() - empezoEn : 0;
    const cuerpo = new Blob(chunks, { type: "video/webm" });
    chunks = [];
    bytes = 0;
    if (!roomKey || cuerpo.size < 20_000) return; // nada real que subir
    try {
      const { serverBase, token } = await config();
      const { dbId } = await sesionDeSala(roomKey);
      // Mismo endpoint de respaldo que usa la web cuando el PUT directo a R2
      // falla: el servidor lo pasa al bucket y lo cuelga del historial.
      const res = await fetch(
        `${serverBase}/api/meetings/${dbId}/recording-upload?durationMs=${Math.round(durationMs)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "video/webm",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: cuerpo,
        }
      );
      if (!res.ok) throw new Error(String(res.status));
      puerto.postMessage({ kind: "subida-ok" });
    } catch {
      try {
        puerto.postMessage({
          kind: "subida-error",
          message: "Grabamos la reunión pero no pudimos subirla. Revisá tu conexión.",
        });
      } catch { /* la página ya no está */ }
    }
  }

  puerto.onDisconnect.addListener(() => {
    // La página murió con la grabación abierta: subir lo que alcanzó a llegar
    // es mejor que perderlo todo (es el motivo por el que los chunks viajan
    // apenas existen).
    if (chunks.length > 0) void finalizarCarrilB();
    if (tabId != null && recordingTabId !== tabId) badge(false);
  });
});

// --- Mensajería general --------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // El panel de Meet nos deja los datos de la reunión apenas se abre.
  if (msg?.kind === "unify-meet-info" && sender.tab?.id != null) {
    lastMeet.set(sender.tab.id, {
      dbId: msg.dbId,
      serverBase: msg.serverBase,
      token: msg.token ?? null,
    });
    void checkVersion(); // momento en que la extensión SE USA (throttle adentro)
    sendResponse?.({ ok: true });
    return true;
  }

  // El injector detectó una reunión externa: guardar la sala para que el
  // carril A (Ctrl+Shift+U / ícono) sepa qué capturar sin volver a preguntar.
  if (msg?.kind === "unify-external-info" && sender.tab?.id != null) {
    lastExternal.set(sender.tab.id, {
      roomKey: msg.roomKey,
      plataforma: msg.plataforma,
      url: msg.url,
    });
    void checkVersion(); // idem: el throttle de 6 h evita el ruido
    sendResponse?.({ ok: true });
    return true;
  }

  // El popup pregunta qué mostrar (y sobre qué pestaña actuar).
  if (msg?.kind === "unify-popup-state") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      const id = tab?.id ?? null;
      sendResponse({
        tabId: id,
        isMeet: Boolean(tab?.url?.startsWith("https://meet.google.com/")),
        isExternal: Boolean(id != null && lastExternal.get(id)),
        ready: Boolean(id != null && (lastMeet.get(id)?.dbId || lastExternal.get(id)?.roomKey)),
        recording: id != null && recordingTabId === id,
      });
    });
    return true;
  }

  // Grabar desde el popup: el clic en el ícono ya cuenta como invocación.
  if (msg?.kind === "unify-popup-toggle") {
    toggleForTab(msg.tabId)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  // Mensajes del panel dentro de Meet.
  if (msg?.kind === "unify-record-start") {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: "No pudimos identificar la pestaña de la reunión." });
      return true;
    }
    lastMeet.set(tabId, { dbId: msg.dbId, serverBase: msg.serverBase, token: msg.token ?? null });
    startRecording(tabId, msg)
      .then(() => sendResponse({ ok: true }))
      .catch((e) =>
        sendResponse({
          ok: false,
          needsInvoke: /gesture|activeTab|invoked|not been invoked/i.test(String(e?.message)),
          error: /gesture|activeTab|invoked|not been invoked/i.test(String(e?.message))
            ? "Chrome pide una acción desde la barra para grabar. Apretá Ctrl+Shift+U (⌘⇧U en Mac) o tocá el ícono de Unify y después Grabar."
            : "No pudimos empezar a grabar la reunión. Probá de nuevo.",
        })
      );
    return true; // respuesta asíncrona
  }

  if (msg?.kind === "unify-record-stop") {
    void stopRecording();
    sendResponse?.({ ok: true });
    return true;
  }

  // Avisos que sube el documento offscreen.
  if (msg?.kind === "offscreen-finished") {
    badge(false);
    notify(recordingTabId, { kind: "unify-record-state", recording: false });
    if (!msg.ok) {
      notify(recordingTabId, {
        kind: "unify-record-error",
        message: msg.error || "No pudimos guardar la grabación.",
      });
    }
    recordingTabId = null;
    void chrome.offscreen.closeDocument().catch(() => {});
    aplicarUpdateSiSePuede(); // se terminó de grabar: momento tranquilo
  }

  // El token de Unify que sincroniza el content script de la web.
  if (msg?.kind === "unify-token") {
    chrome.storage.local.set({ token: msg.token ?? null });
  }
  return false;
});

// Si se cierra la pestaña que se está grabando, cerrar la grabación con prolijidad.
chrome.tabs.onRemoved.addListener((tabId) => {
  lastMeet.delete(tabId);
  lastExternal.delete(tabId);
  if (tabId === recordingTabId) void stopRecording();
  aplicarUpdateSiSePuede(); // se cerró la reunión: momento tranquilo
});
