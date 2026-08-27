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
let cartel = null;
let puente = null;
let detector = null;
let salaActual = "";
let navegadorHijo = null;

// Un solo Unify en la bandeja; el segundo intento sólo avisa al primero.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(arrancar);
}

function arrancar() {
  // Arrancar con la sesión (queda en segundo plano, como pide el flujo:
  // instalás una vez y te olvidás). Sólo tiene sentido empaquetada.
  if (process.platform === "win32" && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true });
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
  const url = `${WEB}/externa?origen=escritorio&sala=${sala}`;
  const chrome = rutaDeChrome();
  if (!chrome) {
    shell.openExternal(url);
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const ancho = 560;
  const alto = 460;
  const x = area.x + area.width - ancho - 16;
  const y = area.y + area.height - alto - 16;
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
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir Unify", click: () => shell.openExternal(WEB) },
      { label: "Mi historial", click: () => shell.openExternal(`${WEB}/historial`) },
      { type: "separator" },
      // Para probar el circuito sin esperar una reunión real.
      { label: "Probar el cartel", click: () => mostrarCartel() },
      { type: "separator" },
      { label: "Salir", click: () => app.quit() },
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
  detector?.detener();
  void puente?.cerrar();
});
