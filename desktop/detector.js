// Detección de "una app de reuniones está en una reunión" (Zoom, Teams,
// Webex, Jitsi y las demás apps de reuniones que usan las empresas).
//
// ZOOM (Windows): el proceso CptHost.exe. Zoom lo levanta al ENTRAR a una
// reunión y lo baja al salir (a diferencia de Zoom.exe, que vive siempre que
// la app esté abierta). No depende del idioma de la interfaz ni de títulos de
// ventana, que cambian con cada localización.
//
// TODAS LAS DEMÁS (Windows): casi ninguna tiene un proceso que exista sólo
// durante la reunión. La señal firme es la del propio Windows: el registro de
// "quién está usando el micrófono" (CapabilityAccessManager\ConsentStore\
// microphone). Mientras una app captura el micrófono, su clave tiene
// LastUsedTimeStop = 0; al soltarlo, Windows escribe la hora. Estas apps
// retienen el micrófono durante TODA la llamada (aunque estés silenciado: el
// mute es de la app, no del dispositivo), así que "la app tiene el micrófono"
// == "la app está en una reunión". Tampoco depende del idioma ni de si la
// ventana está minimizada.
//
// OJO: las reuniones EN EL NAVEGADOR (Jitsi en una pestaña, Meet, etc.) acá
// no se pueden distinguir -- el micrófono figura tomado por chrome.exe y eso
// puede ser cualquier página. De esas se encarga la extensión de Chrome, que
// sí ve QUÉ página es. Esta tabla es para las APPS instaladas.
//
// La máquina de estados exige DOS lecturas seguidas iguales antes de avisar:
// una lectura suelta (un tasklist que falló, un proceso a medio morir) no
// tiene que disparar el cartel ni dar por terminada una reunión viva.
//
// `sonda` es inyectable a propósito: en Windows es tasklist + reg query; en
// desarrollo y en las pruebas es "existe tal archivo" o una función falsa.
// Así toda esta lógica se prueba sin las apps y sin Windows.
//
// La sonda no contesta sí/no: contesta QUÉ app está en reunión ("zoom",
// "teams", "webex", ...) o null. El detector avisa `alEntrar(plataforma)`.

const { exec } = require("child_process");
const fs = require("fs");

// ¿Está la app de Zoom dentro de una reunión AHORA? (Windows)
function hayZoomEnReunion() {
  return new Promise((resolve) => {
    exec('tasklist /FI "IMAGENAME eq CptHost.exe" /FO CSV /NH', { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(/CptHost\.exe/i.test(stdout || ""));
    });
  });
}

// Las apps de reuniones que se reconocen por el registro de micrófonos, con
// los patrones de sus claves. En NonPackaged la ruta del exe viene con "#" en
// vez de "\" (C:#Users#...#Teams.exe); las empaquetadas usan su paquete
// (MSTeams_...). Los patrones son sufijos ESTRICTOS a propósito: "teams"
// pelado matchearía TeamSpeak.exe y dispararía el cartel en una partida.
//
// El ORDEN es la prioridad cuando dos apps tienen el micrófono a la vez: las
// de reuniones puras primero; Slack y Discord al final, porque un huddle o un
// canal de voz pueden quedar abiertos horas de fondo mientras la reunión de
// verdad pasa en otra app.
const APPS_POR_MICROFONO = [
  ["teams", [/\\msteams_[^\\]*$/i, /#(?:ms-)?teams\.exe$/i]],
  ["webex", [/#ciscocollabhost\.exe$/i, /#atmgr\.exe$/i, /#webexmta\.exe$/i, /#webex\.exe$/i]],
  ["jitsi", [/#jitsi meet\.exe$/i]],
  ["chime", [/#amazon chime\.exe$/i, /#chime\.exe$/i]],
  ["goto", [/#goto\.exe$/i, /#g2mcomm\.exe$/i]],
  ["ringcentral", [/#ringcentral[^#]*\.exe$/i]],
  ["slack", [/#slack\.exe$/i]],
  ["discord", [/#discord(?:ptb|canary)?\.exe$/i]],
];

// ¿Qué app de reuniones dice el registro de micrófonos de Windows que lo está
// usando AHORA? Devuelve su nombre ("teams", "webex", ...) o null. Puro texto
// adentro (exportada para probarla sin Windows). El formato de reg query:
//
//   HKEY_CURRENT_USER\...\microphone\MSTeams_8wekyb3d8bbwe!MSTeams
//       LastUsedTimeStop    REG_QWORD    0x0
function appUsandoElMicrofono(salidaReg) {
  const activas = new Set();
  let appActual = null;
  for (const cruda of String(salidaReg || "").split(/\r?\n/)) {
    const linea = cruda.trim();
    if (/^HKEY_/i.test(linea)) {
      appActual = null;
      for (const [app, patrones] of APPS_POR_MICROFONO) {
        if (patrones.some((p) => p.test(linea))) { appActual = app; break; }
      }
      continue;
    }
    if (!appActual) continue;
    const m = linea.match(/^LastUsedTimeStop\s+REG_QWORD\s+0x([0-9a-f]+)$/i);
    if (m && /^0+$/.test(m[1])) activas.add(appActual);
  }
  for (const [app] of APPS_POR_MICROFONO) if (activas.has(app)) return app;
  return null;
}

// Compatibilidad con quien preguntaba sólo por Teams.
function teamsUsaElMicrofono(salidaReg) {
  return appUsandoElMicrofono(salidaReg) === "teams";
}

// ¿Qué app está en reunión según el micrófono? (Windows)
function hayAppConMicrofono() {
  return new Promise((resolve) => {
    exec(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone" /s /v LastUsedTimeStop',
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(appUsandoElMicrofono(stdout));
      }
    );
  });
}

// La sonda de Windows completa: qué app está en reunión, o null. Zoom primero
// (su señal es la más precisa); después, la que tenga el micrófono.
async function sondaWindows() {
  if (await hayZoomEnReunion()) return "zoom";
  return await hayAppConMicrofono();
}

// Las plataformas que la sonda simulada sabe nombrar (las mismas de la tabla,
// más zoom).
const PLATAFORMAS_SIMULABLES = new Set(["zoom", ...APPS_POR_MICROFONO.map(([app]) => app)]);

// Sonda de desarrollo/pruebas: la "reunión" es que exista un archivo. Tocarlo
// simula entrar; borrarlo, salir. El contenido dice de QUÉ app es la reunión
// simulada ("teams", "webex", "jitsi", ...); cualquier otra cosa, Zoom.
function sondaArchivo(ruta) {
  return () => {
    try {
      if (!fs.existsSync(ruta)) return Promise.resolve(null);
      const texto = fs.readFileSync(ruta, "utf8").trim().toLowerCase();
      return Promise.resolve(PLATAFORMAS_SIMULABLES.has(texto) ? texto : "zoom");
    } catch {
      return Promise.resolve(null);
    }
  };
}

// Crea el vigía. Devuelve { detener() }. Llama a `alEntrar(plataforma)` cuando
// la reunión empieza ("zoom"/"teams"/"webex"/...) y `alSalir()` cuando termina
// (confirmadas, ver arriba).
function crearDetector({ sonda, alEntrar, alSalir, intervaloMs = 3000 }) {
  let enReunion = false;
  let seguidas = 0; // lecturas seguidas que CONTRADICEN el estado actual
  let parado = false;

  async function tick() {
    if (parado) return;
    let lectura = null;
    try {
      lectura = (await sonda()) || null;
    } catch {
      lectura = null;
    }
    // Compatibilidad: una sonda vieja que devuelva true a secas cuenta como
    // Zoom (la plataforma de siempre).
    if (lectura === true) lectura = "zoom";
    const hay = Boolean(lectura);
    if (hay === enReunion) {
      seguidas = 0;
    } else {
      seguidas += 1;
      if (seguidas >= 2) {
        enReunion = hay;
        seguidas = 0;
        try {
          if (enReunion) alEntrar(lectura);
          else alSalir();
        } catch {
          // Un error en el aviso no puede matar al vigía.
        }
      }
    }
  }

  const timer = setInterval(() => void tick(), intervaloMs);
  return {
    detener() {
      parado = true;
      clearInterval(timer);
    },
    // Sólo para inspección/pruebas.
    get enReunion() {
      return enReunion;
    },
    // Un tick a mano (pruebas: avanzar sin esperar al reloj).
    _tick: tick,
  };
}

module.exports = {
  crearDetector,
  sondaWindows,
  sondaArchivo,
  appUsandoElMicrofono,
  teamsUsaElMicrofono,
};
