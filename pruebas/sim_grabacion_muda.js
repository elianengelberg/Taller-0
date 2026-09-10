// EL VIDEO QUE NO SE ESCUCHA.
//
// Reportado desde una PC, con el archivo en la mano: «no se escucha el video
// de la grabación». La causa no era el códec ni la subida: la pantalla de
// reunión externa llamaba al grabador con `micStream: null`, así que la ÚNICA
// fuente de sonido era la casilla «Compartir audio» del selector de Chrome.
// Sin tildarla, la mezcla quedaba en silencio absoluto -- pero el nodo de
// audio entrega su pista igual, así que el archivo tenía su pista muda, pesaba
// lo normal, se veía perfecto y no fallaba nada. El problema aparecía recién
// al reproducirlo, cuando la reunión ya había terminado.
//
// Acá se prueba contra el stack real (servidor 4001, web 4174) lo único que
// importa: que la grabación LLEVE SONIDO, y que cuando no pueda llevarlo se
// diga mientras todavía se puede arreglar.
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");

const B = "http://localhost:4174";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const rnd3 = () => Array.from({ length: 3 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

// Dobles de captura. `conAudio` decide si la captura trae la casilla
// «Compartir audio» tildada; `conMicrofono`, si el navegador tiene permiso de
// micrófono. Entre los dos arman los cuatro escenarios reales.
const DOBLES = (conAudio, conMicrofono) => `
(() => {
  window.__pistasDelGrabador = [];
  window.__pidioMicrofono = 0;

  const canvasVivo = () => {
    const c = document.createElement("canvas");
    c.width = 640; c.height = 360;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#123456"; ctx.fillRect(0, 0, 640, 360);
    // El canvas se ANIMA: captureStream sólo emite cuadros cuando cambia, y
    // una grabación de 0 bytes la descarta el propio grabador (con razón).
    setInterval(() => {
      ctx.fillStyle = "#" + ((Math.random() * 0xffffff) | 0).toString(16).padStart(6, "0");
      ctx.fillRect(Math.random() * 560, Math.random() * 300, 60, 60);
    }, 80);
    return c.captureStream(10);
  };

  const pistaDeAudio = () => {
    const actx = new AudioContext();
    const osc = actx.createOscillator();
    const dest = actx.createMediaStreamDestination();
    osc.connect(dest); osc.start();
    return dest.stream.getAudioTracks()[0];
  };

  navigator.mediaDevices.getDisplayMedia = async () => {
    const s = canvasVivo();
    if (${conAudio ? "true" : "false"}) s.addTrack(pistaDeAudio());
    return s;
  };

  navigator.mediaDevices.getUserMedia = async () => {
    window.__pidioMicrofono += 1;
    if (!${conMicrofono ? "true" : "false"}) throw new DOMException("denied", "NotAllowedError");
    const s = new MediaStream();
    s.addTrack(pistaDeAudio());
    return s;
  };

  // Espía del grabador. CONTAR PISTAS NO ALCANZA, y es justamente la trampa
  // del bug original: el audio sale de un MediaStreamDestination, que entrega
  // su pista SIEMPRE -- tenga algo conectado o no. Con el bug, el grabador
  // recibía "1 pista de audio" y grababa silencio absoluto. Así que acá se
  // MIDE el nivel real de lo que entra al grabador.
  const RealMR = window.MediaRecorder;
  window.MediaRecorder = class extends RealMR {
    constructor(stream, opts) {
      super(stream, opts);
      const registro = {
        audio: stream.getAudioTracks().length,
        video: stream.getVideoTracks().length,
        pico: 0,
      };
      window.__pistasDelGrabador.push(registro);
      if (stream.getAudioTracks().length > 0) {
        try {
          const actx = new AudioContext();
          const an = actx.createAnalyser();
          an.fftSize = 512;
          actx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(an);
          const buf = new Uint8Array(an.fftSize);
          const t = setInterval(() => {
            an.getByteTimeDomainData(buf);
            for (const v of buf) registro.pico = Math.max(registro.pico, Math.abs(v - 128));
          }, 100);
          setTimeout(() => { clearInterval(t); actx.close().catch(() => {}); }, 4000);
        } catch { /* sin Web Audio: queda el conteo de pistas */ }
      }
    }
  };
  window.MediaRecorder.isTypeSupported = (t) => (/mp4/i.test(t) ? false : RealMR.isTypeSupported(t));
})();
`;

async function abrirReunion(ctx, dobles) {
  const p = await ctx.newPage();
  await p.addInitScript({ content: dobles });
  await p.route("**meet.google.com/**", (r) => r.fulfill({ status: 204 }));
  await p.route("**fonts.g**", (r) => r.abort());
  const codigo = `${rnd3()}-${rnd3()}${rnd3()[0]}-${rnd3()}`;
  await p.goto(`${B}/externa?url=${encodeURIComponent(`https://meet.google.com/${codigo}`)}&auto=1`, {
    waitUntil: "domcontentloaded",
  });
  await p.waitForTimeout(1500);
  const nombre = p.getByLabel("Tu nombre");
  if (await nombre.count()) {
    await nombre.first().fill("Testigo");
    const entrar = p.getByRole("button", { name: /Entrar|Unirme|Continuar/i });
    if (await entrar.count()) await entrar.first().click();
    await p.waitForTimeout(1500);
  }
  return p;
}

// Cómo se llega a grabar LA PANTALLA, tal como lo hace una persona:
//  - Con permiso de micrófono, la pantalla arranca sola una grabación de sólo
//    audio (a propósito: sin un gesto no se puede pedir la pantalla), y el
//    cartel ofrece «Agregar pantalla». Ese botón ES el gesto.
//  - Sin micrófono no hay nada corriendo: se entra por Ajustes.
async function grabarLaPantalla(p) {
  const agregar = p.getByRole("button", { name: /Agregar pantalla/i });
  if (await agregar.count()) {
    await agregar.first().click();
    await p.waitForTimeout(3500);
    return true;
  }
  const ajustes = p.getByRole("button", { name: /Ajustes de esta reunión/i });
  if (await ajustes.count()) {
    await ajustes.first().click();
    await p.waitForTimeout(700);
  }
  const grabar = p.getByRole("button", { name: /Grabar la reunión \(pantalla y audio\)/i });
  if ((await grabar.count()) === 0) return false;
  await grabar.first().click();
  await p.waitForTimeout(3500);
  return true;
}

(async () => {
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const errs = [];

  // ── 1. Se compartió SIN «Compartir audio», pero hay micrófono ─────────────
  console.log("\n── Sin «Compartir audio», el micrófono salva la grabación ──");
  {
    const p = await abrirReunion(ctx, DOBLES(false, true));
    p.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
    const pudo = await grabarLaPantalla(p);
    check("la pantalla ofrece grabar", pudo);
    const pistas = await p.evaluate(() => window.__pistasDelGrabador);
    const conVideo = pistas.filter((x) => x.video > 0);
    check("se está grabando la pantalla", conVideo.length > 0, JSON.stringify(pistas));
    check("y el grabador recibió una pista de audio", conVideo.some((x) => x.audio > 0), JSON.stringify(pistas));
    // LA PRUEBA DE VERDAD. Con el bug, esa pista existía igual y estaba MUDA:
    // el archivo pesaba, se veía y no se escuchaba. Acá se mide el nivel.
    await p.waitForTimeout(2500);
    const conSonido = await p.evaluate(() =>
      window.__pistasDelGrabador.filter((x) => x.video > 0).map((x) => x.pico)
    );
    check("Y SE ESCUCHA: por el grabador está entrando sonido de verdad, no una pista muda",
      conSonido.some((pico) => pico > 2), `picos=${JSON.stringify(conSonido)}`);
    check("porque el grabador pidió el micrófono por su cuenta (la captura vino muda)",
      (await p.evaluate(() => window.__pidioMicrofono)) > 0);
    const texto = await p.evaluate(() => document.body.innerText);
    check("y no asusta con un aviso de «sin sonido» cuando SÍ hay sonido",
      !/SIN SONIDO/i.test(texto));
    await p.close();
  }

  // ── 2. Ni audio compartido ni micrófono: se avisa EN EL MOMENTO ───────────
  console.log("\n── Sin audio y sin micrófono: se dice mientras se puede arreglar ──");
  {
    const p = await abrirReunion(ctx, DOBLES(false, false));
    p.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
    await grabarLaPantalla(p);
    check("igual se intentó abrir el micrófono antes de rendirse",
      (await p.evaluate(() => window.__pidioMicrofono)) > 0);
    await p.waitForTimeout(2000);
    const mudas = await p.evaluate(() =>
      window.__pistasDelGrabador.filter((x) => x.video > 0).map((x) => x.pico)
    );
    check("acá SÍ está saliendo muda (no hay de dónde sacar sonido)",
      mudas.length > 0 && mudas.every((pico) => pico <= 2), `picos=${JSON.stringify(mudas)}`);
    const texto = await p.evaluate(() => document.body.innerText);
    check("y la pantalla lo AVISA, en vez de entregar un archivo mudo sin decir nada",
      /SIN SONIDO/i.test(texto), texto.replace(/\s+/g, " ").slice(0, 160));
    check("y dice qué hacer (tildar «Compartir audio»)",
      /Compartir audio/i.test(texto));
    check("el aviso se ve mientras se graba, no al final",
      /Grabando/i.test(texto));
    await p.close();
  }

  // ── 3. Con «Compartir audio» tildado: todo normal ─────────────────────────
  console.log("\n── Con «Compartir audio»: sonido y ningún aviso de más ──");
  {
    const p = await abrirReunion(ctx, DOBLES(true, false));
    p.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
    await grabarLaPantalla(p);
    await p.waitForTimeout(2500);
    const pistas = await p.evaluate(() => window.__pistasDelGrabador);
    check("el grabador recibe el audio de la reunión",
      pistas.filter((x) => x.video > 0).some((x) => x.audio > 0), JSON.stringify(pistas));
    check("y ese audio SUENA (no es una pista muda)",
      pistas.filter((x) => x.video > 0).some((x) => x.pico > 2), JSON.stringify(pistas));
    const texto = await p.evaluate(() => document.body.innerText);
    check("y no aparece ningún aviso de «sin sonido»", !/SIN SONIDO/i.test(texto));
    await p.close();
  }

  check("sin errores de JavaScript en todo el recorrido", errs.length === 0, errs[0] || "");

  await ctx.close();
  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
