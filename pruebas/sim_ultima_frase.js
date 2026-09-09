// LA ÚLTIMA FRASE DE QUIEN SE VA.
//
// La frase sale a pantalla al instante, cruda, marcada «provisional», y un
// segundo después la IA manda la versión corregida: recién ahí las pantallas
// la traducen (traducir lo crudo sería traducir los errores del
// reconocimiento). Pero si quien habló se iba mientras la IA pensaba, el
// servidor tiraba esa corrección a la basura -- y la frase se quedaba
// «provisional» PARA SIEMPRE: nadie la traducía nunca. La despedida de quien
// se va (justo la que más se dice antes de irse) quedaba en un idioma que el
// resto no entiende.
//
// Servidor real, con un Anthropic simulado que TARDA a propósito: así se
// puede cortar la conexión justo en el medio, que es cuando pasaba.
const { spawn } = require("child_process");
const http = require("http");
const { io } = require("/home/user/Taller-0/client/node_modules/socket.io-client");

const API = "http://127.0.0.1:4007";
const PUERTO_IA = 4181;
const DEMORA_IA_MS = 1500;
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esperar = async (fn, ms) => { const h = Date.now() + ms; while (Date.now() < h) { try { if (await fn()) return true; } catch {} await sleep(300); } return false; };

const FRASE = "el informe quedó listo y lo mando esta misma tarde";
const CORREGIDA = "el informe quedó listo y lo mando esta misma tarde.";
const EN_INGLES = "the report is ready and I am sending it this afternoon";
// Otra frase distinta: la MISMA frase dicha por otra persona es un eco (dos
// oídos captando el mismo audio) y el servidor la calla a propósito.
const OTRA_FRASE = "mañana repasamos los números con el equipo de finanzas";

(async () => {
  // El modelo simulado. Contesta las dos cosas que le pide el servidor (la
  // corrección del fragmento y la traducción a cada idioma), pero SE TOMA SU
  // TIEMPO: esa demora es la ventana en la que la persona se va.
  const ia = http.createServer((req, res) => {
    const partes = [];
    req.on("data", (c) => partes.push(c));
    req.on("end", async () => {
      let cuerpo = {};
      try { cuerpo = JSON.parse(Buffer.concat(partes).toString()); } catch {}
      const sistema = JSON.stringify(cuerpo.system ?? "");
      const pedido = JSON.stringify(cuerpo.messages ?? "");
      const pideTraduccion = /TRAD_/.test(sistema);
      // La «corrección» de este modelo de mentira es sólo ponerle el punto
      // final: alcanza para distinguir la versión corregida de la cruda.
      const dicha = pedido.includes(OTRA_FRASE) ? OTRA_FRASE : FRASE;
      await sleep(DEMORA_IA_MS);
      const texto = pideTraduccion ? `TRAD_en: ${EN_INGLES}` : `IDIOMA: es\nTEXTO: ${dicha}.`;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "msg", type: "message", role: "assistant", model: "stub",
        content: [{ type: "text", text: texto }],
        stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  await new Promise((r) => ia.listen(PUERTO_IA, r));

  const srv = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: "/home/user/Taller-0/server",
    env: {
      ...process.env,
      DATABASE_URL: "postgres://postgres@localhost:5433/unify",
      AUTH_SECRET: "clave-de-pruebas-local-larga-1234567890",
      PORT: "4007", CLIENT_ORIGIN: "http://localhost:4174", MAIL_LOG: "1", LIMITE_BRIDGE: "2400",
      ANTHROPIC_API_KEY: "clave-stub", ANTHROPIC_BASE_URL: `http://127.0.0.1:${PUERTO_IA}`,
    },
    stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  let logSrv = "";
  srv.stdout.on("data", (d) => { logSrv += d.toString(); });
  srv.stderr.on("data", (d) => { logSrv += d.toString(); });
  const vivo = await esperar(async () => { try { return (await fetch(`${API}/api/health`)).ok; } catch { return false; } }, 40_000);
  check("el servidor con IA configurada levanta", vivo);

  const abiertos = [];
  try {
    // Dos personas, cada una leyendo en su idioma: una habla en castellano y
    // la otra tiene que leerla en inglés.
    const ana = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
    abiertos.push(ana);
    const creada = await new Promise((resolve) => {
      ana.emit("create-meeting", { hostName: "Ana Ríos", hostLanguage: "es-AR", roles: [] }, resolve);
      setTimeout(() => resolve({ ok: false }), 8000);
    });
    check("la reunión se crea", creada.ok === true);
    const codigo = creada.meeting?.id;

    const bruno = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
    abiertos.push(bruno);
    const entro = await new Promise((resolve) => {
      bruno.timeout(8000).emit("join-meeting", { meetingId: codigo, name: "Bruno Lee", language: "en-US" }, (_e, r) => resolve(r));
    });
    check("la otra persona entra, leyendo en inglés", entro?.ok === true);

    // Lo que ve Bruno de la línea de Ana, en orden.
    const versiones = [];
    bruno.on("transcript-line", ({ line }) => versiones.push({ text: line.text, provisional: line.provisional === true, at: Date.now() }));
    const traducciones = [];
    bruno.on("transcript-line-translations", (p) => traducciones.push(p));

    // Ana dice su última frase Y SE VA mientras la IA todavía está pensando.
    ana.emit("transcript-line", { text: FRASE, lang: "es-AR", alternatives: [FRASE] });
    await sleep(400);
    check("la frase sale al instante, sin esperar a la IA", versiones.length >= 1,
      versiones[0] ? `${versiones[0].provisional ? "provisional" : "final"}: ${versiones[0].text.slice(0, 40)}` : "no salió nada");
    check("y sale marcada como provisional (la corrección viene en camino)", versiones[0]?.provisional === true);

    ana.close(); // se despidió y cerró la app: la IA sigue pensando
    await sleep(DEMORA_IA_MS + 2500);

    const ultima = versiones[versiones.length - 1];
    check("aunque quien habló ya se fue, la frase se TERMINA (deja de ser provisional)",
      ultima && ultima.provisional === false,
      ultima ? `${ultima.provisional ? "quedó PROVISIONAL para siempre" : "cerrada"}: ${ultima.text.slice(0, 45)}` : "nunca llegó");
    check("con la corrección de la IA, no la lectura cruda",
      /esta misma tarde\./.test(ultima?.text ?? ""), (ultima?.text ?? "").slice(0, 50));
    check("y le llega traducida a quien lee en otro idioma",
      traducciones.some((t) => /the report is ready/.test(t.translations?.en ?? "")),
      JSON.stringify(traducciones.map((t) => t.translations)).slice(0, 90) || "ninguna traducción");

    // Y con las dos personas adentro, que es lo de siempre, nada cambia.
    {
      const otra = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
      abiertos.push(otra);
      const entroCaro = await new Promise((resolve) => {
        otra.timeout(8000).emit("join-meeting", { meetingId: codigo, name: "Caro Sosa", language: "es-AR" }, (_e, r) => resolve(r));
      });
      check("otra persona entra a la reunión que sigue viva", entroCaro?.ok === true, JSON.stringify(entroCaro || {}).slice(0, 90));
      const vistas = [];
      bruno.on("transcript-line", ({ line }) => vistas.push({ text: line.text, provisional: line.provisional === true }));
      otra.emit("transcript-line", { text: OTRA_FRASE, lang: "es-AR", alternatives: [OTRA_FRASE] });
      await sleep(DEMORA_IA_MS + 2500);
      const fin = vistas[vistas.length - 1];
      check("quien se queda hablando también ve su frase cerrada y corregida",
        fin && fin.provisional === false && fin.text === `${OTRA_FRASE}.`,
        fin ? `${fin.provisional ? "provisional" : "cerrada"}: ${fin.text.slice(0, 45)}` : "nunca llegó");
    }

    check("el servidor no tiró errores sin manejar", !/Unhandled|TypeError|ReferenceError/.test(logSrv),
      logSrv.split("\n").filter((l) => /Unhandled|TypeError|ReferenceError/.test(l))[0] || "");
  } finally {
    for (const s of abiertos) { try { s.close(); } catch {} }
    try { process.kill(-srv.pid, "SIGTERM"); } catch { try { srv.kill("SIGTERM"); } catch {} }
    ia.close();
  }

  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} OK`);
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exit(1); });
