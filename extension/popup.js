// Popup del ícono. Además de mostrar el estado, es el camino confiable para
// grabar: Chrome solo habilita la captura de pestaña cuando la extensión fue
// "invocada" desde la barra del navegador, y abrir este popup cuenta como tal.
// (Dentro de la reunión también está el atajo Ctrl+Shift+U, que sirve igual.)

const DEFAULT_SERVER = "https://taller-0.onrender.com";
const DEFAULT_APP = "https://www.unify-meet.com";

const dot = document.getElementById("dot");
const status = document.getElementById("status");
const login = document.getElementById("login");
const server = document.getElementById("server");
const rec = document.getElementById("rec");
const recTip = document.getElementById("recTip");

let tabId = null;

chrome.storage.local.get({ serverBase: DEFAULT_SERVER, appBase: DEFAULT_APP, token: null }, (v) => {
  server.value = v.serverBase || DEFAULT_SERVER;
  login.href = `${(v.appBase || DEFAULT_APP).replace(/\/+$/, "")}/ingresar`;
  if (v.token) {
    dot.className = "dot ok";
    status.textContent = "Sesión conectada. La IA está lista.";
    login.textContent = "Abrir Unify";
  } else {
    dot.className = "dot warn";
    status.textContent = "Sin sesión: transcripción y grabación andan igual; la IA necesita cuenta.";
  }
});

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
