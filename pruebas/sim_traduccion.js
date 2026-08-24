// La traducción de los subtítulos, atacada por sus dos lados débiles.
//
// 1. El proveedor gratuito (MyMemory, el que corre si no hay clave de
//    Anthropic) contesta HTTP 200 SIEMPRE: sus errores vienen adentro del
//    JSON, como texto en translatedText. Sin mirar responseStatus, ese texto
//    ("'AUTO' IS AN INVALID SOURCE LANGUAGE...") aparecía EN PANTALLA como si
//    fuera la traducción. Acá se estuba fetch y se exige que eso sea un error.
// 2. Los idiomas ofrecidos en cada superficie (web, overlay de la extensión,
//    panel de Meet) se desparejan en silencio: el que elige "日本語" en la web
//    no lo encontraba en la extensión. Acá se leen LAS FUENTES REALES de los
//    cuatro listados y se exige que sean el mismo conjunto.
const { execFileSync } = require("child_process");
const fs = require("fs");
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };

(async () => {
  // ═══════ 1. El módulo real de traducción, con la red estubada ═══════
  console.log("── 1. translate.ts contra un MyMemory simulado ──");
  {
    // Se corre el MÓDULO REAL (server/src/translate.ts) bajo tsx, sin clave de
    // Anthropic (así toma el camino MyMemory), con fetch reemplazado por un
    // doble que registra qué se pidió y contesta lo que el caso necesita.
    const script = `
      import { translateText } from "/home/user/Taller-0/server/src/translate";
      const llamadas: string[] = [];
      let modo = "ok";
      (globalThis as any).fetch = async (url: string) => {
        llamadas.push(String(url));
        const cuerpo =
          modo === "ok" ? { responseData: { translatedText: "Hola mundo" }, responseStatus: 200 } :
          modo === "403" ? { responseData: { translatedText: "'AUTO' IS AN INVALID SOURCE LANGUAGE . EXAMPLE: LANGPAIR=EN|IT" }, responseStatus: "403" } :
          { responseData: { translatedText: "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY" }, responseStatus: 200 };
        return { ok: true, json: async () => cuerpo } as any;
      };
      const out: any = {};
      out.hola = await translateText("Hello world", "auto", "es");
      out.urlAuto = llamadas[0];
      out.cache = await translateText("Hello world", "auto", "es");
      out.llamadasTrasCache = llamadas.length;
      out.mismoIdioma = await translateText("ya en castellano", "es-AR", "es");
      out.llamadasTrasMismo = llamadas.length;
      modo = "403";
      try { await translateText("otra cosa", "auto", "es"); out.error403 = "NO TIRO"; }
      catch { out.error403 = "tiro"; }
      modo = "warning";
      try { await translateText("y otra mas", "en-US", "es"); out.errorWarning = "NO TIRO"; }
      catch { out.errorWarning = "tiro"; }
      console.log("RESULTADO:" + JSON.stringify(out));
    `;
    const salida = execFileSync("env", ["-u", "ANTHROPIC_API_KEY", "npx", "tsx", "-e", script], {
      cwd: "/home/user/Taller-0/server",
      encoding: "utf8",
    });
    const r = JSON.parse(salida.split("RESULTADO:")[1].trim().split("\n")[0]);
    check("con source «auto» le pide a MyMemory Autodetect (no el literal auto)",
      /langpair=Autodetect%7Ces|langpair=Autodetect\|es/.test(decodeURIComponent(r.urlAuto ?? "")),
      (r.urlAuto ?? "").slice(-50));
    check("una traducción sana llega entera", r.hola === "Hola mundo", r.hola);
    check("la segunda vez sale del caché (sin otra llamada)", r.cache === "Hola mundo" && r.llamadasTrasCache === 1,
      `llamadas=${r.llamadasTrasCache}`);
    check("mismo idioma de origen y destino: ni se pide", r.mismoIdioma === "ya en castellano" && r.llamadasTrasMismo === 1);
    check("responseStatus 403 es un ERROR, no una traducción para pantalla", r.error403 === "tiro", r.error403);
    check("el cartel de cuota agotada de MyMemory también es un error", r.errorWarning === "tiro", r.errorWarning);
  }

  // ═══════ 2. El endpoint /api/translate del servidor real ═══════
  console.log("\n── 2. El endpoint, con sus límites ──");
  {
    const api = async (body) => {
      const res = await fetch("http://localhost:4001/api/translate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      let data = {}; try { data = JSON.parse(await res.text()); } catch {}
      return { status: res.status, data };
    };
    const sin = await api({ text: "hola" });
    check("sin source/target: 400", sin.status === 400, `HTTP ${sin.status}`);
    const largo = await api({ text: "x".repeat(4001), source: "en", target: "es" });
    check("texto kilométrico: 400 (nadie usa nuestra API de traductor gratis)", largo.status === 400, `HTTP ${largo.status}`);
    const real = await api({ text: "Good morning, how are you?", source: "en-US", target: "es" });
    if (real.status === 200) {
      const t = String(real.data.translatedText ?? "");
      check("una traducción real vuelve y no es un error disfrazado",
        t.length > 0 && !/INVALID|MYMEMORY|NO QUERY/i.test(t), t.slice(0, 60));
    } else {
      // Sin salida a internet (o proveedor caído) el servidor DEBE decir 502,
      // no 200 con basura: eso también es un resultado correcto acá.
      check("sin proveedor alcanzable, contesta 502 honesto", real.status === 502, `HTTP ${real.status}`);
      console.log("SKIP la traducción real de punta a punta (sin red hacia el proveedor)");
    }
  }

  // ═══════ 3. Paridad de idiomas entre las cuatro superficies ═══════
  console.log("\n── 3. Los mismos idiomas en la web, el overlay y el panel de Meet ──");
  {
    const web = fs.readFileSync("/home/user/Taller-0/client/src/lib/languages.ts", "utf8");
    const codigosWeb = [...new Set([...web.matchAll(/code: "([a-z]{2})-/g)].map((m) => m[1]))].sort();

    const srv = fs.readFileSync("/home/user/Taller-0/server/src/translate.ts", "utf8");
    const bloque = srv.match(/const LANGUAGE_NAMES[\s\S]*?\n\};/)[0];
    const codigosSrv = [...new Set([...bloque.matchAll(/^ {2}([a-z]{2}):/gm)].map((m) => m[1]))].sort();

    const inj = fs.readFileSync("/home/user/Taller-0/extension/prompt-injector.js", "utf8");
    const selInj = inj.match(/\[""\s*,\s*"Sin traducir"\][\s\S]*?\]\)/)?.[0] ?? inj;
    const codigosInj = [...new Set([...selInj.matchAll(/\["([a-z]{2})",/g)].map((m) => m[1]))].sort();
    const autoInj = [...new Set([...(inj.match(/const IDIOMAS = \[[^\]]+\]/)?.[0] ?? "").matchAll(/"([a-z]{2})"/g)].map((m) => m[1]))].sort();

    const cnt = fs.readFileSync("/home/user/Taller-0/extension/content.js", "utf8");
    const selCnt = cnt.match(/<select data-el="lang"[\s\S]*?<\/select>/)?.[0] ?? "";
    const codigosCnt = [...new Set([...selCnt.matchAll(/<option value="([a-z]{2})">/g)].map((m) => m[1]))].sort();
    const autoCnt = [...new Set([...(cnt.match(/const IDIOMAS = \[[^\]]+\]/)?.[0] ?? "").matchAll(/"([a-z]{2})"/g)].map((m) => m[1]))].sort();

    const j = (a) => a.join(",");
    check(`la web ofrece ${codigosWeb.length} idiomas`, codigosWeb.length >= 8, j(codigosWeb));
    check("el servidor los conoce a TODOS por nombre", codigosWeb.every((c) => codigosSrv.includes(c)),
      `faltan: ${codigosWeb.filter((c) => !codigosSrv.includes(c)).join(",") || "ninguno"}`);
    check("el overlay de la extensión ofrece LOS MISMOS", j(codigosInj) === j(codigosWeb),
      `overlay=${j(codigosInj)} web=${j(codigosWeb)}`);
    check("el panel de Meet ofrece LOS MISMOS", j(codigosCnt) === j(codigosWeb),
      `panel=${j(codigosCnt)} web=${j(codigosWeb)}`);
    check("la autodetección del navegador (overlay) cubre los mismos", j(autoInj) === j(codigosWeb), j(autoInj));
    check("la autodetección del navegador (panel de Meet) también", j(autoCnt) === j(codigosWeb), j(autoCnt));
  }

  // ═══════ 4. La voz propia del overlay (la fábrica real, con dobles) ═══════
  console.log("\n── 4. El overlay transcribe TU voz y la publica al bridge ──");
  {
    const src = fs.readFileSync("/home/user/Taller-0/extension/prompt-injector.js", "utf8");
    const fabrica = src.match(/function crearVozPropia\([\s\S]*?\n  \}/)?.[0];
    const publicar = src.match(/async function publicarVozPropia\([\s\S]*?\n  \}/)?.[0];
    check("la fábrica de voz existe en el injector", Boolean(fabrica));
    check("el publicador de líneas existe en el injector", Boolean(publicar));
    if (fabrica && publicar) {
      // SpeechRecognition doble: registra la config y deja disparar eventos.
      const instancias = [];
      function FakeRec() {
        this.started = 0;
        this.stopped = 0;
        this.start = () => { this.started += 1; };
        this.stop = () => { this.stopped += 1; this.onend?.(); };
        instancias.push(this);
      }
      const win = { SpeechRecognition: FakeRec };
      const finales = [], interinas = []; let sinPermiso = 0;
      const crear = new Function("window", `${fabrica}; return crearVozPropia;`)(win);
      const voz = crear({
        lang: "es-AR",
        alTextoFinal: (t) => finales.push(t),
        alTextoInterino: (t) => interinas.push(t),
        alFaltarPermiso: () => { sinPermiso += 1; },
      });
      check("arranca y configura el reconocimiento continuo en tu idioma",
        voz.arrancar() === true && instancias[0].continuous === true &&
        instancias[0].interimResults === true && instancias[0].lang === "es-AR");
      const r = instancias[0];
      r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: " hola a todos " }], { isFinal: false })] });
      r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: "hola a todos" }], { isFinal: true })] });
      check("lo interino y lo final llegan cada uno por su canal",
        interinas[0] === "hola a todos" && finales[0] === "hola a todos",
        `int=${interinas.length} fin=${finales.length}`);
      // Si el reconocimiento se corta solo (silencio largo), se relevanta
      // (con un setTimeout: el freno anti-martilleo vive ahí).
      r.onend();
      await new Promise((r2) => setTimeout(r2, 50));
      check("un corte por silencio lo relevanta solo", r.started === 2, `starts=${r.started}`);
      // Sin permiso de micrófono: avisa y NO queda relevantándose en bucle.
      r.onerror({ error: "not-allowed" });
      r.onend();
      await new Promise((r2) => setTimeout(r2, 50));
      check("sin permiso: avisa una vez y deja de insistir", sinPermiso === 1 && r.started === 2,
        `avisos=${sinPermiso} starts=${r.started}`);
      // Y si el servicio de voz falla y falla (sin red), tampoco insiste para
      // siempre: tras varias fallas seguidas se apaga solo.
      const voz2 = crear({ lang: "es-AR", alTextoFinal: () => {}, alTextoInterino: () => {}, alFaltarPermiso: () => {} });
      voz2.arrancar();
      const r2i = instancias[instancias.length - 1];
      for (let i = 0; i < 8; i++) r2i.onerror({ error: "network" });
      r2i.onend();
      await new Promise((r2) => setTimeout(r2, 900));
      check("fallas de red repetidas: se apaga en vez de martillar", r2i.started === 1, `starts=${r2i.started}`);
      voz2.parar();
      voz.parar();

      // El publicador: la línea final viaja al bridge con idioma y hablante.
      const pedidos = [];
      const cfg = { serverBase: "https://srv.prueba" };
      const fetchFalso = async (url, opts) => { pedidos.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; };
      const pub = new Function("cfg", "fetch", `${publicar}; return publicarVozPropia;`)(cfg, fetchFalso);
      await pub({ roomKey: "zoom:91234567890" }, "hola a todos", "es-AR");
      check("publica en el bridge de ESA sala",
        pedidos[0]?.url === "https://srv.prueba/api/meet-bridge/zoom%3A91234567890/transcript", pedidos[0]?.url);
      check("con hablante, texto e idioma de origen",
        pedidos[0]?.body.speaker === "Vos" && pedidos[0]?.body.text === "hola a todos" && pedidos[0]?.body.lang === "es-AR",
        JSON.stringify(pedidos[0]?.body));
    }
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 400)); process.exit(1); });
