// El BOT que entra a una reunión como un participante más (estilo el "Read AI
// Notetaker"), la escucha, la transcribe y sale cuando termina.
//
// La arquitectura es deliberadamente delgada: el bot NO reimplementa nada de
// la inteligencia. Se une a la reunión, saca texto del audio, y lo POSTea al
// MISMO bridge que ya usan la extensión y la web. El bridge se encarga de la
// corrección con IA, la traducción a todos los idiomas, el guardado en el
// historial y la transmisión en vivo a la sala companion. El bot es sólo un
// par de oídos con patas.
//
// Cómo se une, por plataforma, es lo único específico (los "adaptadores"):
//  - jitsi: entra directo (muchas salas no piden permiso). El más sólido.
//  - google-meet / zoom-web: mejor esfuerzo con los selectores de la página
//    (piden que alguien lo admita; los selectores cambian seguido -> se
//    afinan contra la plataforma real, que este entorno no alcanza).
//  - test: una página local que simula la reunión, para probar TODA la
//    cadena (unirse -> transcribir -> bridge -> salir) sin depender de Zoom
//    ni del servicio de voz.
//
// Uso:
//   MEETING_URL=... ROOM_KEY=zoom:123 SERVER_URL=http://localhost:4001 \
//   BOT_NAME="Unify Notetaker" PLATFORM=jitsi node bot/joinbot.mjs
//
// Variables:
//   MEETING_URL   la URL a la que entrar (obligatoria)
//   ROOM_KEY      la clave de sala del bridge (obligatoria; la deriva el
//                 servidor con la MISMA regla que la web, así el bot y la
//                 gente caen en una sola sala)
//   SERVER_URL    base del servidor de Unify (default http://localhost:4001)
//   BOT_NAME      cómo aparece el bot y cómo firma las líneas
//   PLATFORM      jitsi | google-meet | zoom-web | test
//   BOT_TEST_LINES  (sólo test) JSON de líneas que la página "dice", para
//                   ejercitar la cadena sin el servicio de voz real
//   MAX_MIN       corte de seguridad en minutos (default 180)
import { createRequire } from "module";
import { existsSync, createWriteStream, createReadStream, unlinkSync } from "fs";
import { Readable } from "stream";
import { tmpdir } from "os";
import { join as joinPath } from "path";
import { spawn as spawnHijo, spawnSync } from "child_process";
import { fileURLToPath } from "url";
const require = createRequire(import.meta.url);

// Playwright puede vivir en distintos lugares según el host:
//  - bot/node_modules (lo que instala bot/instalar-host.sh en el droplet),
//  - el node_modules del proyecto,
//  - la instalación global del entorno de desarrollo.
// Probamos en orden y el primero que aparezca gana.
function cargarChromium() {
  const candidatos = [
    "playwright-core",
    "playwright",
    "/opt/node22/lib/node_modules/playwright/node_modules/playwright-core",
  ];
  for (const c of candidatos) {
    try { return require(c).chromium; } catch { /* siguiente */ }
  }
  console.error(
    "[bot] no encuentro Playwright. Corré primero, desde la raíz del repo:\n" +
    "        bash bot/instalar-host.sh"
  );
  process.exit(2);
}
const chromium = cargarChromium();

// El navegador para el bot. El Chromium "de testing" de Playwright NO trae
// las llaves de Google del servicio de voz: el reconocimiento arranca pero
// muere con "network". El Google Chrome de verdad sí las trae (es el mismo
// motivo por el que la extensión funciona en el Chrome de la gente), así que
// si el host lo tiene instalado, se usa ese.
//   BOT_CHROME=/ruta   fuerza un ejecutable puntual
//   BOT_CHROMIUM=1     obliga al Chromium de Playwright (para depurar)
function ejecutableDelNavegador() {
  if (process.env.BOT_CHROMIUM) return null;
  if (process.env.BOT_CHROME) return process.env.BOT_CHROME;
  for (const p of ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/opt/google/chrome/chrome"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

const MEETING_URL = process.env.MEETING_URL;
const ROOM_KEY = process.env.ROOM_KEY;
const SERVER_URL = (process.env.SERVER_URL || "http://localhost:4001").replace(/\/+$/, "");
const BOT_NAME = (process.env.BOT_NAME || "Unify Notetaker").slice(0, 60);
const PLATFORM = process.env.PLATFORM || "test";
const MAX_MIN = Number(process.env.MAX_MIN) > 0 ? Number(process.env.MAX_MIN) : 180;

if (!MEETING_URL || !ROOM_KEY) {
  console.error("[bot] faltan MEETING_URL o ROOM_KEY");
  process.exit(2);
}

const log = (...a) => console.log("[bot]", ...a);

// --- La única salida del bot: el bridge de Unify --------------------------
// Se llama desde Node (no desde la página) por dos motivos: la página real de
// Zoom/Meet no puede hacer fetch a nuestro servidor (CORS), y así ninguna
// credencial vive en un contexto que la reunión podría espiar.
async function postLinea(texto, alts = []) {
  const t = String(texto || "").trim();
  if (!t) return;
  log("dice:", t.length > 90 ? `${t.slice(0, 90)}…` : t);
  try {
    await fetch(`${SERVER_URL}/api/meet-bridge/${encodeURIComponent(ROOM_KEY)}/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speaker: BOT_NAME, text: t, lang: process.env.BOT_LANG || "es-AR", alts }),
    });
  } catch (e) {
    log("no se pudo postear la línea:", e.message);
  }
}
async function postEstado(estado) {
  try {
    await fetch(`${SERVER_URL}/api/meet-bridge/${encodeURIComponent(ROOM_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(estado),
    });
  } catch { /* el estado es best-effort */ }
}

// --- La grabación de video de la reunión ----------------------------------
// El bot graba lo mismo que ve (la pestaña de la reunión, con su audio) y al
// salir lo sube por el MISMO camino que usa la extensión: la sesión del
// bridge da el dbId de la reunión, recording-started ancla el t=0 y
// recording-upload guarda el archivo y lo cuelga del historial. Los chunks
// van cayendo a un archivo temporal (no a memoria: una reunión larga pesa
// cientos de MB y el droplet chico no la aguantaría en RAM).
// Se apaga con BOT_GRABAR=0.
const GRABAR = process.env.BOT_GRABAR !== "0";
const TOPE_GRABACION = 700 * 1024 * 1024; // el servidor rechaza >800 MB
let recPath = null;
let recStream = null;
let recBytes = 0;
let recStartTs = 0;
let recDbId = null;
let recTope = false;

async function dbIdDeLaSala() {
  const r = await fetch(`${SERVER_URL}/api/meet-bridge/${encodeURIComponent(ROOM_KEY)}/session`);
  if (!r.ok) throw new Error(`session HTTP ${r.status}`);
  const s = await r.json();
  if (!s?.dbId) throw new Error("la sala no tiene reunión de respaldo");
  return s.dbId;
}

async function subirGrabacion() {
  if (!recStream) return;
  const stream = recStream;
  recStream = null;
  await new Promise((res) => stream.end(res));
  if (!recBytes) { try { unlinkSync(recPath); } catch {} return; }
  if (!recDbId) {
    // El aviso de inicio pudo fallar (red); un último intento antes de rendirse.
    try { recDbId = await dbIdDeLaSala(); } catch (e) { log("grabación: sin reunión adónde subirla:", e.message); }
  }
  if (!recDbId) { try { unlinkSync(recPath); } catch {} return; }
  const durationMs = Math.max(1, Date.now() - recStartTs);
  log(`grabación: subiendo ${(recBytes / 1024 / 1024).toFixed(1)} MB…`);
  try {
    const res = await fetch(
      `${SERVER_URL}/api/meetings/${encodeURIComponent(recDbId)}/recording-upload?durationMs=${Math.round(durationMs)}`,
      {
        method: "POST",
        headers: { "Content-Type": "video/webm" },
        body: Readable.toWeb(createReadStream(recPath)),
        duplex: "half",
      }
    );
    if (res.ok) log("grabación: guardada, queda en el historial de la reunión");
    else {
      const data = await res.json().catch(() => ({}));
      log(`grabación: el servidor no la aceptó (HTTP ${res.status})${data?.error ? `: ${data.error}` : ""}`);
    }
  } catch (e) {
    log("grabación: no se pudo subir:", e.message);
  }
  try { unlinkSync(recPath); } catch { /* temporal */ }
}

// --- Ayudantes de unión, compartidos por las plataformas reales ------------

// Un notetaker entra SILENCIADO y SIN CÁMARA: no habla ni se muestra, sólo
// escucha. En la pantalla previa (prejoin) de Meet/Zoom hay botones para
// apagar micrófono y cámara -- se tocan sólo si están encendidos.
async function apagarCamaraYMic(page) {
  const apagar = async (patrones) => {
    for (const p of patrones) {
      const b = page.locator(p).first();
      try {
        if ((await b.count()) && (await b.isVisible())) { await b.click({ timeout: 1500 }); return; }
      } catch { /* seguir con el próximo patrón */ }
    }
  };
  // "Turn off microphone" / "Desactivar micrófono" (si dice "Turn on", ya está apagado).
  await apagar([
    '[aria-label*="Turn off microphone" i]', '[aria-label*="Desactivar micrófono" i]',
    '[aria-label*="mute" i][aria-pressed="false"]', 'div[role="button"][aria-label*="micrófono" i][data-is-muted="false"]',
  ]);
  await apagar([
    '[aria-label*="Turn off camera" i]', '[aria-label*="Desactivar cámara" i]',
    'div[role="button"][aria-label*="cámara" i][data-is-muted="false"]',
  ]);
}

// Descarta los diálogos que Meet/Zoom ponen encima: "Got it", "Continuar sin
// micrófono", "Descartar", cookies. Se corren varias veces porque aparecen en
// tandas.
async function descartarDialogos(page) {
  const textos = [
    "Got it", "Entendido", "Dismiss", "Descartar", "Continue without microphone",
    "Continuar sin micrófono", "Continue without camera", "Continuar sin cámara",
    "Accept all", "Aceptar todo", "No thanks", "Ahora no", "Close", "Cerrar",
  ];
  for (let ronda = 0; ronda < 2; ronda++) {
    for (const t of textos) {
      const b = page.locator(`button:has-text("${t}"), [role="button"]:has-text("${t}")`).first();
      try { if ((await b.count()) && (await b.isVisible())) await b.click({ timeout: 1000 }); } catch { /* nada */ }
    }
    await page.waitForTimeout(500);
  }
}

// ¿Ya estamos DENTRO de la llamada? La barra de controles con "colgar/leave"
// es la señal más confiable en las tres plataformas.
async function estaEnLlamada(page) {
  return page.evaluate(() =>
    Boolean(document.querySelector(
      '[aria-label*="Leave call" i], [aria-label*="Salir de la llamada" i], [aria-label*="Abandonar" i], ' +
      '[aria-label*="Leave" i], .filmstrip, #largeVideoContainer, .footer__leave-btn, [aria-label*="End" i]'
    ))
  ).catch(() => false);
}

// ¿Nos rebotaron? (denegado, expulsado, sala llena). Para no esperar de gusto.
async function fueRechazado(page) {
  return page.evaluate(() =>
    /no one responded|nadie respondió|denied|denegad|removed you|te quitó|meeting is full|reunión está llena|you can't join|no podés unirte/i
      .test(document.body?.innerText || "")
  ).catch(() => false);
}

// Espera a ser admitido (sala de espera de Meet/Zoom): sondea hasta que
// aparece la barra de la llamada, o hasta el tope, o hasta que rebotan.
async function esperarAdmision(page, ms) {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) {
    if (await estaEnLlamada(page)) return true;
    if (await fueRechazado(page)) {
      motivoFallo = "La reunión rechazó al bot (lo denegaron, lo sacaron o la sala está llena).";
      return false;
    }
    await page.waitForTimeout(2000);
  }
  motivoFallo = "Nadie admitió al bot: la solicitud le aparece al anfitrión dentro de la reunión.";
  return false;
}

// El PORQUÉ de un ingreso fallido, para contárselo a la persona que mandó el
// bot (viaja por el bridge como botDetalle). Antes el bot moría en silencio
// y el botón quedaba en "mandado" para siempre.
let motivoFallo = null;

// Jitsi acepta configuración por el fragmento de la URL: entrar YA silenciado,
// SIN cámara, sin pantalla previa y con el nombre puesto. Es la forma robusta
// -- no depende de selectores que cambian, y evita que el bot transmita la
// "cámara falsa" de Chromium (la pantalla verde con el contador).
function urlJitsiSilenciosa(raw) {
  const extras =
    "config.startWithAudioMuted=true" +
    "&config.startWithVideoMuted=true" +
    "&config.prejoinConfig.enabled=false" +
    `&userInfo.displayName=${encodeURIComponent(`"${BOT_NAME}"`)}`;
  return raw + (raw.includes("#") ? "&" : "#") + extras;
}

// ¿Cuánta gente hay en la sala? En Jitsi el objeto global APP lo dice de
// verdad; si no, el globito del botón de participantes. null = no se sabe
// (y entonces NO se toman decisiones con esto).
async function contarParticipantes(page) {
  return page
    .evaluate(() => {
      try {
        const n = window.APP?.conference?.membersCount;
        if (Number.isFinite(n) && n > 0) return n;
      } catch { /* no es Jitsi */ }
      const badge = document.querySelector(
        '[data-testid="participantsCountBadge"], .badge-round, .toolbox-badge, .participants-count'
      );
      const m = Number(badge?.textContent?.trim());
      return Number.isFinite(m) && m > 0 ? m : null;
    })
    .catch(() => null);
}

// --- Adaptadores de unión, uno por plataforma -----------------------------
// Cada uno recibe la página ya navegada y devuelve true cuando el bot está
// DENTRO de la reunión. Los de Meet/Zoom son "mejor esfuerzo": los selectores
// de esas páginas cambian seguido y se afinan contra la plataforma viva.
const ADMISION_MS = Number(process.env.ADMISION_MS) > 0 ? Number(process.env.ADMISION_MS) : 120_000;

const adaptadores = {
  async test(page) {
    await page.waitForSelector("#entrar", { timeout: 8000 }).catch(() => {});
    await page.click("#entrar").catch(() => {});
    return page.evaluate(() => Boolean(document.getElementById("en-reunion"))).catch(() => false);
  },

  async jitsi(page) {
    // Jitsi: pantalla de prejoin. Nombre, apagar cam/mic, entrar. Muchas salas
    // no piden permiso, así que el bot queda adentro directo -- por eso es el
    // camino más sólido para arrancar en producción.
    await page.waitForTimeout(4000);
    await descartarDialogos(page);
    const nombre = page.locator('input[placeholder*="name" i], input[aria-label*="name" i], input[name="displayName"]').first();
    if (await nombre.count()) { await nombre.fill(BOT_NAME).catch(() => {}); }
    await apagarCamaraYMic(page);
    const entrar = page.locator(
      '[data-testid="prejoin.joinMeeting"], div[aria-label*="Join" i], button:has-text("Join"), button:has-text("Entrar")'
    ).first();
    if (await entrar.count()) { await entrar.click().catch(() => {}); }
    return esperarAdmision(page, ADMISION_MS);
  },

  async "google-meet"(page) {
    // Google Meet exige, casi siempre, que alguien ADMITA al bot ("Ask to
    // join"), y que la cuenta esté INICIADA (Google bloquea invitados anónimos
    // en muchas reuniones). Por eso conviene el perfil persistente con una
    // sesión de Google ya abierta (ver BOT_PROFILE_DIR en el README).
    await page.waitForTimeout(5000);
    // El botón, con REINTENTOS: Meet carga lento y cambia sus textos seguido.
    // Y si en vez del prejoin hay una PARED (iniciá sesión, navegador no
    // soportado), se dice claro en vez de esperar a ciegas hasta el timeout.
    const BOTON =
      'button:has-text("Ask to join"), button:has-text("Pedir unirse"), ' +
      'button:has-text("Solicitar unirse"), button:has-text("Join now"), ' +
      'button:has-text("Unirte ahora"), button:has-text("Unirse ahora"), ' +
      'button:has-text("Unirme ahora"), button:has-text("Participar"), ' +
      'button:has-text("Join anyway"), button:has-text("Unirse de todos modos")';
    let pidio = false;
    // 20 intentos ≈ un minuto de paciencia: en un host chico, el Chrome con
    // un perfil sincronizado tarda MUCHO en dejar lista la pantalla de Meet
    // (la primera falla real fue exactamente esta: el bot se rindió a los
    // ~30s con Meet todavía cargando).
    for (let intento = 0; intento < 20 && !pidio; intento++) {
      await descartarDialogos(page);
      // Nombre sólo si Meet lo pide (invitado sin sesión).
      const nombre = page.locator(
        'input[aria-label*="name" i], input[placeholder*="name" i], input[aria-label*="nombre" i]'
      ).first();
      if (await nombre.count()) { await nombre.fill(BOT_NAME).catch(() => {}); }
      await apagarCamaraYMic(page);
      const entrar = page.locator(BOTON).first();
      if (await entrar.count()) {
        await entrar.click().catch(() => {});
        pidio = true;
        break;
      }
      const cuerpo = ((await page.locator("body").textContent().catch(() => "")) || "").slice(0, 4000);
      // Un pedazo de la pantalla real, para el diagnóstico: "qué vio el bot"
      // vale más que cualquier adivinanza nuestra.
      const vista = ` Lo que vio el bot: "${cuerpo.replace(/\s+/g, " ").trim().slice(0, 110)}…"`;
      if (/sign in|inicia sesión|iniciá sesión|debes acceder|use your google account|usa tu cuenta de google/i.test(cuerpo)) {
        motivoFallo =
          "Google exigió una cuenta iniciada para dejar entrar al bot. En el host del bot hay " +
          "que dejarle una sesión de Google (BOT_PROFILE_DIR, ver bot/README.md)." + vista;
        return false;
      }
      if (/can't join|you can't|no puedes unirte|no podés unirte|no se puede unir/i.test(cuerpo)) {
        // La pantalla "No puedes unirte a esta llamada": para un invitado
        // anónimo, casi siempre significa "esta reunión pide cuenta iniciada".
        motivoFallo =
          "Meet no dejó entrar al bot como invitado (pantalla \"No puedes unirte\"). Casi " +
          "siempre pide una cuenta de Google iniciada: configurá BOT_PROFILE_DIR en el host " +
          "(bot/README.md, paso 3)." + vista;
        return false;
      }
      if (/not supported|no es compatible|update your browser|actualiza tu navegador|unsupported/i.test(cuerpo)) {
        motivoFallo =
          "Meet rechazó al NAVEGADOR del bot. En el host conviene el Google Chrome real: " +
          "bash bot/instalar-host.sh lo instala." + vista;
        return false;
      }
      if (/check your meeting code|comprueba el código|verificá el código|invalid/i.test(cuerpo)) {
        motivoFallo = "Meet dice que el código de la reunión no es válido." + vista;
        return false;
      }
      await page.waitForTimeout(3000);
    }
    if (!pidio) {
      const cuerpoFinal = ((await page.locator("body").textContent().catch(() => "")) || "")
        .replace(/\s+/g, " ").trim().slice(0, 160);
      motivoFallo =
        "No apareció el botón para pedir entrar (Meet no cargó o cambió su pantalla). " +
        `Lo que vio el bot: "${cuerpoFinal}…"`;
      return false;
    }
    await postEstado({ botFase: "esperando-admision" });
    // Puede quedar "esperando que te dejen entrar": esperarAdmision aguanta eso.
    return esperarAdmision(page, ADMISION_MS);
  },

  async "zoom-web"(page) {
    // Cliente web de Zoom (app.zoom.us/wc/...). El camino robusto de verdad es
    // el Zoom Meeting SDK con credenciales de app; este es el del navegador,
    // que sirve para salas sin restricción. Maneja el "unirse desde el
    // navegador", el nombre, y unir el audio por computadora.
    await page.waitForTimeout(6000);
    await descartarDialogos(page);
    // "Join from your browser" / "Unirse desde el navegador", si aparece.
    const desdeNavegador = page.locator(
      'a:has-text("Join from your browser"), a:has-text("desde el navegador"), button:has-text("Join from Browser")'
    ).first();
    try { if (await desdeNavegador.count()) await desdeNavegador.click({ timeout: 2000 }); } catch { /* ya en el cliente */ }
    await page.waitForTimeout(2000);
    const nombre = page.locator('#input-for-name, input[placeholder*="name" i], input[placeholder*="nombre" i]').first();
    if (await nombre.count()) { await nombre.fill(BOT_NAME).catch(() => {}); }
    const entrar = page.locator('#joinBtn, button:has-text("Join"), button:has-text("Unirse")').first();
    if (await entrar.count()) { await entrar.click().catch(() => {}); }
    const admitido = await esperarAdmision(page, ADMISION_MS);
    // Unir el audio por computadora (si Zoom lo pregunta) para poder escuchar.
    const unirAudio = page.locator(
      'button:has-text("Join Audio by Computer"), button:has-text("Unirse al audio por computadora"), button:has-text("Computer Audio")'
    ).first();
    try { if (await unirAudio.count()) await unirAudio.click({ timeout: 2000 }); } catch { /* nada */ }
    return admitido;
  },
};

// La captura de audio + reconocimiento, inyectada en la página YA adentro.
// Reusa la técnica de la extensión: tomar la pista de audio de la pestaña y
// dársela al reconocimiento del navegador (Chrome 139+). Cada frase final
// sube al bridge por el puente `botEmit`. En modo test la página llama a
// botEmit directamente, así se prueba el pipeline sin el servicio de voz.
async function arrancarEscucha(page) {
  await page.exposeFunction("botEmit", async (texto, alts) => {
    await postLinea(texto, Array.isArray(alts) ? alts : []);
  });
  // El diagnóstico de la escucha sale por la consola del bot: es lo que
  // permite ver, en un host nuevo, exactamente en qué eslabón se corta la
  // cadena (captura de audio -> reconocimiento -> bridge).
  await page.exposeFunction("botDiag", (m) => log("escucha:", m));
  // Los chunks del video llegan por acá (base64) y caen al archivo temporal.
  await page.exposeFunction("botChunk", (b64) => {
    if (!recStream || recTope) return;
    const buf = Buffer.from(b64, "base64");
    recBytes += buf.length;
    if (recBytes > TOPE_GRABACION) {
      recTope = true;
      log("grabación: llegó al tope de tamaño; se corta acá (la transcripción sigue)");
      page.evaluate(() => window.__unifyPararGrabacion?.()).catch(() => {});
      return;
    }
    recStream.write(buf);
  });
  // El recorder arrancó: anclar el t=0 en el servidor (recording-started),
  // igual que hace la extensión, para que el video y el transcripto queden
  // sincronizados en el reproductor del historial.
  await page.exposeFunction("botGrabando", async () => {
    recStartTs = Date.now();
    try {
      recDbId = await dbIdDeLaSala();
      await fetch(`${SERVER_URL}/api/meetings/${encodeURIComponent(recDbId)}/recording-started`, { method: "POST" });
      log("grabación: video de la reunión GRABÁNDOSE (reunión", recDbId + ")");
    } catch (e) {
      log("grabación: no pude avisar el inicio:", e.message);
    }
  });
  if (GRABAR) {
    recPath = joinPath(tmpdir(), `unify-bot-${process.pid}.webm`);
    recStream = createWriteStream(recPath);
  }
  await page.evaluate(({ grabar, kbps, lang }) => {
    if (window.__unifyEscuchando) return;
    window.__unifyEscuchando = true;
    const diag = (m) => { try { window.botDiag(String(m)); } catch { /* sin diag */ } };
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    (async () => {
      // --- La VOZ de la reunión: directo de los reproductores de la página --
      // Jitsi/Meet ponen el audio de cada participante en un <audio>/<video>.
      // Mezclarlos con WebAudio da la señal REAL de la reunión, sin depender
      // de la captura de pantalla (cuyo audio puede venir falso o mudo según
      // los flags del navegador -- exactamente lo que arruinó la primera
      // grabación real). Los elementos aparecen de a poco: se barre al inicio,
      // con un observador y cada 3 s.
      let mezclaTrack = null;
      let mezclados = 0;
      let ctxA = null;
      let dest = null;
      try {
        ctxA = new AudioContext();
        dest = ctxA.createMediaStreamDestination();
        const vistos = new WeakSet();
        const conectar = (el) => {
          if (vistos.has(el)) return;
          try {
            const src = el.srcObject instanceof MediaStream
              ? el.srcObject
              : (typeof el.captureStream === "function" ? el.captureStream() : null);
            if (!src || !src.getAudioTracks().length) return;
            ctxA.createMediaStreamSource(src).connect(dest);
            vistos.add(el);
            mezclados++;
            diag(`voz: mezclando el audio de ${mezclados} reproductor(es) de la reunión`);
          } catch { /* ese elemento todavía no tiene audio */ }
        };
        const barrer = () => document.querySelectorAll("audio, video").forEach(conectar);
        barrer();
        new MutationObserver(barrer).observe(document.documentElement, { childList: true, subtree: true });
        setInterval(barrer, 3000);
        void ctxA.resume().catch(() => {});
        mezclaTrack = dest.stream.getAudioTracks()[0] || null;
      } catch (e) {
        diag(`no pude armar la mezcla de audio: ${e?.message || e}`);
      }

      // --- La IMAGEN: captura de la pestaña (para el video de la grabación) --
      let s = null;
      try {
        s = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
          audio: true,
          preferCurrentTab: true,
        });
        const dim = s.getVideoTracks()[0]?.getSettings?.() ?? {};
        diag(`capturando la pestaña para el video (${dim.width || "?"}x${dim.height || "?"})`);
      } catch (e) {
        diag(`no pude capturar la pestaña (la grabación saldrá sin video): ${e?.name || e}`);
      }

      // El audio propio de la captura se SUMA a la mezcla y se SACA del
      // stream: si quedaran dos pistas de audio, el reproductor del historial
      // usa la primera -- que puede ser la muda -- y el video "no se escucha"
      // aunque la transcripción funcione (pasó en la primera prueba real).
      if (s && ctxA && dest) {
        for (const t of s.getAudioTracks()) {
          try { ctxA.createMediaStreamSource(new MediaStream([t])).connect(dest); } catch { /* sin audio útil */ }
          try { s.removeTrack(t); } catch { /* ya no estaba */ }
        }
      }

      // La voz para el reconocimiento: la mezcla real primero; el audio de la
      // captura sólo como último recurso.
      const track = mezclaTrack || (s && s.getAudioTracks()[0]) || null;
      diag(
        mezclaTrack
          ? "voz: usando la mezcla de los reproductores"
          : track
            ? "voz: usando el audio de la captura de pestaña"
            : "SIN pista de voz -- no va a haber transcripción"
      );

      // La grabación: el stream de captura MUTADO (no uno compuesto a mano,
      // que en este entorno queda mudo): su video + UNA sola pista de audio,
      // la mezcla real (reproductores de la reunión + el audio de la captura,
      // todo junto). vp9 si el navegador puede (mejor calidad por bit), vp8
      // si no; el bitrate se ajusta con BOT_VIDEO_KBPS.
      if (grabar && s) {
        try {
          if (mezclaTrack) { try { s.addTrack(mezclaTrack); } catch { /* ya estaba */ } }
          const opciones = { videoBitsPerSecond: kbps * 1000, audioBitsPerSecond: 128_000 };
          let mr;
          try { mr = new MediaRecorder(s, { ...opciones, mimeType: "video/webm;codecs=vp9,opus" }); }
          catch {
            try { mr = new MediaRecorder(s, { ...opciones, mimeType: "video/webm;codecs=vp8,opus" }); }
            catch { mr = new MediaRecorder(s); }
          }
          mr.ondataavailable = async (ev) => {
            try {
              if (!ev.data || !ev.data.size) return;
              const bytes = new Uint8Array(await ev.data.arrayBuffer());
              let bin = "";
              for (let i = 0; i < bytes.length; i += 0x8000) {
                bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
              }
              window.botChunk(btoa(bin));
            } catch (e) {
              diag(`grabador: un chunk falló: ${e?.message || e}`);
            }
          };
          mr.onstart = () => window.botGrabando();
          mr.onerror = (e) => diag(`grabador: error: ${e?.error?.message || e?.error || "?"}`);
          mr.start(3000);
          // Forzamos un chunk cada 2 s con requestData(): sin esto, una
          // reunión con poco movimiento (una pantalla compartida quieta, una
          // charla con las cámaras apagadas) puede no emitir datos por mucho
          // rato y perderse el principio si el bot sale antes del primer corte.
          const latido = setInterval(() => { try { if (mr.state === "recording") mr.requestData(); } catch { /* nada */ } }, 2000);
          const stopViejo = mr.stop.bind(mr);
          mr.stop = () => { clearInterval(latido); try { stopViejo(); } catch { /* ya paró */ } };
          window.__unifyPararGrabacion = () =>
            new Promise((res) => {
              if (mr.state === "inactive") { res(); return; }
              mr.onstop = res;
              try { mr.stop(); } catch { res(); }
            });
        } catch (e) {
          diag(`no pude grabar el video: ${e?.message || e}`);
        }
      }
      // start(pista) llegó con available() (Chrome 139); sin eso, transcribir
      // el micrófono del bot sería inútil (el bot no habla).
      if (!track) return;
      if (!Ctor) { diag("este navegador no trae SpeechRecognition"); return; }
      if (typeof Ctor.available !== "function") { diag("SpeechRecognition sin soporte de pista (Chrome < 139)"); return; }
      try {
        const disp = await Ctor.available({ langs: ["es-AR"], processLocally: false });
        diag(`reconocimiento disponible: ${disp}`);
      } catch (e) { diag(`available() falló: ${e?.message || e}`); }
      let activa = true, fallas = 0;
      const r = new Ctor();
      r.lang = lang;
      r.continuous = true;
      r.interimResults = false;
      r.maxAlternatives = 3;
      // El reconocimiento corta las frases donde respira, no donde terminan:
      // "quedamos entonces" / "en revisar los números" quedaban como dos
      // líneas sueltas y el transcripto se leía picado. Los fragmentos se
      // juntan y se mandan como UNA frase cuando hay una pausa de verdad
      // (~2 s sin hablar) o cuando ya se armó una oración larga. Las
      // alternativas sólo viajan cuando el fragmento va solo (al juntar
      // varias, mezclar sus alternativas no tiene sentido).
      let pendiente = "";
      let pendAlts = [];
      let pendPartes = 0;
      let timerFrase = null;
      const soltar = () => {
        if (timerFrase) { clearTimeout(timerFrase); timerFrase = null; }
        const t = pendiente.trim();
        const alts = pendPartes === 1 ? pendAlts : [];
        pendiente = ""; pendAlts = []; pendPartes = 0;
        if (t) window.botEmit(t, alts);
      };
      r.onresult = (ev) => {
        fallas = 0;
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i];
          if (!res.isFinal) continue;
          const alts = [];
          for (let j = 0; j < res.length && j < 3; j++) { const t = res[j]?.transcript?.trim(); if (t) alts.push(t); }
          if (!alts.length) continue;
          pendiente = pendiente ? `${pendiente} ${alts[0]}` : alts[0];
          pendAlts = alts.slice(1);
          pendPartes++;
          if (pendiente.length > 220) soltar();
          else {
            if (timerFrase) clearTimeout(timerFrase);
            timerFrase = setTimeout(soltar, 2000);
          }
        }
      };
      r.onerror = (e) => {
        if (e.error !== "no-speech" && e.error !== "aborted") { fallas += 1; diag(`error del reconocimiento: ${e.error}`); }
      };
      r.onend = () => {
        if (activa && fallas < 8 && track.readyState === "live") { try { r.start(track); } catch {} }
        else if (activa) { soltar(); diag(`reconocimiento DETENIDO (errores seguidos=${fallas}, pista=${track.readyState})`); }
      };
      try { r.start(track); diag(`reconocimiento ARRANCADO sobre la pista de la reunión (${lang})`); } catch (e) { diag(`start() falló: ${e?.message || e}`); }
      window.__unifyParar = () => { activa = false; soltar(); try { r.stop(); } catch {} };
    })();
  }, {
    grabar: GRABAR,
    kbps: Number(process.env.BOT_VIDEO_KBPS) > 0 ? Number(process.env.BOT_VIDEO_KBPS) : 2000,
    lang: process.env.BOT_LANG || "es-AR",
  });
}

(async () => {
  // La captura de pestaña (el VIDEO de la grabación) necesita una pantalla:
  // en headless puro getDisplayMedia tira NotSupportedError. Si no hay
  // DISPLAY pero el host tiene xvfb (lo instala instalar-host.sh), el bot se
  // relanza a sí mismo bajo una pantalla VIRTUAL y sigue como si nada. Si no
  // hay xvfb, continúa headless: transcribe igual, pero graba sin video.
  if (!process.env.DISPLAY && !process.env.__UNIFY_XVFB) {
    const hay = spawnSync("xvfb-run", ["--help"], { stdio: "ignore" });
    if (!hay.error) {
      log("sin pantalla: me relanzo bajo xvfb (pantalla virtual) para poder grabar video");
      const hijo = spawnHijo(
        "xvfb-run",
        ["-a", "-s", "-screen 0 1920x1080x24", process.execPath, fileURLToPath(import.meta.url)],
        { env: { ...process.env, __UNIFY_XVFB: "1" }, stdio: "inherit" }
      );
      process.on("SIGTERM", () => hijo.kill("SIGTERM"));
      process.on("SIGINT", () => hijo.kill("SIGINT"));
      hijo.on("exit", (code) => process.exit(code ?? 0));
      await new Promise(() => {}); // el hijo es el bot; este proceso sólo espera
    }
    log("sin pantalla y sin xvfb: sigo headless (la grabación saldrá sin video)");
  }

  log(`entrando a ${PLATFORM} :: ${MEETING_URL} :: sala ${ROOM_KEY}`);
  const args = [
    "--no-sandbox",
    // OJO: acá NO va --use-fake-ui-for-media-stream. Ese flag "auto-acepta"
    // la captura de pantalla entregando DISPOSITIVOS FALSOS: el video verde
    // con contador y un audio mudo -- la primera grabación real salió así y
    // el reconocimiento no escuchó nada. Los permisos de cam/mic los da
    // Playwright (permissions) y la captura de pestaña la acepta el flag de
    // abajo, con la pestaña REAL.
    "--auto-accept-this-tab-capture", // deja capturar la pestaña sin selector
    "--autoplay-policy=no-user-gesture-required",
  ];
  // Cámara/micrófono FALSOS sólo si el bot NO usa un perfil real: con un perfil
  // persistente (sesión de Google de verdad) conviene no falsear dispositivos.
  // Igual el bot entra silenciado y sin cámara -- los dispositivos falsos son
  // sólo para que Meet/Zoom no se traben pidiendo permisos.
  if (!process.env.BOT_PROFILE_DIR) args.push("--use-fake-device-for-media-stream");

  // Perfil persistente: la clave para Google Meet. Iniciás sesión de Google
  // UNA vez en ese perfil (ver README) y el bot reusa esa sesión, así Meet lo
  // deja entrar como una cuenta de verdad en vez de rebotar al invitado anónimo.
  let browser = null;
  let ctx;
  const ejecutable = ejecutableDelNavegador();
  if (ejecutable) log("navegador: Chrome del sistema en", ejecutable);
  else log("navegador: el Chromium de Playwright (ojo: su servicio de voz suele fallar con \"network\"; instalá Google Chrome con bot/instalar-host.sh)");
  const conEjecutable = ejecutable ? { executablePath: ejecutable } : {};
  // Con pantalla (real o xvfb) el navegador va CON CABEZA: es lo que hace
  // funcionar la captura de pestaña. Sin pantalla, headless.
  const headless = !process.env.DISPLAY;
  if (process.env.BOT_PROFILE_DIR) {
    // Si el Chrome anterior del perfil murió mal (o lo mataron con pkill,
    // como en el ritual del login por VNC), quedan locks que hacen fallar
    // el arranque con "profile is already in use". Se limpian: acá nunca
    // hay dos bots sobre el mismo perfil a la vez.
    for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      try { unlinkSync(joinPath(process.env.BOT_PROFILE_DIR, f)); } catch { /* no estaba */ }
    }
    ctx = await chromium.launchPersistentContext(process.env.BOT_PROFILE_DIR, {
      args,
      ...conEjecutable,
      headless,
      permissions: ["microphone", "camera"],
      viewport: { width: 1920, height: 1080 },
    });
  } else {
    browser = await chromium.launch({ args, ...conEjecutable, headless });
    ctx = await browser.newContext({ permissions: ["microphone", "camera"], viewport: { width: 1920, height: 1080 } });
  }
  const page = ctx.pages()[0] || (await ctx.newPage());
  let saliendo = false;

  async function salir(motivo) {
    if (saliendo) return;
    saliendo = true;
    log("saliendo:", motivo);
    await postEstado({ inCall: false, participantCount: 0 });
    try { await page.evaluate(() => window.__unifyParar?.()); } catch {}
    // Cerrar la grabación ANTES de cerrar el navegador: stop() dispara el
    // último chunk, que todavía tiene que viajar por el puente botChunk.
    try { await page.evaluate(() => window.__unifyPararGrabacion?.()); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
    await subirGrabacion();
    if (browser) await browser.close().catch(() => {});
    else await ctx.close().catch(() => {});
    process.exit(0);
  }

  await postEstado({ botFase: "abriendo" });
  try {
    const destino = PLATFORM === "jitsi" ? urlJitsiSilenciosa(MEETING_URL) : MEETING_URL;
    await page.goto(destino, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (e) {
    log("no se pudo abrir la URL:", e.message);
    await postEstado({ botFase: "fallo", botDetalle: "No se pudo abrir el enlace de la reunión desde el host del bot." });
    await salir("url inaccesible");
    return;
  }

  const adaptador = adaptadores[PLATFORM] || adaptadores.test;
  const adentro = await adaptador(page);
  if (!adentro) {
    log("no se pudo confirmar el ingreso a la reunión");
    // El motivo también al journal: así el diagnóstico se lee acá mismo,
    // sin depender de que alguien mire el botón de la web a tiempo.
    log("motivo:", motivoFallo || "(sin motivo detectado)");
    await postEstado({
      botFase: "fallo",
      botDetalle: motivoFallo || "La reunión no admitió al bot y no se pudo saber por qué.",
    });
    await salir("no ingresó");
    return;
  }
  log("adentro de la reunión");
  await postEstado({ inCall: true, participantCount: 2, botFase: "adentro" });

  await arrancarEscucha(page);

  // Modo test: la página "dice" las líneas que le pasamos, simulando el
  // reconocimiento -> se prueba TODO el pipeline sin el servicio de voz.
  if (PLATFORM === "test" && process.env.BOT_TEST_LINES) {
    const lineas = JSON.parse(process.env.BOT_TEST_LINES);
    for (const l of lineas) {
      await page.evaluate((t) => window.botEmit(t, []), l);
      await page.waitForTimeout(400);
    }
    // BOT_TEST_EXIT: sale por el camino LIMPIO (el mismo que en producción usa
    // el vigilante al vaciarse la reunión), para poder probar la subida de la
    // grabación de punta a punta, sin depender de un SIGTERM que corta a la
    // mitad. Espera un poco a que caiga al menos un chunk de video.
    if (process.env.BOT_TEST_EXIT) {
      await page.waitForTimeout(2500);
      await salir("fin de prueba");
      return;
    }
  }

  // Corte de seguridad y vigilancia de fin: si la reunión se vacía (o la
  // página dice que terminó), el bot se va solo. En test la página marca fin
  // con #fin.
  const arranque = Date.now();
  let controlesFueraDesde = 0; // barra de llamada ausente desde este instante
  let soloDesde = 0; // el bot es el único participante desde este instante
  let vioGente = false; // ¿alguna vez hubo alguien más en la sala?
  // Dos paciencias distintas, a propósito:
  //  - Al FINAL (ya hubo gente y se fueron): 60 s y chau (SOLO_MS).
  //  - Al PRINCIPIO (nadie llegó todavía): la gente llega tarde a las
  //    reuniones; esperar sólo un minuto haría que el bot del calendario se
  //    fuera antes de que entre nadie. Default 5 min (ESPERA_INICIO_MS).
  const SOLO_MS = Number(process.env.SOLO_MS) > 0 ? Number(process.env.SOLO_MS) : 60_000;
  const ESPERA_INICIO_MS =
    Number(process.env.ESPERA_INICIO_MS) > 0 ? Number(process.env.ESPERA_INICIO_MS) : 5 * 60_000;
  const vigilante = setInterval(async () => {
    if (Date.now() - arranque > MAX_MIN * 60_000) { clearInterval(vigilante); await salir("máximo de tiempo"); return; }
    // 1. La reunión dice explícitamente que terminó, o nos sacaron.
    const termino = await page.evaluate(() =>
      Boolean(document.getElementById("fin")) ||
      /call ended|meeting ended|reunión finaliz|has abandonado|you (have )?left|removed you|te quitó|returned to home/i
        .test(document.body?.innerText || "")
    ).catch(() => false);
    if (termino) { clearInterval(vigilante); await salir("la reunión terminó"); return; }
    if (PLATFORM !== "test") {
      // 2. El bot quedó SOLO en la sala un buen rato: todos se fueron (o nadie
      //    vino). Se cuenta de verdad (APP.conference en Jitsi, el globito de
      //    participantes si no); cuando no se puede saber, no se decide nada.
      const gente = await contarParticipantes(page);
      if (gente !== null) {
        if (gente >= 2) {
          vioGente = true;
          soloDesde = 0;
        } else {
          const paciencia = vioGente ? SOLO_MS : ESPERA_INICIO_MS;
          if (!soloDesde) {
            soloDesde = Date.now();
            log(
              vioGente
                ? `quedé solo en la sala; espero ${Math.round(paciencia / 1000)} s por si vuelven`
                : `todavía no llegó nadie; espero hasta ${Math.round(paciencia / 60000)} min`
            );
          } else if (Date.now() - soloDesde > paciencia) {
            clearInterval(vigilante);
            await salir(vioGente ? "la sala quedó vacía" : "no vino nadie");
            return;
          }
        }
      }
      // 3. La barra de la llamada desapareció y no vuelve en ~15 s: la reunión
      //    se cerró o nos echó.
      const enLlamada = await estaEnLlamada(page);
      if (enLlamada) {
        controlesFueraDesde = 0;
      } else {
        if (!controlesFueraDesde) controlesFueraDesde = Date.now();
        else if (Date.now() - controlesFueraDesde > 15_000) { clearInterval(vigilante); await salir("la barra de la llamada desapareció"); return; }
      }
    }
  }, 5000);

  // Señal externa para colgar (el servidor puede querer sacarlo).
  process.on("SIGTERM", () => void salir("SIGTERM"));
  process.on("SIGINT", () => void salir("SIGINT"));
})().catch(async (e) => {
  console.error("[bot] error fatal:", e.message);
  // El fallo también viaja al botón de la web: un bot que muere ANTES de
  // cualquier fase (el navegador no arrancó, el perfil trabado) dejaba a la
  // persona esperando sin ninguna señal.
  await postEstado({
    botFase: "fallo",
    botDetalle: `El bot se cayó antes de entrar: ${String(e?.message || e).slice(0, 180)}`,
  });
  process.exit(1);
});
