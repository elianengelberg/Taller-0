// Puente mínimo del grabador oculto: la página sólo puede mandar trozos de
// video y avisos a main, y enterarse de "parar". Nada de Node del otro lado.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("grabadorPuente", {
  chunk(buf) {
    ipcRenderer.send("grabador:chunk", new Uint8Array(buf));
  },
  listo(info) {
    ipcRenderer.send("grabador:listo", info);
  },
  fin(r) {
    ipcRenderer.send("grabador:fin", r);
  },
  alParar(cb) {
    ipcRenderer.on("grabador:parar", () => cb());
  },
});
