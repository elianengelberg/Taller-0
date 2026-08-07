// Popup del ícono: estado de la sesión y ajuste del servidor. Deliberadamente
// mínimo -- todo lo que se usa durante una reunión vive en el panel dentro de
// Meet, no acá.

const DEFAULT_SERVER = "https://taller-0.onrender.com";
const DEFAULT_APP = "https://www.unify-meet.com";

const dot = document.getElementById("dot");
const status = document.getElementById("status");
const login = document.getElementById("login");
const server = document.getElementById("server");

chrome.storage.local.get(
  { serverBase: DEFAULT_SERVER, appBase: DEFAULT_APP, token: null },
  (v) => {
    server.value = v.serverBase || DEFAULT_SERVER;
    login.href = `${(v.appBase || DEFAULT_APP).replace(/\/+$/, "")}/ingresar`;
    if (v.token) {
      dot.className = "dot ok";
      status.textContent = "Sesión de Unify conectada. La IA está lista.";
      login.textContent = "Abrir Unify";
    } else {
      dot.className = "dot warn";
      status.textContent = "Sin sesión: la transcripción y la grabación andan igual; la IA necesita cuenta.";
    }
  }
);

server.addEventListener("change", () => {
  const value = server.value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) {
    server.value = DEFAULT_SERVER;
    return;
  }
  chrome.storage.local.set({ serverBase: value });
});
