// El PILOTO AUTOMÁTICO del bot, probado de punta a punta: una reunión en el
// calendario (un .ics) hace que el bot entre SOLO, sin que la persona toque
// nada. Se ejercita el motor REAL (parser ICS, derivación de sala, el poller
// con dedup contra la base de verdad) y, además, se lleva al bot de test a la
// reunión falsa bajo la sala derivada, para ver que la línea cae en el bridge
// real y la sala companion la ve en vivo.
//
// Lo único simulado (igual que sim_bot): la reunión "real" de Jitsi -> se usa
// la página falsa y el bot en modo test. El servicio de voz tampoco corre
// acá. Todo lo NUEVO de la agenda es real: parseo, ventana de tiempo,
// derivación URL->sala, quién tiene el piloto encendido, y el dedup.
import { createRequire } from "module";
import { spawn } from "child_process";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parsearICS, derivarSala, repasarAgenda, _setBajarICS } from "../server/src/botAgenda.js";

const require = createRequire(import.meta.url);
const { io } = require("/home/user/Taller-0/client/node_modules/socket.io-client");
const { Client } = require("/home/user/Taller-0/server/node_modules/pg");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API = "http://localhost:4001";
const results: boolean[] = [];
const check = (n: string, ok: boolean, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const compact = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

(async () => {
  console.log("── 0. El parser de ICS (lo que manda un calendario de verdad) ──");
  {
    const ahora = Date.parse("2026-08-26T15:00:00Z");
    // Un evento UTC que arranca ahora, con el link en la descripción.
    const ics1 = [
      "BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:u1", "SUMMARY:Daily",
      "DTSTART:20260826T150000Z",
      "DESCRIPTION:Entrá por https://meet.google.com/abc-defg-hij",
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    const e1 = parsearICS(ics1, ahora);
    check("un evento UTC que arranca ahora se detecta", e1.length === 1 && e1[0].joinUrl.includes("meet.google.com"),
      JSON.stringify(e1.map((e) => e.subject)));

    // Con TZID (hora local de Buenos Aires = UTC-3): 12:00 en BA == 15:00Z.
    const ics2 = [
      "BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:u2", "SUMMARY:TZ",
      "DTSTART;TZID=America/Argentina/Buenos_Aires:20260826T120000",
      "DESCRIPTION:https://meet.jit.si/SalaTz",
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    const e2 = parsearICS(ics2, ahora);
    check("un evento con TZID se ancla al instante correcto (UTC-3)", e2.length === 1, `n=${e2.length}`);

    // Fuera de la ventana (dentro de 3 horas): NO se dispara todavía.
    const ics3 = [
      "BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:u3", "SUMMARY:Lejos",
      `DTSTART:${compact(ahora + 3 * 3600_000)}`,
      "DESCRIPTION:https://meet.jit.si/Lejos",
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    check("un evento dentro de 3 horas NO se dispara todavía", parsearICS(ics3, ahora).length === 0);

    // Recurrente semanal: la instancia base fue hace una semana, pero HOY cae una.
    const ics4 = [
      "BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:u4", "SUMMARY:Semanal",
      `DTSTART:${compact(ahora - 7 * 86400_000)}`,
      "RRULE:FREQ=WEEKLY",
      "DESCRIPTION:https://meet.jit.si/Semanal",
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    check("una reunión semanal dispara su instancia de HOY", parsearICS(ics4, ahora).length === 1);

    // Un evento sin ningún link: se ignora (no hay adónde mandar el bot).
    const ics5 = [
      "BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:u5", "SUMMARY:Sin link",
      "DTSTART:20260826T150000Z", "DESCRIPTION:Charlamos en la oficina",
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    check("un evento sin link se ignora", parsearICS(ics5, ahora).length === 0);
  }

  console.log("\n── 1. La derivación URL -> sala (misma regla que la web y lanzar.mjs) ──");
  {
    check("Meet", derivarSala("https://meet.google.com/abc-defg-hij?authuser=1")?.roomKey === "google-meet:abc-defg-hij");
    check("Zoom", derivarSala("https://us05web.zoom.us/j/89123456789?pwd=x")?.roomKey === "zoom:89123456789");
    check("Jitsi", derivarSala("https://meet.jit.si/MiSala")?.roomKey === "jitsi:meet.jit.si/misala");
    check("un link que no es de reunión no deriva sala", derivarSala("https://example.com/foo") === null);
  }

  console.log("\n── 2. El poller: del calendario al bot, con dueño y sin duplicar ──");
  const pg = new Client({ connectionString: "postgres://postgres@localhost:5433/unify" });
  await pg.connect();
  // Arrancamos de cero: apagamos el piloto de cualquier usuario que haya
  // quedado de una corrida anterior, así el poller ve SÓLO a nuestra persona.
  await pg.query(`UPDATE users SET bot_auto = FALSE`);

  // Una persona real con el piloto encendido. Se crea por la API (así se
  // ejercita también el endpoint /api/bot/agenda) y se lee su id de la base.
  const email = `agenda${Date.now()}@test.com`;
  const reg = await fetch(`${API}/api/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "melon42Trueno", name: "Dueña Agenda" }),
  }).then((r) => r.json());
  const token = reg.token as string;
  const { rows: urows } = await pg.query(`SELECT id FROM users WHERE email = $1`, [email]);
  const userId = urows[0].id as string;

  const guardar = await fetch(`${API}/api/bot/agenda`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ auto: true, icsUrl: "https://calendario.falso/privado.ics" }),
  });
  check("el endpoint guarda el piloto automático (auto + iCal)", guardar.ok, `HTTP ${guardar.status}`);
  const leido = await fetch(`${API}/api/bot/agenda`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  check("y al releerlo queda encendido", leido.auto === true && String(leido.icsUrl).includes("privado.ics"));

  // El calendario "devuelve" una reunión que arranca ahora (inyectamos el .ics
  // en vez de salir a internet).
  const LINK = "https://meet.jit.si/ReunionDelCalendario";
  const SALA = "jitsi:meet.jit.si/reuniondelcalendario";
  _setBajarICS(async () => [
    "BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:evento-ahora", "SUMMARY:Reunión del calendario",
    `DTSTART:${compact(Date.now())}`,
    `DESCRIPTION:Unite por ${LINK}`,
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n"));

  // La reunión falsa servida por HTTP, para que el bot de test "entre".
  const HTML = fs.readFileSync(path.join(__dirname, "fixtures", "reunion-falsa.html"), "utf8");
  const sitio = http.createServer((_q, s) => { s.writeHead(200, { "Content-Type": "text/html" }); s.end(HTML); });
  await new Promise<void>((r) => sitio.listen(4192, () => r()));

  // Un testigo en la sala companion (como quien abre "Unify al lado") ANTES
  // del despacho, para ver la línea del bot en vivo.
  const socket = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
  const lineas: any[] = [];
  socket.on("transcript-line", (p: any) => lineas.push(p.line));
  await new Promise<void>((resolve) => {
    socket.emit("join-companion", { externalKey: SALA, name: "Testigo", language: "es-AR" }, () => resolve());
    setTimeout(resolve, 4000);
  });

  // El despachador que le inyectamos al poller: registra la llamada y lleva al
  // bot (modo test) a la reunión falsa, bajo la sala DERIVADA del link.
  const llamadas: any[] = [];
  const bots: any[] = [];
  const despachador = async (a: any) => {
    llamadas.push(a);
    const bot = spawn("node", ["/home/user/Taller-0/bot/joinbot.mjs"], {
      env: {
        ...process.env, MEETING_URL: "http://localhost:4192/", ROOM_KEY: a.roomKey,
        SERVER_URL: API, PLATFORM: "test", BOT_NAME: "Unify Notetaker",
        BOT_TEST_LINES: JSON.stringify(["hola, esta reunión la agendé y el bot entró solo"]),
        MAX_MIN: "5",
      },
      stdio: "ignore", detached: true,
    });
    bots.push(bot);
  };

  // PRIMERA pasada: tiene que despachar UNA vez, con la sala derivada y el dueño.
  const n1 = await repasarAgenda(despachador);
  check("el poller despacha el bot al arrancar la reunión", n1 === 1, `despachados=${n1}`);
  check("lo despacha a la sala DERIVADA del link", llamadas[0]?.roomKey === SALA, llamadas[0]?.roomKey);
  check("y a nombre de quien tiene el piloto (dueño)", llamadas[0]?.ownerId === userId);
  check("con la plataforma correcta (jitsi)", llamadas[0]?.platform === "jitsi");
  check(
    "con la paciencia de MEDIA HORA del calendario (espera y se retira solo)",
    llamadas[0]?.esperaMs === 30 * 60_000,
    `esperaMs=${llamadas[0]?.esperaMs}`,
  );

  // SEGUNDA pasada (el poller corre una y otra vez): NO vuelve a mandar el bot.
  const n2 = await repasarAgenda(despachador);
  check("una segunda pasada NO manda un segundo bot (dedup real en la base)", n2 === 0, `despachados=${n2}`);

  // El TIMING: una reunión agendada para dentro de 10 minutos NO recibe el
  // bot todavía (llegaría a una sala vacía, se iría, y el dedup le impediría
  // volver a la hora real). Recién cuando la hora llega, se despacha.
  {
    const T = Date.now();
    const enDiezMin = T + 10 * 60_000;
    _setBajarICS(async () => [
      "BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:evento-futuro", "SUMMARY:Reunión de las seis",
      `DTSTART:${compact(enDiezMin)}`,
      "DESCRIPTION:https://meet.jit.si/ReunionDeLasSeis",
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n"));
    const soloCuenta: any[] = [];
    const contador = async (a: any) => { soloCuenta.push(a); };
    const antes = await repasarAgenda(contador, T);
    check("una reunión que empieza en 10 min NO se despacha todavía", antes === 0, `despachados=${antes}`);
    const alLlegar = await repasarAgenda(contador, enDiezMin - 30_000);
    check("y cuando llega la hora, el bot SÍ sale (no quedó bloqueada por dedup)",
      alLlegar === 1 && soloCuenta[0]?.roomKey === "jitsi:meet.jit.si/reuniondelasseis",
      `despachados=${alLlegar} sala=${soloCuenta[0]?.roomKey}`);
  }

  // Y el bot que entró de verdad dejó su línea en el bridge / la sala en vivo.
  const vio = await (async () => {
    for (let i = 0; i < 40; i++) {
      if (lineas.some((l) => l.speakerName === "Unify Notetaker" && /entró solo/.test(l.text))) return true;
      await sleep(500);
    }
    return false;
  })();
  check("el bot despachado por el calendario transcribe al bridge (línea en vivo)", vio,
    `lineas=${lineas.length}`);

  console.log("\n── 3. «¿Quedó conectado?»: la prueba del calendario, contra uno REAL ──");
  {
    // Un calendario de verdad servido por HTTP (no el inyector de arriba):
    // esto ejercita la bajada, el parseo y el resumen que ve la persona.
    const enDosDias = Date.now() + 2 * 24 * 3600_000;
    const ICS = [
      "BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:prueba-1", "SUMMARY:Clase de los martes",
      `DTSTART:${compact(enDosDias)}`,
      "DESCRIPTION:Entramos por https://meet.google.com/pru-ebac-abc",
      "END:VEVENT",
      // Un evento SIN link: existe, pero el bot no puede entrar (no se cuenta).
      "BEGIN:VEVENT", "UID:prueba-2", "SUMMARY:Almuerzo",
      `DTSTART:${compact(Date.now() + 3 * 24 * 3600_000)}`,
      "DESCRIPTION:En la cocina", "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    const calendario = http.createServer((q, s) => {
      if ((q.url || "").includes("vacio")) { s.writeHead(200, { "Content-Type": "text/calendar" }); s.end("BEGIN:VCALENDAR\r\nEND:VCALENDAR"); return; }
      if ((q.url || "").includes("no-es-ics")) { s.writeHead(200, { "Content-Type": "text/html" }); s.end("<html>una página cualquiera</html>"); return; }
      s.writeHead(200, { "Content-Type": "text/calendar" }); s.end(ICS);
    });
    await new Promise<void>((r) => calendario.listen(4193, () => r()));

    const probar = (url: string) =>
      fetch(`${API}/api/bot/agenda/probar`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ icsUrl: url }),
      }).then((r) => r.json());

    const buena = await probar("http://localhost:4193/mi.ics");
    check("un calendario con reuniones dice CONECTADO y las lista",
      buena.ok === true && buena.proximas?.length === 1 &&
      /Clase de los martes/.test(buena.proximas[0].subject) && buena.proximas[0].platform === "google-meet",
      JSON.stringify(buena).slice(0, 120));

    const vacia = await probar("http://localhost:4193/vacio.ics");
    check("uno vacío NO miente: dice que se leyó pero no hay reuniones con link",
      vacia.ok === true && (vacia.proximas?.length ?? 0) === 0, JSON.stringify(vacia).slice(0, 80));

    const noEsIcs = await probar("http://localhost:4193/no-es-ics");
    check("una dirección que no es un calendario se explica (no dice «guardado» y listo)",
      noEsIcs.ok === false && /no es un calendario/i.test(noEsIcs.error ?? ""), String(noEsIcs.error).slice(0, 70));

    const rota = await probar("http://localhost:4199/no-existe.ics");
    check("una dirección que no abre se explica igual de claro",
      rota.ok === false && /No pudimos abrir/i.test(rota.error ?? ""), String(rota.error).slice(0, 70));

    const sinSesion = await fetch(`${API}/api/bot/agenda/probar`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ icsUrl: "http://localhost:4193/mi.ics" }),
    });
    check("sin sesión, la prueba no atiende (el calendario es privado)", sinSesion.status === 401,
      `HTTP ${sinSesion.status}`);

    await new Promise<void>((r) => calendario.close(() => r()));
  }

  console.log("\n── 4. La reunión de SIEMPRE (sin calendario, la del celular) ──");
  {
    // Sacar la dirección iCal secreta de Google exige una computadora (en la
    // app del iPad no existe), así que este es el camino que sí funciona
    // desde el teléfono: el link, los días y la hora.
    const crear = (cuerpo: any, tok = token) =>
      fetch(`${API}/api/bot/repeticiones`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
        body: JSON.stringify(cuerpo),
      });

    const malo = await crear({ url: "https://example.com/no-es-reunion", dias: [1], hora: "10:00" });
    check("un link que no es de reunión se rechaza al guardarlo (no falla a las 10)",
      malo.status === 400, `HTTP ${malo.status}`);

    const sinDias = await crear({ url: "https://meet.jit.si/RepeDePrueba", dias: [], hora: "10:00" });
    check("sin días elegidos, tampoco guarda", sinDias.status === 400, `HTTP ${sinDias.status}`);

    const horaMala = await crear({ url: "https://meet.jit.si/RepeDePrueba", dias: [1], hora: "25:99" });
    check("una hora imposible se rechaza", horaMala.status === 400, `HTTP ${horaMala.status}`);

    // La de verdad: HOY, dentro de un minuto, en la zona de la persona.
    const ZONA = "America/Argentina/Buenos_Aires";
    const enUnMinuto = new Date(Date.now() + 60_000);
    const partes = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: ZONA, hour12: false, weekday: "short",
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      }).formatToParts(enUnMinuto).map((x) => [x.type, x.value]),
    );
    const diaHoy = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(partes.weekday));
    const horaLocal = `${partes.hour}:${partes.minute}`;

    const ok = await crear({
      titulo: "Mi clase de siempre", url: "https://meet.jit.si/LaDeTodosLosDias",
      dias: [diaHoy], hora: horaLocal, zona: ZONA,
    });
    const creada = await ok.json();
    check("se guarda la reunión de siempre (link + días + hora)", ok.ok && Boolean(creada.repeticion?.id),
      `HTTP ${ok.status}`);
    check("y prende el piloto automático sola (guardar algo que no va a pasar sería mentir)",
      creada.pilotoEncendido === true);

    const listadas = await fetch(`${API}/api/bot/repeticiones`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    check("aparece en la lista de la persona", listadas.repeticiones?.length === 1 &&
      listadas.repeticiones[0].titulo === "Mi clase de siempre");

    // El poller, a la hora exacta: el calendario inyectado ya no devuelve nada
    // nuevo, así que lo que despache sale de la repetición.
    _setBajarICS(async () => "BEGIN:VCALENDAR\r\nEND:VCALENDAR");
    const enHora: any[] = [];
    const n = await repasarAgenda(async (a) => { enHora.push(a); }, Date.now() + 60_000);
    check("a la hora, el bot sale SOLO a la reunión de siempre", n === 1 &&
      enHora[0]?.roomKey === "jitsi:meet.jit.si/ladetodoslosdias", `despachados=${n} sala=${enHora[0]?.roomKey}`);
    check("y con la misma paciencia de media hora del calendario",
      enHora[0]?.esperaMs === 30 * 60_000, String(enHora[0]?.esperaMs));

    const otra = await repasarAgenda(async (a) => { enHora.push(a); }, Date.now() + 60_000);
    check("una segunda pasada NO manda un segundo bot a la misma", otra === 0, `despachados=${otra}`);

    // Y a una hora que no es la suya, no sale.
    const enTresHoras = await repasarAgenda(async () => {}, Date.now() + 3 * 3600_000);
    check("fuera de su horario no despacha nada", enTresHoras === 0, `despachados=${enTresHoras}`);

    // Sólo la dueña la ve y la borra.
    const otroReg = await fetch(`${API}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `ajena${Date.now()}@test.com`, password: "melon42Trueno", name: "Ajena" }),
    }).then((r) => r.json());
    const ajena = await fetch(`${API}/api/bot/repeticiones/${creada.repeticion.id}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${otroReg.token}` },
    });
    check("otra persona NO puede borrar tu reunión de siempre", ajena.status === 404, `HTTP ${ajena.status}`);

    const borrada = await fetch(`${API}/api/bot/repeticiones/${creada.repeticion.id}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${token}` },
    });
    check("la dueña sí la borra", borrada.ok, `HTTP ${borrada.status}`);
  }

  // Limpieza.
  for (const b of bots) { try { process.kill(-b.pid, "SIGTERM"); } catch { try { b.kill("SIGTERM"); } catch {} } }
  socket.close();
  await pg.end();
  await new Promise<void>((r) => sitio.close(() => r()));

  const fallidos = results.filter((r) => !r).length;
  console.log(`\n${results.length - fallidos}/${results.length} OK`);
  process.exit(fallidos ? 1 : 0);
})().catch((e) => { console.error("sim_agenda explotó:", e); process.exit(1); });
