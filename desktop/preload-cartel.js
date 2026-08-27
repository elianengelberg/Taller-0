// Puente mínimo del cartel: la página sólo puede decir "sí" o "no".
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("unifyCartel", {
  responder(valor) {
    ipcRenderer.send("cartel:respuesta", valor === "si" ? "si" : "no");
  },
});
