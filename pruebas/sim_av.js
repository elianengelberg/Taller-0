// Audio y video entre DOS personas reales: mute, cámara, compartir pantalla
// CON audio, y la transcripción de ese audio -- todo cruzado, buscando los
// bugs que sólo aparecen cuando hay otro del otro lado.
//
// Lo nuevo que protege: el audio de la pantalla compartida VIAJA por la malla
// (el otro escucha el video que compartís) y se TRANSCRIBE ("Pantalla de X"
// en el transcript de todos, con la misma IA y traducción que el resto).
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");
const { io: sio } = require("/home/user/Taller-0/client/node_modules/socket.io-client");
const fs = require("fs");
const B = "http://localhost:4174", API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const IGNORABLE = /fonts\.g|favicon|ERR_ABORTED|ResizeObserver|Download the React|speech|recognition/i;
function watch(page, bag) {
  page.on("pageerror", (e) => bag.push(`JS: ${e.message.slice(0, 140)}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const url = m.location?.().url || "";
    const t = `${m.text()} ${url}`;
    if (IGNORABLE.test(t)) return;
    if (/Failed to load resource/i.test(m.text())) {
      // Recursos externos que el sandbox corta (proxy con 502/404): no son
      // errores del producto. Sólo cuentan las fallas de carga de NUESTRO stack.
      if (!url.includes("localhost")) return;
      // El 502 de /api/translate es la degradación DISEÑADA cuando ningún
      // proveedor de traducción responde (en el sandbox están bloqueados):
      // el cliente lo maneja y deja el texto original.
      if (url.includes("/api/translate")) return;
      bag.push(`consola: ${m.text().slice(0, 80)} @ ${url.slice(-50)}`);
      return;
    }
    bag.push(`consola: ${m.text().slice(0, 110)}`);
  });
}

// Videos con stream REMOTO vivo (el propio se distingue por estar silenciado).
async function remoteVideos(page) {
  return page.evaluate(() => {
    let n = 0;
    for (const v of document.querySelectorAll("video")) {
      const s = v.srcObject;
      if (!s || typeof s.getTracks !== "function") continue;
      if (v.muted) continue;
      if (s.getTracks().some((t) => t.readyState === "live")) n++;
    }
    return n;
  });
}

// La mayor cantidad de pistas de AUDIO vivas en un mismo stream remoto: con
// una pantalla compartida con audio tienen que ser DOS (micrófono + pantalla).
async function maxAudioRemoto(page) {
  return page.evaluate(() => {
    let max = 0;
    for (const v of document.querySelectorAll("video, audio")) {
      const s = v.srcObject;
      if (!s || typeof s.getAudioTracks !== "function") continue;
      if (v.muted) continue; // el propio no cuenta
      const vivas = s.getAudioTracks().filter((t) => t.readyState === "live").length;
      if (vivas > max) max = vivas;
    }
    return max;
  });
}

// Indicadores de "micrófono silenciado" en las FICHAS de participantes (el
// ícono chico junto al nombre, no el botón de la barra propia).
async function indicadoresMute(page) {
  return page.locator("svg.text-brand-300").count();
}

(async () => {
  const browser = await chromium.launch({
    args: [
      "--no-sandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--auto-accept-this-tab-capture",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const mk = async () => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ["microphone", "camera"] });
    await c.route("**fonts.g**", (r) => r.abort());
    return c;
  };
  const a = await (await mk()).newPage();
  const b = await (await mk()).newPage();
  const bagA = [], bagB = [];
  watch(a, bagA); watch(b, bagB);

  // ═══════ 0. Dos personas reales en la misma reunión ═══════
  console.log("── 0. Ana y Bruno entran ──");
  const creator = sio(API, { transports: ["websocket"], forceNew: true, reconnection: false });
  await new Promise((r, x) => { creator.on("connect", r); creator.on("connect_error", x); });
  const created = await new Promise((res) => creator.timeout(8000).emit("create-meeting",
    { hostName: "Semilla", hostLanguage: "es-AR", roles: [] }, (e, r) => res(r)));
  const code = created?.meeting?.id;
  check("se crea la reunión", Boolean(code), String(code));
  if (!code) { creator.disconnect(); await browser.close(); process.exit(1); }
  creator.disconnect();

  for (const [page, name] of [[a, "Ana"], [b, "Bruno"]]) {
    await page.goto(`${B}/unirse/${code}`, { waitUntil: "domcontentloaded" });
    await page.getByLabel(/Tu nombre/i).fill(name);
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: /Unirme|Entrar/i }).last().click();
    await page.waitForTimeout(4000);
  }
  let ra = 0, rb = 0;
  for (let i = 0; i < 12 && (ra === 0 || rb === 0); i++) {
    ra = await remoteVideos(a); rb = await remoteVideos(b);
    if (ra === 0 || rb === 0) await sleep(1500);
  }
  check("la malla queda establecida (se ven mutuamente)", ra > 0 && rb > 0, `A=${ra} B=${rb}`);

  // ═══════ 1. Silenciarse: el OTRO lo ve ═══════
  console.log("\n── 1. Mute y cámara, mirados desde el otro lado ──");
  {
    const antes = await indicadoresMute(b);
    await a.getByRole("button", { name: /Silenciar micrófono/i }).first().click();
    await sleep(1800);
    const con = await indicadoresMute(b);
    check("B ve que Ana se silenció (aparece el ícono en su ficha)", con > antes, `${antes} -> ${con}`);
    await a.getByRole("button", { name: /Activar micrófono/i }).first().click();
    await sleep(1800);
    check("y lo ve volver a hablar (el ícono se va)", (await indicadoresMute(b)) === antes);

    // La cámara: el <video> queda montado a propósito (desmontarlo dejaba la
    // ficha negra al reactivar) y se oculta por CSS con el avatar encima.
    // Lo que se mira acá es EXACTAMENTE eso: visibilidad, no nodos.
    const ocultos = () => b.locator("video.hidden").count();
    check("antes de apagar nada, ningún video está oculto en B", (await ocultos()) === 0);
    await a.getByRole("button", { name: /Apagar cámara/i }).first().click();
    await sleep(1800);
    check("B deja de VER el video de Ana al apagar la cámara (oculto + avatar)",
      (await ocultos()) === 1, `ocultos=${await ocultos()}`);
    check("pero Ana sigue en la reunión para B", ((await b.locator("body").textContent()) || "").includes("Ana"));
    await a.getByRole("button", { name: /Activar cámara/i }).first().click();
    await sleep(1800);
    check("al prenderla, el video vuelve a verse", (await ocultos()) === 0);
    check("sin errores de JS en ninguno de los dos", bagA.length === 0 && bagB.length === 0,
      [...bagA, ...bagB].slice(0, 2).join(" | "));
  }

  // ═══════ 2. Compartir pantalla CON audio: el otro la ve Y LA ESCUCHA ═══════
  console.log("\n── 2. Pantalla compartida con audio ──");
  {
    const audioAntes = await maxAudioRemoto(b);
    await a.getByRole("button", { name: /Compartir (la )?pantalla|Compartir/i }).first().click();
    await sleep(3500);
    check("Ana queda compartiendo",
      (await a.getByRole("button", { name: /Dejar de compartir|Compartiendo/i }).count()) > 0);
    check("B sigue viendo video remoto (ahora la pantalla)", (await remoteVideos(b)) > 0);
    let audioCon = 0;
    for (let i = 0; i < 8 && audioCon < 2; i++) { audioCon = await maxAudioRemoto(b); if (audioCon < 2) await sleep(1200); }
    check("y ESCUCHA el audio de lo compartido (2 pistas: voz + pantalla)",
      audioCon === 2, `antes=${audioAntes} ahora=${audioCon}`);

    // Cruces en plena compartida: mute y cámara no la tiran.
    await a.getByRole("button", { name: /Silenciar micrófono/i }).first().click();
    await sleep(900);
    await a.getByRole("button", { name: /Activar micrófono/i }).first().click();
    await sleep(900);
    check("mute y unmute en plena compartida no la cortan",
      (await a.getByRole("button", { name: /Dejar de compartir|Compartiendo/i }).count()) > 0);
    check("y B sigue con las 2 pistas de audio", (await maxAudioRemoto(b)) === 2);

    await a.getByRole("button", { name: /Dejar de compartir|Compartiendo/i }).first().click();
    await sleep(2500);
    check("al dejar de compartir, B vuelve a UNA pista de audio", (await maxAudioRemoto(b)) === 1,
      String(await maxAudioRemoto(b)));
    check("y vuelve a ver la cámara de Ana", (await remoteVideos(b)) > 0);
    check("sin errores de JS compartiendo", bagA.length === 0 && bagB.length === 0,
      [...bagA, ...bagB].slice(0, 2).join(" | "));
  }

  // ═══════ 3. Clics rápidos de Bruno mientras tanto ═══════
  console.log("\n── 3. Clics rápidos del otro lado ──");
  {
    for (let i = 0; i < 4; i++) {
      await b.getByRole("button", { name: /Silenciar micrófono|Activar micrófono/i }).first().click();
      await b.getByRole("button", { name: /Apagar cámara|Activar cámara/i }).first().click();
      await sleep(250);
    }
    await sleep(2500);
    check("Bruno sigue en la reunión tras 8 toggles seguidos", b.url().includes("/reunion"));
    check("Ana lo sigue viendo", ((await a.locator("body").textContent()) || "").includes("Bruno"));
    check("las pistas de B siguen sanas", await b.evaluate(() => {
      for (const v of document.querySelectorAll("video")) {
        const s = v.srcObject;
        if (s && v.muted && s.getTracks().some((t) => t.readyState === "live")) return true;
      }
      return false;
    }));
    check("sin errores de JS en los toggles", bagA.length === 0 && bagB.length === 0,
      [...bagA, ...bagB].slice(0, 2).join(" | "));
  }

  // ═══════ 4. La línea "Pantalla de X" llega al transcript de TODOS ═══════
  console.log("\n── 4. Transcripción del audio compartido (por el mismo canal real) ──");
  {
    // Carla entra por socket (como haría la app) y manda una línea de
    // PANTALLA: lo que el reconocimiento oyó del video que está compartiendo.
    const carla = sio(API, { transports: ["websocket"], forceNew: true, reconnection: false });
    await new Promise((r, x) => { carla.on("connect", r); carla.on("connect_error", x); });
    const joined = await new Promise((res) => carla.timeout(8000).emit("join-meeting",
      { meetingId: code, name: "Carla", language: "es-AR" }, (e, r) => res(r)));
    check("Carla entra por socket", Boolean(joined?.meeting || joined?.ok || joined?.self), JSON.stringify(joined)?.slice(0, 60));

    const lineas = [];
    carla.on("transcript-line", (p) => lineas.push(p.line));
    carla.emit("transcript-line", {
      alternatives: ["bienvenidos al video institucional de la empresa"],
      lang: "es-AR",
      screen: true,
    });
    await sleep(2500);
    const linea = lineas.find((l) => l.text.includes("video institucional"));
    check("la línea vuelve etiquetada como Pantalla de Carla",
      linea?.speakerName === "Pantalla de Carla", JSON.stringify(linea)?.slice(0, 90));
    check("con su propio hablante (no se mezcla con la voz de Carla)",
      linea?.speakerId?.startsWith("caption:"), linea?.speakerId);

    // Y Bruno la VE en su panel de transcripción: el resultado final.
    await b.getByRole("button", { name: /Ver transcripción completa/i }).first().click();
    await sleep(1200);
    const panel = (await b.locator("body").textContent()) || "";
    check("Bruno la lee en su panel: dice quién (Pantalla de Carla) y qué",
      panel.includes("Pantalla de Carla") && panel.includes("video institucional"),
      panel.includes("Pantalla de Carla") ? "nombre ok" : "no aparece");
    carla.disconnect();
  }

  // ═══════ 5. La llave de seguridad del start(pista) ═══════
  console.log("\n── 5. El reconocimiento con pista NO arranca donde duplicaría el mic ──");
  {
    // La fábrica real del injector, con dobles: en un Chrome viejo (sin
    // available()) start(pista) ignoraría el argumento y transcribiría el
    // MICRÓFONO como si fuera la pantalla -- cada frase saldría dos veces.
    const src = fs.readFileSync("/home/user/Taller-0/extension/prompt-injector.js", "utf8");
    const fabrica = src.match(/function crearVozPropia\([\s\S]*?\n  \}/)?.[0];
    check("la fábrica existe", Boolean(fabrica));
    if (fabrica) {
      const pista = { readyState: "live" };
      const hecho = { conArg: null, arranco: false };
      function Viejo() { this.start = () => { hecho.arranco = true; }; }
      function Nuevo() { this.start = (t) => { hecho.arranco = true; hecho.conArg = t ?? null; }; }
      Nuevo.available = () => Promise.resolve("available");

      const crear = (Ctor) => new Function("window", `${fabrica}; return crearVozPropia;`)({ SpeechRecognition: Ctor });
      const viejo = crear(Viejo)({ lang: "es", track: pista, alTextoFinal: () => {}, alTextoInterino: () => {}, alFaltarPermiso: () => {} });
      check("en un Chrome viejo, con pista, NO arranca (nada de duplicar el mic)",
        viejo.arrancar() === false && hecho.arranco === false);
      const nuevo = crear(Nuevo)({ lang: "es", track: pista, alTextoFinal: () => {}, alTextoInterino: () => {}, alFaltarPermiso: () => {} });
      check("en un Chrome nuevo arranca y la pista viaja como argumento",
        nuevo.arrancar() === true && hecho.conArg === pista);
      nuevo.parar();
      // Sin pista sigue siendo el micrófono de siempre, hasta en el viejo.
      hecho.arranco = false;
      const mic = crear(Viejo)({ lang: "es", alTextoFinal: () => {}, alTextoInterino: () => {}, alFaltarPermiso: () => {} });
      check("sin pista, el micrófono arranca igual que siempre", mic.arrancar() === true && hecho.arranco === true);
      mic.parar();

      // EL RESCATE DE LO INTERINO y EL NUNCA RENDIRSE, con la fábrica real.
      // Dos males de una reunión de verdad: (1) la sesión de voz muere
      // (silencio, red) y Chrome TIRA el texto interino nunca confirmado --
      // palabras dichas que desaparecían; (2) tras 8 fallas seguidas el
      // reconocimiento se apagaba PARA SIEMPRE -- subtítulos "trabados"
      // hasta recargar.
      {
        const finales = [];
        let instancia = null;
        function Falso() {
          instancia = this;
          this.arranques = 0;
          this.start = () => { this.arranques += 1; };
          this.stop = () => { if (this.onend) this.onend(); };
        }
        const voz = crear(Falso)({
          lang: "es",
          alTextoFinal: (t) => finales.push(t),
          alTextoInterino: () => {},
          alFaltarPermiso: () => {},
        });
        check("el doble de voz arranca", voz.arrancar() === true && instancia !== null);
        const interino = (texto) =>
          instancia.onresult({ resultIndex: 0, results: [{ isFinal: false, length: 1, 0: { transcript: texto } }] });
        const final = (texto) =>
          instancia.onresult({ resultIndex: 0, results: [{ isFinal: true, length: 1, 0: { transcript: texto } }] });

        interino("esto quedó a medio decir");
        instancia.onend(); // la sesión muere SIN confirmar
        check("una sesión que muere NO se lleva lo interino (se rescata como final)",
          finales.includes("esto quedó a medio decir"), JSON.stringify(finales));

        interino("otra frase");
        final("otra frase entera");
        instancia.onend();
        check("lo ya confirmado NO se rescata dos veces",
          finales.filter((t) => /otra frase/.test(t)).length === 1, JSON.stringify(finales));

        for (let i = 0; i < 10; i++) { instancia.onerror({ error: "network" }); instancia.onend(); }
        await sleep(5600); // los reintentos van espaciados (tope ~4,9 s)
        check("tras DIEZ fallas de red sigue reintentando (antes quedaba muerto para siempre)",
          instancia.arranques >= 10, `arranques=${instancia.arranques}`);
        voz.parar();
      }
    }
  }

  // ── EL MISMO RESCATE, EN LA WEB DE VERDAD ────────────────────────────────
  // El companion externo escucha con useSpeechRecognition: acá se le planta
  // un reconocimiento controlable, se lo hace morir con un interino a medio
  // confirmar, y esas palabras tienen que aparecer en la transcripción real
  // (viajaron por el socket hasta el servidor y volvieron como línea).
  {
    const pr = await (await mk()).newPage();
    const bagR = [];
    watch(pr, bagR);
    await pr.addInitScript(() => {
      window.__recs = [];
      const Doble = class {
        constructor() { window.__recs.push(this); this.arranques = 0; }
        start() { this.arranques += 1; }
        stop() { if (this.onend) setTimeout(() => this.onend(), 0); }
        abort() { if (this.onend) setTimeout(() => this.onend(), 0); }
      };
      window.SpeechRecognition = Doble;
      window.webkitSpeechRecognition = Doble;
    });
    await pr.goto(`${B}/externa?url=${encodeURIComponent("https://meet.google.com/res-cate-xyz")}`, { waitUntil: "domcontentloaded" });
    await pr.waitForTimeout(1200);
    const nombreR = pr.getByLabel("Tu nombre");
    if (await nombreR.count()) await nombreR.first().fill("Rescate");
    const unirmeR = pr.getByRole("button", { name: /Unirme acá dentro/i });
    if (await unirmeR.count()) await unirmeR.first().click();
    await pr.waitForURL(/\/externa\/reunion/, { timeout: 15000 }).catch(() => {});
    await pr.waitForTimeout(2500);

    const manejado = await pr.evaluate(() => {
      const r = [...window.__recs].reverse().find((x) => x.onresult && x.onend);
      if (!r) return false;
      r.onresult({ resultIndex: 0, results: [{ isFinal: false, length: 1, 0: { transcript: "las palabras que casi se pierden" } }] });
      r.onend(); // la sesión muere sin confirmar
      return true;
    });
    await pr.waitForTimeout(2500);
    const cuerpoR = (await pr.locator("body").textContent()) || "";
    check("en la web real, lo interino de una sesión muerta llega igual a la transcripción",
      manejado && /las palabras que casi se pierden/i.test(cuerpoR),
      manejado ? cuerpoR.replace(/\s+/g, " ").slice(0, 90) : "el reconocimiento no arrancó");
    const seRelevanto = await pr.evaluate(() =>
      window.__recs.some((x) => x.arranques >= 2));
    check("y la escucha se relevanta sola tras el corte", seRelevanto === true);
    await pr.close();
  }

  check("cierre: ni un error de JS en toda la sesión de A", bagA.length === 0, bagA.slice(0, 3).join(" | "));
  check("cierre: ni un error de JS en toda la sesión de B", bagB.length === 0, bagB.slice(0, 3).join(" | "));

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 400)); process.exit(1); });
