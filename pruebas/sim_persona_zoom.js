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
    // Captura falsa con pista de audio de verdad (canvas + oscilador). El
    // canvas se ANIMA a propósito: captureStream sólo emite cuadros cuando el
    // canvas cambia, y un canvas quieto produce una grabación de ~0 bytes que
    // el recorder descarta (con razón) como "vacía".
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#123456"; ctx.fillRect(0, 0, 1280, 720);
      setInterval(() => {
        ctx.fillStyle = "#" + ((Math.random() * 0xffffff) | 0).toString(16).padStart(6, "0");
        ctx.fillRect(Math.random() * 1200, Math.random() * 640, 80, 80);
      }, 100);
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
    // El Chromium de pruebas DICE soportar mp4 pero (sin códecs propietarios)
    // codifica vacío -> blob de ~0 bytes que el recorder descarta con razón.
    // Se lo empuja a webm (VP8/VP9, códecs reales acá); en el Chrome de la
    // gente el mp4 funciona de verdad y este empujón no existe.
    const soporta = RealMR.isTypeSupported.bind(RealMR);
    window.MediaRecorder.isTypeSupported = (t) => (/mp4/i.test(t) ? false : soporta(t));
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
  // locale es-AR: desde que el idioma sale del APARATO, un navegador de
  // pruebas en inglés haría que Ana "hable" en-US y elegir traducir a en-US
  // no pediría nada (mismo idioma). Ana es argentina: se lo decimos al
  // navegador, como en un teléfono real.
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ["microphone"],
    locale: "es-AR",
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message.slice(0, 120)));
  // Espía de subidas de grabación (presign directo o vía servidor).
  const subidas = [];
  p.on("request", (r) => { if (/recording-upload/.test(r.url())) subidas.push(r.url()); });
  await p.addInitScript(DOBLES);
  await p.addInitScript((t) => localStorage.setItem("encuentro_token", t), token);
  // Este entorno no tiene R2, y el servidor lo dice en /api/platforms
  // (recording:false) -- ante eso el cliente, POR DISEÑO, ni intenta subir.
  // Para probar el camino de subida real se le miente sólo ese flag: el
  // cliente entonces recorre el circuito entero (bóveda local -> presign ->
  // respaldo vía servidor) con requests de verdad.
  await p.route("**/api/platforms", async (route) => {
    const res = await route.fetch();
    const data = await res.json();
    data.recording = true;
    await route.fulfill({ response: res, json: data });
  });

  // ═══════ 1. La app de Zoom la trae a la barra ═══════
  console.log("\n── 1. Ana entra (app de escritorio → barra) ──");
  await p.goto(`${B}/externa?origen=escritorio&sala=persona${Date.now().toString(36)}`);
  await p.waitForURL(/\/externa\/reunion/, { timeout: 15000 });
  check("entra derecho a la barra, sin formularios", p.url().includes("/externa/reunion"));
  await p.getByText("Zoom (app de escritorio)").first().waitFor({ timeout: 15000 }).catch(() => {});
  check("la barra dice de qué reunión es", (await p.getByText("Zoom (app de escritorio)").count()) > 0);

  // La barra YA NO graba sola en este modo: desde la 1.4.0 el VIDEO lo graba
  // la APP de escritorio (pantalla + audio del sistema, sin selector) --
  // duplicar acá daba DOS videos del mismo rato en el historial. Y la barra
  // lo DICE, para que nadie crea que no se está grabando nada.
  await dormir(2500);
  // Por el BOTÓN de detener (no por el texto "Grabando": la nota de abajo
  // dice "lo está grabando la app" y un getByText la agarraría).
  check("la barra NO arranca su propia grabación (el video lo graba la app)",
    (await p.getByRole("button", { name: "Detener grabación" }).count()) === 0);
  await p.getByText(/lo está grabando la app de Unify/i).first().waitFor({ timeout: 10000 }).catch(() => {});
  check("y lo dice con todas las letras (nadie cree que no se graba)",
    (await p.getByText(/lo está grabando la app de Unify/i).count()) > 0);

  // ═══════ 2. Ana igual quiere grabar la PANTALLA desde la barra (manual) ═══════
  console.log("\n── 2. Grabar pantalla con audio ──");
  await p.getByRole("button", { name: /Grabar la reunión/ }).click(); // manual: graba pantalla
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
  // El deep link de la app espera a la sesión: la línea sale con el nombre de
  // la CUENTA de Ana, no como "Invitado".
  check("firmada con su nombre de cuenta", (await p.getByText(/Ana Prueba/).count()) > 0);

  check("los demás hablan (gente sin Unify, por el audio de la captura)",
    await p.evaluate(() => window.__emitirReunion("buenos días a todos, el presupuesto quedó aprobado")));
  await p.getByText("La reunión").first().waitFor({ timeout: 25000 }).catch(() => {});
  check("y aparecen como «La reunión», no mezclados con Ana", (await p.getByText("La reunión").count()) > 0);
  // Ana quiere leer a los demás en inglés: elige el idioma en el selector del
  // dock (el camino real de "acceder a las traducciones de las demás
  // personas"). Este entorno no tiene salida al traductor externo (MyMemory
  // está bloqueado; en producción además traduce Claude), así que lo que se
  // prueba de verdad es el MECANISMO completo del lado del producto: elegir
  // idioma dispara los pedidos de traducción reales al servidor.
  const traducciones = [];
  p.on("request", (r) => { if (r.url().includes("/api/translate")) traducciones.push(r.url()); });
  await p.getByLabel("Traducir los subtítulos a").selectOption("en-US");
  let pedida = false;
  for (let i = 0; i < 15 && !pedida; i++) {
    await dormir(1000);
    pedida = traducciones.length > 0;
  }
  check("eligiendo idioma en el dock, la traducción SE PIDE de verdad al servidor", pedida);

  // ═══════ 4. Zoom se cierra: la barra corta, sube y abre el historial ═══════
  console.log("\n── 4. Fin de la reunión → historial ──");
  enReunion = false;
  await p.waitForURL(/\/historial\//, { timeout: 40000 }).catch(() => {});
  check("al cerrarse Zoom, Ana queda EN el detalle de su historial", /\/historial\//.test(p.url()), p.url());
  // La grabación: este entorno no tiene R2 (el almacén real de producción),
  // así que lo que SÍ se puede probar de verdad es que el cliente la subió --
  // el request de subida al servidor existe y viaja con el video. En
  // producción ese mismo request termina en R2 y el detalle lo reproduce
  // (las grabaciones reales del historial salen de ahí).
  check("la subida de la grabación se intentó de verdad (request real)",
    subidas.length > 0, subidas[0] || "sin requests de subida");
  // El detalle carga la reunión del servidor: se le da el tiempo que tarda.
  await p.getByText(/arrancamos con el presupuesto/i).first().waitFor({ timeout: 20000 }).catch(() => {});
  check("la transcripción del detalle tiene lo de Ana", (await p.getByText(/arrancamos con el presupuesto/i).count()) > 0);
  await p.getByText("La reunión").first().waitFor({ timeout: 10000 }).catch(() => {});
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
