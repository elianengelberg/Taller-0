// LA IA EN UNA REUNIÓN QUE SE LEE TRADUCIDA.
//
// La gente lee los subtítulos traducidos a su idioma, pero lo que se DIJO
// está en otro. La pregunta es qué recibe la IA y en qué idioma contesta: si
// le llegara la traducción en vez del original, estaría respondiendo sobre un
// texto de segunda mano; y si contestara en el idioma de la reunión, quien
// pregunta en castellano no la entendería.
//
// Servidor real en 4005 (con su propia base de datos, la misma) y un Anthropic
// simulado en 4179 que GUARDA lo que se le manda: así se puede mirar el
// pedido de verdad, no una suposición.
const { spawn } = require("child_process");
const http = require("http");
const { io } = require("/home/user/Taller-0/client/node_modules/socket.io-client");

const API = "http://127.0.0.1:4005";
const PUERTO_IA = 4179;
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esperar = async (fn, ms) => { const h = Date.now() + ms; while (Date.now() < h) { try { if (await fn()) return true; } catch {} await sleep(300); } return false; };

(async () => {
  // El modelo simulado: guarda cada pedido y contesta en castellano.
  const pedidos = [];
  const ia = http.createServer((req, res) => {
    const partes = [];
    req.on("data", (c) => partes.push(c));
    req.on("end", () => {
      try { pedidos.push(JSON.parse(Buffer.concat(partes).toString())); } catch { pedidos.push(null); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "msg", type: "message", role: "assistant", model: "stub",
        content: [{ type: "text", text: "Bruno dijo que los números están listos para el jueves." }],
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
      PORT: "4005", CLIENT_ORIGIN: "http://localhost:4174", MAIL_LOG: "1", LIMITE_BRIDGE: "2400",
      ANTHROPIC_API_KEY: "clave-stub", ANTHROPIC_BASE_URL: `http://127.0.0.1:${PUERTO_IA}`,
    },
    stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  let logSrv = "";
  srv.stdout.on("data", (d) => { logSrv += d.toString(); });
  srv.stderr.on("data", (d) => { logSrv += d.toString(); });
  const vivo = await esperar(async () => { try { return (await fetch(`${API}/api/health`)).ok; } catch { return false; } }, 40_000);
  check("el servidor con IA configurada levanta", vivo);

  try {
    const reg = await fetch(`${API}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `ia${Date.now()}@test.com`, password: "melon42Trueno", name: "Ana" }),
    }).then((r) => r.json());

    // Una reunión de Unify (interna) con una puerta en Zoom: las dos formas de
    // que entre texto, en la misma prueba.
    const NUM = `9${Math.floor(Math.random() * 900000000 + 100000000)}`;
    const CLAVE = `zoom:${NUM}`;
    const s = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
    const creada = await new Promise((resolve) => {
      s.emit("create-meeting", {
        hostName: "Ana", hostLanguage: "es-AR", roles: [], token: reg.token,
        salaExterna: { clave: CLAVE, enlace: `https://zoom.us/j/${NUM}`, etiqueta: "Zoom" },
      }, resolve);
      setTimeout(() => resolve({ ok: false }), 8000);
    });
    check("la reunión se crea", creada.ok === true);
    const dbId = creada.meeting?.dbId;

    // Lo que se dijo, EN INGLÉS (así llega de una reunión en inglés).
    for (const [quien, texto] of [
      ["Bruno Pérez", "the numbers are ready for thursday and I will send the deck tonight"],
      ["Caro Díaz", "we should close the budget before friday, otherwise we lose the discount"],
    ]) {
      await fetch(`${API}/api/meet-bridge/${encodeURIComponent(CLAVE)}/transcript`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speaker: quien, text: texto, lang: "es-AR" }),
      });
      await sleep(1200);
    }
    await sleep(1500);

    // La pregunta, en castellano (como la escribe quien lee traducido).
    const antes = pedidos.length;
    const r = await fetch(`${API}/api/meetings/${dbId}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${reg.token}` },
      body: JSON.stringify({ question: "¿Qué dijo Bruno sobre los números?" }),
    });
    const cuerpo = await r.json().catch(() => ({}));
    check("la IA de la reunión contesta (200)", r.status === 200 && typeof cuerpo.answer === "string", `HTTP ${r.status}`);
    check("y la respuesta llega tal cual a quien pregunta", /números están listos/.test(cuerpo.answer || ""), (cuerpo.answer || "").slice(0, 60));

    const pedido = pedidos.slice(antes).pop();
    const sistema = JSON.stringify(pedido?.system ?? "");
    const mensajes = JSON.stringify(pedido?.messages ?? "");
    check("a la IA le llega lo que se DIJO, en su idioma original (no la traducción)",
      /the numbers are ready for thursday/.test(sistema) && /close the budget before friday/.test(sistema),
      sistema.slice(0, 80));
    check("con el nombre de cada persona", /Bruno Pérez/.test(sistema) && /Caro Díaz/.test(sistema));
    check("y la instrucción de responder en el idioma de quien pregunta",
      /idioma en que te escriben/.test(sistema));
    check("la pregunta viaja como la escribió la persona",
      /Qué dijo Bruno sobre los números/.test(mensajes), mensajes.slice(0, 80));

    // El informe: lo mismo, sobre el original.
    const antesInf = pedidos.length;
    const inf = await fetch(`${API}/api/meetings/${dbId}/report`, {
      method: "POST", headers: { Authorization: `Bearer ${reg.token}` },
    });
    const cuerpoInf = await inf.json().catch(() => ({}));
    check("el informe se genera", inf.status === 200 && typeof cuerpoInf.report === "string", `HTTP ${inf.status}`);
    const pedidoInf = pedidos.slice(antesInf).pop();
    check("y también se arma con lo que se dijo de verdad",
      /the numbers are ready for thursday/.test(JSON.stringify(pedidoInf?.system ?? "")));

    check("el servidor no tiró errores sin manejar", !/Unhandled|TypeError|ReferenceError/.test(logSrv),
      logSrv.split("\n").filter((l) => /Unhandled|TypeError|ReferenceError/.test(l))[0] || "");
    s.close();
  } finally {
    try { process.kill(-srv.pid, "SIGTERM"); } catch { try { srv.kill("SIGTERM"); } catch {} }
    ia.close();
  }

  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} OK`);
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exit(1); });
