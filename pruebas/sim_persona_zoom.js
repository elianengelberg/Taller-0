// UNA PERSONA usando Unify en un Zoom, de punta a punta, contra el stack real.
//
// El guion: Ana (cuenta real) está en una reunión de la app de Zoom; la app de
// escritorio de Unify le abrió la barra acompañante. Ana graba la pantalla,
// habla, LOS DEMÁS hablan en inglés (gente sin Unify, su voz llega por el
// audio de la captura), y Ana ve los subtítulos de todos CON la traducción al
// castellano sin tocar nada. Zoom se cierra: la barra corta sola, sube la
// grabación y la deja mirando el detalle en su historial.
//
// Fakes sólo donde el entorno no llega (el servicio de voz de Google y el
// selector de captura de Chrome); todo lo demás -- servidor, salas, IA
// correctora, traducción, subida, historial -- es real. También se inspecciona
// la CALIDAD pedida al grabador (bitrates/mime) envolviendo MediaRecorder.
//
// Requiere: build en 4174 (serve_csp) y servidor real en 4001.
const http = require("http");
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");

const B = "http://localhost:4174";
const API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const PUERTO_PUENTE = 47125;

const DOBLES = `
  (() => {
    window.__recs = [];
    class FakeRec {
      constructor() {
        this.lang = ""; this.continuous = false; this.interimResults = false;
        this.maxAlternatives = 1; this.conPista = false; this.arrancada = 0;
        window.__recs.push(this);
      }
      start(pista) { this.arrancada += 1; this.conPista = pista instanceof MediaStreamTrack; }
      stop() { this.onend && this.onend(); }
      abort() { this.onend && this.onend(); }
    }
    FakeRec.available = async () => "available";
    window.SpeechRecognition = FakeRec;
    window.webkitSpeechRecognition = FakeRec;
    const emitir = (rec, texto) => {
      const res = Object.assign([{ transcript: texto }], { isFinal: true });
      rec.onresult({ resultIndex: 0, results: [res] });
      return true;
    };
    // La voz de Ana (micrófono: reconocedor SIN pista).
    window.__emitirPropia = (texto) => {
      const rec = window.__recs.find((r) => !r.conPista && r.onresult && r.arrancada > 0);
      return rec ? emitir(rec, texto) : false;
    };
    // Las voces de los demás (el audio de la captura: reconocedor CON pista).
    window.__emitirReunion = (texto) => {
      const rec = window.__recs.find((r) => r.conPista && r.onresult);
      return rec ? emitir(rec, texto) : false;
    };
    // Captura falsa con pista de audio de verdad (canvas + oscilador).
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#123456"; ctx.fillRect(0, 0, 1280, 720);
      const stream = canvas.captureStream(10);
      const actx = new AudioContext();
      const osc = actx.createOscillator();
      const dest = actx.createMediaStreamDestination();
      osc.connect(dest); osc.start();
      stream.addTrack(dest.stream.getAudioTracks()[0]);
      return stream;
    };
    // Espía de calidad: con qué opciones se crea el grabador de verdad.
    window.__recOpts = [];
    const RealMR = window.MediaRecorder;
    window.MediaRecorder = class extends RealMR {
      constructor(stream, opts) { super(stream, opts); window.__recOpts.push(opts || {}); }
    };
    window.MediaRecorder.isTypeSupported = RealMR.isTypeSupported.bind(RealMR);
  })();
`;

async function api(ruta, init) {
  const res = await fetch(`${API}${ruta}`, init);
  let body = null;
  try { body = await res.json(); } catch { /* sin json */ }
  return { status: res.status, body };
}
const json = (obj) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

(async () => {
  // Ana existe de verdad (cuenta por el endpoint real).
  const email = `ana${Date.now()}@test.com`;
  const reg = await api("/api/auth/register", json({ email, password: "persona42Zoom", name: "Ana Prueba" }));
  check("Ana tiene cuenta real", reg.status === 200 && !!reg.body?.token, `HTTP ${reg.status}`);
  const token = reg.body?.token ?? "";

  // El puente local que mantiene viva la sesión (lo publica la app de
  // escritorio); al final la prueba lo baja para simular que Zoom se cerró.
  let enReunion = true;
  const puente = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ app: "unify-escritorio", enReunion }));
  });
  await new Promise((r) => puente.listen(PUERTO_PUENTE, "127.0.0.1", r));

  const browser = await chromium.launch({
    args: ["--no-sandbox", "--no-proxy-server", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["microphone"] });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message.slice(0, 120)));
  await p.addInitScript(DOBLES);
  await p.addInitScript((t) => localStorage.setItem("encuentro_token", t), token);

  // ═══════ 1. La app de Zoom la trae a la barra ═══════
  console.log("\n── 1. Ana entra (app de escritorio → barra) ──");
  await p.goto(`${B}/externa?origen=escritorio&sala=persona${Date.now().toString(36)}`);
  await p.waitForURL(/\/externa\/reunion/, { timeout: 15000 });
  check("entra derecho a la barra, sin formularios", p.url().includes("/externa/reunion"));
  await p.getByText("Zoom (app de escritorio)").first().waitFor({ timeout: 15000 }).catch(() => {});
  check("la barra dice de qué reunión es", (await p.getByText("Zoom (app de escritorio)").count()) > 0);
  check("y saluda a Ana por su nombre de cuenta", (await p.getByText(/Ana Prueba/).count()) > 0);

  // La grabación automática (sólo audio, todavía sin captura) ya arrancó.
  await p.getByText("Grabando").first().waitFor({ timeout: 15000 }).catch(() => {});
  check("la grabación arranca sola al entrar", (await p.getByText("Grabando").count()) > 0);

  // ═══════ 2. Ana pasa a grabar la PANTALLA (con el audio de la reunión) ═══════
  console.log("\n── 2. Grabar pantalla con audio ──");
  // Por ROL y aria-label: el texto "Grabando" también está en la pastilla de
  // estado (no clickeable) y un getByText agarra esa primero.
  await p.getByRole("button", { name: "Detener grabación" }).click(); // corta la de sólo audio
  await dormir(1500);
  await p.getByRole("button", { name: /Grabar la reunión/ }).click(); // y graba pantalla
  let conPista = false;
  for (let i = 0; i < 20 && !conPista; i++) {
    await dormir(500);
    conPista = await p.evaluate(() => window.__recs.some((r) => r.conPista && r.arrancada > 0));
  }
  check("con la captura, el audio de la reunión queda escuchándose", conPista);
  const calidad = await p.evaluate(() => window.__recOpts[window.__recOpts.length - 1] || {});
  check("la calidad pedida al grabador es real (video ≥ 2.5 Mbps)",
    (calidad.videoBitsPerSecond ?? 0) >= 2_500_000, JSON.stringify(calidad));
  check("y el audio a 192 kbps", calidad.audioBitsPerSecond === 192_000);

  // ═══════ 3. Hablan Ana y LOS DEMÁS; traducción sin tocar nada ═══════
  console.log("\n── 3. Subtítulos de todos + traducción ──");
  check("Ana habla y se la escucha", await p.evaluate(() => window.__emitirPropia("hola a todos, arrancamos con el presupuesto")));
  await p.getByText(/arrancamos con el presupuesto/i).first().waitFor({ timeout: 20000 }).catch(() => {});
  check("su frase aparece en los subtítulos", (await p.getByText(/arrancamos con el presupuesto/i).count()) > 0);

  check("los demás hablan (en inglés, sin Unify)", await p.evaluate(() => window.__emitirReunion("good morning everyone, the budget looks fine")));
  await p.getByText("La reunión").first().waitFor({ timeout: 25000 }).catch(() => {});
  check("y aparecen como «La reunión», no mezclados con Ana", (await p.getByText("La reunión").count()) > 0);
  // La traducción al idioma de Ana llega sola (asincrónica): se le da margen.
  let traducida = false;
  for (let i = 0; i < 24 && !traducida; i++) {
    await dormir(1000);
    traducida = (await p.getByText(/buenos días|buen día|el presupuesto (se ve|está|parece)/i).count()) > 0;
  }
  check("la frase ajena aparece TRADUCIDA al castellano, sin tocar nada", traducida);

  // ═══════ 4. Zoom se cierra: la barra corta, sube y abre el historial ═══════
  console.log("\n── 4. Fin de la reunión → historial ──");
  enReunion = false;
  await p.waitForURL(/\/historial\//, { timeout: 40000 }).catch(() => {});
  check("al cerrarse Zoom, Ana queda EN el detalle de su historial", /\/historial\//.test(p.url()), p.url());
  await p.locator("video, audio").first().waitFor({ timeout: 30000 }).catch(() => {});
  check("con la grabación subida y reproducible", (await p.locator("video, audio").count()) > 0);
  check("la transcripción del detalle tiene lo de Ana", (await p.getByText(/arrancamos con el presupuesto/i).count()) > 0);
  check("y lo de los demás («La reunión»)", (await p.getByText("La reunión").count()) > 0);

  check("cero errores de JavaScript en todo el recorrido", errs.length === 0, errs[0] || "");
  await ctx.close();
  await browser.close();
  await new Promise((r) => puente.close(r));

  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} OK`);
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
