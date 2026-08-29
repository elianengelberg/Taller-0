// La app de escritorio de Unify.
//
// Qué hace: vive en la bandeja (al lado del reloj), y cuando la app de Zoom
// entra a una reunión muestra NUESTRO cartel al medio de la pantalla:
// "¿querés grabarla?". Si la respuesta es sí (o no se toca nada en unos
// segundos), abre la barra acompañante de Unify -- la página web en una
// ventanita del navegador -- que pone subtítulos en vivo, traducción, IA y
// graba. Cuando Zoom cierra la reunión, esta app lo ve y se lo avisa a la
// barra por el puente local (ver puente.js): la barra corta, sube todo y abre
// el detalle en el historial.
//
// La barra corre en Chrome de verdad (modo --app), NO en una ventana de
// Electron: el reconocimiento de voz del navegador necesita las llaves de
// Google que sólo trae Chrome. Electron acá sólo vigila, pregunta y coordina.

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, screen, nativeImage, desktopCapturer } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { crearDetector, sondaWindows, sondaArchivo } = require("./detector");
const { crearPuente } = require("./puente");
const { refrescarExtension } = require("./extensionLocal");
// electron-updater es quien mira GitHub Releases (latest.yml), baja el
// instalador nuevo y lo deja listo. Acá sólo se decide CUÁNDO mirar y cómo
// contarlo; el trabajo sucio es de él.
const { autoUpdater } = require("electron-updater");

// La web de Unify. En desarrollo se puede apuntar a un build local:
//   UNIFY_WEB=http://localhost:4174 npm start
const WEB = process.env.UNIFY_WEB || "https://unify-meet.com";
// La API (donde viven el bridge y las grabaciones). Separada de la web: el
// sitio es estático; los datos van a Render.
const SERVER = process.env.UNIFY_SERVER || "https://taller-0.onrender.com";

// En Linux/macOS no hay Zoom que vigilar: la "reunión" se simula tocando y
// borrando este archivo (y sirve para probar todo el circuito sin Zoom).
const ARCHIVO_SIMULACION = path.join(os.tmpdir(), "unify-reunion-simulada");

let tray = null;
let ventana = null;      // LA app: la ventana principal de Unify
let cartel = null;
let avisoDeBandejaDado = false;
let puente = null;
let detector = null;
let salaActual = "";
let navegadorHijo = null;

// Un solo Unify en la bandeja; el segundo intento sólo avisa al primero.
if (process.env.UNIFY_TEST === "1") {
  // SOLO el arnés: micrófono falso y sin carteles del sistema, para poder
  // ejercitar el grabador en un contenedor sin hardware.
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Doble clic en el acceso directo con Unify ya abierto: en vez de no hacer
  // nada (y parecer que no se instaló), trae la ventana al frente.
  app.on("second-instance", () => abrirVentana());
  // (Que no se cierre al cerrar las ventanas ya está resuelto más abajo.)
  app.on("activate", () => abrirVentana());
  app.whenReady().then(arrancar);
}

function arrancar() {
  // Arrancar con la sesión (queda en segundo plano, como pide el flujo:
  // instalás una vez y te olvidás). Sólo tiene sentido empaquetada.
  if (process.platform === "win32" && app.isPackaged) {
    // Con "--oculto": el arranque automático con Windows deja a Unify atento
    // en la bandeja SIN abrir la ventana en la cara. Cuando la abrís vos (o
    // recién instalada), sí se muestra.
    app.setLoginItemSettings({ openAtLogin: true, args: ["--oculto"] });
  }

  puente = crearPuente();
  puente.listo.catch(() => {
    // Puerto tomado (otra instancia vieja): la app sigue, sin puente la barra
    // simplemente no se corta sola.
  });

  detector = crearDetector({
    sonda: process.platform === "win32" ? sondaWindows : sondaArchivo(ARCHIVO_SIMULACION),
    alEntrar: reunionEmpezo,
    alSalir: reunionTermino,
  });

  armarBandeja();
  arrancarActualizador();

  // LA APP TIENE VENTANA. Antes esto era sólo un ícono al lado del reloj y
  // todo lo demás abría el navegador: se instalaba y no pasaba nada visible
  // -- se sentía una página web, no un programa. Ahora abre en su propia
  // ventana, en la pantalla de inicio, como cualquier app de Windows.
  if (!process.argv.includes("--oculto")) abrirVentana("/");
}

// La ventana de la app. Se crea una sola vez y se reusa: cerrarla la esconde
// en la bandeja (si se destruyera, Unify dejaría de vigilar las reuniones,
// que es justamente para lo que está).
function abrirVentana(ruta) {
  if (ventana && !ventana.isDestroyed()) {
    if (ruta) ventana.loadURL(`${WEB}${ruta}`);
    if (ventana.isMinimized()) ventana.restore();
    ventana.show();
    ventana.focus();
    return;
  }
  ventana = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 880,
    minHeight: 600,
    title: "Unify",
    backgroundColor: "#0b1020",
    autoHideMenuBar: true,
    show: false,
    icon: iconoBandeja(),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  ventana.loadURL(`${WEB}${ruta || "/"}`);
  // Mostrarla SÓLO con "ready-to-show" es la receta de manual, pero si ese
  // evento no llega (pasa: sin aceleración de video, con la red lenta) la
  // ventana se queda invisible y la app parece que no arrancó -- justo el
  // problema que estamos arreglando. Se muestra con lo que llegue primero,
  // y hay una red de seguridad por tiempo.
  const mostrar = () => {
    if (ventana && !ventana.isDestroyed() && !ventana.isVisible()) ventana.show();
  };
  ventana.once("ready-to-show", mostrar);
  ventana.webContents.once("did-finish-load", mostrar);
  ventana.webContents.once("did-fail-load", mostrar);
  setTimeout(mostrar, 4000);

  // El nombre de la ventana es el de la APP, no el de la página: en la barra
  // de tareas de Windows tiene que decir "Unify".
  ventana.on("page-title-updated", (ev) => ev.preventDefault());

  // Las REUNIONES corren en Chrome de verdad, no acá: el reconocimiento de
  // voz del navegador necesita las llaves de Google que Electron no trae, y
  // una reunión sin subtítulos no es una reunión de Unify. La ventana se
  // queda con todo lo demás (inicio, historial, cuenta, ayuda).
  ventana.webContents.on("will-navigate", (ev, url) => {
    if (!esRutaDeReunion(url)) return;
    ev.preventDefault();
    abrirEnChrome(url);
  });
  ventana.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(WEB) && esRutaDeReunion(url)) abrirEnChrome(url);
    else shell.openExternal(url);
    return { action: "deny" };
  });

  // Cerrar la ventana NO cierra Unify: sigue atento en la bandeja, que es su
  // trabajo. Se avisa una vez para que nadie crea que se colgó.
  ventana.on("close", (ev) => {
    if (app.cerrandoDeVerdad) return;
    ev.preventDefault();
    ventana.hide();
    if (!avisoDeBandejaDado) {
      avisoDeBandejaDado = true;
      try {
        tray?.displayBalloon?.({
          title: "Unify sigue acá",
          content: "Queda al lado del reloj, atento a tus reuniones. Para abrirlo, tocá su ícono.",
        });
      } catch { /* Windows viejo sin globos: no pasa nada */ }
    }
  });
}

// ¿Esta dirección ENTRA a una reunión? (Las que necesitan Chrome.)
function esRutaDeReunion(url) {
  try {
    const { pathname } = new URL(url);
    return /^\/(reunion|externa|unirse|crear)(\/|$)/.test(pathname);
  } catch {
    return false;
  }
}

function reunionEmpezo() {
  salaActual = `zoom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  puente.fijarEstado(true);
  mostrarCartel();
}

function reunionTermino() {
  // La barra (si está abierta) ve el cambio por el puente y corta lo suyo.
  puente.fijarEstado(false);
  salaActual = "";
  if (cartel && !cartel.isDestroyed()) cartel.close();
  // Y el grabador silencioso cierra y sube: la reunión terminó.
  void detenerGrabacionEscritorio();
}

// ============================================================================
// EL GRABADOR SILENCIOSO. "Tocás grabar y graba LA REUNIÓN", sin selector:
// un navegador no puede saltarse el selector de getDisplayMedia (regla de
// Chrome, sin excepciones) -- y encima las ventanas minimizadas ni aparecen
// en la lista, que era exactamente lo que pasaba con Zoom. Esta app SÍ puede:
// elige la fuente por código y en Windows suma el audio del sistema
// (loopback), así que graba la reunión se vea donde se vea, sin preguntar
// nada. Se captura LA PANTALLA (no la ventana de Zoom: minimizada se graba
// negra; la pantalla es lo que la persona está mirando, siempre existe).
// ============================================================================
let grabador = null; // { win, archivo, stream, empezoEn, sala }

async function iniciarGrabacionEscritorio() {
  if (grabador) return; // ya hay una andando
  const sala = salaActual || `zoom-${Date.now().toString(36)}`;
  try {
    const fuentes = await desktopCapturer.getSources({ types: ["screen"] });
    const fuente = fuentes[0];
    if (!fuente) throw new Error("sin pantallas para capturar");

    const archivo = path.join(os.tmpdir(), `unify-grabacion-${Date.now()}.webm`);
    const salida = fs.createWriteStream(archivo);

    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        // Ventana oculta que carga SOLO nuestro archivo local: puede usar
        // ipcRenderer directo (nada remoto entra acá jamás).
        nodeIntegration: true,
        contextIsolation: false,
      },
    });
    // La fuente la decide este handler: getDisplayMedia en la ventana oculta
    // NO muestra ningún selector. "loopback" = el audio del sistema (las
    // voces de la reunión) en Windows; donde no existe, cae sin audio de
    // sistema y queda el micrófono que mezcla el grabador.
    win.webContents.session.setDisplayMediaRequestHandler((_req, callback) => {
      // "loopback" (audio del sistema) existe SOLO en Windows: pedirlo en
      // Mac/Linux hace fallar la captura entera. Ahí va sin audio de sistema
      // y queda el micrófono que mezcla el grabador.
      if (process.platform === "win32") {
        try {
          callback({ video: fuente, audio: "loopback" });
          return;
        } catch { /* algún Windows sin WGC: sin audio de sistema */ }
      }
      callback({ video: fuente });
    });
    // El micrófono de la ventana oculta, concedido sin cartel (es nuestra).
    win.webContents.session.setPermissionRequestHandler((_wc, permiso, callback) => {
      callback(permiso === "media");
    });

    grabador = { win, archivo, stream: salida, empezoEn: Date.now(), sala };
    win.on("closed", () => {
      if (grabador && grabador.win === win) grabador = null;
    });
    await win.loadFile(path.join(__dirname, "grabador.html"));
  } catch (err) {
    grabador = null;
    globo("Unify", `No pude arrancar la grabación automática (${String((err && err.message) || err)}).`);
  }
}

ipcMain.on("grabador:chunk", (_ev, buf) => {
  grabador?.stream.write(Buffer.from(buf));
});
ipcMain.on("grabador:listo", (_ev, info) => {
  if (!info?.conLoopback) {
    // Verdad por delante: sin loopback (Mac/Linux) el video lleva sólo lo
    // que entra por el micrófono.
    globo("Unify", "Grabando la reunión. En este sistema no hay audio interno: el sonido sale del micrófono.");
  }
});
ipcMain.on("grabador:fin", (_ev, r) => {
  void cerrarYSubirGrabacion(r);
});

function detenerGrabacionEscritorio() {
  if (!grabador) return Promise.resolve();
  try { grabador.win.webContents.send("grabador:parar"); } catch { /* ya cerrada */ }
  // Si el renderer no contesta (colgado), a los 8 segundos se fuerza cierre.
  return new Promise((resolve) => {
    const t = setTimeout(() => { void cerrarYSubirGrabacion({ ok: true }); resolve(); }, 8000);
    const listo = setInterval(() => {
      if (!grabador) { clearTimeout(t); clearInterval(listo); resolve(); }
    }, 300);
  });
}

async function cerrarYSubirGrabacion(resultado) {
  const g = grabador;
  if (!g) return;
  grabador = null;
  const duracionMs = Date.now() - g.empezoEn;
  try { g.win.destroy(); } catch { /* ya cerrada */ }
  await new Promise((r) => g.stream.end(r));

  const talle = (() => { try { return fs.statSync(g.archivo).size; } catch { return 0; } })();
  if (!resultado?.ok || talle < 20_000) {
    fs.rmSync(g.archivo, { force: true });
    if (resultado && resultado.ok === false) {
      globo("Unify", `La grabación no salió (${resultado.error || "sin detalle"}).`);
    }
    return;
  }

  try {
    // La MISMA sala que la barra companion: el video cae en esa reunión, con
    // su transcripción. El GET crea la reunión si la barra nunca llegó a
    // abrirse (mejor un video huérfano de barra que un video perdido).
    const clave = encodeURIComponent(`escritorio:${g.sala}`);
    const ses = await fetch(`${SERVER}/api/meet-bridge/${clave}/session`).then((r) => r.json());
    if (!ses?.dbId) throw new Error("el bridge no dio la reunión");
    const subida = await fetch(
      `${SERVER}/api/meetings/${ses.dbId}/recording-upload?durationMs=${Math.round(duracionMs)}`,
      {
        method: "POST",
        headers: { "Content-Type": "video/webm" },
        body: fs.createReadStream(g.archivo),
        duplex: "half",
      }
    );
    if (!subida.ok) throw new Error(`HTTP ${subida.status}`);
    globo("Unify", "La grabación de la reunión quedó guardada en tu historial.");
  } catch (err) {
    globo("Unify", `Grabé la reunión pero no pude subirla (${String((err && err.message) || err)}). El archivo quedó en ${g.archivo}.`);
    return; // el archivo se conserva: peor sería borrarlo
  }
  fs.rmSync(g.archivo, { force: true });
}

function mostrarCartel(segundos = 15) {
  if (cartel && !cartel.isDestroyed()) return; // ya hay uno abierto
  cartel = new BrowserWindow({
    width: 470,
    height: 240,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    center: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-cartel.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  cartel.loadFile(path.join(__dirname, "cartel.html"), { search: `seg=${segundos}` });
  cartel.once("ready-to-show", () => cartel.show());
  ipcMain.once("cartel:respuesta", (_ev, valor) => {
    if (cartel && !cartel.isDestroyed()) cartel.close();
    cartel = null;
    if (valor === "si") {
      // La barra pone los subtítulos; el grabador silencioso pone el VIDEO,
      // sin selector ni preguntas: graba la pantalla con el audio del sistema.
      void iniciarGrabacionEscritorio();
      abrirBarra();
    }
  });
  // Cerrar el cartel con la cruz/Alt+F4 (sin responder) cuenta como "no":
  // cerrar es un gesto explícito, distinto de no tocar nada.
  cartel.on("closed", () => {
    cartel = null;
  });
}

// Abre la barra acompañante: Chrome en modo --app (ventana pelada, sin
// pestañas), abajo a la derecha, sobre la reunión. Sin Chrome, el navegador
// que haya -- la barra funciona igual, sólo que en una pestaña común.
function abrirBarra() {
  const sala = salaActual || `zoom-${Date.now().toString(36)}`;
  // AL MEDIO y con lugar. Antes abría 560x460 en la esquina de abajo a la
  // derecha, y justo al entrar hay que decidir varias cosas (el permiso del
  // micrófono, si grabar, los subtítulos flotantes, el idioma): en ese rincón
  // todo quedaba apretado y parecía roto. Centrada se elige cómodo; después
  // se arrastra al costado de la reunión, que para eso es una ventana.
  const area = screen.getPrimaryDisplay().workArea;
  const ancho = Math.min(760, area.width - 80);
  const alto = Math.min(780, area.height - 80);
  abrirEnChrome(`${WEB}/externa?origen=escritorio&sala=${sala}`, {
    ancho,
    alto,
    x: Math.round(area.x + (area.width - ancho) / 2),
    y: Math.round(area.y + (area.height - alto) / 2),
  });
}

// Abre una dirección en CHROME de verdad, en una ventana pelada (--app). Es
// donde las reuniones funcionan: el reconocimiento de voz necesita las llaves
// de Google que sólo trae Chrome. Sin Chrome instalado, el navegador que haya
// -- la reunión anda igual, y la propia web avisa si no puede transcribir.
function abrirEnChrome(url, medidas) {
  const chrome = rutaDeChrome();
  if (!chrome) {
    shell.openExternal(url);
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const ancho = medidas?.ancho ?? Math.min(1180, area.width - 80);
  const alto = medidas?.alto ?? Math.min(800, area.height - 80);
  const x = medidas?.x ?? Math.round(area.x + (area.width - ancho) / 2);
  const y = medidas?.y ?? Math.round(area.y + (area.height - alto) / 2);
  navegadorHijo = spawn(
    chrome,
    [`--app=${url}`, `--window-size=${ancho},${alto}`, `--window-position=${x},${y}`],
    { detached: true, stdio: "ignore" }
  );
  navegadorHijo.unref();
}

// Dónde suele estar Chrome. Windows primero (la app se usa ahí); los otros
// para desarrollo.
function rutaDeChrome() {
  const candidatos =
    process.platform === "win32"
      ? [
          path.join(process.env["ProgramFiles"] || "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
          path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google/Chrome/Application/chrome.exe"),
          path.join(process.env["LocalAppData"] || "", "Google/Chrome/Application/chrome.exe"),
        ]
      : ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidatos.find((c) => c && fs.existsSync(c)) || null;
}

// ============================================================================
// ACTUALIZACIONES: la app entera se mantiene sola.
//
//  - La parte WEB (lo que se ve adentro de la ventana) ya se actualiza sola:
//    es la misma web con su service worker.
//  - El PROGRAMA (esta app: ventana, bandeja, detector de Zoom) se busca en
//    GitHub Releases, se baja solo, y ofrece "Reiniciar y actualizar" en la
//    bandeja. Si nadie toca nada, igual se instala al cerrar la app.
//  - La EXTENSIÓN cargada por ZIP vive en la carpeta de datos de la app y se
//    refresca acá mismo (la de la Web Store se actualiza sola con Chrome).
// ============================================================================
let estadoUpdate = { fase: "quieto", version: null }; // quieto|buscando|descargando|listo|error
let busquedaManual = false;

function globo(titulo, cuerpo) {
  try {
    tray?.displayBalloon?.({ title: titulo, content: cuerpo });
  } catch {
    /* Linux/Mac sin globos: el estado igual queda en el menú */
  }
}

function etiquetaDeUpdate() {
  switch (estadoUpdate.fase) {
    case "buscando": return "Buscando actualización…";
    case "descargando": return `Bajando la versión ${estadoUpdate.version || "nueva"}…`;
    case "listo": return `Reiniciar y actualizar (v${estadoUpdate.version})`;
    case "error": return "Buscar actualización (falló la última vez)";
    default: return "Buscar actualización";
  }
}

function clicEnUpdate() {
  if (estadoUpdate.fase === "listo") {
    app.cerrandoDeVerdad = true;
    autoUpdater.quitAndInstall();
    return;
  }
  busquedaManual = true;
  buscarActualizacion();
  // La extensión por ZIP viaja en el mismo gesto: un solo botón, todo al día.
  void refrescarExtensionLocal(true);
}

function buscarActualizacion() {
  if (!app.isPackaged) return; // en desarrollo no hay release que mirar
  if (estadoUpdate.fase === "buscando" || estadoUpdate.fase === "descargando") return;
  estadoUpdate = { fase: "buscando", version: null };
  armarBandeja();
  autoUpdater.checkForUpdates().catch(() => {});
}

function arrancarActualizador() {
  // Si el update quedó bajado y nadie reinició, se instala al salir igual.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-available", (info) => {
    estadoUpdate = { fase: "descargando", version: info?.version || null };
    armarBandeja();
  });
  autoUpdater.on("update-not-available", () => {
    estadoUpdate = { fase: "quieto", version: null };
    armarBandeja();
    if (busquedaManual) globo("Unify", "Ya estás en la última versión.");
    busquedaManual = false;
  });
  autoUpdater.on("update-downloaded", (info) => {
    estadoUpdate = { fase: "listo", version: info?.version || null };
    armarBandeja();
    globo(
      "Unify se actualizó",
      `La versión ${info?.version || "nueva"} está lista: tocá «Reiniciar y actualizar» en el menú de Unify (al lado del reloj). Si no, se instala sola al cerrar.`
    );
    busquedaManual = false;
  });
  autoUpdater.on("error", () => {
    estadoUpdate = { fase: "error", version: null };
    armarBandeja();
    if (busquedaManual) globo("Unify", "No pudimos buscar la actualización (¿sin internet?). Probá de nuevo más tarde.");
    busquedaManual = false;
  });

  // Al arrancar (con un respiro para no pelearle el arranque a la ventana) y
  // después cada 6 horas: nadie tiene que acordarse de nada.
  setTimeout(buscarActualizacion, 30_000);
  const timer = setInterval(buscarActualizacion, 6 * 60 * 60_000);
  if (typeof timer.unref === "function") timer.unref();

  // Y la extensión local, si la persona la usa: al día en silencio.
  setTimeout(() => void refrescarExtensionLocal(false), 45_000);
}

// La carpeta donde la app mantiene la extensión para "Cargar descomprimida".
function carpetaBaseExtension() {
  return app.getPath("userData");
}

async function refrescarExtensionLocal(avisar) {
  const baseDir = carpetaBaseExtension();
  const carpeta = path.join(baseDir, "extension");
  // Silencioso salvo pedido expreso: sólo refresca solo si YA existe (la
  // persona eligió ese camino); crearla sin que nadie la pida sería basura.
  if (!avisar && !fs.existsSync(carpeta)) return;
  const r = await refrescarExtension({ baseDir, web: WEB });
  if (!avisar) return;
  if (r.estado === "error") {
    globo("Extensión de Unify", `No se pudo actualizar la extensión (${r.detalle || "sin detalle"}). La que está sigue andando.`);
  } else if (r.estado === "al-dia") {
    globo("Extensión de Unify", `Ya está en la última versión (${r.version}).`);
  } else {
    globo(
      "Extensión de Unify",
      `Versión ${r.version} lista en la carpeta de Unify. Chrome la toma al reiniciarse (o recargala en chrome://extensions).`
    );
    shell.openPath(carpeta).catch(() => {});
  }
}

function armarBandeja() {
  // Se rearma entero cada vez que cambia el estado del actualizador (los
  // menús de Tray no se editan en el lugar). Crear el Tray una sola vez.
  if (!tray) {
    tray = new Tray(iconoBandeja());
    tray.setToolTip("Unify — atento a tus reuniones");
    // Un clic en el ícono abre la app: es lo que todo el mundo intenta primero.
    tray.on("click", () => abrirVentana());
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir Unify", click: () => abrirVentana("/") },
      { label: "Mi historial", click: () => abrirVentana("/historial") },
      { type: "separator" },
      // Un solo botón para todo: el programa Y la extensión por zip.
      { label: etiquetaDeUpdate(), click: clicEnUpdate },
      { label: "Actualizar la extensión de Chrome (zip)", click: () => void refrescarExtensionLocal(true) },
      { type: "separator" },
      // Para probar el circuito sin esperar una reunión real. OJO: tiene que
      // pasar por reunionEmpezo() como una reunión de verdad -- si sólo
      // mostrara el cartel, el puente quedaría en "no hay reunión" y la barra,
      // al abrirse, se despediría sola a los cinco segundos CON la grabación
      // adentro (pasó: "la grabación no funciona").
      { label: "Probar el cartel", click: () => reunionEmpezo() },
      { type: "separator" },
      { label: "Salir", click: () => { app.cerrandoDeVerdad = true; app.quit(); } },
    ])
  );
}

// Ícono de bandeja dibujado acá mismo (un punto azul Unify): sin archivos de
// imagen que empaquetar ni rutas que se rompan al instalar.
function iconoBandeja() {
  const talle = 16;
  const png = Buffer.alloc(talle * talle * 4);
  const cx = talle / 2 - 0.5;
  const cy = talle / 2 - 0.5;
  for (let y = 0; y < talle; y++) {
    for (let x = 0; x < talle; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const i = (y * talle + x) * 4;
      if (d <= 6.5) {
        // Azul de la marca (#3B82F6), borde suavizado.
        const a = d > 5.5 ? Math.round(255 * (6.5 - d)) : 255;
        png[i] = 0x3b;
        png[i + 1] = 0x82;
        png[i + 2] = 0xf6;
        png[i + 3] = a;
      }
    }
  }
  return nativeImage.createFromBitmap(png, { width: talle, height: talle });
}

// La app NO se cierra al cerrarse las ventanas: vive en la bandeja.
app.on("window-all-closed", () => {});

app.on("before-quit", () => {
  app.cerrandoDeVerdad = true;
  void detenerGrabacionEscritorio();
  detector?.detener();
  void puente?.cerrar();
});
