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

  // LO YA DICHO NO SE REPITE. La foto del usuario: el reconocedor entregó
  // el mismo párrafo varias veces (un final por tramo y un acumulado con
  // todo lo anterior + lo nuevo) y la transcripción lo repetía y seguía.
  {
    const A = "dejaron de funcionar el mismo día a la misma hora y nadie sabe si fue una coincidencia";
    const B = "y es que el jueves tres de septiembre hubo un apagón en los tres grandes";
    const antesN = live.length;
    await post(`/api/meet-bridge/${code}/transcript`, { speaker: "Nico", text: A, lang: "es-AR" });
    await sleep(400);
    await post(`/api/meet-bridge/${code}/transcript`, { speaker: "Nico", text: `${A} ${B}`, lang: "es-AR" }); // el acumulado
    await sleep(400);
    const rep = await post(`/api/meet-bridge/${code}/transcript`, { speaker: "Nico", text: "Dejaron de funcionar el mismo día a la misma hora y nadie sabe si fue una coincidencia", lang: "es-AR" }); // otra vez
    await sleep(700);
    const deNico = new Map();
    for (const l of live.slice(antesN)) if (l.speakerName === "Nico") deNico.set(l.id, l.text);
    const todoNico = [...deNico.values()].join(" || ");
    const veces = (t) => (todoNico.match(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")) || []).length;
    check("un acumulado (lo ya dicho + lo nuevo) sólo agrega lo nuevo", veces(A) === 1 && veces(B) === 1, todoNico.slice(0, 160));
    check("y repetir el mismo párrafo no agrega nada (contesta ok, sin línea)",
      rep.status === 200 && (rep.body?.repetido === true || rep.body?.text === "") && veces(A) === 1, JSON.stringify(rep.body).slice(0, 100));
  }

  // LA ETIQUETA MIENTE. Lo que pasó de verdad: te hablan en inglés, el
  // reconocedor está en español, y la línea llega marcada "es-AR"; toda la
  // cadena la daba por "ya en tu idioma" y NO la traducía. Sin IA, el
  // servidor lee el idioma del propio texto y la etiqueta correctamente.
  const antes = live.length;
  await post(`/api/meet-bridge/${code}/transcript`, { speaker: "Ellen", text: "we need to close the budget before friday and I think the numbers are fine", lang: "es-AR" });
  await sleep(400);
  await post(`/api/meet-bridge/${code}/transcript`, { speaker: "Carla", text: "tenemos que cerrar el presupuesto antes del viernes con todo el equipo", lang: "en-US" });
  await sleep(700);
  const nuevas = live.slice(antes);
  const deEllen = nuevas.find((l) => l.speakerName === "Ellen");
  const deCarla = nuevas.find((l) => l.speakerName === "Carla");
  check("una frase en inglés etiquetada «es-AR» viaja como inglés (para que cada pantalla la traduzca)",
    deEllen?.sourceLang === "en", String(deEllen?.sourceLang));
  check("y una en español etiquetada «en-US» viaja como español",
    deCarla?.sourceLang === "es", String(deCarla?.sourceLang));

  // LAS FRASES CORTAS, que es lo que de verdad llega de los subtítulos de
  // Meet: "Okay", "yes, exactly". Con menos de tres palabras nadie puede
  // detectar el idioma, y hasta acá se le creía a la etiqueta -- la del
  // reconocimiento, o sea el idioma de QUIEN ESCUCHA. En una reunión en
  // inglés eso dejaba casi todas las líneas marcadas "es-AR" y por lo tanto
  // sin traducir: exactamente lo reportado. Ahora manda lo que se viene
  // hablando en esta sala.
  {
    const antesCortas = live.length;
    for (const t of ["Okay", "yes, exactly", "perfect"]) {
      await post(`/api/meet-bridge/${code}/transcript`, { speaker: "Ellen", text: t, lang: "es-AR" });
      await sleep(2200); // más que la fusión de fragmentos seguidos: líneas separadas
    }
    const cortas = live.slice(antesCortas).filter((l) => l.speakerName === "Ellen");
    check("después de una frase larga en inglés, las cortas de esa persona también viajan como inglés",
      cortas.length >= 3 && cortas.every((l) => l.sourceLang === "en"),
      cortas.map((l) => `${l.text}=${l.sourceLang}`).join(" | "));
    // Y una persona que SÍ habla español no se contagia: su frase larga manda.
    const antesCaro = live.length;
    await post(`/api/meet-bridge/${code}/transcript`, { speaker: "Caro", text: "yo prefiero que lo veamos el jueves con todo el equipo tranquilos", lang: "es-AR" });
    await sleep(700);
    const deCaro = live.slice(antesCaro).find((l) => l.speakerName === "Caro");
    check("y quien habla en español sigue viajando como español (la memoria no arrastra a todos)",
      deCaro?.sourceLang !== "en", String(deCaro?.sourceLang));
  }

  // LO QUE SE ESTÁ DICIENDO AHORA MISMO. El bot juntaba lo oído y recién
  // mandaba la frase tras dos segundos de silencio; con la IA encima, el
  // subtítulo aparecía cuatro o cinco segundos después de hablar (medido por
  // el usuario, y era cierto). Ahora lo interino viaja por su propio camino:
  // llega al instante, no se guarda, y la frase final lo reemplaza.
  {
    const interinos = [];
    s.on("transcript-interim", (p) => interinos.push(p));
    const antesLineas = live.length;
    const t0 = Date.now();
    await post(`/api/meet-bridge/${code}/transcript`, { speaker: "Unify Notetaker", text: "estamos viendo el", lang: "es-AR", interim: true });
    let espera = 0;
    while (interinos.length === 0 && espera < 3000) { await sleep(50); espera += 50; }
    check("lo que se está diciendo llega al instante (menos de un segundo)",
      interinos.length === 1 && Date.now() - t0 < 1000, `${interinos.length} en ${Date.now() - t0} ms`);
    check("y trae quién habla y el texto en curso",
      interinos[0]?.speaker === "Unify Notetaker" && interinos[0]?.text === "estamos viendo el",
      JSON.stringify(interinos[0]));
    await sleep(300);
    check("un interino NO se guarda como línea de la transcripción", live.length === antesLineas,
      `líneas=${live.length - antesLineas}`);
    const detInt = await fetch(`${API}/api/meetings/${dbId}`, { headers: { Authorization: `Bearer ${token}` } });
    const cuerpoInt = detInt.ok ? await detInt.json() : { messages: [] };
    check("ni en el historial",
      !(cuerpoInt.messages ?? []).some((m) => m.text === "estamos viendo el"),
      String((cuerpoInt.messages ?? []).length));
    // Y la frase final sí entra, como siempre.
    await post(`/api/meet-bridge/${code}/transcript`, { speaker: "Unify Notetaker", text: "estamos viendo el informe del trimestre", lang: "es-AR" });
    await sleep(800);
    check("la frase terminada sí queda en la transcripción",
      live.slice(antesLineas).some((l) => /informe del trimestre/.test(l.text)),
      live.slice(antesLineas).map((l) => l.text.slice(0, 40)).join(" | "));
  }

  // LAS ÓRDENES PARA LA REUNIÓN DE AFUERA. La barra de Unify no puede tocar
  // Meet por sí sola (apretar «silenciar» no silenciaba nada, reporte real):
  // deja la orden acá y la extensión, que está en esa pestaña, aprieta el
  // botón de Meet. Se entregan UNA vez.
  {
    const mala = await post(`/api/meet-bridge/${code}/comando`, { accion: "formatear-todo" });
    check("una orden desconocida se rechaza", mala.status === 400, `HTTP ${mala.status}`);
    const ok1 = await post(`/api/meet-bridge/${code}/comando`, { accion: "mic-toggle" });
    const ok2 = await post(`/api/meet-bridge/${code}/comando`, { accion: "colgar" });
    check("silenciar y cortar se aceptan", ok1.status === 200 && ok2.status === 200, `${ok1.status}/${ok2.status}`);
    const ses = await fetch(`${API}/api/meet-bridge/${code}/session?ordenes=1`).then((r) => r.json());
    check("la extensión las recibe, en orden y con su id",
      Array.isArray(ses.comandos) && ses.comandos.length === 2 &&
        ses.comandos[0].accion === "mic-toggle" && ses.comandos[1].accion === "colgar" &&
        typeof ses.comandos[0].id === "string",
      JSON.stringify(ses.comandos));
    const ses2 = await fetch(`${API}/api/meet-bridge/${code}/session?ordenes=1`).then((r) => r.json());
    check("y NO se entregan dos veces (una orden vieja no se ejecuta sola después)",
      Array.isArray(ses2.comandos) && ses2.comandos.length === 0, JSON.stringify(ses2.comandos));
    // Y quien NO las pide (la web sondeando la grabación, el botón del bot)
    // no se las lleva: si no, la extensión no las ejecutaría nunca.
    await post(`/api/meet-bridge/${code}/comando`, { accion: "mic-toggle" });
    const mirona = await fetch(`${API}/api/meet-bridge/${code}/session`).then((r) => r.json());
    check("un sondeo cualquiera NO se lleva las órdenes de la extensión",
      Array.isArray(mirona.comandos) && mirona.comandos.length === 0, JSON.stringify(mirona.comandos));
    const extension = await fetch(`${API}/api/meet-bridge/${code}/session?ordenes=1`).then((r) => r.json());
    check("y la extensión las sigue recibiendo",
      Array.isArray(extension.comandos) && extension.comandos.length === 1, JSON.stringify(extension.comandos));
  }

  // EL CUPO. Lo interino llega varias veces por segundo: si compartiera el
  // cupo de las frases de verdad se lo comería entero y, hablando de corrido,
  // las frases terminadas empezarían a rebotar (429) justo cuando más
  // importan. Se cuentan aparte.
  {
    const key = encodeURIComponent(`externa:reunion.falsa/cupo-${Date.now()}`);
    let rebotes = 0;
    let noOk = 0;
    for (let i = 0; i < 45; i++) {
      const r = await post(`/api/meet-bridge/${key}/transcript`, { speaker: "Bot", text: `en curso ${i}`, lang: "es-AR", interim: true });
      if (r.status === 429) rebotes++;
      if (r.status !== 200) noOk++;
    }
    check("45 interinos seguidos entran sin rebotar", rebotes === 0 && noOk === 0, `rebotes=${rebotes} otros=${noOk}`);
    const real = await post(`/api/meet-bridge/${key}/transcript`, { speaker: "Bot", text: "y esta frase terminada tiene que entrar igual", lang: "es-AR" });
    check("y una frase TERMINADA sigue entrando después de esa lluvia (no se quedó sin cupo)",
      real.status === 200, `HTTP ${real.status}`);
  }

  // LA TRANSCRIPCIÓN NO SE PICA EN UNA REUNIÓN EN INGLÉS. La primera frase
  // larga hace que la línea quede marcada "en"; el fragmento siguiente llega
  // otra vez etiquetado "es-AR" (el reconocimiento manda SU idioma). Si el
  // pegado se decidiera con la etiqueta cruda, cada pedacito abriría línea
  // nueva: la misma idea partida en frases sueltas.
  {
    const antes = live.length;
    const hablante = `Ellen ${Date.now()}`;
    await post(`/api/meet-bridge/${code}/transcript`, { speaker: hablante, text: "we need to close the budget before friday", lang: "es-AR" });
    await sleep(700);
    await post(`/api/meet-bridge/${code}/transcript`, { speaker: hablante, text: "and the numbers look fine to me", lang: "es-AR" });
    await sleep(900);
    const suyas = live.slice(antes).filter((l) => l.speakerName === hablante);
    const ids = new Set(suyas.map((l) => l.id));
    check("dos fragmentos seguidos de la misma persona quedan en UNA línea (no se pica)",
      ids.size === 1, `líneas=${ids.size}`);
    const texto = suyas[suyas.length - 1]?.text ?? "";
    check("y la línea tiene las dos partes", /close the budget/.test(texto) && /numbers look fine/.test(texto), texto.slice(0, 90));
  }

  // ═══ La extensión pide desde meet.google.com, no desde la web de Unify ═══
  //
  // Un content script corre con el origen de LA PÁGINA, así que sus pedidos
  // salen con «Origin: https://meet.google.com» y pasan por CORS igual que
  // los de cualquier sitio ajeno. /api/translate no estaba contemplado y el
  // navegador bloqueaba el pedido ANTES de que saliera: elegir «Traducir:
  // Español» adentro de Meet no hacía absolutamente nada y los subtítulos
  // seguían en el idioma original, sin un solo error a la vista. Y el GET de
  // la sesión sólo tenía permitido POST, así que la extensión nunca conseguía
  // el id de la reunión y la grabación terminaba colgada de otra sala.
  {
    console.log("\n── La extensión llega al servidor desde adentro de Meet ──");
    const preflight = (ruta, metodo) =>
      fetch(API + ruta, {
        method: "OPTIONS",
        headers: {
          Origin: "https://meet.google.com",
          "Access-Control-Request-Method": metodo,
          "Access-Control-Request-Headers": "content-type",
        },
      });

    const t = await preflight("/api/translate", "POST");
    const okT = t.headers.get("access-control-allow-origin");
    check("traducir desde meet.google.com está permitido (si no, no se traduce NADA en Meet)",
      okT === "https://meet.google.com" || okT === "*", `allow-origin=${okT || "(ninguno)"}`);

    const ses = await preflight(`/api/meet-bridge/${code}/session`, "GET");
    const metodos = ses.headers.get("access-control-allow-methods") || "";
    check("y LEER la sesión del bridge también (es lo que ata la grabación a la reunión)",
      /GET/i.test(metodos), `allow-methods=${metodos || "(ninguno)"}`);

    // Y la puerta sigue cerrada para todo lo demás: abrir CORS de más sería
    // dejar que cualquier sitio hable con la API del usuario.
    const priv = await fetch(`${API}/api/meetings`, {
      method: "OPTIONS",
      headers: { Origin: "https://meet.google.com", "Access-Control-Request-Method": "POST" },
    });
    check("pero el resto de la API NO se abrió a cualquier origen",
      !priv.headers.get("access-control-allow-origin"),
      `allow-origin=${priv.headers.get("access-control-allow-origin") || "(ninguno)"}`);

    // Con el preflight en regla, la traducción de verdad viaja y vuelve.
    const trad = await fetch(`${API}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://meet.google.com" },
      body: JSON.stringify({ text: "the budget is approved", source: "auto", target: "es" }),
    });
    check("y el pedido real de traducción no lo rechaza el origen", trad.status !== 403 && trad.status !== 404,
      `HTTP ${trad.status}`);

    // Y LA GRABACIÓN TIENE QUE CAER EN LA MISMA REUNIÓN QUE LA TRANSCRIPCIÓN.
    // El código pelado del Meet y la clave genérica de pestaña son DOS salas
    // distintas del bridge: grabar con la genérica dejaba el video colgado de
    // un historial vacío al lado del que tenía el texto.
    const sesion = (clave) =>
      fetch(`${API}/api/meet-bridge/${encodeURIComponent(clave)}/session`).then((r) => r.json());
    const porCodigo = await sesion(code);
    const porClaveGenerica = await sesion(`externa:meet.google.com/${code}`);
    check("el código del Meet y la clave genérica de pestaña son reuniones DISTINTAS",
      Boolean(porCodigo?.dbId) && porCodigo.dbId !== porClaveGenerica?.dbId,
      `${porCodigo?.dbId} vs ${porClaveGenerica?.dbId}`);

    const bg = require("fs").readFileSync("/home/user/Taller-0/extension/background.js", "utf8");
    const toggle = bg.match(/async function toggleForTab[\s\S]*?\n\}/)?.[0] ?? "";
    check("y la extensión graba con el CÓDIGO del Meet, no con la clave genérica",
      toggle.indexOf("claveDeMeet(") > -1 &&
      toggle.indexOf("claveDeMeet(") < toggle.indexOf("claveWebDePestana("),
      toggle.includes("claveDeMeet(") ? "el código va primero" : "no usa el código del Meet");
  }

  s.disconnect();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
