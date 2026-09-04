// LA COPIA QUE VIENE DE LA MICROSOFT STORE. Electron marca process.windowsStore
// cuando la app corre desde un paquete AppX/MSIX; UNIFY_TIENDA=1 lo finge en
// las pruebas. En esa copia cambian tres cosas y todas se deciden acá, con
// funciones puras que se prueban sin Electron:
//
//  1. Las ACTUALIZACIONES las trae la tienda: electron-updater no puede (ni
//     debe) tocar una instalación de la tienda. El menú ofrece la ficha.
//  2. El ARRANQUE CON WINDOWS lo declara el manifiesto (una StartupTask,
//     ver build/appx-extensiones.xml), no la clave Run del registro: dentro
//     del paquete esa clave está virtualizada y no arranca nada.
//  3. La tarea de inicio ejecuta el .exe pelado (no acepta "--oculto"), así
//     que "¿me abrió Windows o me abrió la persona?" se decide por la edad
//     de la sesión: en los primeros minutos después de iniciar, es Windows.
const UMBRAL_ARRANQUE_SEG = 150;

function esDeTienda({ windowsStore, env } = {}) {
  return windowsStore === true || (env && env.UNIFY_TIENDA === "1") || false;
}

// ¿Arranca escondida en la bandeja (sin abrir la ventana)?
function arrancaOculto({ argv = [], deTienda = false, uptimeSeg = Infinity } = {}) {
  if (argv.includes("--oculto")) return true;
  return Boolean(deTienda) && uptimeSeg < UMBRAL_ARRANQUE_SEG;
}

// La ficha de Unify en la tienda (abre la app Microsoft Store en esa página).
// El productId lo inyecta el workflow al empaquetar (extraMetadata.tienda).
function enlaceTienda(productId) {
  const id = String(productId || "").trim();
  return /^[A-Za-z0-9]{6,20}$/.test(id) ? `ms-windows-store://pdp/?productid=${id}` : null;
}

module.exports = { esDeTienda, arrancaOculto, enlaceTienda, UMBRAL_ARRANQUE_SEG };
