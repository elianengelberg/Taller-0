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
// LAS REUNIONES EN EL NAVEGADOR (Meet en una pestaña de Chrome, Opera GX o
// Edge; Teams, Zoom o Jitsi en su versión web): el micrófono figura tomado
// por chrome.exe y eso puede ser cualquier página, así que ahí no sirve. La
// señal es el TÍTULO DE LA VENTANA: Meet pone el código de la reunión en el
// título de la pestaña ("Meet – abc-defg-hij"), Teams pone "Reunión |
// Microsoft Teams", etc., y el navegador copia el título de la pestaña
// activa en el de su ventana -- minimizada también. Un ayudante de
// PowerShell enumera TODAS las ventanas (EnumWindows) cada pocos segundos.
// Como el título desaparece apenas la persona cambia de pestaña, la lectura
// del navegador se sostiene con una gracia (GRACIA_NAVEGADOR_MS) antes de
// dar la reunión por terminada. Antes esto era sólo trabajo de la extensión
// de Chrome, y sin la extensión en ESE navegador no avisaba nadie.
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

// ── Reuniones en el navegador, por el título de la ventana ──────────────────
//
// Cada entrada: plataforma, patrón sobre el título y (opcional) cómo sacar el
// código de la reunión. Meet primero: es la única con código en el título, y
// con el código la barra y la grabación caen en la MISMA sala que usaría la
// extensión (google-meet:<código>). Se ignoran los títulos con «Unify»: la
// barra companion se titula "Google Meet · abc-defg-hij · Unify" y se
// detectaría a sí misma (la reunión no terminaría nunca).
const REUNIONES_POR_TITULO = [
  ["meet", /\bMeet\b[^|]*?\b([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i, (m) => m[1].toLowerCase()],
  ["teams", /\b(reuni[oó]n|meeting|llamada|call)\b[^|]*\|\s*Microsoft Teams\b/i],
  ["zoom", /\bZoom Meeting\b|\bReuni[oó]n de Zoom\b/i],
  ["webex", /\bWebex\b[^|]*\b(meeting|reuni[oó]n)\b|\bCisco Webex Meetings\b/i],
  ["jitsi", /\|\s*Jitsi Meet\b/i],
];

// ¿Alguna ventana está en una reunión del navegador? Devuelve
// { plataforma, codigo? } o null. Puro texto (se prueba sin Windows).
function reunionEnTitulos(titulos) {
  for (const [plataforma, patron, sacarCodigo] of REUNIONES_POR_TITULO) {
    for (const cruda of titulos || []) {
      const titulo = String(cruda || "");
      if (!titulo || /\bUnify\b/i.test(titulo)) continue;
      const m = titulo.match(patron);
      if (!m) continue;
      const lectura = { plataforma };
      if (sacarCodigo) lectura.codigo = sacarCodigo(m);
      return lectura;
    }
  }
  return null;
}

// La memoria con gracia: el título de Meet se va apenas la persona cambia
// de pestaña (o el navegador muestra otra ventana), y eso NO es que terminó
// la reunión. Se sostiene la última lectura del navegador hasta que pasen
// `graciaMs` sin volver a verla.
const GRACIA_NAVEGADOR_MS = 90_000;
function crearMemoriaDeNavegador(graciaMs = GRACIA_NAVEGADOR_MS) {
  let ultima = null; // { lectura, vistoEn }
  return {
    recordar(lectura, ahora = Date.now()) {
      if (lectura) {
        ultima = { lectura, vistoEn: ahora };
        return lectura;
      }
      if (ultima && ahora - ultima.vistoEn < graciaMs) return ultima.lectura;
      ultima = null;
      return null;
    },
    olvidar() {
      ultima = null;
    },
  };
}

// El ayudante que enumera las ventanas en Windows. Es UN PowerShell que
// queda vivo (compilar el EnumWindows cuesta medio segundo: se hace una vez)
// y escribe una línea JSON con todos los títulos cada 3 s. Si se cae, se
// vuelve a levantar a los 15 s. Fuera de Windows (desarrollo, pruebas) no
// hay ventanas que mirar: devuelve una lista vacía.
const SCRIPT_VENTANAS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$src = @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class UnifyVentanas {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static List<string> Titulos() {
    var r = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (IsWindowVisible(h)) {
        int n = GetWindowTextLength(h);
        if (n > 0) { var sb = new StringBuilder(n + 1); GetWindowText(h, sb, n + 1); r.Add(sb.ToString()); }
      }
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
"@
Add-Type -TypeDefinition $src -Language CSharp
while ($true) {
  $t = [UnifyVentanas]::Titulos()
  $json = ConvertTo-Json -Compress -InputObject @($t)
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
  Start-Sleep -Seconds 3
}
`;
const COMANDO_VENTANAS = Buffer.from(SCRIPT_VENTANAS, "utf16le").toString("base64");

function crearSondaVentanas({ plataforma = process.platform, spawn = require("child_process").spawn } = {}) {
  let ultimos = [];
  let hijo = null;
  let detenido = false;
  let reintento = null;

  function levantar() {
    if (detenido || plataforma !== "win32") return;
    try {
      hijo = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", COMANDO_VENTANAS], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      hijo = null;
      return;
    }
    let resto = "";
    hijo.stdout.setEncoding("utf8");
    hijo.stdout.on("data", (trozo) => {
      resto += trozo;
      const lineas = resto.split(/\r?\n/);
      resto = lineas.pop() || "";
      for (const linea of lineas) {
        if (!linea.trim()) continue;
        try {
          const v = JSON.parse(linea);
          if (Array.isArray(v)) ultimos = v.map(String);
        } catch {
          /* una línea a medias: se espera la siguiente */
        }
      }
    });
    hijo.on("exit", () => {
      hijo = null;
      ultimos = [];
      if (!detenido) reintento = setTimeout(levantar, 15_000);
    });
    hijo.on("error", () => {
      hijo = null;
    });
  }

  levantar();
  return {
    titulos: () => ultimos.slice(),
    get viva() {
      return Boolean(hijo);
    },
    detener() {
      detenido = true;
      if (reintento) clearTimeout(reintento);
      try { hijo?.kill(); } catch { /* ya muerto */ }
      hijo = null;
    },
  };
}

// La sonda de Windows completa: qué app está en reunión, o null. Zoom primero
// (su señal es la más precisa); después, la que tenga el micrófono.
let ventanas = null; // el ayudante de títulos, levantado en la primera sonda
const memoriaNavegador = crearMemoriaDeNavegador();
async function sondaWindows() {
  if (await hayZoomEnReunion()) return "zoom";
  const app = await hayAppConMicrofono();
  if (app) return app;
  if (!ventanas) ventanas = crearSondaVentanas();
  return memoriaNavegador.recordar(reunionEnTitulos(ventanas.titulos()));
}
function detenerSondaWindows() {
  if (ventanas) ventanas.detener();
  ventanas = null;
  memoriaNavegador.olvidar();
}

// Las plataformas que la sonda simulada sabe nombrar (las mismas de la tabla,
// más zoom).
const PLATAFORMAS_SIMULABLES = new Set(["zoom", "meet", ...APPS_POR_MICROFONO.map(([app]) => app)]);

// Sonda de desarrollo/pruebas: la "reunión" es que exista un archivo. Tocarlo
// simula entrar; borrarlo, salir. El contenido dice de QUÉ app es la reunión
// simulada ("teams", "webex", "jitsi", ...); cualquier otra cosa, Zoom.
function sondaArchivo(ruta) {
  return () => {
    try {
      if (!fs.existsSync(ruta)) return Promise.resolve(null);
      const texto = fs.readFileSync(ruta, "utf8").trim().toLowerCase();
      // "meet:abc-defg-hij" simula un Meet en el navegador, con su código.
      const conCodigo = texto.match(/^([a-z-]+):([a-z0-9-]+)$/);
      if (conCodigo && PLATAFORMAS_SIMULABLES.has(conCodigo[1])) {
        return Promise.resolve({ plataforma: conCodigo[1], codigo: conCodigo[2] });
      }
      return Promise.resolve(PLATAFORMAS_SIMULABLES.has(texto) ? texto : "zoom");
    } catch {
      return Promise.resolve(null);
    }
  };
}

// Crea el vigía. Devuelve { detener() }. Llama a `alEntrar(lectura)` cuando
// la reunión empieza -- la plataforma a secas ("zoom"/"teams"/...) o, para
// las del navegador, { plataforma, codigo? } -- y `alSalir()` cuando termina
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
  detenerSondaWindows,
  sondaArchivo,
  appUsandoElMicrofono,
  teamsUsaElMicrofono,
  reunionEnTitulos,
  crearMemoriaDeNavegador,
  crearSondaVentanas,
  GRACIA_NAVEGADOR_MS,
  SCRIPT_VENTANAS,
};
