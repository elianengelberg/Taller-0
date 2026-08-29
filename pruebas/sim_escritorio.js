// LA APP DE ESCRITORIO, lanzada de verdad.
//
// Se corre Electron con el main.js real contra la web local y se mira, desde
// adentro del proceso, qué ventana quedó. Nació de un problema concreto: la
// app se instalaba en Windows y no aparecía NADA (era sólo un ícono al lado
// del reloj que abría el navegador), así que se sentía una página web y no un
// programa. Estas comprobaciones son las que impiden que vuelva a pasar.
//
// Necesita la web servida en :4174 y las dependencias de desktop instaladas
// (cd desktop && npm install). Se corre con xvfb-run.
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const DESK = "/home/user/Taller-0/desktop";

// ── 0. La extensión mantenida por la app (puro Node, sin ventanas) ─────────
// La Web Store se actualiza sola, pero el ZIP no: la app guarda la extensión
// en su carpeta de datos y la refresca contra la web. Acá se ejercita ese
// módulo REAL contra la web local: crear, decir "al día", y actualizar una
// versión vieja sin romper nada.
async function probarExtensionLocal(check) {
  const os = require("os");
  const { refrescarExtension, versionInstalada } = require(path.join(DESK, "extensionLocal.js"));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "unify-extloc-"));
  const WEB = "http://localhost:4174";
  const publicada = JSON.parse(fs.readFileSync("/home/user/Taller-0/client/dist/version-extension.json", "utf8")).version;

  const r1 = await refrescarExtension({ baseDir: base, web: WEB });
  check("la app instala la extensión desde cero (baja el zip y lo abre)",
    r1.estado === "creada" && r1.version === publicada,
    `estado=${r1.estado} v=${r1.version}`);
  check("y la carpeta queda lista para «Cargar descomprimida»",
    versionInstalada(path.join(base, "extension")) === publicada &&
    fs.existsSync(path.join(base, "extension", "content.js")));

  const r2 = await refrescarExtension({ baseDir: base, web: WEB });
  check("si ya está al día, no baja nada de nuevo", r2.estado === "al-dia", r2.estado);

  // Se simula una instalación VIEJA: el próximo refresco la tiene que subir.
  const manifest = path.join(base, "extension", "manifest.json");
  const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
  m.version = "1.0.0";
  fs.writeFileSync(manifest, JSON.stringify(m));
  const r3 = await refrescarExtension({ baseDir: base, web: WEB });
  check("una versión vieja se actualiza sola al refrescar",
    r3.estado === "actualizada" && versionInstalada(path.join(base, "extension")) === publicada,
    `estado=${r3.estado} v=${versionInstalada(path.join(base, "extension"))}`);

  // Y si la web no responde, la instalada NO se toca (vieja > rota).
  const r4 = await refrescarExtension({ baseDir: base, web: "http://localhost:4599" });
  check("sin red, la extensión instalada queda intacta (no se rompe nada)",
    r4.estado === "error" && versionInstalada(path.join(base, "extension")) === publicada,
    r4.estado);
  fs.rmSync(base, { recursive: true, force: true });
}

// ── 0a. El detector de reuniones: Zoom Y Teams (puro Node, lógica real) ────
// Teams no tiene un proceso que viva sólo durante la reunión: la señal es el
// registro de Windows de "quién usa el micrófono" (LastUsedTimeStop = 0
// mientras está tomado). Acá se prueba el intérprete de ese registro con
// salidas reales de `reg query`, y la sonda de archivo que simula ambas apps.
async function probarDetector(check) {
  const { teamsUsaElMicrofono, appUsandoElMicrofono, sondaArchivo } = require(path.join(DESK, "detector.js"));
  const os = require("os");
  const base = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";
  const bloque = (clave, valor = "0x0") =>
    `\r\n${base}\\${clave}\r\n    LastUsedTimeStop    REG_QWORD    ${valor}\r\n\r\n`;

  check("Teams con el micrófono tomado (reunión en curso) se detecta",
    teamsUsaElMicrofono(bloque("MSTeams_8wekyb3d8bbwe!MSTeams")) === true);

  check("Teams con el micrófono ya soltado (reunión terminada) NO se detecta",
    teamsUsaElMicrofono(bloque("MSTeams_8wekyb3d8bbwe!MSTeams", "0x1dbdd47e0e37e26")) === false);

  check("el Teams clásico (Teams.exe suelto) también se detecta",
    teamsUsaElMicrofono(bloque("NonPackaged\\C:#Users#x#AppData#Local#Microsoft#Teams#current#Teams.exe")) === true);

  // La trampa: TeamSpeak contiene "teams" en el nombre. Un micrófono tomado
  // por TeamSpeak NO es una reunión de Teams (dispararía el cartel jugando).
  check("TeamSpeak con el micrófono NO dispara el cartel (no es Teams)",
    appUsandoElMicrofono(bloque("NonPackaged\\C:#Program Files#TeamSpeak#TeamSpeak.exe")) === null);

  // Y las demás apps de reuniones de las empresas, cada una por su exe real.
  const esperadas = [
    ["Webex (app moderna)", "NonPackaged\\C:#Program Files#Cisco Spark#CiscoCollabHost.exe", "webex"],
    ["Webex Meetings clásico (atmgr.exe)", "NonPackaged\\C:#Users#x#AppData#Local#WebEx#atmgr.exe", "webex"],
    ["Jitsi Meet (la app de escritorio)", "NonPackaged\\C:#Users#x#AppData#Local#Programs#jitsi-meet#Jitsi Meet.exe", "jitsi"],
    ["Amazon Chime", "NonPackaged\\C:#Users#x#AppData#Local#AmazonChime#Amazon Chime.exe", "chime"],
    ["GoTo (app nueva)", "NonPackaged\\C:#Users#x#AppData#Local#GoTo#GoTo.exe", "goto"],
    ["GoToMeeting clásico (g2mcomm.exe)", "NonPackaged\\C:#Users#x#AppData#Local#GoToMeeting#19842#g2mcomm.exe", "goto"],
    ["RingCentral", "NonPackaged\\C:#Users#x#AppData#Local#Programs#RingCentral#RingCentral.exe", "ringcentral"],
    ["Slack (huddle)", "NonPackaged\\C:#Users#x#AppData#Local#slack#slack.exe", "slack"],
    ["Discord (canal de voz)", "NonPackaged\\C:#Users#x#AppData#Local#Discord#app-1.0.9#Discord.exe", "discord"],
  ];
  for (const [nombre, clave, plataforma] of esperadas) {
    check(`${nombre} en reunión se detecta como «${plataforma}»`,
      appUsandoElMicrofono(bloque(clave)) === plataforma,
      String(appUsandoElMicrofono(bloque(clave))));
  }

  // Prioridad: Discord de fondo (un canal de voz abierto hace horas) + la
  // reunión de verdad en Teams => gana Teams, no el ruido de fondo.
  const dosALaVez =
    bloque("NonPackaged\\C:#Users#x#AppData#Local#Discord#app-1.0.9#Discord.exe") +
    bloque("MSTeams_8wekyb3d8bbwe!MSTeams");
  check("con Discord de fondo Y Teams en reunión, gana Teams",
    appUsandoElMicrofono(dosALaVez) === "teams", String(appUsandoElMicrofono(dosALaVez)));

  // Un navegador con el micrófono NO es detectable como reunión (podría ser
  // cualquier página: de eso se encarga la extensión, que ve QUÉ página es).
  check("Chrome con el micrófono NO dispara el cartel (eso es de la extensión)",
    appUsandoElMicrofono(bloque("NonPackaged\\C:#Program Files#Google#Chrome#Application#chrome.exe")) === null);

  // La sonda simulada distingue la app por el contenido del archivo.
  const ruta = path.join(os.tmpdir(), `unify-sonda-prueba-${Date.now()}`);
  const sonda = sondaArchivo(ruta);
  const sinArchivo = await sonda();
  fs.writeFileSync(ruta, "teams");
  const conTeams = await sonda();
  fs.writeFileSync(ruta, "webex");
  const conWebex = await sonda();
  fs.writeFileSync(ruta, "1");
  const conZoom = await sonda();
  fs.rmSync(ruta, { force: true });
  check("la sonda simulada dice QUÉ app está en reunión (teams/webex/zoom/nada)",
    sinArchivo === null && conTeams === "teams" && conWebex === "webex" && conZoom === "zoom",
    `${String(sinArchivo)}/${conTeams}/${conWebex}/${conZoom}`);
}

// ── 0b. El cartel de Zoom: 15 segundos y automático (Playwright, HTML real) ─
// El cartel de la app da tiempo a LEER (con 8 segundos no llegabas a elegir
// entre grabar, subtítulos y demás) y, si nadie toca nada, cuenta como SÍ.
async function probarCartel(check) {
  const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");
  const b = await chromium.launch({ args: ["--no-sandbox"] });
  const p = await b.newPage();
  await p.goto("file://" + path.join(DESK, "cartel.html"));
  const cuenta = await p.locator("#cuenta").textContent();
  check("el cartel de Zoom arranca con 15 segundos (antes 8: no daba tiempo a elegir)",
    cuenta === "15", `cuenta=${cuenta}`);
  const caja = await p.locator(".caja").boundingBox();
  check("y el cartel tiene su caja entera a la vista", Boolean(caja) && caja.width >= 400,
    caja ? `${Math.round(caja.width)}px` : "sin caja");
  // A los 3 segundos sigue esperando; "Ahora no" responde al instante.
  await p.waitForTimeout(3000);
  check("a los 3 segundos todavía espera", await p.evaluate(() => window.__respuesta === undefined));
  await p.locator("#no").click();
  check("«Ahora no» responde y corta la cuenta", await p.evaluate(() => window.__respuesta === "no"));
  // Y el automático: con la cuenta en 2, al vencer responde SÍ solo.
  const p2 = await b.newPage();
  await p2.goto("file://" + path.join(DESK, "cartel.html") + "?seg=2");
  await p2.waitForTimeout(3200);
  check("si nadie toca nada, al vencer cuenta como SÍ (graba solo)",
    await p2.evaluate(() => window.__respuesta === "si"));
  // Y nombra a la app detectada: en una reunión de Teams, el cartel dice
  // Teams (hablar de Zoom ahí sonaría a error de la app).
  const p3 = await b.newPage();
  await p3.goto("file://" + path.join(DESK, "cartel.html") + "?seg=15&app=Microsoft%20Teams");
  const titulo = await p3.locator("#titulo").textContent();
  check("el cartel nombra a la app detectada (reunión de Microsoft Teams)",
    /reunión de Microsoft Teams/.test(titulo || ""), String(titulo));
  await b.close();
}

// ── 0c. EL GRABADOR SILENCIOSO, de punta a punta ───────────────────────────
// "Tocás grabar y graba LA REUNIÓN, sin selector": la app entera corriendo de
// verdad -- reunión simulada, cartel con su auto-sí, grabador oculto
// capturando la pantalla, corte al terminar la reunión, y el webm subido al
// servidor (acá, un stub que guarda los bytes para mirarlos de verdad).
// Corre para AMBAS apps: la simulación dice cuál ("1" = Zoom, "teams" =
// Teams) y la sala subida tiene que llevar ese prefijo -- así el título del
// historial dice la app correcta.
async function probarGrabadorSilencioso(check, opciones = {}) {
  const { contenido = "1", clavePrefijo = /^escritorio:zoom-/, etiqueta = "Zoom" } = opciones;
  const os = require("os");
  const http = require("http");
  const SIMULACION = path.join(os.tmpdir(), "unify-reunion-simulada");
  fs.rmSync(SIMULACION, { force: true });

  const capturado = { sesionKey: null, upload: null, duracion: null };
  const stub = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const mSes = url.pathname.match(/^\/api\/meet-bridge\/([^/]+)\/session$/);
    if (mSes) {
      capturado.sesionKey = decodeURIComponent(mSes[1]);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ dbId: "prueba-escritorio", transcript: [], participants: [] }));
      return;
    }
    if (url.pathname === "/api/meetings/prueba-escritorio/recording-upload") {
      capturado.duracion = Number(url.searchParams.get("durationMs"));
      const partes = [];
      req.on("data", (d) => partes.push(d));
      req.on("end", () => {
        capturado.upload = Buffer.concat(partes);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((r) => stub.listen(4197, "127.0.0.1", r));

  const probe = path.join("/tmp", "sonda-grabador.js");
  fs.writeFileSync(probe, `require(${JSON.stringify(path.join(DESK, "main.js"))});\n`);
  const hijo = spawn(path.join(DESK, "node_modules/.bin/electron"), [probe, "--no-sandbox"], {
    env: {
      ...process.env,
      UNIFY_TEST: "1",
      UNIFY_WEB: "http://localhost:4174",
      UNIFY_SERVER: "http://127.0.0.1:4197",
      DISPLAY: process.env.DISPLAY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    await espera(2500);                    // la app arranca y el detector late
    fs.writeFileSync(SIMULACION, contenido); // «entró a la reunión»
    // Detector (3 s) + cartel con su cuenta de 15: el auto-sí arranca TODO.
    await espera(23_000);
    await espera(8_000);                   // se graba un rato la pantalla
    fs.rmSync(SIMULACION, { force: true }); // «la reunión terminó»
    // Corte + cierre del archivo + subida al stub.
    const hasta = Date.now() + 25_000;
    while (!capturado.upload && Date.now() < hasta) await espera(500);

    check(`al terminar la reunión de ${etiqueta}, el video se sube SOLO (sin tocar nada)`,
      Boolean(capturado.upload), capturado.upload ? `${capturado.upload.length} bytes` : "no llegó");
    if (capturado.upload) {
      check(`a la MISMA sala que la barra companion, con la app en la clave (${etiqueta})`,
        clavePrefijo.test(capturado.sesionKey ?? ""), String(capturado.sesionKey));
      if (!opciones.soloClave) {
        check("y es un webm de verdad (magia EBML)",
          capturado.upload.subarray(0, 4).toString("hex") === "1a45dfa3");
        check("codificado en VP8 (el que no se traba en vivo)",
          capturado.upload.includes("V_VP8"), capturado.upload.includes("V_VP9") ? "V_VP9" : "V_VP8");
        check("con un tamaño real (la pantalla de verdad, no un archivo vacío)",
          capturado.upload.length > 20_000, `${capturado.upload.length} bytes`);
        check("declarando su duración (para sincronizar la transcripción)",
          Number.isFinite(capturado.duracion) && capturado.duracion > 4000 && capturado.duracion < 120_000,
          `${capturado.duracion}ms`);
      }
    } else {
      const faltan = opciones.soloClave ? 1 : 5;
      for (let i = 0; i < faltan; i++) check("(sin subida: no se puede verificar)", false);
    }
  } finally {
    // Esperar la MUERTE real del Electron: kill() vuelve al instante, y si el
    // proceso sigue vivo cuando arranca la corrida siguiente, el candado de
    // instancia única hace que la nueva app se cierre sola (¡y la prueba de
    // Teams fallaría por un fantasma, no por el código!).
    await new Promise((r) => {
      if (hijo.exitCode !== null) return r();
      const forzar = setTimeout(() => {
        try { hijo.kill("SIGKILL"); } catch { /* ya muerto */ }
        setTimeout(r, 500);
      }, 4000);
      hijo.once("exit", () => { clearTimeout(forzar); setTimeout(r, 300); });
      try { hijo.kill("SIGTERM"); } catch { /* ya muerto */ }
    });
    fs.rmSync(SIMULACION, { force: true });
    await new Promise((r) => stub.close(r));
  }
}

const sonda = path.join("/tmp", "sonda-escritorio.js");
fs.writeFileSync(sonda, `
  const { app } = require("electron");
  const original = require(${JSON.stringify(path.join(DESK, "main.js"))});
  setTimeout(() => {
    const { BrowserWindow } = require("electron");
    const vs = BrowserWindow.getAllWindows();
    const v = vs[0];
    const r = {
      ventanas: vs.length,
      visible: v ? v.isVisible() : false,
      titulo: v ? v.getTitle() : null,
      url: v ? v.webContents.getURL() : null,
      ancho: v ? v.getBounds().width : 0,
    };
    console.log("RESULTADO " + JSON.stringify(r));
    app.exit(0);
  }, 9000);
`);
const hijo = spawn(path.join(DESK, "node_modules/.bin/electron"), [sonda, "--no-sandbox"], {
  env: { ...process.env, UNIFY_WEB: "http://localhost:4174", DISPLAY: process.env.DISPLAY },
  stdio: ["ignore", "pipe", "pipe"],
});
let salida = "";
hijo.stdout.on("data", (d) => { salida += d; process.stdout.write(d); });
hijo.stderr.on("data", (d) => process.stderr.write(d));
hijo.on("exit", async (c) => {
  const m = salida.match(/RESULTADO (.+)/);
  if (!m) { console.log("FAIL sin resultado (código " + c + ")"); process.exit(1); }
  const r = JSON.parse(m[1]);
  const ok = [];
  const check = (n, c, d = "") => { ok.push(c); console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
  await probarDetector(check).catch((e) => check("detector Zoom/Teams", false, String(e.message)));
  await probarExtensionLocal(check).catch((e) => check("módulo de extensión local", false, String(e.message)));
  await probarCartel(check).catch((e) => check("cartel de escritorio", false, String(e.message)));
  await probarGrabadorSilencioso(check).catch((e) => check("grabador silencioso", false, String(e.message)));
  // La MISMA película, pero la reunión simulada es de TEAMS: la sala subida
  // tiene que decirlo en el prefijo (de ahí sale el título del historial).
  await probarGrabadorSilencioso(check, {
    contenido: "teams",
    clavePrefijo: /^escritorio:teams-/,
    etiqueta: "Microsoft Teams",
    soloClave: true,
  }).catch((e) => check("grabador silencioso (Teams)", false, String(e.message)));
  // Y una vez más con JITSI: la plataforma nueva del pedido «que detecte
  // jitsi y más apps de reuniones» pasa entera por la app real.
  await probarGrabadorSilencioso(check, {
    contenido: "jitsi",
    clavePrefijo: /^escritorio:jitsi-/,
    etiqueta: "Jitsi",
    soloClave: true,
  }).catch((e) => check("grabador silencioso (Jitsi)", false, String(e.message)));
  check("la app de escritorio abre UNA ventana propia (antes no abría ninguna)", r.ventanas === 1, `ventanas=${r.ventanas}`);
  check("y se ve (no queda escondida en la bandeja)", r.visible === true);
  check("con el título de la app", r.titulo === "Unify", String(r.titulo));
  check("y arranca en la PANTALLA DE INICIO", /localhost:4174\/?$/.test(r.url || ""), String(r.url));
  check("con tamaño de app de verdad", r.ancho >= 1000, `${r.ancho}px`);
  console.log(`\n${ok.filter(Boolean).length}/${ok.length} OK`);
  process.exit(ok.every(Boolean) ? 0 : 1);
});
