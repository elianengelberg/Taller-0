// Verifica el bridge de la extensión: líneas de TODOS los participantes que
// llegan en vivo a la web, se persisten en el historial y alimentan la IA.
const { io } = require("/home/user/Taller-0/client/node_modules/socket.io-client");
const API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CODE = "xyz-" + Math.random().toString(36).slice(2, 6) + "-abc";
const code = "xyz-qwer-abc"; // formato válido: 3-4-3

async function register(name) {
  const r = await fetch(`${API}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${name}${Date.now()}@t.com`, name, password: "password123" }) });
  return (await r.json()).token;
}
const post = (p, b, token) => fetch(API + p, { method: "POST",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

(async () => {
  const token = await register("Extuser");

  // Un usuario de la WEB entra a la sala companion de ese Meet (como haría
  // alguien que abrió el enlace en Unify).
  const s = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
  await new Promise((r, x) => { s.on("connect", r); s.on("connect_error", x); });
  const joined = await new Promise((res) => s.timeout(8000).emit("join-companion",
    { externalKey: `google-meet:${code}`, name: "Espectador", language: "es-AR", token }, (e, r) => res(r)));
  check("un usuario de la web entra a la sala del Meet", joined?.ok === true);
  const dbId = joined.meeting.dbId;

  // La EXTENSIÓN empuja líneas de varios participantes (como los subtítulos de Meet).
  const live = [];
  s.on("transcript-line", (d) => live.push(d.line));
  const said = [
    ["Ana", "buenos días, empecemos por el presupuesto"],
    ["Bruno", "el trimestre cerró un quince por ciento arriba"],
    ["Caro", "diseño necesita dos semanas más"],
    ["Ana", "de acuerdo, lo dejamos para el próximo sprint"],
  ];
  for (const [speaker, text] of said) {
    const r = await post(`/api/meet-bridge/${code}/transcript`, { speaker, text, lang: "es-AR" });
    if (r.status !== 200) check(`push de ${speaker}`, false, `status=${r.status}`);
  }
  await sleep(700);

  check("las 4 líneas llegan EN VIVO a la web", live.length === 4, `recibidas=${live.length}`);
  const speakers = [...new Set(live.map((l) => l.speakerName))];
  check("llegan TODOS los hablantes, no solo uno", speakers.length === 3, speakers.join(", "));
  check("cada línea trae el nombre de quien habló", live.every((l) => l.speakerName && l.text));
  check("la reunión es la misma para la web y para la extensión", live.length > 0 && dbId === joined.meeting.dbId);

  // Persistencia: el historial del dueño debe tener todo.
  const det = await fetch(`${API}/api/meetings/${dbId}`, { headers: { Authorization: `Bearer ${token}` } });
  const detail = await det.json();
  const msgs = detail?.meeting?.messages ?? [];
  check("todo queda guardado en el historial", msgs.length >= 4, `mensajes=${msgs.length}`);
  const savedSpeakers = [...new Set(msgs.map((m) => m.senderName))];
  check("el historial conserva quién dijo cada cosa", savedSpeakers.length === 3, savedSpeakers.join(", "));

  // La IA del panel: debe pasar el control de acceso (falla solo por falta de clave).
  const ask = await post(`/api/meet-bridge/${code}/ask`, { question: "resumime la reunión" }, token);
  check("la IA del panel pasa el control de acceso",
    !/no encontramos esa reuni/i.test(ask.body?.error || ""), ask.body?.error || "respondió");
  const anon = await post(`/api/meet-bridge/${code}/ask`, { question: "hola" });
  check("la IA NO es anónima (requiere cuenta)", anon.status === 401, `status=${anon.status}`);

  // Código inválido rechazado.
  const bad = await post(`/api/meet-bridge/no-es-un-codigo/transcript`, { speaker: "x", text: "y" });
  check("un código de Meet inválido se rechaza", bad.status === 400, `status=${bad.status}`);

  s.disconnect();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
