// Service worker de Unify para Google Meet.
//
// Su trabajo principal es la GRABACIÓN. La versión anterior dependía de
// "compartir pantalla": el usuario tenía que elegir la pestaña correcta y
// acordarse de tildar "compartir audio" -- y si se equivocaba, el video salía
// mudo o mostraba la interfaz de Unify en vez de la reunión.
//
// Acá usamos la captura de pestaña de la extensión: tomamos el audio y el video
// de la pestaña de Meet tal cual suenan y se ven, con TODOS los participantes,
// sin pedirle nada al usuario. En Manifest V3 el service worker no puede usar
// MediaRecorder, así que la grabación real ocurre en un documento "offscreen"
// que este archivo crea y controla.

const OFFSCREEN = "offscreen.html";
let recordingTabId = null;

async function hasOffscreen() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return ctxs.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN,
    reasons: ["USER_MEDIA"],
    justification: "Grabar el audio y el video de la reunión de Google Meet.",
  });
}

function notify(tabId, msg) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

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
  chrome.action.setBadgeText({ text: "REC" });
  chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
}

async function stopRecording() {
  if (await hasOffscreen()) {
    await chrome.runtime.sendMessage({ target: "offscreen", kind: "stop" }).catch(() => {});
  }
  chrome.action.setBadgeText({ text: "" });
}

// Datos de la reunión que el panel comparte, para poder grabar desde el popup o
// el atajo de teclado sin volver a pedírselos a la pestaña.
const lastMeet = new Map(); // tabId -> { dbId, serverBase, token }

// Chrome exige que la extensión haya sido "invocada" (ícono de la barra, atajo
// o menú contextual) antes de dejar capturar la pestaña: un clic dentro de la
// página no alcanza. Por eso hay tres caminos y todos terminan acá.
async function toggleForTab(tabId) {
  if (recordingTabId === tabId) {
    await stopRecording();
    return { ok: true, recording: false };
  }
  const payload = lastMeet.get(tabId);
  if (!payload?.dbId) return { ok: false, error: "Abrí el panel de Unify en la reunión y probá de nuevo." };
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // El panel nos deja los datos de la reunión apenas se abre.
  if (msg?.kind === "unify-meet-info" && sender.tab?.id != null) {
    lastMeet.set(sender.tab.id, {
      dbId: msg.dbId,
      serverBase: msg.serverBase,
      token: msg.token ?? null,
    });
    sendResponse?.({ ok: true });
    return true;
  }

  // El popup pregunta qué mostrar (y sobre qué pestaña actuar).
  if (msg?.kind === "unify-popup-state") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      sendResponse({
        tabId: tab?.id ?? null,
        isMeet: Boolean(tab?.url?.startsWith("https://meet.google.com/")),
        ready: Boolean(tab?.id != null && lastMeet.get(tab.id)?.dbId),
        recording: tab?.id != null && recordingTabId === tab.id,
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
    chrome.action.setBadgeText({ text: "" });
    notify(recordingTabId, { kind: "unify-record-state", recording: false });
    if (!msg.ok) {
      notify(recordingTabId, {
        kind: "unify-record-error",
        message: msg.error || "No pudimos guardar la grabación.",
      });
    }
    recordingTabId = null;
    void chrome.offscreen.closeDocument().catch(() => {});
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
  if (tabId === recordingTabId) void stopRecording();
});
