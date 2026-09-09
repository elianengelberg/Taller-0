// LA MISMA REUNIÓN, POR DOS PUERTAS.
//
// Pedido real: «crear una reunión de Unify y que se puedan unir desde
// cualquier aplicación/web de reuniones». Un cliente de Zoom no se puede
// conectar a una sala de Unify (sólo habla con los servidores de Zoom), así
// que la forma honesta es la inversa: el anfitrión pega el enlace de SU Zoom,
// Meet o Teams al crear la reunión, y esa sala externa pasa a apuntar a la
// reunión de Unify. Los que entran por su app y los que entran por Unify
// terminan en la MISMA sala: una transcripción, una traducción, una IA y un
// solo historial.
//
// Acá se prueba con el stack real: se crea la reunión por socket con su sala
// externa, se manda una línea por el puente (que es lo que hacen la extensión
// y el bot) y se exige que caiga en ESA reunión, en vivo y en el historial.
const { io } = require("/home/user/Taller-0/client/node_modules/socket.io-client");

const API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NUMERO = `9${Math.floor(Math.random() * 900000000 + 100000000)}`;
const CLAVE = `zoom:${NUMERO}`;

function conectar() {
  return io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
}
const emitir = (s, evento, carga) =>
  new Promise((resolve) => {
    s.emit(evento, carga, resolve);
    setTimeout(() => resolve({ ok: false, error: "sin respuesta" }), 8000);
  });

(async () => {
  const reg = await fetch(`${API}/api/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `puerta${Date.now()}@test.com`, password: "melon42Trueno", name: "Anfitriona" }),
  }).then((r) => r.json());

  // 1. El anfitrión crea la reunión en Unify pegando su enlace de Zoom.
  const anfitriona = conectar();
  const lineas = [];
  anfitriona.on("transcript-line", (p) => lineas.push(p.line));
  const creada = await emitir(anfitriona, "create-meeting", {
    hostName: "Anfitriona", hostLanguage: "es-AR", roles: [], token: reg.token,
    salaExterna: { clave: CLAVE, enlace: `https://zoom.us/j/${NUMERO}`, etiqueta: "Zoom" },
  });
  check("la reunión de Unify se crea con la puerta de la otra app", creada.ok === true, JSON.stringify(creada).slice(0, 120));
  const codigo = creada.meeting?.id;
  const dbId = creada.meeting?.dbId;
  check("y la reunión sabe cuál es su otra puerta (para invitar con las dos)",
    creada.meeting?.salaExterna?.clave === CLAVE && creada.meeting?.salaExterna?.etiqueta === "Zoom",
    JSON.stringify(creada.meeting?.salaExterna));

  // 2. Alguien entra por Zoom: su voz llega por el puente (extensión o bot).
  const porElPuente = await fetch(`${API}/api/meet-bridge/${encodeURIComponent(CLAVE)}/transcript`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ speaker: "Bruno (por Zoom)", text: "entré desde Zoom y me escuchan igual", lang: "es-AR" }),
  });
  check("una línea que llega desde la otra app se acepta", porElPuente.status === 200, `HTTP ${porElPuente.status}`);
  await sleep(900);
  check("y aparece EN VIVO en la reunión de Unify (no en una sala aparte)",
    lineas.some((l) => /desde Zoom/.test(l.text) && l.speakerName === "Bruno (por Zoom)"),
    JSON.stringify(lineas.map((l) => [l.speakerName, l.text.slice(0, 30)])));

  // 3. La puerta externa NO abre una reunión separada: es la misma sala.
  const sesion = await fetch(`${API}/api/meet-bridge/${encodeURIComponent(CLAVE)}/session`).then((r) => r.json());
  check("el puente resuelve a la MISMA reunión (mismo id de historial)", sesion.dbId === dbId, `${sesion.dbId} vs ${dbId}`);
  check("y el código que ve el puente es el de la reunión de Unify", sesion.joinCode === codigo, `${sesion.joinCode} vs ${codigo}`);

  // 4. Todo queda en UN historial, con las dos voces.
  const invitada = conectar();
  await emitir(invitada, "join-meeting", { meetingId: codigo, name: "Caro", language: "es-AR", token: reg.token });
  await sleep(300);
  let mensajes = [];
  for (let i = 0; i < 12; i++) {
    const det = await fetch(`${API}/api/meetings/${dbId}`, { headers: { Authorization: `Bearer ${reg.token}` } });
    const cuerpo = det.ok ? await det.json() : {};
    mensajes = cuerpo.meeting?.messages ?? [];
    if (mensajes.some((m) => /desde Zoom/.test(m.text || ""))) break;
    await sleep(500);
  }
  check("en el historial (uno solo) está lo que se dijo del lado de afuera",
    mensajes.some((m) => /desde Zoom/.test(m.text || "")),
    `mensajes=${mensajes.length}`);

  // 5. Una sala externa que NADIE enlazó sigue abriendo su propia reunión
  //    (no se roban salas ajenas).
  const otraClave = `zoom:9${Math.floor(Math.random() * 900000000 + 100000000)}`;
  const otra = await fetch(`${API}/api/meet-bridge/${encodeURIComponent(otraClave)}/session`).then((r) => r.json());
  check("una sala externa sin enlazar sigue siendo su propia reunión", otra.dbId && otra.dbId !== dbId, `${otra.dbId}`);

  anfitriona.close();
  invitada.close();
  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} OK`);
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exit(1); });
