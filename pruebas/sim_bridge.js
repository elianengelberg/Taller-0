// Verifica el bridge de la extensión: líneas de TODOS los participantes que
// llegan en vivo a la web, se persisten en el historial y alimentan la IA.
const { io } = require("/home/user/Taller-0/client/node_modules/socket.io-client");
const API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CODE = "xyz-" + Math.random().toString(36).slice(2, 6) + "-abc";
// Código ÚNICO por corrida. Estaba fijo ("xyz-qwer-abc") y eso hacía fallar
// la suite contra un servidor que llevaba horas prendido: la sala en memoria
// de una corrida anterior seguía viva, con la reunión de OTRO usuario de
// prueba adentro, y el historial que se leía no era el que se acababa de
// escribir. Con servidor recién arrancado pasaba; con uno real, no. Una
// prueba que depende de cuándo se reinició el servidor no prueba nada.
const rnd3 = () => Array.from({ length: 3 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
const code = `${rnd3()}-${rnd3()}${rnd3()[0]}-${rnd3()}`; // formato válido: 3-4-3

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
  // Esta comprobación era VACÍA: comparaba dbId con joined.meeting.dbId, y
  // dbId se había definido como joined.meeting.dbId dos líneas antes -- una
  // variable contra sí misma, siempre verdadera. Ahora compara de verdad la
  // sala del SOCKET (la web) contra la que devuelve el BRIDGE (la extensión),
  // que es lo único que importa: si difieren, las transcripciones se parten
  // en dos historiales distintos.
  const puente = await post(`/api/meet-bridge/${code}/transcript`,
    { speaker: "Ana", text: "control de sala", lang: "es-AR" });
  check("la reunión es la misma para la web y para la extensión",
    live.length > 0 && puente.body?.dbId === joined.meeting.dbId,
    `bridge=${puente.body?.dbId} socket=${joined.meeting.dbId}`);

  // LA FUSIÓN DE FRAGMENTOS. El motor de Meet corta la frase cada ~1,6 s de
  // pausa, así que un pensamiento llegaba PICADO en varias líneas -- feas de
  // leer y peores de traducir. Ahora, si el MISMO hablante sigue enseguida,
  // el fragmento se PEGA a su última línea (misma id, la web la re-renderiza)
  // en vez de abrir otra. "control de sala" vino de Ana justo después de la
  // línea de Ana: tiene que haber crecido esa línea, no sumado una nueva.
  await sleep(400);
  const idAna = live[3]?.id;
  const crecida = live[live.length - 1];
  check("un fragmento que sigue enseguida SE PEGA a la línea anterior (misma id)",
    crecida?.id === idAna && / control de sala$/.test(crecida?.text ?? ""),
    `${crecida?.id === idAna ? "misma id" : "id distinta"}: "${crecida?.text}"`);

  // Otro hablante SIEMPRE abre línea nueva; y sus propios fragmentos seguidos
  // quedan en UNA sola.
  await post(`/api/meet-bridge/${code}/transcript`, { speaker: "Dani", text: "una cosa más sobre los plazos", lang: "es-AR" });
  await sleep(400);
  await post(`/api/meet-bridge/${code}/transcript`, { speaker: "Dani", text: "mejor lo vemos el jueves", lang: "es-AR" });
  await sleep(600);
  const deDani = live.filter((l) => l.speakerName === "Dani");
  check("otro hablante abre línea nueva, y sus fragmentos seguidos quedan en UNA",
    new Set(deDani.map((l) => l.id)).size === 1 &&
    deDani[deDani.length - 1]?.text === "una cosa más sobre los plazos mejor lo vemos el jueves",
    deDani[deDani.length - 1]?.text);

  // Persistencia: el historial del dueño debe tener todo -- y SIN filas
  // picadas: 4 líneas de la charla + la única de Dani (las fusiones crecen la
  // fila existente, no agregan).
  await sleep(400);
  const det = await fetch(`${API}/api/meetings/${dbId}`, { headers: { Authorization: `Bearer ${token}` } });
  const detail = await det.json();
  const msgs = detail?.meeting?.messages ?? [];
  check("todo queda guardado en el historial SIN filas picadas", msgs.length === 5, `mensajes=${msgs.length}`);
  check("y las filas fusionadas guardan el texto COMPLETO",
    msgs.some((m) => / control de sala$/.test(m.text ?? "")) &&
    msgs.some((m) => /una cosa más sobre los plazos mejor lo vemos el jueves/.test(m.text ?? "")),
    msgs.map((m) => m.text).join(" | ").slice(0, 160));
  const savedSpeakers = [...new Set(msgs.map((m) => m.senderName))];
  check("el historial conserva quién dijo cada cosa", savedSpeakers.length === 4, savedSpeakers.join(", "));

  // EL ECO. Dos oídos que escuchan la misma voz producían la misma frase dos
  // veces (los subtítulos de Meet y el oído de la pestaña; dos micrófonos en
  // la misma sala, o uno sin auriculares). Ahora el servidor la reconoce por
  // PARECIDO y no la repite -- y si la primera vino de un oído "sin cara",
  // el nombre gana.
  {
    const antes = live.length;
    const frase = "mañana cerramos el presupuesto con el equipo de ventas";
    await post(`/api/meet-bridge/${code}/transcript`, { speaker: "Voces de la reunión", text: frase, lang: "es-AR" });
    await sleep(300);
    const generica = live[live.length - 1];
    check("el oído de la pestaña pone la frase como «Voces de la reunión»",
      live.length === antes + 1 && generica?.speakerName === "Voces de la reunión", String(generica?.speakerName));
    // Meet la subtitula CON NOMBRE un instante después (con otro error de oído).
    const r = await post(`/api/meet-bridge/${code}/transcript`,
      { speaker: "Ana", text: "mañana cerramos el presupuesto con el equipo de venta", lang: "es-AR" });
    await sleep(400);
    const renombrada = live[live.length - 1];
    const idsDeLaFrase = new Set(live.filter((l) => /cerramos el presupuesto/.test(l.text)).map((l) => l.id));
    check("la misma frase con nombre NO se repite: se responde como eco", r.body?.eco === true, JSON.stringify(r.body).slice(0, 90));
    check("y el nombre gana: la línea genérica pasa a ser de Ana (misma id, sin línea nueva)",
      renombrada?.id === generica?.id && renombrada?.speakerName === "Ana" && idsDeLaFrase.size === 1,
      `${renombrada?.speakerName} / ids=${idsDeLaFrase.size}`);
    // El micrófono de Dani (misma sala) la oye por el parlante: eco, afuera.
    const antesDani = live.length;
    const rd = await post(`/api/meet-bridge/${code}/transcript`, { speaker: "Dani", text: frase, lang: "es-AR" });
    await sleep(400);
    check("el eco por el parlante de OTRO micrófono no entra",
      rd.body?.eco === true && live.length === antesDani, `líneas nuevas=${live.length - antesDani}`);
    // Y por el SOCKET (la voz de un participante de la web): mismo criterio.
    const antesSocket = live.length;
    s.emit("transcript-line", { alternatives: [frase], lang: "es-AR" });
    await sleep(800);
    check("tampoco entra el eco que llega por la voz de la web (socket)",
      live.length === antesSocket, `líneas nuevas=${live.length - antesSocket}`);
    s.emit("transcript-line", { alternatives: ["perfecto, entonces yo preparo la presentación"], lang: "es-AR" });
    await sleep(800);
    check("una frase DISTINTA por el socket sí entra (el anti-eco no come frases legítimas)",
      live.length === antesSocket + 1 && /preparo la presentación/.test(live[live.length - 1]?.text ?? ""),
      String(live[live.length - 1]?.text));
    // Repetir una frase corta es normal ("sí, dale") y no se filtra.
    const antesCorta = live.length;
    await post(`/api/meet-bridge/${code}/transcript`, { speaker: "Bruno", text: "sí, dale", lang: "es-AR" });
    await post(`/api/meet-bridge/${code}/transcript`, { speaker: "Caro", text: "sí, dale", lang: "es-AR" });
    await sleep(400);
    check("las frases cortas repetidas («sí, dale») no se consideran eco",
      live.length === antesCorta + 2, `líneas nuevas=${live.length - antesCorta}`);
    // El historial también aprendió el nombre.
    const det2 = await fetch(`${API}/api/meetings/${dbId}`, { headers: { Authorization: `Bearer ${token}` } });
    const msgs2 = (await det2.json())?.meeting?.messages ?? [];
    const filas = msgs2.filter((m) => /cerramos el presupuesto/.test(m.text ?? ""));
    check("y en el historial la frase quedó a nombre de Ana, no de «Voces de la reunión»",
      filas.length === 1 && filas[0]?.senderName === "Ana", `${filas[0]?.senderName} / filas=${filas.length}`);
  }

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
