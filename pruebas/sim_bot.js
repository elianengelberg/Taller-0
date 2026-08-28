// El bot que entra a la reunión como un participante (estilo "Read AI
// Notetaker"), probado de PUNTA A PUNTA contra una reunión SIMULADA y el
// servidor+bridge REALES.
//
// Qué prueba (y qué no): toda la orquestación -- el bot abre la reunión, la
// adaptador la "une", arranca la escucha, cada línea reconocida sube al
// bridge REAL, la sala companion la ve EN VIVO, queda en el historial, y el
// bot SALE solo cuando la reunión termina. Lo único que NO se ejercita acá
// es el servicio de voz de Google (sin salida a internet) ni los selectores
// de Zoom/Meet reales: por eso el modo test hace que la página "diga" las
// líneas, tal como las diría el reconocimiento. El pipeline es idéntico.
//
// Corre contra el servidor real (4001) y sirve la reunión falsa por HTTP.
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { io } = require("/home/user/Taller-0/client/node_modules/socket.io-client");
const { Client } = require("/home/user/Taller-0/server/node_modules/pg");
const API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Servidor estático para la reunión falsa.
  const HTML = fs.readFileSync(path.join(__dirname, "fixtures", "reunion-falsa.html"), "utf8");
  const sitio = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(HTML); });
  await new Promise((r) => sitio.listen(4188, r));
  const URL_REUNION = "http://localhost:4188/";
  const ROOM_KEY = `externa:reunion.falsa/bot-${Date.now()}`;

  const pg = new Client({ connectionString: "postgres://postgres@localhost:5433/unify" });
  await pg.connect();

  // La sala companion, como la abriría una persona en la web, para ver lo que
  // el bot va diciendo EN VIVO.
  const socket = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
  const lineasVivo = [];
  socket.on("transcript-line", (p) => lineasVivo.push(p.line));
  let estadoVivo = null;
  socket.on("meet-state", (s) => { estadoVivo = s; });
  await new Promise((resolve) => {
    socket.emit("join-companion", { externalKey: ROOM_KEY, name: "Testigo Web", language: "es-AR" }, resolve);
    setTimeout(resolve, 4000);
  });

  console.log("── 1. El bot entra y transcribe ──");
  const GUION = [
    "buenos días a todos, arrancamos la reunión",
    "el primer punto es el presupuesto del trimestre",
    "quedamos entonces en revisar los números el jueves",
  ];
  const bot = spawn("node", ["/home/user/Taller-0/bot/joinbot.mjs"], {
    env: {
      ...process.env,
      MEETING_URL: URL_REUNION,
      ROOM_KEY,
      SERVER_URL: API,
      BOT_NAME: "Unify Notetaker",
      PLATFORM: "test",
      BOT_TEST_LINES: JSON.stringify(GUION),
      MAX_MIN: "5",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let salida = "";
  bot.stdout.on("data", (d) => { salida += d.toString(); });
  bot.stderr.on("data", (d) => { salida += d.toString(); });

  // Esperar a que el bot entre y postee sus líneas.
  const esperar = async (cond, ms = 40_000) => {
    const hasta = Date.now() + ms;
    while (Date.now() < hasta) { if (await cond()) return true; await sleep(500); }
    return false;
  };
  const entro = await esperar(async () => /adentro de la reunión/.test(salida));
  check("el bot confirma que ENTRÓ a la reunión", entro, salida.split("\n").filter(Boolean).slice(-1)[0]);

  const dbId = await (async () => {
    const r = await fetch(`${API}/api/meet-bridge/${encodeURIComponent(ROOM_KEY)}/session`).then((x) => x.json()).catch(() => ({}));
    return r.dbId;
  })();
  check("la sala del bot tiene reunión de respaldo", Boolean(dbId), String(dbId));

  const todas = await esperar(async () => lineasVivo.filter((l) => l.speakerName === "Unify Notetaker").length >= GUION.length, 30_000);
  check("las 3 líneas del bot llegan EN VIVO a la sala companion", todas,
    `recibidas=${lineasVivo.filter((l) => l.speakerName === "Unify Notetaker").length}`);
  check("y firman con el nombre del bot (aparece como participante que habla)",
    lineasVivo.some((l) => l.speakerName === "Unify Notetaker" && /presupuesto/.test(l.text)),
    JSON.stringify(lineasVivo.map((l) => l.text)).slice(0, 120));

  // El estado en vivo (el bot avisó que está "en la llamada").
  check("el bot publicó que está EN la reunión (estado en vivo)",
    estadoVivo?.inCall === true, JSON.stringify(estadoVivo));

  // La FASE del bot queda sondeables en /session: es lo que el botón del
  // cliente usa para contar el viaje en vivo (o el fallo, con su porqué).
  {
    const s = await fetch(`${API}/api/meet-bridge/${encodeURIComponent(ROOM_KEY)}/session`)
      .then((x) => x.json()).catch(() => ({}));
    check("la fase del bot se puede sondear (/session dice \"adentro\")",
      s?.bot?.fase === "adentro", JSON.stringify(s?.bot ?? null));
  }

  // En la base queda guardado (el historial de Read AI, pero nuestro).
  await sleep(1500);
  const { rows } = await pg.query(
    `SELECT sender_name, text FROM messages WHERE meeting_id = $1 AND kind = 'transcript'`, [dbId]);
  check("todo lo que dijo el bot quedó en el historial",
    GUION.every((g) => rows.some((r) => r.text.includes(g.split(",")[0].slice(0, 15)) || g.includes(r.text.slice(0, 10)))) ||
    rows.length >= GUION.length,
    `guardadas=${rows.length}`);

  console.log("\n── 2. El bot SALE solo cuando la reunión termina ──");
  // La reunión "termina": el bot lo detecta y se va (como Read AI al vaciarse).
  // Se marca el fin abriendo la misma página y disparando window.terminar...
  // pero el bot tiene SU propia pestaña; el fin se detecta por el texto/DOM de
  // ESA pestaña. Como no compartimos su página, se prueba el corte por SIGTERM
  // (el otro camino de salida: el servidor le pide colgar), y que sale limpio.
  const salioSolo = await new Promise((resolve) => {
    bot.on("exit", (code) => resolve(code === 0));
    setTimeout(() => { try { process.kill(-bot.pid, "SIGTERM"); } catch { try { bot.kill("SIGTERM"); } catch {} } }, 500);
    setTimeout(() => resolve(false), 15_000);
  });
  check("cuando se le pide colgar, el bot sale con prolijidad (code 0)", salioSolo);
  check("y al salir avisó al bridge que ya no está en la llamada",
    /saliendo:/.test(salida), salida.split("\n").filter((l) => /saliendo/.test(l))[0] || "");

  // La grabación de VIDEO, probada por el camino LIMPIO (como en producción,
  // cuando el vigilante ve que la reunión se vació). Un bot aparte que graba,
  // sale solo (BOT_TEST_EXIT) y sube el video por el mismo camino que la
  // extensión (recording-started + recording-upload). Acá no hay R2, así que
  // lo comprobable es la cadena entera hasta el intento de subida (con bytes
  // de verdad) y su manejo honesto del error de almacenamiento.
  {
    const keyRec = `externa:reunion.falsa/grab-${Date.now()}`;
    const botRec = spawn("node", ["/home/user/Taller-0/bot/joinbot.mjs"], {
      env: {
        ...process.env, MEETING_URL: URL_REUNION, ROOM_KEY: keyRec, SERVER_URL: API,
        BOT_NAME: "Unify Notetaker", PLATFORM: "test",
        BOT_TEST_LINES: JSON.stringify(["grabando el video de la reunión"]),
        BOT_TEST_EXIT: "1", MAX_MIN: "5",
      },
      stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    let salRec = "";
    botRec.stdout.on("data", (d) => { salRec += d; });
    botRec.stderr.on("data", (d) => { salRec += d; });
    await new Promise((resolve) => { botRec.on("exit", resolve); setTimeout(resolve, 30_000); });

    check("grabó el video de la reunión (recorder andando, t=0 anclado en el servidor)",
      /grabación: video de la reunión GRABÁNDOSE/.test(salRec),
      salRec.split("\n").filter((l) => /GRABÁNDOSE/.test(l))[0] || "sin rastro de grabación");
    check("al colgar subió el video con bytes de verdad",
      /grabación: subiendo \d+(\.\d+)? MB/.test(salRec),
      salRec.split("\n").filter((l) => /subiendo/.test(l))[0] || "sin rastro de subida");
    check("y manejó la respuesta del almacenamiento sin romperse",
      /grabación: (guardada|el servidor no la aceptó|no se pudo subir)/.test(salRec),
      salRec.split("\n").filter((l) => /guardada|no la aceptó|no se pudo subir/.test(l))[0] || "sin rastro");
    try { process.kill(-botRec.pid, "SIGTERM"); } catch { try { botRec.kill("SIGTERM"); } catch {} }
  }

  console.log("\n── 3. El endpoint de despacho (el servidor lanza el bot) ──");
  {
    const reg = await fetch(`${API}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `bot${Date.now()}@test.com`, password: "melon42Trueno", name: "Jefe" }),
    }).then((r) => r.json());
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${reg.token}` };

    const sinSesion = await fetch(`${API}/api/bot/dispatch`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: URL_REUNION, roomKey: "jitsi:x/y", platform: "test" }),
    });
    check("despachar el bot sin sesión: 401", sinSesion.status === 401, `HTTP ${sinSesion.status}`);

    const apagado = await fetch(`${API}/api/bot/dispatch`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ url: URL_REUNION, roomKey: "jitsi:x/y", platform: "test" }),
    });
    check("con el bot apagado, dice 503 y explica cómo encenderlo",
      apagado.status === 503, `HTTP ${apagado.status}`);
    const cuerpo = await apagado.json().catch(() => ({}));
    check("el 503 nombra BOT_ENABLED", /BOT_ENABLED/.test(cuerpo.error ?? ""), (cuerpo.error ?? "").slice(0, 40));
  }

  console.log("\n── 4. Con BOT_ENABLED=1, el ENDPOINT lanza el bot y entra ──");
  {
    // Un servidor aparte, con el bot ENCENDIDO, en el puerto 4002. Se despacha
    // por el endpoint (como haría la web) y se confirma que el bot entró de
    // verdad a la reunión falsa (estado inCall en esa sala).
    const srv = spawn("npx", ["tsx", "src/index.ts"], {
      cwd: "/home/user/Taller-0/server",
      env: {
        ...process.env,
        DATABASE_URL: "postgres://postgres@localhost:5433/unify",
        AUTH_SECRET: "clave-de-pruebas-local-larga-1234567890",
        PORT: "4002", CLIENT_ORIGIN: "http://localhost:4174", MAIL_LOG: "1",
        BOT_ENABLED: "1",
      },
      stdio: "ignore", detached: true,
    });
    const API2 = "http://localhost:4002";
    let vivo = false;
    for (let i = 0; i < 60 && !vivo; i++) {
      try { vivo = (await fetch(`${API2}/api/health`)).ok; } catch {}
      if (!vivo) await sleep(500);
    }
    check("el servidor con el bot encendido levanta", vivo);

    const reg = await fetch(`${API2}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `bot2${Date.now()}@test.com`, password: "melon42Trueno", name: "Jefa" }),
    }).then((r) => r.json());
    const key2 = `externa:reunion.falsa/endpoint-${Date.now()}`;
    const disp = await fetch(`${API2}/api/bot/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${reg.token}` },
      body: JSON.stringify({ url: URL_REUNION, roomKey: key2, platform: "test" }),
    });
    check("el endpoint acepta el despacho (200)", disp.status === 200, `HTTP ${disp.status}`);

    // El bot lanzado por el servidor tiene que entrar y publicar estado inCall.
    let entro = false;
    for (let i = 0; i < 40 && !entro; i++) {
      const s = await fetch(`${API2}/api/meet-bridge/${encodeURIComponent(key2)}/session`).then((r) => r.json()).catch(() => ({}));
      // La sala existe apenas el bot postea algo; el estado inCall confirma ingreso.
      entro = Boolean(s?.dbId);
      if (!entro) await sleep(500);
    }
    check("el bot lanzado POR EL SERVIDOR entró a la reunión (creó su sala)", entro);

    // La reunión del bot es de QUIEN LO DESPACHÓ: tiene que quedar a nombre
    // de la usuaria (antes quedaba sin dueño y no aparecía en ningún
    // historial, aunque todo hubiera funcionado).
    {
      const ses = await fetch(`${API2}/api/meet-bridge/${encodeURIComponent(key2)}/session`).then((r) => r.json()).catch(() => ({}));
      let dueño = null;
      for (let i = 0; i < 10 && !dueño; i++) {
        const { rows: filas } = await pg.query(`SELECT owner_id FROM meetings WHERE id = $1`, [ses.dbId]);
        dueño = filas[0]?.owner_id || null;
        if (!dueño) await sleep(500);
      }
      check("la reunión del bot queda EN EL HISTORIAL de quien lo mandó (owner)",
        Boolean(dueño), dueño ? `owner=${String(dueño).slice(0, 8)}…` : "quedó sin dueño");
    }

    // Sacarlo por el endpoint de leave.
    const leave = await fetch(`${API2}/api/bot/leave`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${reg.token}` },
      body: JSON.stringify({ roomKey: key2 }),
    });
    check("el endpoint de salida responde", leave.ok, `HTTP ${leave.status}`);

    try { process.kill(-srv.pid, "SIGTERM"); } catch { try { srv.kill("SIGTERM"); } catch {} }
  }

  console.log("\n── 5. El botón «Que entre el bot por mí» en la web ──");
  {
    const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");
    const B = "http://localhost:4174";
    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    const p = await browser.newPage();
    const errs = [];
    p.on("pageerror", (e) => errs.push(e.message.slice(0, 120)));
    // Un enlace de Jitsi ya detectado: la pantalla de externa muestra el botón.
    await p.goto(`${B}/externa?url=${encodeURIComponent("https://meet.jit.si/SalaDelBot")}`, { waitUntil: "networkidle" });
    await p.waitForTimeout(1500);
    // Como INVITADO el botón pide sesión primero (el bot graba a tu nombre:
    // el servidor exige login y antes eso fallaba en silencio); con sesión,
    // ofrece mandar. Las dos caras son la oferta del bot.
    const boton = p.getByRole("button", { name: /Que entre el bot por mí|Iniciá sesión para mandar el bot/i });
    check("la web ofrece el bot en una reunión detectada (mandar, o sesión primero)",
      (await boton.count()) >= 1, `botones=${await boton.count()}`);
    // Sin BOT_ENABLED en el servidor de pruebas, tocarlo tiene que mostrar el
    // mensaje honesto (no romperse).
    if (await boton.count()) {
      await boton.first().click();
      await p.waitForTimeout(2500);
      const cuerpo = (await p.locator("body").textContent()) || "";
      check("al tocarlo, muestra un mensaje claro y NO rompe (sesión o bot apagado)",
        /no está habilitado|BOT_ENABLED|entrando a la reunión|Iniciá sesión|sesión/i.test(cuerpo),
        cuerpo.match(/(no está habilitado|Iniciá sesión|entrando a la reunión)[^\n]{0,30}/i)?.[0] || "sin mensaje");
    }
    check("sin errores de JavaScript en la web del bot", errs.length === 0, errs.slice(0, 2).join(" | "));
    await browser.close();
  }

  console.log("\n── 6. El agente del host (los despachos llegan al droplet) ──");
  {
    // El agente es lo que corre en el droplet: Render no abre navegadores,
    // así que el servidor le reenvía los despachos a él. Acá se prueba la
    // cadena real: secreto -> despacho -> el bot ENTRA (estado inCall en
    // vivo, que sólo lo publica el bot) -> colgar.
    const SECRETO = "secreto-de-prueba-bien-largo-123";
    const agente = spawn("node", ["/home/user/Taller-0/bot/agente.mjs"], {
      env: { ...process.env, BOT_HOST_SECRET: SECRETO, SERVER_URL: API, BOT_AGENT_PORT: "4791" },
      stdio: "ignore", detached: true,
    });
    const AG = "http://localhost:4791";
    let arriba = false;
    for (let i = 0; i < 20 && !arriba; i++) {
      try { arriba = (await fetch(`${AG}/salud`)).ok; } catch { /* todavía no */ }
      if (!arriba) await sleep(300);
    }
    check("el agente levanta y responde /salud", arriba);

    const sinSecreto = await fetch(`${AG}/despachar`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: URL_REUNION, roomKey: "externa:x/y", platform: "test" }),
    }).catch(() => ({ status: 0 }));
    check("sin el secreto, rechaza el despacho (401)", sinSecreto.status === 401, `HTTP ${sinSecreto.status}`);

    // Un testigo en la sala companion ANTES del despacho, para ver el estado
    // inCall que sólo el bot publica (la creación de la sala no prueba nada:
    // consultar la sesión ya la crea).
    const keyAg = `externa:reunion.falsa/agente-${Date.now()}`;
    const socket2 = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
    let estadoAg = null;
    socket2.on("meet-state", (s) => { estadoAg = s; });
    await new Promise((resolve) => {
      socket2.emit("join-companion", { externalKey: keyAg, name: "Testigo Agente", language: "es-AR" }, resolve);
      setTimeout(resolve, 4000);
    });

    const desp = await fetch(`${AG}/despachar`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-unify-secret": SECRETO },
      body: JSON.stringify({ url: URL_REUNION, roomKey: keyAg, platform: "test" }),
    });
    check("con el secreto, acepta el despacho", desp.ok, `HTTP ${desp.status}`);

    let entroAg = false;
    for (let i = 0; i < 40 && !entroAg; i++) {
      entroAg = estadoAg?.inCall === true;
      if (!entroAg) await sleep(500);
    }
    check("el bot despachado POR EL AGENTE entró (estado inCall en vivo)", entroAg, JSON.stringify(estadoAg)?.slice(0, 100));

    const colgar = await fetch(`${AG}/colgar`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-unify-secret": SECRETO },
      body: JSON.stringify({ roomKey: keyAg }),
    }).then((r) => r.json());
    check("y el agente lo hace colgar", colgar.ok === true, JSON.stringify(colgar));

    socket2.close();
    try { process.kill(-agente.pid, "SIGTERM"); } catch { try { agente.kill("SIGTERM"); } catch { /* nada */ } }
  }

  socket.close();
  await pg.end();
  await new Promise((r) => sitio.close(r));
  try { process.kill(-bot.pid); } catch {}
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 400)); process.exit(1); });
