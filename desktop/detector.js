// Detección de "una app de reuniones está en una reunión" (Zoom y Teams).
//
// ZOOM (Windows): el proceso CptHost.exe. Zoom lo levanta al ENTRAR a una
// reunión y lo baja al salir (a diferencia de Zoom.exe, que vive siempre que
// la app esté abierta). No depende del idioma de la interfaz ni de títulos de
// ventana, que cambian con cada localización.
//
// TEAMS (Windows): Teams no tiene un proceso que exista sólo durante la
// reunión (el nuevo Teams es un único ms-teams.exe con WebView2). La señal
// firme es la del propio Windows: el registro de "quién está usando el
// micrófono" (CapabilityAccessManager\ConsentStore\microphone). Mientras una
// app captura el micrófono, su clave tiene LastUsedTimeStop = 0; al soltarlo,
// Windows escribe la hora. Teams mantiene el micrófono tomado durante TODA la
// llamada (aunque estés silenciado: el mute es de la app, no del dispositivo),
// así que "Teams tiene el micrófono" == "Teams está en una reunión". Tampoco
// depende del idioma ni de si la ventana está minimizada.
//
// La máquina de estados exige DOS lecturas seguidas iguales antes de avisar:
// una lectura suelta (un tasklist que falló, un proceso a medio morir) no
// tiene que disparar el cartel ni dar por terminada una reunión viva.
//
// `sonda` es inyectable a propósito: en Windows es tasklist + reg query; en
// desarrollo y en las pruebas es "existe tal archivo" o una función falsa.
// Así toda esta lógica se prueba sin Zoom, sin Teams y sin Windows.
//
// La sonda ya no contesta sí/no: contesta QUÉ app está en reunión ("zoom",
// "teams") o null. El detector avisa `alEntrar(plataforma)`.

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

// ¿Dice el registro de micrófonos de Windows que TEAMS lo está usando? Puro
// texto adentro (exportada para probarla sin Windows). El formato de reg query:
//
//   HKEY_CURRENT_USER\...\microphone\MSTeams_8wekyb3d8bbwe!MSTeams
//       LastUsedTimeStop    REG_QWORD    0x0
//
// Se acepta el Teams empaquetado (clave MSTeams_...) y el clásico/exe suelto
// (NonPackaged\...#Teams.exe o #ms-teams.exe). Los sufijos son estrictos a
// propósito: "teams" pelado adentro de la ruta matchearía TeamSpeak.exe y
// dispararía el cartel en una partida de videojuegos.
function teamsUsaElMicrofono(salidaReg) {
  let claveEsDeTeams = false;
  for (const cruda of String(salidaReg || "").split(/\r?\n/)) {
    const linea = cruda.trim();
    if (/^HKEY_/i.test(linea)) {
      claveEsDeTeams =
        /\\msteams_[^\\]*$/i.test(linea) || /#(?:ms-)?teams\.exe$/i.test(linea);
      continue;
    }
    if (!claveEsDeTeams) continue;
    const m = linea.match(/^LastUsedTimeStop\s+REG_QWORD\s+0x([0-9a-f]+)$/i);
    if (m && /^0+$/.test(m[1])) return true;
  }
  return false;
}

// ¿Está la app de Teams dentro de una reunión AHORA? (Windows)
function hayTeamsEnReunion() {
  return new Promise((resolve) => {
    exec(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone" /s /v LastUsedTimeStop',
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(false);
        resolve(teamsUsaElMicrofono(stdout));
      }
    );
  });
}

// La sonda de Windows completa: qué app está en reunión, o null. Zoom primero
// (su señal es la más precisa); con las dos a la vez, gana Zoom.
async function sondaWindows() {
  if (await hayZoomEnReunion()) return "zoom";
  if (await hayTeamsEnReunion()) return "teams";
  return null;
}

// Sonda de desarrollo/pruebas: la "reunión" es que exista un archivo. Tocarlo
// simula entrar; borrarlo, salir. Si el archivo dice "teams", la reunión
// simulada es de Teams; cualquier otro contenido, de Zoom.
function sondaArchivo(ruta) {
  return () => {
    try {
      if (!fs.existsSync(ruta)) return Promise.resolve(null);
      const texto = fs.readFileSync(ruta, "utf8").trim().toLowerCase();
      return Promise.resolve(texto.includes("teams") ? "teams" : "zoom");
    } catch {
      return Promise.resolve(null);
    }
  };
}

// Crea el vigía. Devuelve { detener() }. Llama a `alEntrar(plataforma)` cuando
// la reunión empieza ("zoom"/"teams") y `alSalir()` cuando termina
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

module.exports = { crearDetector, sondaWindows, sondaArchivo, teamsUsaElMicrofono };
