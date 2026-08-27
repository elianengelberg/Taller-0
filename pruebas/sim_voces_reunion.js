// Las voces de LOS DEMÁS en una reunión externa (el bug reportado: "sólo
// transcribía lo que hablábamos nosotros, no lo que decían los demás").
//
// El arreglo: el audio que viene con la captura de pantalla/pestaña (donde
// suenan las voces de quienes entran por Zoom/Meet/lo que sea, sin Unify) se
// pasa al reconocimiento de voz por PISTA (Chrome 139+) y cada frase entra a
// la sala como línea de "La reunión": subtítulos, transcripción y traducción
// para todos.
//
// Lo único que se fakea acá es lo que el entorno no tiene: el servicio de voz
// de Google (SpeechRecognition doble que registra si lo arrancaron CON la
// pista) y el selector de captura (getDisplayMedia devuelve un stream real de
// canvas + oscilador, con pista de audio de verdad). Todo lo demás -- la
// sala companion, el servidor, la IA correctora, la sincronización entre
// participantes -- es el stack real.
//
// Requiere: build en 4174 (serve_csp) y servidor real en 4001.
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");

const B = "http://localhost:4174";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Dobles de SpeechRecognition y getDisplayMedia, inyectados ANTES de la app.
// `conAudio` controla si la captura falsa trae pista de audio (el caso triste
// de no tildar "compartir audio" se prueba con false).
const doble = (conAudio) => `
  (() => {
    window.__recs = [];
    class FakeRec {
      constructor() {
        this.lang = ""; this.continuous = false; this.interimResults = false;
        this.maxAlternatives = 1; this.conPista = false; this.arrancada = 0;
        window.__recs.push(this);
      }
      start(pista) {
        this.arrancada += 1;
        this.conPista = pista instanceof MediaStreamTrack;
      }
      stop() { this.onend && this.onend(); }
      abort() { this.onend && this.onend(); }
    }
    FakeRec.available = async () => "available";
    window.SpeechRecognition = FakeRec;
    window.webkitSpeechRecognition = FakeRec;
    // Dispara un resultado FINAL en el reconocedor que escucha la pista de la
    // captura (los demás). Devuelve false si todavía no existe.
    window.__emitirReunion = (texto) => {
      const rec = window.__recs.find((r) => r.conPista && r.onresult);
      if (!rec) return false;
      const res = Object.assign([{ transcript: texto }], { isFinal: true });
      rec.onresult({ resultIndex: 0, results: [res] });
      return true;
    };
    // Captura falsa: video de canvas + (según el caso) audio de un oscilador.
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#123456"; ctx.fillRect(0, 0, 640, 360);
      const stream = canvas.captureStream(5);
      if (${conAudio}) {
        const actx = new AudioContext();
        const osc = actx.createOscillator();
        const dest = actx.createMediaStreamDestination();
        osc.connect(dest); osc.start();
        stream.addTrack(dest.stream.getAudioTracks()[0]);
      }
      return stream;
    };
  })();
`;

const SALA = `https://meet.jit.si/VocesReunion${Math.random().toString(36).slice(2, 8)}`;

async function entrarComoCompanion(ctx, nombre, conAudio) {
  const p = await ctx.newPage();
  await p.addInitScript(doble(conAudio));
  // Sin red externa: la capa Unify no la necesita. Por HOSTNAME, no por glob:
  // un glob sobre la URL entera también matchearía nuestra propia página, que
  // lleva el enlace de jitsi percent-encoded en el query.
  await p.route(
    (url) => url.hostname.endsWith("jit.si") || url.hostname.startsWith("fonts.g"),
    (r) => r.abort()
  );
  await p.goto(`${B}/externa?url=${encodeURIComponent(SALA)}`);
  await p.getByLabel(/Tu nombre|nombre/i).first().fill(nombre).catch(async () => {
    await p.locator("input").first().fill(nombre);
  });
  await p.getByRole("button", { name: /Unirme acá dentro/i }).click();
  await p.waitForURL(/\/externa\/reunion/, { timeout: 15000 });
  return p;
}

(async () => {
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--no-proxy-server", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const errs = [];

  // ═══════ 1. Ana entra, la captura trae audio, y "los demás" se transcriben ═══════
  console.log("\n── 1. El audio de la reunión se transcribe ──");
  const ctxA = await browser.newContext({ viewport: { width: 1200, height: 800 }, permissions: ["microphone"] });
  const ana = await entrarComoCompanion(ctxA, "Ana", true);
  ana.on("pageerror", (e) => errs.push("Ana: " + e.message.slice(0, 100)));

  // La grabación automática arranca con la captura (que acá trae audio).
  let grabando = false;
  for (let i = 0; i < 20 && !grabando; i++) {
    await dormir(500);
    grabando = await ana.evaluate(() => window.__recs.some((r) => r.conPista && r.arrancada > 0));
  }
  check("el reconocimiento de la reunión arranca CON la pista de la captura", grabando);
  check("y en el idioma elegido", await ana.evaluate(() => {
    const r = window.__recs.find((x) => x.conPista);
    return !!r && r.lang.length >= 2 && r.continuous === true;
  }));

  const emitido = await ana.evaluate(() => window.__emitirReunion("necesitamos cerrar el presupuesto mañana"));
  check("se puede inyectar una frase de los demás", emitido === true);
  await ana.getByText("La reunión").first().waitFor({ timeout: 20000 }).catch(() => {});
  check("la frase aparece etiquetada como «La reunión» (no como la voz de Ana)",
    (await ana.getByText("La reunión").count()) > 0);
  check("con el texto que se dijo",
    (await ana.getByText(/cerrar el presupuesto/i).count()) > 0);

  // ═══════ 2. Beto (otro participante) también la ve ═══════
  console.log("\n── 2. Llega a todos los presentes ──");
  const ctxB = await browser.newContext({ viewport: { width: 1200, height: 800 }, permissions: ["microphone"] });
  const beto = await entrarComoCompanion(ctxB, "Beto", true);
  await beto.getByText(/cerrar el presupuesto/i).first().waitFor({ timeout: 15000 }).catch(() => {});
  check("Beto ve la línea de «La reunión» que capturó Ana",
    (await beto.getByText(/cerrar el presupuesto/i).count()) > 0);
  await ctxB.close();

  // ═══════ 3. Captura SIN audio: aviso honesto, sin reconocedor fantasma ═══════
  console.log("\n── 3. Captura sin audio ──");
  const ctxC = await browser.newContext({ viewport: { width: 1200, height: 800 }, permissions: ["microphone"] });
  const cami = await entrarComoCompanion(ctxC, "Cami", false);
  await dormir(4000);
  check("sin audio en la captura NO se inventa un reconocedor de reunión",
    (await cami.evaluate(() => window.__recs.filter((r) => r.conPista).length)) === 0);
  check("y se avisa cómo arreglarlo (tildar «Compartir audio»)",
    (await cami.getByText(/Compartir audio/i).count()) > 0);
  await ctxC.close();

  check("sin errores de página en todo el recorrido", errs.length === 0, errs[0] || "");
  await ctxA.close();
  await browser.close();

  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} OK`);
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
