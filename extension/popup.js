// Popup del ícono. Además de mostrar el estado, es el camino confiable para
// grabar: Chrome solo habilita la captura de pestaña cuando la extensión fue
// "invocada" desde la barra del navegador, y abrir este popup cuenta como tal.
// (Dentro de la reunión también está el atajo Ctrl+Shift+U, que sirve igual.)

const DEFAULT_SERVER = "https://taller-0.onrender.com";
const DEFAULT_APP = "https://www.unify-meet.com";
// La ficha publicada: instalada desde ahí, Chrome la actualiza sola para
// siempre. Es el destino del único aviso de versión que sigue existiendo.
const TIENDA_ID = "elnehilolmbolklgagfegbkibmdjgpbb";
const TIENDA = `https://chromewebstore.google.com/detail/${TIENDA_ID}`;

const dot = document.getElementById("dot");
const status = document.getElementById("status");
const login = document.getElementById("login");
const server = document.getElementById("server");
const rec = document.getElementById("rec");
const recTip = document.getElementById("recTip");

let tabId = null;

chrome.storage.local.get(
  { serverBase: DEFAULT_SERVER, appBase: DEFAULT_APP, token: null, updateAvailable: null },
  (v) => {
    server.value = v.serverBase || DEFAULT_SERVER;
    const appBase = (v.appBase || DEFAULT_APP).replace(/\/+$/, "");
    login.href = `${appBase}/ingresar`;
    if (v.token) {
      dot.className = "dot ok";
      status.textContent = "Sesión conectada. La IA está lista.";
      login.textContent = "Abrir Unify";
    } else {
      dot.className = "dot warn";
      status.textContent = "Sin sesión: transcripción y grabación andan igual; la IA necesita cuenta.";
    }
    // Aviso de versión nueva (lo deja el background al comparar contra
    // unify-meet.com). Va SÓLO para quien instaló por ZIP: desde la tienda,
    // Chrome actualiza solo y no hay nada que pedirle a nadie. Y el aviso no
    // lleva a bajar otro ZIP -- eso sería instalar versiones a mano de nuevo,
    // que es el problema: lleva a la tienda, una vez, y nunca más.
    const deLaTienda = chrome.runtime.id === TIENDA_ID;
    if (!deLaTienda && v.updateAvailable && v.updateAvailable !== chrome.runtime.getManifest().version) {
      const nota = document.createElement("a");
      nota.className = "btn";
      nota.id = "update";
      nota.target = "_blank";
      nota.rel = "noreferrer";
      nota.href = TIENDA;
      nota.style.background = "#6366f1";
      nota.textContent = `Versión nueva (${v.updateAvailable}): instalala de la tienda y se actualiza sola`;
      document.querySelector("main")?.prepend(nota);
    }
  }
);

function paintRecording(on) {
  rec.classList.toggle("is-rec", on);
  rec.textContent = on ? "⏹ Detener la grabación" : "⏺ Grabar la reunión";
}

chrome.runtime.sendMessage({ kind: "unify-popup-state" }, (s) => {
  // El botón aparece en Meet (panel profundo) y también en las reuniones
  // externas que detectó prompt-injector.js: abrir este popup cuenta como
  // invocación, así que desde acá la captura de pestaña queda habilitada.
  if (!s?.isMeet && !s?.isExternal) return;
  tabId = s.tabId;
  rec.hidden = false;
  recTip.hidden = false;
  paintRecording(Boolean(s.recording));
  if (!s.ready && !s.recording) {
    rec.disabled = true;
    rec.style.opacity = "0.55";
    rec.title = s.isMeet
      ? "Esperá a que cargue el panel de Unify en la reunión."
      : "Entrá a la reunión y esperá un segundo a que Unify la detecte.";
  }
});

rec.addEventListener("click", () => {
  if (tabId == null) return;
  rec.disabled = true;
  chrome.runtime.sendMessage({ kind: "unify-popup-toggle", tabId }, (r) => {
    rec.disabled = false;
    if (r?.ok) {
      paintRecording(Boolean(r.recording));
      if (r.recording) window.close();
    } else {
      status.textContent = r?.error || "No pudimos grabar en este momento.";
      dot.className = "dot warn";
    }
  });
});

server.addEventListener("change", () => {
  const value = server.value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) {
    server.value = DEFAULT_SERVER;
    return;
  }
  chrome.storage.local.set({ serverBase: value });
});
