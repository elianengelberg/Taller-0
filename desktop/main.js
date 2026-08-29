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

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, screen, nativeImage } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { crearDetector, sondaWindows, sondaArchivo } = require("./detector");
const { crearPuente } = require("./puente");

// La web de Unify. En desarrollo se puede apuntar a un build local:
//   UNIFY_WEB=http://localhost:4174 npm start
const WEB = process.env.UNIFY_WEB || "https://unify-meet.com";

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
  // La barra (si está abierta) ve el cambio por el puente y se encarga de
  // cortar, subir la grabación y abrir el historial. Acá sólo se apaga la luz.
  puente.fijarEstado(false);
  salaActual = "";
  if (cartel && !cartel.isDestroyed()) cartel.close();
}

function mostrarCartel(segundos = 8) {
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
    if (valor === "si") abrirBarra();
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
  // Abajo a la derecha, chiquita: la barra acompaña la reunión, no la tapa.
  const area = screen.getPrimaryDisplay().workArea;
  abrirEnChrome(`${WEB}/externa?origen=escritorio&sala=${sala}`, {
    ancho: 560,
    alto: 460,
    x: area.x + area.width - 560 - 16,
    y: area.y + area.height - 460 - 16,
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

function armarBandeja() {
  tray = new Tray(iconoBandeja());
  tray.setToolTip("Unify — atento a tus reuniones");
  // Un clic en el ícono abre la app: es lo que todo el mundo intenta primero.
  tray.on("click", () => abrirVentana());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir Unify", click: () => abrirVentana("/") },
      { label: "Mi historial", click: () => abrirVentana("/historial") },
      { type: "separator" },
      // Para probar el circuito sin esperar una reunión real.
      { label: "Probar el cartel", click: () => mostrarCartel() },
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
  detector?.detener();
  void puente?.cerrar();
});
