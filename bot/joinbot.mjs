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
const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");

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

// --- Adaptadores de unión, uno por plataforma -----------------------------
// Cada uno recibe la página ya navegada y devuelve true cuando el bot está
// DENTRO de la reunión (o lo mejor que se pueda afirmar sin la plataforma
// real). Devuelven false si no se pudo entrar.
const adaptadores = {
  async test(page) {
    // La página de prueba marca el ingreso con #entrar y expone que ya está
    // "en la reunión". Es lo que permite probar el resto sin Zoom.
    await page.waitForSelector("#entrar", { timeout: 8000 }).catch(() => {});
    await page.click("#entrar").catch(() => {});
    return page.evaluate(() => Boolean(document.getElementById("en-reunion"))).catch(() => false);
  },

  async jitsi(page) {
    // Jitsi: pantalla de "prejoin". Se pone el nombre y se toca "Entrar".
    // Muchas salas no piden permiso, así que el bot queda adentro directo.
    await page.waitForTimeout(4000);
    const nombre = page.locator('input[placeholder*="name" i], input[aria-label*="name" i], input[name="displayName"]').first();
    if (await nombre.count()) { await nombre.fill(BOT_NAME).catch(() => {}); }
    const entrar = page.locator(
      'div[aria-label*="Join" i], button:has-text("Join"), button:has-text("Entrar"), [data-testid="prejoin.joinMeeting"]'
    ).first();
    if (await entrar.count()) { await entrar.click().catch(() => {}); }
    await page.waitForTimeout(4000);
    // "Adentro" = existe la barra de la llamada (colgar) o el film de videos.
    return page.evaluate(() =>
      Boolean(document.querySelector('[aria-label*="Leave" i], [aria-label*="hang" i], .filmstrip, #largeVideoContainer'))
    ).catch(() => false);
  },

  async "google-meet"(page) {
    // Mejor esfuerzo: Meet suele exigir que alguien ADMITA al bot, así que
    // "entrar" acá es "pedir unirse". Los selectores cambian seguido.
    await page.waitForTimeout(5000);
    const nombre = page.locator('input[aria-label*="name" i], input[placeholder*="name" i]').first();
    if (await nombre.count()) { await nombre.fill(BOT_NAME).catch(() => {}); }
    const pedir = page.locator(
      'button:has-text("Ask to join"), button:has-text("Pedir unirse"), button:has-text("Join now"), button:has-text("Unirte ahora")'
    ).first();
    if (await pedir.count()) { await pedir.click().catch(() => {}); }
    // Espera a ser admitido: la barra de controles aparece cuando entrás.
    return page.waitForSelector('[aria-label*="Leave call" i], [aria-label*="Salir de la llamada" i]', { timeout: 90_000 })
      .then(() => true).catch(() => false);
  },

  async "zoom-web"(page) {
    // Mejor esfuerzo contra el cliente web de Zoom. Requiere afinado real.
    await page.waitForTimeout(6000);
    const nombre = page.locator('#input-for-name, input[placeholder*="name" i]').first();
    if (await nombre.count()) { await nombre.fill(BOT_NAME).catch(() => {}); }
    const entrar = page.locator('button:has-text("Join"), #joinBtn, button:has-text("Unirse")').first();
    if (await entrar.count()) { await entrar.click().catch(() => {}); }
    return page.waitForSelector('[aria-label*="mute" i], .footer__leave-btn, button:has-text("Leave")', { timeout: 90_000 })
      .then(() => true).catch(() => false);
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
  await page.evaluate(() => {
    if (window.__unifyEscuchando) return;
    window.__unifyEscuchando = true;
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    (async () => {
      let track = null;
      try {
        const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, preferCurrentTab: true });
        track = s.getAudioTracks()[0] || null;
      } catch { /* sin captura: en modo test la página emite sola */ }
      // start(pista) llegó con available() (Chrome 139); sin eso, transcribir
      // el micrófono del bot sería inútil (el bot no habla).
      if (!track || !Ctor || typeof Ctor.available !== "function") return;
      let activa = true, fallas = 0;
      const r = new Ctor();
      r.lang = "es-AR";
      r.continuous = true;
      r.interimResults = false;
      r.maxAlternatives = 3;
      r.onresult = (ev) => {
        fallas = 0;
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i];
          if (!res.isFinal) continue;
          const alts = [];
          for (let j = 0; j < res.length && j < 3; j++) { const t = res[j]?.transcript?.trim(); if (t) alts.push(t); }
          if (alts.length) window.botEmit(alts[0], alts.slice(1));
        }
      };
      r.onerror = (e) => { if (e.error !== "no-speech" && e.error !== "aborted") fallas += 1; };
      r.onend = () => { if (activa && fallas < 8 && track.readyState === "live") { try { r.start(track); } catch {} } };
      try { r.start(track); } catch {}
      window.__unifyParar = () => { activa = false; try { r.stop(); } catch {} };
    })();
  });
}

(async () => {
  log(`entrando a ${PLATFORM} :: ${MEETING_URL} :: sala ${ROOM_KEY}`);
  const browser = await chromium.launch({
    args: [
      "--no-sandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--auto-accept-this-tab-capture",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const ctx = await browser.newContext({ permissions: ["microphone", "camera"] });
  const page = await ctx.newPage();
  let saliendo = false;

  async function salir(motivo) {
    if (saliendo) return;
    saliendo = true;
    log("saliendo:", motivo);
    await postEstado({ inCall: false, participantCount: 0 });
    try { await page.evaluate(() => window.__unifyParar?.()); } catch {}
    await browser.close().catch(() => {});
    process.exit(0);
  }

  try {
    await page.goto(MEETING_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (e) {
    log("no se pudo abrir la URL:", e.message);
    await salir("url inaccesible");
    return;
  }

  const adaptador = adaptadores[PLATFORM] || adaptadores.test;
  const adentro = await adaptador(page);
  if (!adentro) {
    log("no se pudo confirmar el ingreso a la reunión");
    await salir("no ingresó");
    return;
  }
  log("adentro de la reunión");
  await postEstado({ inCall: true, participantCount: 2 });

  await arrancarEscucha(page);

  // Modo test: la página "dice" las líneas que le pasamos, simulando el
  // reconocimiento -> se prueba TODO el pipeline sin el servicio de voz.
  if (PLATFORM === "test" && process.env.BOT_TEST_LINES) {
    const lineas = JSON.parse(process.env.BOT_TEST_LINES);
    for (const l of lineas) {
      await page.evaluate((t) => window.botEmit(t, []), l);
      await page.waitForTimeout(400);
    }
  }

  // Corte de seguridad y vigilancia de fin: si la reunión se vacía (o la
  // página dice que terminó), el bot se va solo. En test la página marca fin
  // con #fin.
  const arranque = Date.now();
  const vigilante = setInterval(async () => {
    if (Date.now() - arranque > MAX_MIN * 60_000) { clearInterval(vigilante); await salir("máximo de tiempo"); return; }
    const termino = await page.evaluate(() =>
      Boolean(document.getElementById("fin")) ||
      /call ended|meeting ended|reunión finaliz|has abandonado/i.test(document.body?.innerText || "")
    ).catch(() => false);
    if (termino) { clearInterval(vigilante); await salir("la reunión terminó"); }
  }, 5000);

  // Señal externa para colgar (el servidor puede querer sacarlo).
  process.on("SIGTERM", () => void salir("SIGTERM"));
  process.on("SIGINT", () => void salir("SIGINT"));
})().catch(async (e) => {
  console.error("[bot] error fatal:", e.message);
  process.exit(1);
});
