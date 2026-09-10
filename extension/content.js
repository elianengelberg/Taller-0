// Unify para Google Meet — content script.
//
// Toda la interfaz vive DENTRO de un Shadow DOM: Google Meet tiene estilos
// globales agresivos y reescribe su árbol constantemente, así que aislar es la
// única forma de que la extensión no se rompa ni rompa a Meet. La única pieza
// que sí va en el DOM de Meet es el botón de su barra inferior (tiene que ser
// hermano de los suyos para sentarse ahí), y va con estilos en línea.
//
// De dónde salen las voces: un navegador solo puede escuchar TU micrófono, así
// que transcribir "desde afuera" captura una sola persona. Meet, en cambio, ya
// transcribe a todos con sus subtítulos y les pone nombre. Leemos ESOS
// subtítulos; el micrófono queda como respaldo cuando Meet no los ofrece.

(() => {
  if (window.__unifyLoaded) return;
  window.__unifyLoaded = true;

  const DEFAULT_SERVER = "https://taller-0.onrender.com";
  const DEFAULT_APP = "https://www.unify-meet.com";
  const MEET_CODE_RE = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/;
  const SETTLE_MS = 1600;

  const cfg = { serverBase: DEFAULT_SERVER, appBase: DEFAULT_APP, token: null, lang: "" };
  const log = (...a) => console.debug("[unify]", ...a);
  const meetCode = () => location.pathname.match(MEET_CODE_RE)?.[1] ?? null;

  const ROLES = [
    { id: "", label: "Sin rol", color: "#94a3b8" },
    { id: "anfitrion", label: "Anfitrión", color: "#34d399" },
    { id: "cliente", label: "Cliente", color: "#60a5fa" },
    { id: "equipo", label: "Equipo", color: "#a78bfa" },
    { id: "invitado", label: "Invitado", color: "#f59e0b" },
  ];
  const roleOf = (id) => ROLES.find((r) => r.id === id) ?? ROLES[0];

  const state = {
    lines: [],            // { speaker, text, translated, lang, at }
    roles: {},            // nombre -> id de rol
    speakers: new Set(),
    session: { code: null, dbId: null },
    micDenied: false,
    usingMic: false,
    recording: false,
  };

  // ===========================================================================
  // Backend
  // ===========================================================================
  async function api(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
    const res = await fetch(`${cfg.serverBase}${path}`, { ...options, headers });
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  }

  async function ensureSession() {
    const code = meetCode();
    if (!code) return null;
    if (state.session.code === code && state.session.dbId) return state.session.dbId;
    try {
      // Esta lectura es para armar la sesión (una vez): NO pide las órdenes,
      // que las trae el sondeo de abajo con `ordenes=1`.
      const s = await api(`/api/meet-bridge/${code}/session`);
      state.session = { code, dbId: s.dbId };
      // El popup y el atajo de teclado graban sin volver a preguntarle a la
      // pestaña: les dejamos acá los datos de la reunión.
      chrome.runtime.sendMessage({
        kind: "unify-meet-info", dbId: s.dbId, serverBase: cfg.serverBase, token: cfg.token,
      });
      if (Array.isArray(s.transcript) && state.lines.length === 0) {
        s.transcript.forEach((l) => pushLocal(l.speakerName, l.text, { translate: false, at: l.timestamp }));
        ui.renderStream();
        ui.renderRoles();
      }
      return s.dbId;
    } catch {
      return null;
    }
  }

  // CÓMO SE ARMA CADA TARJETA DE LA TRANSCRIPCIÓN.
  //
  // Antes: todo lo que dijera la misma persona en 8 segundos se pegaba en una
  // sola línea, hasta 400 caracteres... medidos ANTES de pegar, así que una
  // tarjeta terminaba con muros de texto imposibles de leer -- párrafos
  // enteros sin respiro, sin hora propia, y con la frase de hace diez minutos
  // enganchada a la de recién.
  //
  // Ahora se juntan sólo los PEDACITOS de una misma idea: se corta al cerrar
  // una frase, cuando hay una pausa, o al llegar al largo de un párrafo
  // cómodo. El resultado se lee como una conversación, no como un volcado.
  const CORTE_PAUSA_MS = 2500;   // una pausa así ya es otra idea
  const LARGO_COMODO = 220;      // dos renglones y medio en el panel

  const cierraFrase = (t) => /[.?!…]["')\]]?$/.test(t.trim());

  // Parte un texto largo en frases (sin perder nada) para que no entre como
  // un ladrillo. Si no hay puntuación, corta por palabras al largo cómodo.
  function partirEnFrases(texto) {
    const frases = texto.split(/(?<=[.?!…])\s+/).filter(Boolean);
    const salida = [];
    for (const f of frases) {
      if (f.length <= LARGO_COMODO * 1.6) { salida.push(f); continue; }
      let actual = "";
      for (const palabra of f.split(/\s+/)) {
        if (actual && (actual + " " + palabra).length > LARGO_COMODO) {
          salida.push(actual);
          actual = palabra;
        } else {
          actual = actual ? `${actual} ${palabra}` : palabra;
        }
      }
      if (actual) salida.push(actual);
    }
    return salida.length ? salida : [texto];
  }

  function pushLocal(speaker, text, { translate = true, at = Date.now() } = {}) {
    const name = speaker || "Participante";
    state.speakers.add(name);
    let ultima = null;
    for (const pedazo of partirEnFrases(text.trim())) {
      ultima = agregarPedazo(name, pedazo, translate, at);
    }
    return ultima;
  }

  function agregarPedazo(name, text, translate, at) {
    const last = state.lines[state.lines.length - 1];
    const sePuedeJuntar =
      last &&
      last.speaker === name &&
      at - last.at < CORTE_PAUSA_MS &&
      !cierraFrase(last.text) &&
      (last.text.length + text.length) <= LARGO_COMODO;
    if (sePuedeJuntar) {
      if (last.text.includes(text)) return last; // ya está adentro: no repetir
      last.text = `${last.text} ${text}`.trim();
      last.at = at;
      if (translate) void translateLine(last);
      return last;
    }
    const line = { speaker: name, text, translated: null, at };
    state.lines.push(line);
    if (state.lines.length > 400) state.lines.shift();
    if (translate) void translateLine(line);
    return line;
  }

  async function translateLine(line) {
    if (!cfg.lang) return;
    // La foto del texto AL PEDIR: si la línea crece mientras la respuesta
    // viaja (fusión de fragmentos), ya salió otro pedido por el texto largo,
    // y esta respuesta vieja NO debe pisar la traducción nueva (la carrera
    // dejaba una traducción corta pegada a una frase larga).
    const textoPedido = line.text;
    try {
      // Las últimas líneas de la charla viajan como contexto: "no lo veo" se
      // traduce distinto si venían hablando de un archivo o de una persona.
      const contexto = state.lines
        .filter((l) => l !== line)
        .slice(-3)
        .map((l) => `${l.speaker}: ${l.text}`.slice(0, 240));
      const r = await api("/api/translate", {
        method: "POST",
        body: JSON.stringify({ text: textoPedido, source: "auto", target: cfg.lang, context: contexto }),
      });
      if (line.text !== textoPedido) return; // llegó tarde: la línea ya es otra
      if (r?.translatedText && r.translatedText !== textoPedido) {
        line.translated = r.translatedText;
        ui.renderStream();
        // Y el cartel de arriba del video, que es lo que se está leyendo:
        // sin esto la traducción llegaba sólo al panel lateral.
        ui.refrescarSubtitulo(line);
      } else if (r?.translatedText === textoPedido && line.translated) {
        // Ya está en tu idioma: si quedó una traducción vieja de puente
        // (de antes de una corrección), acá se retira.
        line.translated = null;
        ui.renderStream();
        ui.refrescarSubtitulo(line);
      }
    } catch {
      /* la traducción es un extra: si falla, queda el original */
    }
  }

  // Memoria corta de lo ya transcripto, para no repetir frases. Meet recicla
  // los nodos de sus subtítulos y a veces reaparece texto viejo: sin esto, la
  // transcripción se llenaba de la misma frase una y otra vez.
  const yaDicho = new Map(); // frase normalizada -> cuándo
  const normalizar = (t) =>
    t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9ñ ]/g, " ").replace(/\s+/g, " ").trim();

  function sacarLoYaDicho(texto) {
    const ahora = Date.now();
    for (const [k, t] of yaDicho) if (ahora - t > 5 * 60_000) yaDicho.delete(k);
    // Se parte en frases: repetir "hola" es normal, repetir una frase larga
    // entera no lo es.
    const frases = texto.split(/(?<=[.?!])\s+/).filter(Boolean);
    const nuevas = frases.filter((f) => {
      const clave = normalizar(f);
      if (clave.split(" ").length < 4) return true; // muy corta para juzgarla
      if (yaDicho.has(clave)) return false;
      yaDicho.set(clave, ahora);
      return true;
    });
    return nuevas.join(" ").trim();
  }

  // Lo ya dicho por cada quien, para recortar lo repetido (repetidos.js,
  // cargado antes que este script): el reconocedor entrega el mismo tramo
  // más de una vez y el panel repetía un párrafo entero y seguía.
  const memoriaRepetidos = window.__unifyRepetidos ? window.__unifyRepetidos.crearMemoriaDeRepetidos() : null;
  async function emit(speaker, text, alts = []) {
    const code = meetCode();
    if (!code || !text) return;
    // Última red: venga de donde venga (subtítulos, micrófono, una región mal
    // elegida), una dirección web es interfaz, no alguien hablando.
    if (TIENE_ENLACE.test(text)) return;
    if (memoriaRepetidos) {
      const previo = memoriaRepetidos.previo(speaker);
      text = window.__unifyRepetidos.recortarRepetido(previo, text);
      alts = (alts || []).map((a) => window.__unifyRepetidos.recortarRepetido(previo, a)).filter(Boolean);
      if (!text) return; // ya se había dicho: no se repite
      memoriaRepetidos.anotar(speaker, text);
    }
    text = sacarLoYaDicho(text);
    if (!text) return; // era todo repetido: no ensucia la transcripción
    const line = pushLocal(speaker, text);
    ui.renderStream();
    ui.renderRoles();
    ui.showSubtitle(line);
    try {
      const r = await api(`/api/meet-bridge/${code}/transcript`, {
        method: "POST",
        body: JSON.stringify({ speaker: line.speaker, text, lang: navigator.language || "es-AR", alts }),
      });
      if (r?.dbId) state.session.dbId = r.dbId;
      // La IA del servidor reconstruye la frase más probable (el
      // reconocimiento confunde palabras que suenan parecido). Acá se adopta
      // esa versión: antes el historial guardaba la buena y el panel seguía
      // mostrando la cruda -- la persona veía la peor de las dos.
      if (r?.text && r.text !== text && line.text.includes(text)) {
        const i = line.text.lastIndexOf(text);
        line.text = (line.text.slice(0, i) + r.text + line.text.slice(i + text.length)).trim();
        // La traducción vieja se QUEDA de puente (la corrección es un retoque,
        // no otra frase): borrarla hacía parpadear el subtítulo al idioma
        // original hasta que llegara la nueva. translateLine la reemplaza.
        ui.renderStream();
        ui.showSubtitle(line);
        if (cfg.lang) void translateLine(line);
      }
      // Y si Meet está escribiendo en OTRO idioma que el que se habla, se
      // dice con nombre y apellido: es la causa número uno de que salgan
      // frases sin sentido, y no hay IA que las recupere después.
      if (r?.idiomaDistinto) ui.avisarIdiomaDeMeet(r.idiomaDistinto);
      ui.setStatus("live");
    } catch {
      ui.setStatus("offline");
    }
  }

  // ===========================================================================
  // Lecturas del DOM de Meet
  // ===========================================================================
  // ¿Estamos DENTRO de la llamada (no en la sala de espera)?
  //
  // Antes esto se decidía sólo por el texto del botón de colgar, en dos
  // idiomas. Bastaba con que Meet dijera "Salir de la videollamada", o que la
  // persona lo tuviera en portugués, para que la extensión no apareciera
  // NUNCA -- sin un solo error en la consola, que es la peor forma de fallar.
  //
  // Ahora hay dos caminos, y alcanza con uno:
  //  1. El botón de colgar, con muchas más variantes de idioma.
  //  2. La ESTRUCTURA: los controles de micrófono y cámara ([data-is-muted])
  //     sólo existen una vez adentro de la llamada. Es independiente del
  //     idioma y de cómo Google redacte sus etiquetas.
  const COLGAR_RE = /salir de la (llamada|videollamada)|abandonar la (llamada|videollamada)|leave call|hang up|sair da chamada|quitter l'appel|anruf verlassen|abbandona chiamata/i;
  // EL BOTÓN DE COLGAR ES LA PRUEBA DE QUE LA LLAMADA EMPEZÓ: existe adentro
  // y en ninguna otra pantalla de Meet. `botonDeColgar()` (más abajo, y
  // hoisteada) lo encuentra por etiqueta o por su ícono «call_end», que se
  // escribe igual en todos los idiomas.
  const hayBotonDeColgar = () => Boolean(botonDeColgar());
  // El botón de ENTRAR: es lo que distingue la sala de espera de la llamada.
  // Hace falta porque los controles de micrófono y cámara ([data-is-muted])
  // existen en LAS DOS pantallas -- Meet muestra la vista previa antes de
  // entrar -- así que sin esto la sala de espera se confundiría con estar
  // adentro, y la extensión pediría el micrófono antes de que la persona
  // decidiera entrar.
  //
  // La lista creció con lo que Meet dice de verdad en cada región: «Unirme
  // ahora» (es-419) y «Solicitar unirse» faltaban, y sin ellas la vista
  // previa se confundía con estar adentro -- que es como terminaron los
  // carteles de Meet transcriptos antes de entrar a la reunión.
  const ENTRAR_RE = /unir(te|se|me) ahora|pedir unirse|solicitar unirse|pedir para unirse|participar ahora|join now|ask to join|entrar agora|participar agora|pedir para participar|solicitar participação|rejoindre maintenant|demander à participer|jetzt teilnehmen|teilnahme anfragen|partecipa ora|chiedi di partecipare/i;
  const botonEntrar = () => {
    for (const b of document.querySelectorAll("button, [role='button']")) {
      const t = `${b.getAttribute("aria-label") || ""} ${b.textContent || ""}`;
      if (ENTRAR_RE.test(t)) return true;
    }
    return false;
  };

  const controlesLlamada = () => document.querySelectorAll("[data-is-muted]").length >= 2;

  const inCall = () => {
    if (hayBotonDeColgar()) return true;
    // Camino estructural, independiente del idioma: los controles de la
    // llamada están presentes y YA NO hay botón de entrar.
    return controlesLlamada() && !botonEntrar();
  };

  /**
   * ¿Podemos transcribir? Es MÁS ESTRICTO que `inCall()` a propósito.
   *
   * `inCall()` decide si se muestra la interfaz de Unify, y puede permitirse
   * una duda: aparecer de más es un panel que sobra. Escuchar de más, no: en
   * una reunión real la extensión llegó a transcribir los carteles de la
   * propia pantalla de Meet («¿Estás desarrollando una extensión para
   * Meet?», el enlace a developers.google.com) y a mandarlos al historial
   * como si un participante los hubiera dicho, ANTES de que la persona
   * entrara a la llamada.
   *
   * Así que para escuchar se exige la prueba positiva de que la llamada
   * empezó -- el botón de colgar -- y que ya no haya botón de entrar. Sin
   * las dos cosas no se lee un solo carácter de la pantalla.
   *
   * Con una salida: si algún día Meet cambia el botón de colgar y deja de
   * reconocerse, la extensión no puede quedarse muda para siempre. Pasado un
   * rato con los controles de la llamada puestos y sin botón de entrar a la
   * vista, se acepta igual -- el criterio viejo, degradado a último recurso
   * en vez de ser la regla.
   */
  const GRACIA_SIN_COLGAR_MS = 20_000;
  let sinColgarDesde = 0;
  function sePuedeTranscribir() {
    if (botonEntrar()) { sinColgarDesde = 0; return false; }
    if (hayBotonDeColgar()) { sinColgarDesde = 0; return true; }
    if (!controlesLlamada()) { sinColgarDesde = 0; return false; }
    if (!sinColgarDesde) sinColgarDesde = Date.now();
    return Date.now() - sinColgarDesde > GRACIA_SIN_COLGAR_MS;
  }

  /**
   * La sala de espera: abriste el enlace (el que te mandaron por WhatsApp) y
   * Meet te muestra la vista previa con "Unirse ahora". Es EL momento de
   * avisar -- "veo que te estás uniendo" -- y no después, cuando la reunión ya
   * empezó y estás hablando.
   */
  const enSalaDeEspera = () => !inCall() && (botonEntrar() || controlesLlamada());

  function ownToggle(kind) {
    const el =
      (kind === "mic"
        ? document.querySelector('[data-is-muted][aria-label*="icróf"], [data-is-muted][aria-label*="icrophone"]')
        : document.querySelector('[data-is-muted][aria-label*="ámara"], [data-is-muted][aria-label*="amera"]')) ||
      document.querySelectorAll("[data-is-muted]")[kind === "mic" ? 0 : 1];
    return el ? el.getAttribute("data-is-muted") === "true" : null;
  }

  function participantCount() {
    const btn = document.querySelector(
      'button[aria-label*="Mostrar a todos"], button[aria-label*="Show everyone"], button[aria-label*="participante"], button[aria-label*="participant"]'
    );
    const label = btn?.getAttribute("aria-label") ?? "";
    const m = label.match(/\((\d+)\)/) || label.match(/(\d+)/);
    return m ? Number(m[1]) : null;
  }

  const presenting = () =>
    document.querySelector(
      'button[aria-label*="Dejar de compartir"], button[aria-label*="Stop presenting"], button[aria-label*="Stop sharing"]'
    )
      ? true
      : /está presentando|is presenting/i.test((document.body?.innerText ?? "").slice(0, 20000))
        ? true
        : null;

  // ===========================================================================
  // Motor de subtítulos de Meet (la fuente de TODAS las voces)
  // ===========================================================================
  // `nudged` es CUÁNDO se apretó por última vez el botón CC de Meet, no un
  // "ya se apretó": ver ensureCaptionsOn.
  const caps = { region: null, entries: new Map(), observer: null, nudged: 0 };

  // Cómo se llama la región (y el botón) de subtítulos según el idioma de la
  // interfaz de Meet. Antes sólo se reconocían «Subtítulos» y «Captions»: con
  // Meet en portugués, francés o alemán la extensión caía al micrófono en
  // silencio y "solo salía lo que yo decía".
  const ETIQUETA_SUBTITULOS = /subt[ií]tul|caption|legenda|sous-titre|untertitel|sottotitol|ondertitel|napisy|字幕|자막/i;
  const regionPorEtiqueta = () => {
    for (const r of document.querySelectorAll('[role="region"][aria-label]')) {
      if (ETIQUETA_SUBTITULOS.test(r.getAttribute("aria-label") || "")) return r;
    }
    return null;
  };

  // POR SU FORMA Y SU RITMO. Google cambia los jsname y las etiquetas de Meet
  // sin avisar, y cada vez que pasó la extensión dejó de ver a los demás sin
  // decir nada. Cuando ningún selector conocido encuentra la región, se la
  // reconoce por lo que ES: el contenedor cuyas filas traen la foto de quien
  // habla y un texto que se reescribe varias veces por segundo mientras
  // habla. Nada más en Meet reescribe el mismo texto a ese ritmo (el chat
  // agrega mensajes enteros; el reloj cambia por minuto), y por eso se exige
  // actividad reciente antes de dar una región por buena.
  const actividadDeTexto = new Map(); // elemento → marcas de tiempo de sus cambios de texto
  const PROPIO = "#unify-root, #unify-subs, #unify-panel, #unify-aviso";
  function anotarActividad(muts) {
    const ahora = Date.now();
    for (const m of muts) {
      let el = null;
      if (m.type === "characterData") el = m.target.parentElement;
      else if (m.type === "childList" && m.addedNodes.length) {
        const n = m.addedNodes[0];
        el = n.nodeType === Node.TEXT_NODE ? n.parentElement : n.nodeType === Node.ELEMENT_NODE ? n : null;
      }
      if (!el || !el.isConnected || el.closest(PROPIO)) continue;
      const marcas = actividadDeTexto.get(el) || [];
      marcas.push(ahora);
      if (marcas.length > 40) marcas.shift();
      actividadDeTexto.set(el, marcas);
    }
    if (actividadDeTexto.size > 400) {
      for (const [el, marcas] of actividadDeTexto) {
        if (!el.isConnected || ahora - marcas[marcas.length - 1] > 30000) actividadDeTexto.delete(el);
        if (actividadDeTexto.size <= 200) break;
      }
    }
  }
  // NADA DE ESTO ES UN SUBTÍTULO. Meet llena su pantalla de paneles, carteles
  // y menús que también tienen "una foto y un texto que cambia": el chat, la
  // lista de participantes, el panel de Gemini y los avisos de Google. Uno de
  // ellos («¿Estás desarrollando una extensión para Meet?», con su enlace a
  // developers.google.com) terminó ENTERO en la transcripción de una reunión
  // real, firmado como «Participante», y también sobre el video. El
  // reconocimiento por forma se queda afuera de todos ellos.
  const ZONAS_QUE_NO_SON_SUBTITULOS =
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="complementary"], ' +
    '[role="navigation"], [role="banner"], [role="menu"], [role="menubar"], [role="listbox"], ' +
    '[role="log"], [role="feed"], [role="tablist"], [role="toolbar"], [role="grid"], ' +
    '[role="alert"], [role="status"], [role="tooltip"], form';
  /**
   * ¿Este nodo vive en una zona que NO puede ser subtítulos?
   *
   * Con la excepción que evita un desastre silencioso: si la región de
   * subtítulos que YA estamos leyendo (reconocida por la etiqueta propia de
   * Meet, que no se discute) vive adentro de esa zona, entonces la zona no es
   * «otra cosa al lado» -- es el marco de los subtítulos. Los subtítulos en
   * vivo son justamente el caso de uso de `role="log"` y `aria-live`, así que
   * el día que Google los marque así, sin esta excepción la extensión
   * descartaría TODAS las filas y se quedaría muda sin un solo error.
   */
  const enZonaQueNoEsSubtitulo = (el) => {
    const zona = el.closest?.(ZONAS_QUE_NO_SON_SUBTITULOS);
    if (!zona) return false;
    if (caps.region && (zona === caps.region || zona.contains(caps.region))) return false;
    return true;
  };

  // Nadie DICTA una dirección web en una reunión, pero los carteles de Meet
  // están llenos de ellas: un enlace adentro es la firma de la interfaz, no
  // de una persona hablando.
  const TIENE_ENLACE = /https?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}/i;

  const esFilaDeSubtitulo = (h) =>
    h.nodeType === Node.ELEMENT_NODE &&
    Boolean(h.querySelector('img, [role="img"], svg, [data-avatar]')) &&
    // Una fila de subtítulos es la foto de quien habla y lo que dijo: ni un
    // botón, ni un enlace, ni un campo para escribir. Con eso adentro es
    // otra cosa (un cartel, el chat, un menú).
    !h.querySelector('a[href], button, [role="button"], input, textarea, [contenteditable="true"]') &&
    !TIENE_ENLACE.test(h.textContent || "") &&
    (h.textContent || "").trim().length > 0;

  /**
   * ¿Tiene FORMA de subtítulos, o de panel lateral?
   *
   * Los subtítulos de Meet son unos pocos renglones anchos sobre el video. El
   * chat y el panel de Gemini son columnas: altas y angostas, pegadas a un
   * costado. Esa proporción los separa sin atarse a dónde Google decida poner
   * sus subtítulos el mes que viene -- que es la clase de suposición que
   * después deja la extensión muda sin un solo error a la vista.
   */
  function tieneFormaDeSubtitulos(el) {
    let r;
    try { r = el.getBoundingClientRect(); } catch { return false; }
    const alto = window.innerHeight || 0;
    const ancho = window.innerWidth || 0;
    if (r.width < 80 || r.height < 8) return false;              // invisible o mínimo
    if (!alto || !ancho) return true;                            // sin ventana medible, no se opina
    return !(r.height > alto * 0.55 && r.width < ancho * 0.45);  // columna alta y angosta: panel
  }

  function regionPorForma() {
    const ahora = Date.now();
    const puntos = new Map();
    for (const [el, marcas] of actividadDeTexto) {
      if (!el.isConnected) {
        actividadDeTexto.delete(el);
        continue;
      }
      const recientes = marcas.filter((t) => ahora - t < 15000).length;
      if (recientes < 6) continue;
      if (el.closest('button, [role="button"], [role="textbox"], [contenteditable], input, textarea')) continue;
      if (enZonaQueNoEsSubtitulo(el)) continue;
      // Subir hasta el contenedor cuyos hijos son FILAS (foto + texto), como
      // las filas de subtítulos de Meet; la fila que se está escribiendo
      // tiene que ser una de ellas.
      let fila = el;
      for (let i = 0; fila && i < 8; i++) {
        const padre = fila.parentElement;
        if (!padre || padre === document.body || padre === document.documentElement) break;
        const hijos = Array.from(padre.children);
        const filas = hijos.filter(esFilaDeSubtitulo);
        if (filas.length >= 1 && filas.length >= hijos.length * 0.6 && esFilaDeSubtitulo(fila)) {
          if (enZonaQueNoEsSubtitulo(padre) || !tieneFormaDeSubtitulos(padre)) break;
          puntos.set(padre, (puntos.get(padre) || 0) + recientes);
          break;
        }
        fila = padre;
      }
    }
    let mejor = null;
    let max = 0;
    for (const [c, n] of puntos) if (n > max) { mejor = c; max = n; }
    if (mejor) log("región de subtítulos reconocida por su forma y su ritmo");
    return mejor;
  }
  new MutationObserver(anotarActividad).observe(document.documentElement, {
    characterData: true,
    childList: true,
    subtree: true,
  });

  // El reconocimiento POR FORMA es el último recurso, y es el único que puede
  // equivocarse de contenedor: sólo entra en juego con la llamada empezada de
  // verdad y cuando ninguno de los selectores propios de Meet dio con la
  // región. Los otros tres son marcas de Meet: esos no se discuten.
  const findCaptionRegion = () =>
    regionPorEtiqueta() ||
    document.querySelector('div[jsname="dsyhDe"]') ||
    document.querySelector("[data-use-tweaked-caption-styles]") ||
    (sePuedeTranscribir() ? regionPorForma() : null) ||
    null;

  // El botón CC de Meet: por etiqueta, por su jsname, o por su ícono
  // («closed_caption_off» / «closed_caption»), que es igual en todos los
  // idiomas.
  function botonDeSubtitulos() {
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      if (ETIQUETA_SUBTITULOS.test(b.getAttribute("aria-label") || "")) return b;
      const t = (b.textContent || "").trim();
      if (t === "closed_caption" || t === "closed_caption_off" || t === "closed_caption_disabled") return b;
    }
    return document.querySelector('button[jsname="r8qRAd"]');
  }

  // ENCENDERLOS UNA VEZ NO ALCANZABA. Meet apaga sus subtítulos solo más de
  // lo que uno cree: al cambiar de diseño, al compartir pantalla, al
  // reconectar. Con un único intento («caps.nudged = true» y nunca más), la
  // primera vez que se apagaban quedaban apagados para el resto de la
  // reunión: la persona se muteaba, hablaban los demás y no aparecía un solo
  // subtítulo. Ahora se reintenta cada 12 segundos mientras no haya región,
  // que es exactamente mientras el problema exista.
  const REINTENTO_CC_MS = 12_000;
  function ensureCaptionsOn() {
    if (findCaptionRegion()) return true;
    if (Date.now() - (caps.nudged || 0) < REINTENTO_CC_MS) return false;
    const btn = botonDeSubtitulos();
    if (!btn) return false;
    const label = (btn.getAttribute("aria-label") || "").toLowerCase();
    const apagados =
      /activar|turn on|ativar|activer|einschalten|attiva|inschakelen|włącz/.test(label) ||
      btn.getAttribute("aria-pressed") === "false" ||
      (btn.textContent || "").trim() === "closed_caption_off" ||
      (btn.textContent || "").trim() === "closed_caption_disabled";
    if (!apagados) return false;
    caps.nudged = Date.now();
    btn.click();
    log("subtítulos de Meet activados");
    return true;
  }

  // ¿Parece un nombre y no una frase? Sirve para separar el hablante del texto
  // sin depender del largo (al empezar una frase el texto es más corto que el
  // nombre, y cualquier regla de "el bloque más largo es el texto" se equivoca).
  const looksLikeName = (s) => s.length > 0 && s.length <= 60 && s.split(/\s+/).length <= 6 && !/[.?!,]$/.test(s);

  // Los íconos de Material se escriben como TEXTO dentro del HTML
  // ("arrow_downward"), así que el botón «Ir al final» de Meet entraba a la
  // transcripción como si alguien lo hubiera dicho: quedaba un participante
  // llamado "arrow_downward" diciendo "Ir al final". Ninguna persona habla
  // así -- se descartan las ligaduras de ícono y todo lo que viva adentro de
  // un botón, que es controles de Meet y no lo que se está hablando.
  const esLigaduraDeIcono = (t) => /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(t);
  const esControlDeMeet = (el) => Boolean(el.closest('button, [role="button"], [role="toolbar"]'));

  // Los íconos de UNA sola palabra ("mic", "chat", "send") se le escapaban a
  // la regla del guion bajo y entraban a la transcripción como "comandos"
  // dichos por nadie (pasó de nuevo en una reunión real). Se los reconoce por
  // ESTRUCTURA, que es lo que de verdad los delata: van marcados aria-hidden,
  // en <i>, con clases de ícono, o -- la prueba reina -- dibujados con la
  // fuente de símbolos de Google.
  const esElementoDeIcono = (el) =>
    Boolean(
      el.closest(
        'i, [aria-hidden="true"], [class*="material-icon"], [class*="google-symbols"], .notranslate, [translate="no"], [data-icon]'
      )
    );
  const pareceLigaduraSuelta = (el, t) => {
    if (!/^[a-z][a-z0-9_]{1,29}$/.test(t)) return false; // una sola palabra pelada
    if (t.includes("_")) return true; // mic_off, arrow_downward
    try {
      return /symbols|material/i.test(getComputedStyle(el).fontFamily || "");
    } catch {
      return false;
    }
  };

  function parseEntry(node) {
    // Un cartel de Meet, el chat o el panel de Gemini no son voces: aunque la
    // región elegida los tocara, de acá no sale nada.
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    if (enZonaQueNoEsSubtitulo(node)) return null;
    if (node.querySelector("a[href]")) return null;
    const leaves = [];
    node.querySelectorAll("*").forEach((el) => {
      if (el.children.length === 0) {
        if (esControlDeMeet(el) || esElementoDeIcono(el)) return;
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (t && !esLigaduraDeIcono(t) && !pareceLigaduraSuelta(el, t)) leaves.push(t);
      }
    });
    if (leaves.length === 0) {
      // Sin hojas útiles: si lo único que había era un control de Meet, no hay
      // nada que transcribir (antes se colaba el texto del botón entero).
      if (node.querySelector('button, [role="button"]') || esControlDeMeet(node)) return null;
      const raw = (node.textContent || "").replace(/\s+/g, " ").trim();
      return raw && !esLigaduraDeIcono(raw) ? { speaker: "", text: raw } : null;
    }
    let speaker = "";
    let body;
    if (leaves.length >= 2 && looksLikeName(leaves[0])) {
      speaker = leaves[0];
      body = leaves.slice(1).join(" ").trim();
    } else {
      body = leaves.join(" ").trim();
    }
    if (speaker && body.startsWith(speaker)) body = body.slice(speaker.length).trim();
    // Nadie dicta una dirección web en voz alta; los carteles de Meet las
    // traen siempre. Fue así como «https://developers.google.com/meet/…»
    // terminó en la transcripción de una reunión real.
    if (TIENE_ENLACE.test(body)) return null;
    return body ? { speaker, text: body } : null;
  }

  // Meet reescribe la MISMA fila mientras la persona habla, así que guardamos
  // qué parte ya se envió y mandamos únicamente lo nuevo.
  // Cuánto coinciden dos textos desde el principio. Es lo que permite mandar
  // SÓLO lo nuevo aunque Meet haya corregido alguna palabra del medio.
  function largoDelPrefijoComun(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
  }

  function finalizeEntry(node) {
    const rec = caps.entries.get(node);
    if (!rec) return;
    clearTimeout(rec.timer);
    rec.timer = null;
    // Sólo la parte que todavía no mandamos. Si Meet corrigió algo de lo ya
    // enviado, esa corrección se pierde -- y está bien: es una palabra, no la
    // conversación entera repetida.
    const pending = rec.text.slice(largoDelPrefijoComun(rec.emitted, rec.text)).trim();
    if (pending) {
      rec.emitted = rec.text;
      void emit(rec.speaker || "Participante", pending);
    }
  }

  function touchEntry(node) {
    const parsed = parseEntry(node);
    if (!parsed) return;
    let rec = caps.entries.get(node);
    if (!rec) {
      rec = { speaker: parsed.speaker, text: parsed.text, emitted: "", timer: null };
      caps.entries.set(node, rec);
    } else {
      if (parsed.speaker) rec.speaker = parsed.speaker;
      if (parsed.text === rec.text) return; // nada cambió: ni tocar el cartel
      if (!parsed.text.startsWith(rec.emitted)) {
        // Meet corrigió algo de lo ya enviado. Se retrocede el puntero a la
        // parte en común y listo: la versión CORREGIDA de ahí en adelante se
        // emite en el próximo asentamiento, UNA sola vez. Antes acá se
        // emitía primero la cola vieja pendiente (finalizeEntry) y después
        // la corregida: la misma frase dos veces con una palabra cambiada --
        // el "se repiten las oraciones" de las reuniones reales.
        rec.emitted = rec.emitted.slice(0, largoDelPrefijoComun(rec.emitted, parsed.text));
      }
      rec.text = parsed.text;
    }
    clearTimeout(rec.timer);
    rec.timer = setTimeout(() => finalizeEntry(node), SETTLE_MS);
    // MONÓLOGO SIN PAUSAS: si nadie respira 1,6 s, el asentamiento no llega
    // nunca y el panel/historial quedan "trabados" mientras la persona habla
    // de corrido. Con mucha cola acumulada se emite la parte ya FRÍA (hasta
    // el último cierre de frase o espacio), dejando calientes los últimos
    // ~40 caracteres, que son los que Meet todavía suele corregir. El bridge
    // después pega los pedazos del mismo hablante en una sola línea.
    {
      const pendiente = rec.text.slice(rec.emitted.length);
      if (rec.text.startsWith(rec.emitted) && pendiente.length > 240) {
        const zona = pendiente.slice(0, pendiente.length - 40);
        const corte = Math.max(
          zona.lastIndexOf(". "), zona.lastIndexOf("? "), zona.lastIndexOf("! "),
          zona.lastIndexOf(" ")
        );
        if (corte > 60) {
          const listo = pendiente.slice(0, corte + 1).trim();
          rec.emitted = rec.text.slice(0, rec.emitted.length + corte + 1);
          void emit(rec.speaker || "Participante", listo);
        }
      }
    }
    // Lo que se está diciendo AHORA: la cola de la fila, no todo el historial.
    //
    // Cuando no queda nada pendiente (la frase se acaba de emitir), el cartel
    // NO se toca. Antes acá caía un `|| rec.text` y el subtítulo saltaba de
    // golpe a la fila entera -- el párrafo completo de la persona sobre el
    // video, un parpadeo, y de vuelta a la frase corta. Lo que corresponde
    // mostrar en ese momento ya lo puso `emit()` con la línea de verdad.
    const enCurso = rec.text.slice(largoDelPrefijoComun(rec.emitted, rec.text)).trim();
    if (enCurso && enCurso !== rec.ultimoCartel) {
      rec.ultimoCartel = enCurso;
      ui.showSubtitle({ speaker: rec.speaker || "Participante", text: enCurso, translated: null });
      // Y a la SALA, para que la pantalla de Unify (la del iPad al lado, la
      // de la compu) lo vea mientras se dice. Adentro de Meet el cartel ya
      // salía al instante, pero afuera había que esperar el asentamiento y
      // la IA: varios segundos de diferencia entre lo que se oye y lo que se
      // lee. Lo interino no se guarda ni se traduce: lo reemplaza la frase.
      postInterino(rec.speaker || "Participante", enCurso);
    }
  }

  // Lo que se está diciendo ahora mismo, hacia la sala. Con freno: llega
  // varias veces por segundo y no hace falta mandar cada repintado.
  let ultimoInterino = 0;
  function postInterino(speaker, texto) {
    const t = String(texto || "").trim();
    const code = meetCode();
    if (!t || !code) return;
    const ahora = Date.now();
    if (ahora - ultimoInterino < 400) return;
    ultimoInterino = ahora;
    void api(`/api/meet-bridge/${code}/transcript`, {
      method: "POST",
      body: JSON.stringify({
        speaker,
        text: t.slice(0, 300),
        lang: navigator.language || "es-AR",
        interim: true,
      }),
    }).catch(() => {
      /* un interino perdido no importa: en medio segundo va otro */
    });
  }

  function scanCaptions(region) {
    region.querySelectorAll(":scope > *").forEach(touchEntry);
    for (const node of Array.from(caps.entries.keys())) {
      if (!region.contains(node)) {
        finalizeEntry(node);
        clearTimeout(caps.entries.get(node)?.timer);
        caps.entries.delete(node);
      }
    }
  }

  // Suelta la región de subtítulos y todo lo que colgaba de ella: los
  // temporizadores pendientes incluidos. Sin esto quedaba un `finalizeEntry`
  // en vuelo que emitía, un segundo y medio después, texto de una pantalla
  // en la que ya no estábamos.
  function soltarSubtitulos() {
    caps.observer?.disconnect();
    caps.observer = null;
    caps.region = null;
    for (const rec of caps.entries.values()) clearTimeout(rec.timer);
    caps.entries.clear();
  }

  function watchCaptions() {
    const region = findCaptionRegion();
    if (!region) {
      // MEET RE-RENDERIZA SU ÁRBOL A CADA RATO y, en el medio, la región de
      // subtítulos deja de encontrarse por un instante. Soltarla ahí mismo
      // era carísimo: se apagaba el lector de Meet, arrancaba el micrófono
      // (que sólo oye una voz), y al volver la región se apagaba el
      // micrófono otra vez. Ese vaivén es el «cada tanto se buguean los
      // subtítulos y desaparecen un segundo y después vuelven». Mientras el
      // contenedor que ya estábamos leyendo siga vivo en la página, se sigue
      // leyendo: sólo se suelta cuando de verdad se fue.
      if (caps.region?.isConnected) return true;
      soltarSubtitulos();
      return false;
    }
    if (region === caps.region) return true;
    caps.region = region;
    caps.observer?.disconnect();
    caps.observer = new MutationObserver(() => scanCaptions(region));
    caps.observer.observe(region, { childList: true, subtree: true, characterData: true });
    // Lo que ya está escrito en la región cuando se la encuentra (con el
    // reconocimiento por forma, alguien YA estaba hablando): se lee ahora,
    // no recién con el próximo cambio.
    scanCaptions(region);
    log("leyendo subtítulos de Meet");
    return true;
  }

  // ===========================================================================
  // Respaldo por micrófono (solo TU voz) cuando Meet no da subtítulos
  // ===========================================================================
  const mic = { rec: null, running: false, reintento: null };

  function startMicFallback() {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor || mic.running) return;
    const r = new Ctor();
    r.lang = navigator.language || "es-AR";
    r.continuous = true;
    r.interimResults = true;
    // Tres lecturas candidatas: la IA del servidor elige la palabra que de
    // verdad tiene sentido (ver transcriptCleanup.ts del lado del servidor).
    r.maxAlternatives = 3;
    // Lo interino que la sesión nunca confirmó se rescata al morir: eran
    // palabras dichas que desaparecían (mismo arreglo que en el injector).
    let interinoPendiente = "";
    // "no-speech" = el reconocedor RETRACTÓ lo interino ("era ruido"): no se
    // rescata. Y una palabra suelta tampoco (suele ser ruido de fondo).
    let retractado = false;
    const rescatarInterino = () => {
      const texto = interinoPendiente.trim();
      interinoPendiente = "";
      if (retractado) {
        retractado = false;
        return;
      }
      if (texto && texto.split(/\s+/).length >= 2) void emit("Vos", texto, []);
    };
    r.onresult = (ev) => {
      state.micDenied = false;
      retractado = false;
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const text = res[0]?.transcript?.trim();
        if (!text) continue;
        if (res.isFinal) {
          const alts = [];
          for (let j = 1; j < res.length && j < 3; j++) {
            const otra = res[j]?.transcript?.trim();
            if (otra && otra !== text) alts.push(otra);
          }
          interinoPendiente = "";
          void emit("Vos", text, alts);
        } else {
          interinoPendiente = text;
          ui.showSubtitle({ speaker: "Vos", text, translated: null });
        }
      }
    };
    r.onerror = (ev) => {
      if (ev.error === "no-speech") {
        retractado = true;
        return;
      }
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        rescatarInterino();
        state.micDenied = true;
        mic.running = false;
        ui.renderMicCard();
      }
    };
    // EL RESPALDO NO PUEDE MORIRSE EN SILENCIO. Chrome cierra la sesión de
    // reconocimiento sola cada tanto (silencio largo, cambio de red, la
    // reunión tomando el micrófono) y el `r.start()` de acá adentro puede
    // fallar. Antes ese fallo se tragaba en un `catch` vacío con
    // `mic.running` en true: para el resto de la extensión el micrófono
    // seguía "andando" y nunca se volvía a intentar. En una reunión real eso
    // se vio como «después probé hablar yo y ya no me daba más los
    // subtítulos», sin un solo error a la vista. Ahora, si no arranca, se
    // reintenta con paciencia hasta que arranque.
    r.onend = () => {
      rescatarInterino();
      if (!mic.running || mic.rec !== r) return;
      try {
        r.start();
      } catch {
        // Puede estar arrancando ya, o haber quedado en un estado del que no
        // se vuelve: se rearma desde cero en un segundo.
        mic.running = false;
        mic.rec = null;
        state.usingMic = false;
        clearTimeout(mic.reintento);
        mic.reintento = setTimeout(() => {
          if (!state.micDenied && !caps.region) startMicFallback();
        }, 1000);
      }
    };
    try {
      r.start();
      mic.rec = r;
      mic.running = true;
      state.usingMic = true;
    } catch {
      // Ni arrancó: se reintenta en un rato en vez de dejar el respaldo
      // apagado para siempre.
      clearTimeout(mic.reintento);
      mic.reintento = setTimeout(() => {
        if (!state.micDenied && !caps.region) startMicFallback();
      }, 3000);
    }
  }

  function stopMicFallback() {
    mic.running = false;
    state.usingMic = false;
    clearTimeout(mic.reintento);
    mic.reintento = null;
    const r = mic.rec;
    mic.rec = null;
    try { r?.stop(); } catch { /* noop */ }
    try { r?.abort?.(); } catch { /* noop */ }
  }

  // Vuelve a pedir el permiso sin recargar la página.
  async function retryMic() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      state.micDenied = false;
      startMicFallback();
    } catch {
      state.micDenied = true;
    }
    ui.renderMicCard();
  }

  // ===========================================================================
  // GRABAR DESDE LA PROPIA PÁGINA (carril B)
  // ===========================================================================
  // Por qué existe esto en Meet, si ya había un carril A (tabCapture): Chrome
  // sólo habilita tabCapture cuando la extensión fue INVOCADA desde el
  // navegador (el ícono de la barra o el atajo). Un clic adentro de la página
  // no cuenta -- lo define Chrome y no hay forma de rodearlo. Así que el
  // botón «Grabar» del panel terminaba siempre en el mismo cartel: «apretá
  // Ctrl+Shift+U». En una reunión de verdad eso fue, textual, «la grabación
  // tampoco funciona y me tira este aviso que no sirve de nada».
  //
  // getDisplayMedia SÍ acepta un clic de la página. Es el mismo camino que ya
  // usaban Zoom, Teams y Jitsi (prompt-injector.js), y termina igual: los
  // pedazos viajan al service worker apenas existen y se suben a LA MISMA
  // reunión del historial donde está la transcripción -- la clave de sala es
  // el código del Meet, el mismo que usa el bridge.
  const grabacion = { recorder: null, port: null, pidiendo: false, mic: null, ctx: null, vigia: null };

  function aBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    const paso = 0x8000; // de a pedacitos: apply() con un array enorme revienta
    for (let i = 0; i < bytes.length; i += paso) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + paso));
    }
    return btoa(bin);
  }

  async function iniciarGrabacionAca() {
    const code = meetCode();
    if (!code || grabacion.recorder || grabacion.pidiendo || state.recording) return;
    grabacion.pidiendo = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        // 30 fps pedidos a mano: sin esto Chrome puede entregar la captura a
        // 5-10 fps y el video queda a los saltos.
        video: { frameRate: { ideal: 30 } },
        audio: true,
        // Acá la pestaña actual ES la reunión: se ofrece primero.
        preferCurrentTab: true,
        selfBrowserSurface: "include",
        systemAudio: "include",
      });
    } catch {
      grabacion.pidiendo = false;
      ui.avisarGrabacion(
        "Para grabar hace falta compartir esta pestaña. Tocá «Grabar» y elegí <b>esta pestaña</b> con la casilla <b>Compartir audio</b> tildada."
      );
      return;
    }

    try {
      grabacion.port = chrome.runtime.connect({ name: "unify-ext-rec" });
      grabacion.port.onDisconnect.addListener(() => {
        grabacion.port = null;
        if (grabacion.recorder && grabacion.recorder.state !== "inactive") {
          grabacion.recorder.stop();
          ui.avisarGrabacion(
            "Se cortó el canal con la extensión y la grabación se detuvo. Lo que alcanzó a llegar se está guardando en tu historial."
          );
        }
      });
      grabacion.port.onMessage.addListener((msg) => {
        if (msg?.kind === "subida-ok") ui.avisarGrabacion("Grabación guardada en tu historial de Unify.", true);
        if (msg?.kind === "subida-error") ui.avisarGrabacion(msg.message || "No pudimos subir la grabación.");
        if (msg?.kind === "cortar" && grabacion.recorder && grabacion.recorder.state !== "inactive") {
          grabacion.recorder.stop();
        }
      });
      // La clave de sala es el código del Meet: el mismo que usa el bridge
      // para la transcripción, así el video queda colgado de ESA reunión.
      grabacion.port.postMessage({ kind: "inicio", roomKey: code, plataforma: "meet" });
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      grabacion.pidiendo = false;
      ui.avisarGrabacion("La extensión se recargó: recargá la página y probá de nuevo.");
      return;
    }

    // EL VIDEO QUE NO SE ESCUCHA. La captura trae el audio de la pestaña
    // SÓLO si se tildó «Compartir audio», y nunca trae TU micrófono (el
    // navegador no te devuelve tu propia voz). Grabando el stream pelado, el
    // archivo salía sin una sola voz propia -- y, sin la casilla tildada, sin
    // ninguna voz: un video que pesa, se ve bien y no se oye. Acá se mezcla
    // el micrófono con lo que haya traído la captura, como ya hacían el
    // grabador de escritorio y el carril A.
    let mezcla = stream;
    let hayAudio = stream.getAudioTracks().length > 0;
    try {
      grabacion.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      grabacion.mic = null; // sin permiso: queda el audio de la captura
    }
    if (grabacion.mic) hayAudio = true;
    if (grabacion.mic || stream.getAudioTracks().length > 0) {
      try {
        const ctx = new AudioContext();
        grabacion.ctx = ctx;
        if (ctx.state === "suspended") await ctx.resume().catch(() => {});
        const destino = ctx.createMediaStreamDestination();
        const sumar = (s2) => {
          if (!s2 || s2.getAudioTracks().length === 0) return;
          ctx.createMediaStreamSource(new MediaStream(s2.getAudioTracks())).connect(destino);
        };
        sumar(stream);
        sumar(grabacion.mic);
        mezcla = new MediaStream([...stream.getVideoTracks(), ...destino.stream.getAudioTracks()]);
      } catch {
        mezcla = stream; // sin Web Audio: se graba lo que vino
      }
    }
    if (!hayAudio) {
      ui.avisarGrabacion(
        "Ojo: esta grabación va a salir <b>sin sonido</b>. Detené, volvé a grabar y tildá <b>Compartir audio</b> al elegir la pestaña."
      );
    }

    // VP8 antes que VP9: VP9 en vivo se come la CPU que la reunión necesita.
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
      ? "video/webm;codecs=vp8,opus"
      : "video/webm";
    const pistaV = stream.getVideoTracks()[0];
    if (pistaV) pistaV.contentHint = "motion";
    let rec;
    try {
      rec = new MediaRecorder(mezcla, { mimeType: mime, videoBitsPerSecond: 3_500_000, audioBitsPerSecond: 192_000 });
    } catch {
      soltarAudioDeGrabacion();
      stream.getTracks().forEach((t) => t.stop());
      try { grabacion.port?.disconnect(); } catch { /* ya no está */ }
      grabacion.port = null;
      grabacion.pidiendo = false;
      ui.avisarGrabacion("Este navegador no pudo abrir el grabador de video.");
      return;
    }
    grabacion.recorder = rec;
    rec.ondataavailable = async (e) => {
      if (!e.data || e.data.size === 0) return;
      // Los pedazos salen de la página apenas existen: si la pestaña muere de
      // golpe, lo ya enviado se sube igual. En base64 porque un Port
      // serializa como JSON y un ArrayBuffer no sobrevive el viaje.
      try {
        grabacion.port?.postMessage({ kind: "chunk", b64: aBase64(await e.data.arrayBuffer()) });
      } catch { /* port muerto: el background sube lo que ya tiene */ }
    };
    rec.onstop = () => {
      try { grabacion.port?.postMessage({ kind: "fin" }); } catch { /* port muerto */ }
      stream.getTracks().forEach((t) => t.stop());
      soltarAudioDeGrabacion();
      grabacion.recorder = null;
      ui.setRecording(false);
    };
    rec.onerror = () => {
      ui.avisarGrabacion("El grabador falló a mitad de camino. Lo grabado hasta acá se está guardando en tu historial.");
      if (rec.state !== "inactive") rec.stop();
    };
    // Si se corta desde la barra nativa de «dejar de compartir».
    pistaV?.addEventListener("ended", () => {
      if (rec.state !== "inactive") rec.stop();
    });
    // Y el vigía: tener una pista de audio no garantiza que SUENE (la
    // pestaña puede estar en silencio, el micrófono puede ser de un aparato
    // apagado). Si a los doce segundos no entró nada, se avisa igual.
    if (grabacion.ctx && mezcla !== stream) {
      try {
        const analizador = grabacion.ctx.createAnalyser();
        analizador.fftSize = 512;
        grabacion.ctx.createMediaStreamSource(new MediaStream(mezcla.getAudioTracks())).connect(analizador);
        const muestras = new Uint8Array(analizador.fftSize);
        const desde = Date.now();
        grabacion.vigia = setInterval(() => {
          analizador.getByteTimeDomainData(muestras);
          let pico = 0;
          for (const v of muestras) pico = Math.max(pico, Math.abs(v - 128));
          if (pico > 2 || Date.now() - desde > 12_000) {
            if (pico <= 2) {
              ui.avisarGrabacion(
                "Llevamos 12 segundos grabando y no entra <b>nada de sonido</b>. Detené, volvé a grabar y tildá <b>Compartir audio</b>."
              );
            }
            clearInterval(grabacion.vigia);
            grabacion.vigia = null;
          }
        }, 1000);
      } catch { /* sin analizador: el aviso de «sin pista» ya cubre lo grave */ }
    }

    rec.start(4000); // un pedazo cada 4 s
    grabacion.pidiendo = false;
    ui.setRecording(true);
    ui.avisarGrabacion("Grabando. Al terminar queda en tu historial, junto a la transcripción.", true);
  }

  // El micrófono y el AudioContext que abrimos para la mezcla son NUESTROS:
  // si no se sueltan, Chrome deja el punto rojo de «te está escuchando»
  // encendido después de terminar la grabación.
  function soltarAudioDeGrabacion() {
    clearInterval(grabacion.vigia);
    grabacion.vigia = null;
    try { grabacion.mic?.getTracks().forEach((t) => t.stop()); } catch { /* ya cerrado */ }
    grabacion.mic = null;
    try { grabacion.ctx?.close(); } catch { /* ya cerrado */ }
    grabacion.ctx = null;
  }

  function detenerGrabacionAca() {
    const rec = grabacion.recorder;
    if (rec && rec.state !== "inactive") rec.stop();
  }

  const grabandoAca = () => Boolean(grabacion.recorder);

  // EL «SÍ» AUTOMÁTICO NO PUEDE PEDIR LA PANTALLA: un temporizador no es un
  // gesto y Chrome rechaza getDisplayMedia. Podríamos quedarnos esperando el
  // próximo clic en cualquier parte de Meet, pero entonces el selector de
  // pantalla se abriría de golpe al tocar cualquier cosa -- justo el tipo de
  // sorpresa que no queremos. En su lugar queda UN botón, a la vista, en el
  // panel que se acaba de abrir: un clic, y graba.
  function ofrecerGrabar() {
    ui.avisarGrabacion(
      "Listo para grabar. Tocá el botón y elegí <b>esta pestaña</b> con <b>Compartir audio</b> tildado: al terminar queda en tu historial con la transcripción.",
      false,
      { boton: "Grabar la reunión", accion: () => void iniciarGrabacionAca() }
    );
  }

  // ===========================================================================
  // Interfaz (Shadow DOM)
  // ===========================================================================
  const ui = (() => {
    let host = null, shadow = null, el = {}, tab = "stream", drawerOpen = false;
    let subsTimer = null;
    // Cuál es la línea que se está mostrando SOBRE EL VIDEO ahora mismo. La
    // traducción llega medio segundo después que la frase: sin esto, el
    // subtítulo flotante se quedaba con el original para siempre y la
    // traducción sólo aparecía en el panel de al lado.
    let subLinea = null;

    function mount() {
      if (host && document.body.contains(host)) return;
      host = document.createElement("div");
      host.id = "unify-root";
      // El host no debe interceptar clics: cada pieza reactiva su propio
      // pointer-events. Si no, un contenedor a pantalla completa dejaría Meet
      // inutilizable.
      host.style.cssText = "position:fixed;inset:0;z-index:2147483000;pointer-events:none;";
      shadow = host.attachShadow({ mode: "open" });

      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = chrome.runtime.getURL("shadow.css");
      shadow.appendChild(link);

      const wrap = document.createElement("div");
      wrap.innerHTML = `
        <button class="fab" data-el="fab" type="button" title="Unify: transcripción, IA y grabación" aria-label="Abrir el panel de Unify">U</button>
        <div class="badge glass" part="badge">
          <span class="live"></span>
          <span class="txt"><b>Unify</b>: <span data-el="statusTxt">Buscando la reunión…</span></span>
          <span class="tradlbl" aria-hidden="true">Traducir</span>
          <select class="langsel" data-el="lang" title="Traducir los subtítulos a este idioma" aria-label="Traducir los subtítulos a este idioma">
            <option value="">No traducir</option>
            <option value="es">Español</option>
            <option value="en">Inglés</option>
            <option value="pt">Portugués</option>
            <option value="fr">Francés</option>
            <option value="de">Alemán</option>
            <option value="it">Italiano</option>
            <option value="zh">Chino</option>
            <option value="ja">Japonés</option>
          </select>
        </div>

        <div class="subs glass" data-el="subs">
          <div class="who">
            <span class="role" data-el="subRole">Sin rol</span>
            <span class="name" data-el="subName">—</span>
            <span class="lang" data-el="subLang">es</span>
          </div>
          <div class="orig" data-el="subText"></div>
          <div class="tr" data-el="subTr" hidden></div>
        </div>

        <aside class="drawer glass" data-el="drawer">
          <div class="dhead">
            <span class="mark"></span>
            <span class="t">Unify</span>
            <button class="recbtn" data-el="rec" title="Grabar la reunión completa">
              <span class="dot"></span><span class="lbl" data-el="recTxt">Grabar</span>
            </button>
            <button class="iconbtn" data-el="close" title="Cerrar el panel" aria-label="Cerrar el panel">✕</button>
          </div>
          <div class="tabs">
            <button class="tab is-on" data-tab="stream">Transcripción</button>
            <button class="tab" data-tab="ai">Asistente IA</button>
            <button class="tab" data-tab="roles">Roles</button>
          </div>
          <div class="panes">
            <div class="pane" data-pane="stream">
              <div class="hint" data-el="capHint">Buscando los subtítulos de Meet…</div>
              <div data-el="micCard"></div>
              <div data-el="recCard"></div>
              <div class="stream" data-el="stream"></div>
            </div>
            <div class="pane" data-pane="ai" hidden>
              <div class="chat" data-el="chat"></div>
              <div class="hint" data-el="aiHint"></div>
              <div class="ask">
                <input type="text" data-el="aiInput" placeholder="Preguntá sobre la reunión…" />
                <button data-el="aiSend">Enviar</button>
              </div>
            </div>
            <div class="pane" data-pane="roles" hidden>
              <div class="hint">Asigná un rol a cada persona: se muestra en los subtítulos y en la transcripción.</div>
              <div class="roles" data-el="rolesList"></div>
            </div>
          </div>
        </aside>`;
      while (wrap.firstChild) shadow.appendChild(wrap.firstChild);

      el = {};
      shadow.querySelectorAll("[data-el]").forEach((n) => (el[n.dataset.el] = n));

      shadow.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
      el.fab.addEventListener("click", () => toggleDrawer());
      el.close.addEventListener("click", () => toggleDrawer(false));
      el.rec.addEventListener("click", toggleRecording);
      el.lang.addEventListener("change", () => {
        cfg.lang = el.lang.value;
        chrome.storage.local.set({ lang: cfg.lang });
        state.lines.forEach((l) => (l.translated = null));
        renderStream();
        // Y se vuelven a pedir: antes se borraban y nadie las pedía de nuevo,
        // así que elegir un idioma DEJABA la transcripción sin traducir.
        if (cfg.lang) {
          for (const l of state.lines.slice(-40)) void translateLine(l);
        }
      });
      el.aiSend.addEventListener("click", ask);
      el.aiInput.addEventListener("keydown", (e) => e.key === "Enter" && ask());
      el.lang.value = cfg.lang || "";

      document.body.appendChild(host);
      renderStream();
      renderRoles();
      renderMicCard();
      refreshAccount();
    }

    function setTab(name) {
      tab = name;
      shadow.querySelectorAll(".tab").forEach((b) => b.classList.toggle("is-on", b.dataset.tab === name));
      shadow.querySelectorAll(".pane").forEach((p) => (p.hidden = p.dataset.pane !== name));
      if (name === "ai") void ensureSession();
      if (name === "roles") renderRoles();
    }

    function toggleDrawer(force) {
      drawerOpen = force === undefined ? !drawerOpen : force;
      el.drawer.classList.toggle("is-open", drawerOpen);
      // El badge de estado se corre a la izquierda del cajón: si no, tapa el
      // título y la ✕ del panel.
      shadow.querySelector(".badge")?.classList.toggle("is-shifted", drawerOpen);
      // El panel entra desde la derecha y taparía al botón: se corre solo.
      el.fab?.classList.toggle("is-active", drawerOpen);
    }

    // ¿A QUIÉN ESTAMOS OYENDO? La chapita de arriba es lo único que se ve con
    // el cajón cerrado, así que la respuesta va ahí: en una reunión real la
    // persona se muteó, hablaron los demás, no apareció nada, y la
    // explicación («activá los subtítulos de Meet») estaba escondida adentro
    // de un panel que nadie tenía abierto. Y decir «Escuchando a todos» antes
    // de encontrar los subtítulos sería mentir: por eso hay un tercer estado.
    let oido = "buscando"; // "todos" | "solo-mic" | "buscando"
    function setStatus(kind) {
      const badge = shadow?.querySelector(".badge");
      if (!badge || !el.statusTxt) return;
      const problema = kind === "offline" || (kind !== "off" && oido === "solo-mic");
      badge.classList.toggle("is-off", kind === "off");
      badge.classList.toggle("is-warn", problema);
      el.statusTxt.textContent =
        kind === "off"
          ? "Fuera de la llamada"
          : kind === "offline"
            ? "Sin conexión"
            : oido === "todos"
              ? "Escuchando a todos"
              : oido === "solo-mic"
                ? "Sólo se oye tu voz — activá CC en Meet"
                : "Buscando los subtítulos de Meet…";
    }

    // Meet escribiendo en un idioma que no es el que se habla: se avisa una
    // sola vez y con el idioma detectado, no con una sospecha genérica.
    let idiomaAvisado = null;
    function avisarIdiomaDeMeet(codigo) {
      if (!el.capHint || idiomaAvisado === codigo) return;
      idiomaAvisado = codigo;
      const nombres = { en: "inglés", es: "español", pt: "portugués", fr: "francés", de: "alemán", it: "italiano" };
      el.capHint.innerHTML =
        `Los subtítulos de Meet están saliendo en <b>${nombres[codigo] || codigo}</b>, y por eso las ` +
        `palabras salen mal. Cambiá el idioma en <b>CC → ⚙</b> de Meet.`;
      el.capHint.classList.remove("ok");
      el.capHint.classList.add("aviso");
    }

    function setCaptionsReady(ok) {
      const antes = oido;
      oido = ok ? "todos" : state.usingMic ? "solo-mic" : "buscando";
      if (antes !== oido) setStatus("live");
      if (idiomaAvisado) return; // no pisar el aviso que sí explica el problema
      // Las palabras las escribe MEET, no Unify: si sus subtítulos están en
      // otro idioma que el que se habla, salen frases sin sentido ("cómo
      // andás" -> "Commanders") y no hay IA que lo arregle después. Decir
      // dónde se cambia es lo único que de verdad lo soluciona.
      el.capHint.innerHTML = ok
        ? 'Escuchando a todos los participantes desde los subtítulos de Meet. ' +
          '<span class="tip">¿Salen palabras raras? Los escribe Meet: revisá su idioma en <b>CC → ⚙</b>.</span>'
        : state.usingMic
          ? "Meet no está dando subtítulos: por ahora solo se transcribe TU micrófono, a los demás no se los oye. Activá los subtítulos de Meet (botón CC abajo, o la tecla c) para capturar a todos."
          : "Activá los subtítulos de Meet (botón CC abajo, o la tecla c) para transcribir a todos.";
      el.capHint.classList.toggle("ok", ok);
    }

    function renderMicCard() {
      if (!el.micCard) return;
      if (!state.micDenied) {
        el.micCard.innerHTML = "";
        return;
      }
      el.micCard.innerHTML = `
        <div class="card">
          <p>El navegador bloqueó el micrófono, así que no podemos transcribir tu voz.</p>
          <button data-el="micRetry">Permitir micrófono</button>
        </div>`;
      el.micCard.querySelector("[data-el=micRetry]").addEventListener("click", retryMic);
    }

    function renderStream() {
      if (!el.stream) return;
      if (state.lines.length === 0) {
        el.stream.innerHTML = `<div class="empty">Cuando alguien hable, lo vas a ver acá.</div>`;
        return;
      }
      const atBottom = el.stream.scrollHeight - el.stream.scrollTop - el.stream.clientHeight < 48;
      el.stream.innerHTML = state.lines
        .slice(-150)
        .map((l) => {
          const r = roleOf(state.roles[l.speaker] ?? "");
          const badge = r.id ? `<span class="role" style="--role:${r.color}">${esc(r.label)}</span>` : "";
          // Con traducción, la tarjeta se marca: el CSS pone la traducción
          // arriba y grande, y el original abajo, chico (quien pidió una
          // traducción viene a leer la traducción).
          const tr = l.translated ? `<div class="tr">${esc(l.translated)}</div>` : "";
          return `<div class="entry${l.translated ? " traducida" : ""}">
            <div class="meta">${badge}<span class="name">${esc(l.speaker)}</span><span class="time">${hhmm(l.at)}</span></div>
            <div class="text">${esc(l.text)}</div>${tr}
          </div>`;
        })
        .join("");
      if (atBottom) el.stream.scrollTop = el.stream.scrollHeight;
    }

    function renderRoles() {
      if (!el.rolesList) return;
      const names = Array.from(state.speakers);
      if (names.length === 0) {
        el.rolesList.innerHTML = `<div class="empty">Los participantes aparecen acá en cuanto hablan.</div>`;
        return;
      }
      el.rolesList.innerHTML = names
        .map((n) => {
          const cur = state.roles[n] ?? "";
          const opts = ROLES.map(
            (r) => `<option value="${r.id}"${r.id === cur ? " selected" : ""}>${esc(r.label)}</option>`
          ).join("");
          return `<div class="rrow"><span class="n">${esc(n)}</span><select data-name="${esc(n)}">${opts}</select></div>`;
        })
        .join("");
      el.rolesList.querySelectorAll("select").forEach((s) =>
        s.addEventListener("change", () => {
          state.roles[s.dataset.name] = s.value;
          const code = meetCode();
          if (code) chrome.storage.local.set({ [`roles:${code}`]: state.roles });
          renderStream();
        })
      );
    }

    function showSubtitle(line) {
      if (!el.subs) return;
      subLinea = line;
      pintarSubtitulo(line);
      el.subs.classList.add("is-on");
      clearTimeout(subsTimer);
      subsTimer = setTimeout(() => el.subs.classList.remove("is-on"), 6500);
    }

    // Vuelve a pintar el subtítulo que YA está en pantalla (llegó su
    // traducción, o la IA corrigió la frase) sin reiniciar el reloj: el
    // cartel no tiene por qué quedarse más tiempo por haberse traducido.
    function refrescarSubtitulo(line) {
      if (!el.subs || !line || subLinea !== line) return;
      if (!el.subs.classList.contains("is-on")) return;
      pintarSubtitulo(line);
    }

    function pintarSubtitulo(line) {
      if (!el.subs) return;
      const r = roleOf(state.roles[line.speaker] ?? "");
      el.subRole.textContent = r.label;
      el.subRole.style.setProperty("--role", r.color);
      el.subRole.hidden = !r.id;
      el.subName.textContent = line.speaker;
      // El nombre entero ("Español"), no "ES": las siglas no le dicen nada a
      // quien no las conoce.
      const NOMBRES = { es: "Español", en: "Inglés", pt: "Portugués", fr: "Francés", de: "Alemán", it: "Italiano", zh: "Chino", ja: "Japonés", ko: "Coreano", ru: "Ruso", ar: "Árabe" };
      const corto = (cfg.lang || navigator.language || "es").slice(0, 2).toLowerCase();
      el.subLang.textContent = NOMBRES[corto] || corto.toUpperCase();
      // Sobre el video entra una idea, no un párrafo: se muestra el final,
      // que es lo que se está diciendo ahora.
      const visible = line.text.length > 160 ? "…" + line.text.slice(-160) : line.text;
      el.subText.textContent = visible;
      if (line.translated) {
        el.subTr.textContent = line.translated;
        el.subTr.hidden = false;
      } else {
        el.subTr.hidden = true;
      }
      // Con traducción, ESA es la lectura principal (grande, arriba) y el
      // original queda debajo, chico: a eso vino quien traduce.
      el.subs.classList.toggle("traducido", Boolean(line.translated));
    }

    function refreshAccount() {
      if (!el.aiHint) return;
      el.aiHint.innerHTML = cfg.token
        ? ""
        : `Para usar la IA, <a href="${cfg.appBase}/ingresar" target="_blank" rel="noreferrer">iniciá sesión en Unify</a> y volvé a esta pestaña.`;
    }

    // ESTE CLIC ALCANZA PARA GRABAR. Antes el botón intentaba tabCapture, que
    // Chrome sólo habilita si la orden viene del ícono o del atajo, y el
    // final del camino era un cartel pidiendo apretar Ctrl+Shift+U. Ahora
    // graba acá mismo (getDisplayMedia sí acepta un clic de la página); el
    // atajo y el ícono siguen andando por su cuenta, con la captura de
    // pestaña, que es todavía mejor.
    async function toggleRecording() {
      const code = meetCode();
      if (!code) return;
      if (grabandoAca()) {
        detenerGrabacionAca();
        return;
      }
      if (state.recording) {
        chrome.runtime.sendMessage({ kind: "unify-record-stop" });
        setRecording(false);
        return;
      }
      // La sesión primero: es lo que ata el video a la reunión del historial.
      void ensureSession();
      await iniciarGrabacionAca();
    }

    // Cómo va la grabación, dicho donde se está mirando. `bien` distingue una
    // buena noticia (se guardó) de un problema (no se pudo subir): la buena
    // se va sola, la mala se queda hasta que la cierren.
    let avisoGrabTimer = null;
    function avisarGrabacion(html, bien = false, accion = null) {
      if (!el.recCard) return;
      clearTimeout(avisoGrabTimer);
      const boton = accion ? `<button data-el="grabAccion">${esc(accion.boton)}</button>` : "";
      el.recCard.innerHTML = `<div class="card${bien ? " ok" : ""}"><p>${html}</p>${boton}</div>`;
      if (accion) {
        el.recCard.querySelector("[data-el=grabAccion]").addEventListener("click", () => {
          el.recCard.innerHTML = "";
          accion.accion();
        });
      }
      if (bien) avisoGrabTimer = setTimeout(() => { el.recCard.innerHTML = ""; }, 8000);
    }

    function setRecording(on) {
      state.recording = on;
      // La grabación puede arrancar o terminar con el panel desmontado (Meet
      // reescribe su árbol, o todavía no entraste): el estado se guarda igual
      // y los botones se pintan cuando haya botones.
      if (!el.rec) return;
      el.rec.classList.toggle("is-rec", on);
      el.rec.title = on ? "Detener la grabación" : "Grabar la reunión completa";
      if (el.recTxt) el.recTxt.textContent = on ? "Grabando" : "Grabar";
    }

    function addMsg(who, text) {
      const d = document.createElement("div");
      d.className = `msg${who === "Vos" ? " me" : ""}`;
      const b = document.createElement("b");
      b.textContent = who;
      const s = document.createElement("span");
      s.textContent = text;
      d.append(b, s);
      el.chat.appendChild(d);
      el.chat.scrollTop = el.chat.scrollHeight;
      return s;
    }


  // La IA contesta en Markdown (negritas con **, listas con -): el panel lo
  // mostraba con los asteriscos a la vista. Se dibuja lo básico, escapando
  // primero el HTML (la respuesta es texto ajeno).
  function pintarMarkdown(el, texto) {
    const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const lineas = esc(String(texto || "")).split(/\r?\n/);
    let html = "";
    let enLista = false;
    for (const l of lineas) {
      const item = l.match(/^\s*[-*•]\s+(.*)$/);
      if (item) {
        if (!enLista) { html += "<ul>"; enLista = true; }
        html += `<li>${item[1]}</li>`;
        continue;
      }
      if (enLista) { html += "</ul>"; enLista = false; }
      if (!l.trim()) { html += "<br>"; continue; }
      const titulo = l.match(/^\s*#{1,3}\s+(.*)$/);
      html += titulo ? `<b>${titulo[1]}</b><br>` : `${l}<br>`;
    }
    if (enLista) html += "</ul>";
    html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
    el.innerHTML = html;
  }

    async function ask() {
      const q = el.aiInput.value.trim();
      if (!q) return;
      if (!cfg.token) return refreshAccount();
      el.aiInput.value = "";
      addMsg("Vos", q);
      const pending = addMsg("Unify", "Pensando…");
      try {
        const r = await api(`/api/meet-bridge/${meetCode()}/ask`, {
          method: "POST",
          body: JSON.stringify({ question: q }),
        });
        if (r.answer) pintarMarkdown(pending, r.answer); else pending.textContent = "Sin respuesta.";
      } catch (e) {
        pending.textContent =
          String(e.message) === "401"
            ? "Tu sesión de Unify venció. Volvé a iniciar sesión."
            : "No pudimos consultar a la IA en este momento.";
      }
      el.chat.scrollTop = el.chat.scrollHeight;
    }

    const esc = (s) =>
      String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const hhmm = (ts) =>
      new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    return {
      mount,
      unmount() { host?.remove(); host = null; shadow = null; el = {}; },
      get mounted() { return Boolean(host && document.body.contains(host)); },
      toggleDrawer, setStatus, setCaptionsReady, setRecording, avisarIdiomaDeMeet, avisarGrabacion,
      renderStream, renderRoles, renderMicCard, showSubtitle, refrescarSubtitulo, refreshAccount,
      // El idioma puede resolverse DESPUÉS de montar la interfaz (el storage
      // es asíncrono): esto empareja el selector con cfg.lang cuando llega.
      syncLang() { if (el.lang) el.lang.value = cfg.lang || ""; },
    };
  })();

  // ===========================================================================
  // El botón "U" para abrir el panel. ANTES se inyectaba ADENTRO de la barra
  // inferior de Meet (bar.appendChild sobre el ancestro del micrófono) y eso
  // rompía los botones de Meet: su framework re-renderiza esa barra y un hijo
  // ajeno la descuadra o directamente hace fallar sus updates (mutear/apagar
  // cámara "completamente bugueados" -- pasó de verdad). Ahora es un botón
  // FLOTANTE en nuestro shadow (abajo a la derecha, cerca de la barra): cero
  // escrituras en el DOM que Meet administra.
  // ===========================================================================
  const barButton = {
    ensure() { /* vive en el shadow: lo crea ui.mount() */ },
    remove() { /* se va con ui.unmount() */ },
  };

  // ===========================================================================
  // LAS ÓRDENES DE LA BARRA DE UNIFY (silenciar, cortar)
  // ===========================================================================
  // La barra de Unify tiene botones que parecen de llamada, pero la llamada
  // es de Meet: apretarlos no hacía nada (reporte real). Acá se ejecutan de
  // verdad, apretando los propios botones de Meet -- que es exactamente lo
  // que haría la persona.
  const ordenesHechas = new Set();

  function botonDeControl(kind) {
    return (
      (kind === "mic"
        ? document.querySelector('[data-is-muted][aria-label*="icróf"], [data-is-muted][aria-label*="icrophone"]')
        : document.querySelector('[data-is-muted][aria-label*="ámara"], [data-is-muted][aria-label*="amera"]')) ||
      document.querySelectorAll("[data-is-muted]")[kind === "mic" ? 0 : 1] ||
      null
    );
  }
  // Por etiqueta O por su ícono. Meet dibuja el de colgar con la ligadura
  // «call_end», que no cambia con el idioma de la interfaz: con la etiqueta
  // sola, un Meet en portugués o japonés dejaba el botón «Salir» de Unify sin
  // nada que apretar, y a la extensión sin forma de saber si la llamada
  // empezó (que es lo que decide si se transcribe o no).
  function botonDeColgar() {
    let porIcono = null;
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      if (COLGAR_RE.test(b.getAttribute("aria-label") || "")) return b;
      if (!porIcono && (b.textContent || "").trim() === "call_end") porIcono = b;
    }
    return porIcono;
  }
  // Meet marca el estado con data-is-muted, a veces en el botón mismo y a
  // veces en un envoltorio: el clic tiene que ir al botón de verdad, esté
  // arriba o abajo en el árbol. (Con `closest` solo, se clickeaba el
  // envoltorio y no pasaba nada.)
  const clicable = (el) => {
    if (!el) return null;
    if (el.matches?.('button, [role="button"]')) return el;
    return el.querySelector?.('button, [role="button"]') || el.closest?.('button, [role="button"]') || el;
  };

  function ejecutarOrden(accion) {
    if (accion === "colgar") {
      const b = botonDeColgar();
      if (!b) return false;
      b.click();
      return true;
    }
    const kind = accion.startsWith("mic") ? "mic" : "cam";
    const el = botonDeControl(kind);
    const b = clicable(el);
    if (!el || !b) return false;
    const silenciado = el.getAttribute("data-is-muted") === "true";
    // "on" = encendido (NO silenciado); "off" = silenciado/apagado.
    const quiereApagado = accion.endsWith("-off");
    const quiereEncendido = accion.endsWith("-on");
    if ((quiereApagado && silenciado) || (quiereEncendido && !silenciado)) return true; // ya estaba
    b.click();
    return true;
  }

  function atenderOrdenes(comandos) {
    if (!Array.isArray(comandos) || !comandos.length) return;
    for (const c of comandos) {
      const id = c && c.id;
      if (!id || ordenesHechas.has(id)) continue;
      ordenesHechas.add(id);
      if (ordenesHechas.size > 200) ordenesHechas.clear();
      try {
        const ok = ejecutarOrden(String(c.accion || ""));
        log(`orden de Unify «${c.accion}»: ${ok ? "hecha" : "no se encontró el control de Meet"}`);
      } catch (e) {
        log("no se pudo ejecutar la orden:", e?.message);
      }
    }
    void syncState(true);
  }

  // ===========================================================================
  // Estado de la llamada hacia Unify
  // ===========================================================================
  let lastState = "";
  async function syncState(force = false) {
    const code = meetCode();
    if (!code) return;
    const body = JSON.stringify({
      inCall: inCall(),
      micMuted: ownToggle("mic"),
      cameraOff: ownToggle("cam"),
      participantCount: participantCount(),
      presenting: presenting(),
      activeSpeakers: [],
      participants: null,
    });
    if (!force && body === lastState) return;
    lastState = body;
    try {
      await fetch(`${cfg.serverBase}/api/meet-bridge/${code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch {
      /* el badge ya refleja el estado de conexión */
    }
  }

  // ===========================================================================
  // Resiliencia: Meet re-renderiza su árbol entero sin avisar, así que en vez
  // de confiar en que lo inyectado sobreviva, se reafirma todo periódicamente
  // (y ante cada mutación, con freno). Reponer algo que ya está es gratis.
  // ===========================================================================
  // --- El aviso de bienvenida, igual que en Zoom, Teams o Jitsi -------------
  //
  // Faltaba, y era un agujero real: en Meet el panel montaba COLAPSADO (un
  // botón chico en la barra de Google), así que quien creaba una reunión no
  // veía absolutamente nada y creía que la extensión no andaba. En todas las
  // demás plataformas aparece un aviso; acá no. Ahora sí, con el mismo trato:
  // si no contestás, a los 5 segundos se abre solo con los subtítulos.
  let toastMostrado = null; // código de reunión donde ya se avisó
  let toastTimer = null;
  let aceptado = null;      // código donde ya dijo que sí (o venció la cuenta)
  let quiereGrabar = null;  // dijo que sí ANTES de entrar: se le ofrece al entrar
  function avisarEnMeet(code, { enEspera = false } = {}) {
    if (toastMostrado === code) return;
    toastMostrado = code;
    try {
      if (sessionStorage.getItem(`unify-no:${code}`)) return;
    } catch { /* sin storage */ }

    const host = document.createElement("div");
    host.id = "unify-aviso";
    host.style.cssText =
      "position:fixed;z-index:2147483001;inset:0;display:flex;align-items:center;" +
      "justify-content:center;pointer-events:none;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        /* En el MEDIO y grande: en el rincón se perdía entre los controles de
           Meet y la gente ni lo llegaba a ver. El fondo NO recibe clics
           (pointer-events en el host), así que Meet se sigue usando atrás. */
        .caja { width: 520px; max-width: calc(100vw - 40px); box-sizing: border-box;
          pointer-events: auto;
          background: #0f172a; color: #f5f6fb; border: 1px solid #334155;
          border-radius: 20px; padding: 28px 30px;
          font: 19px/1.45 system-ui, -apple-system, sans-serif;
          box-shadow: 0 24px 70px rgba(0,0,0,.55); }
        .msg { font-size: 21px; font-weight: 600; }
        .detalle { margin-top: 10px; font-size: 16px; color: #cbd5e1; }
        .fila { display: flex; gap: 12px; margin-top: 22px; flex-wrap: wrap; }
        button { border: 0; border-radius: 14px; padding: 15px 26px; font: inherit;
          font-size: 18px; font-weight: 700; cursor: pointer; min-height: 54px; }
        button:focus-visible { outline: 2px solid #a5b4fc; outline-offset: 2px; }
        .si { background: #6366f1; color: #fff; flex: 1; }
        .si:hover { background: #4f46e5; }
        .no { background: transparent; color: #e2e8f0; border: 1px solid #475569; }
        .no:hover { background: #1e293b; }
        .pie { margin-top: 14px; font-size: 15px; color: #94a3b8; }
      </style>
      <div class="caja" role="dialog" aria-label="Aviso de Unify">
        <div class="msg"></div>
        <div class="detalle"></div>
        <div class="fila"><button class="si">Sí, grabá y poné subtítulos</button><button class="no">Ahora no</button></div>
        <div class="pie"></div>
      </div>`;
    // El texto cambia según el momento: en la sala de espera se está
    // "uniendo" (es el caso del enlace que te mandaron por WhatsApp), ya
    // adentro se está "en" la reunión. Decirlo mal suena a robot.
    root.querySelector(".msg").textContent = enEspera
      ? "Veo que te estás uniendo a una reunión de Google Meet. ¿Querés los subtítulos y grabar la reunión?"
      : "Veo que estás en una reunión de Google Meet. ¿Querés los subtítulos y grabar la reunión?";
    // Que quede dicho ANTES de tocar: al decir que sí se graba, y la
    // grabación termina en el historial con la transcripción. Es lo que la
    // persona espera del «Sí» y lo que ahora hace de verdad.
    root.querySelector(".detalle").textContent = enEspera
      ? "Con «Sí», al entrar te dejo la grabación lista a un toque: al terminar queda en tu historial junto a la transcripción."
      : "Con «Sí» empieza a grabar y, al terminar, queda en tu historial junto a la transcripción.";
    (document.body || document.documentElement).appendChild(host);

    const pie = root.querySelector(".pie");
    // Quince segundos: cinco no alcanzaban ni para leerlo mientras se entra a
    // una reunión. Si no contesta, se hace lo mismo que si hubiera dicho que
    // sí -- que es lo que la persona quiere el 99% de las veces.
    let restante = 15;
    const textoPie = (n) => `Si no contestás, en ${n} segundo${n === 1 ? "" : "s"} abro los subtítulos solo.`;
    pie.textContent = textoPie(restante);
    const cerrar = () => {
      if (toastTimer) { clearInterval(toastTimer); toastTimer = null; }
      host.remove();
    };
    toastTimer = setInterval(() => {
      restante -= 1;
      if (restante > 0) {
        pie.textContent = textoPie(restante);
        return;
      }
      cerrar();
      // Auto-SÍ: se abre el panel con la transcripción y la grabación queda
      // armada para el primer clic real en la página (Chrome no deja pedir la
      // pantalla desde un temporizador).
      aceptar(false);
    }, 1000);

    // Aceptar en la SALA DE ESPERA no puede abrir un panel que todavía no
    // existe: se recuerda la respuesta y el panel se abre solo al entrar a la
    // llamada. Así, quien abrió el enlace de WhatsApp y dijo "sí" no tiene
    // que volver a decirlo del otro lado.
    // `porGesto` distingue el clic real del "Sí" automático. Sólo el clic
    // habilita getDisplayMedia: un temporizador no es un gesto y Chrome lo
    // rechaza. Con el automático, el pedido queda armado para el próximo
    // clic de verdad en la página, y así el «Sí» graba igual.
    const aceptar = (porGesto) => {
      aceptado = code;
      if (ui.mounted) ui.toggleDrawer(true);
      if (grabandoAca() || state.recording) return;
      // EN LA SALA DE ESPERA NO SE GRABA. Decir que sí ahí es decir que sí a
      // la reunión que está por empezar, no a que Chrome abra el selector de
      // pantalla sobre la vista previa, con la persona todavía afuera. Se
      // anota el pedido y, al entrar, queda el botón a un clic (para entonces
      // este clic ya no sirve como gesto: Chrome los da por vencidos).
      if (enEspera || !ui.mounted) {
        quiereGrabar = code;
        return;
      }
      if (porGesto) void iniciarGrabacionAca();
      else ofrecerGrabar();
    };

    root.querySelector(".si").addEventListener("click", () => {
      cerrar();
      aceptar(true);
    });
    root.querySelector(".no").addEventListener("click", () => {
      try { sessionStorage.setItem(`unify-no:${code}`, "1"); } catch { /* sin storage */ }
      cerrar();
    });
  }

  function ensureAll() {
    const code = meetCode();
    if (!code || !inCall()) {
      if (ui.mounted) {
        ui.unmount();
        barButton.remove();
        stopMicFallback();
      }
      soltarSubtitulos();
      // SE TERMINÓ LA REUNIÓN: se cierra la grabación y se sube. Es la mitad
      // que faltaba de «que se grabe solo y quede en el historial una vez
      // terminado» -- si no, colgar con la pestaña abierta dejaba el grabador
      // corriendo sobre una pantalla que ya no es la reunión.
      if (grabandoAca()) detenerGrabacionAca();

      // ANTES DE ENTRAR: éste es el momento del enlace que te mandaron por
      // WhatsApp. Meet muestra la vista previa con "Unirse ahora" y Unify
      // avisa ahí mismo -- no después, cuando la reunión ya arrancó. El panel
      // NO se monta todavía y el micrófono ni se toca: hasta que no entres,
      // no hay nada que transcribir.
      if (code && enSalaDeEspera()) {
        avisarEnMeet(code, { enEspera: true });
        return;
      }

      // Ni reunión ni sala de espera: se limpia todo. Si vuelve a entrar,
      // vuelve a avisar (y no queda un timer viejo abriendo el panel solo).
      if (toastTimer) { clearInterval(toastTimer); toastTimer = null; }
      document.getElementById("unify-aviso")?.remove();
      toastMostrado = null;
      aceptado = null;
      quiereGrabar = null;
      return;
    }
    ui.mount();
    barButton.ensure();
    // Si ya dijo que sí en la sala de espera, el panel se abre solo al entrar
    // y no se le vuelve a preguntar lo mismo.
    if (aceptado === code) {
      document.getElementById("unify-aviso")?.remove();
      if (toastTimer) { clearInterval(toastTimer); toastTimer = null; }
      ui.toggleDrawer(true);
      aceptado = null; // ya se cumplió; no reabrir si la persona lo cierra
      // Dijo que sí antes de entrar: acá adentro es donde tiene sentido
      // grabar, y queda a un clic.
      if (quiereGrabar === code && !grabandoAca() && !state.recording) {
        quiereGrabar = null;
        ofrecerGrabar();
      }
    } else {
      avisarEnMeet(code);
    }

    // NADA SE ESCUCHA HASTA QUE LA LLAMADA EMPEZÓ DE VERDAD. El panel puede
    // aparecer antes (no molesta a nadie); leer la pantalla, no: es lo que
    // hizo que los carteles de Meet entraran a la transcripción antes de
    // entrar a la reunión.
    if (!sePuedeTranscribir()) {
      soltarSubtitulos();
      stopMicFallback();
      ui.setCaptionsReady(false);
      ui.setStatus("live");
      return;
    }

    watchCaptions();
    ensureCaptionsOn();
    ui.setCaptionsReady(Boolean(caps.region));
    // Sin subtítulos de Meet no hay forma de oír a los demás; al menos que
    // quede la voz propia hasta que se activen.
    if (!caps.region && !mic.running) startMicFallback();
    if (caps.region && mic.running) stopMicFallback();
    ui.setStatus("live");
  }

  let pending = null;
  const globalObserver = new MutationObserver(() => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      try {
        ensureAll();
        void syncState();
      } catch (e) {
        log("recuperando de un cambio de Meet:", e?.message);
      }
    }, 700);
  });
  globalObserver.observe(document.documentElement, { childList: true, subtree: true });

  // ===========================================================================
  // LOS ÍCONOS DE MEET, RESCATADOS. En algunas redes (antivirus, bloqueadores,
  // DNS filtrado) fonts.gstatic.com no responde y la fuente de íconos de
  // Google no carga: cada botón de Meet muestra su NOMBRE en texto ("mic",
  // "videocam", "call_end") -- "los botones bugueados", tal cual se vio en una
  // reunión real. No lo rompemos nosotros (esta extensión no puede bloquear
  // fuentes: no tiene webRequest ni declarativeNetRequest, y no inyecta CSS a
  // la página), pero sí podemos arreglarlo: la fuente viaja ADENTRO de la
  // extensión y, SOLO si la de Google no cargó, se registra en la página con
  // los mismos nombres de familia. Si la de Google funciona, esto no toca nada.
  // ===========================================================================
  async function rescatarIconosDeMeet() {
    try {
      // Un respiro generoso: primero que la fuente REAL tenga su oportunidad.
      await new Promise((r) => setTimeout(r, 6000));
      const familias = ['"Google Symbols"', '"Google Material Icons"', '"Material Symbols Outlined"'];
      const faltantes = [];
      for (const familia of familias) {
        try { await document.fonts.load(`24px ${familia}`); } catch { /* sigue */ }
        if (!document.fonts.check(`24px ${familia}`)) faltantes.push(familia);
      }
      if (faltantes.length === 0 || document.getElementById("unify-rescate-iconos")) return;
      const url = chrome.runtime.getURL("iconos-material.woff2");
      const estilo = document.createElement("style");
      estilo.id = "unify-rescate-iconos";
      estilo.textContent = faltantes
        .map((f) => `@font-face{font-family:${f};font-style:normal;font-weight:100 700;src:url("${url}") format("woff2");font-display:block;}`)
        .join("\n");
      document.documentElement.appendChild(estilo);
      log("íconos de Meet rescatados con la fuente local:", faltantes.join(", "));
    } catch {
      /* mejor íconos rotos que romper otra cosa */
    }
  }
  void rescatarIconosDeMeet();

  setInterval(() => {
    try {
      ensureAll();
    } catch (e) {
      log("ensureAll falló, se reintenta:", e?.message);
    }
  }, 2000);
  setInterval(() => void syncState(true), 10000);
  // Las órdenes que deja la barra de Unify (silenciar, cortar): se buscan
  // seguido para que el botón se sienta inmediato, y sólo con la llamada en
  // curso (fuera de la reunión no hay nada que ejecutar).
  setInterval(() => {
    void (async () => {
      const code = meetCode();
      if (!code || !inCall()) return;
      try {
        // `ordenes=1`: las órdenes son para la extensión, y quien las lee se
        // las lleva. Los demás sondeos de esta misma sesión (la web, el botón
        // del bot) no deben consumirlas.
        const s = await api(`/api/meet-bridge/${code}/session?ordenes=1`);
        atenderOrdenes(s.comandos);
      } catch {
        /* la próxima vuelta lo reintenta */
      }
    })();
  }, 2000);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.kind === "unify-record-state") ui.setRecording(Boolean(msg.recording));
    if (msg?.kind === "unify-record-error") {
      ui.setRecording(false);
      log("grabación:", msg.message);
    }
  });

  window.addEventListener("pagehide", () => {
    const code = meetCode();
    if (code) {
      navigator.sendBeacon?.(
        `${cfg.serverBase}/api/meet-bridge/${code}`,
        new Blob([JSON.stringify({ inCall: false })], { type: "application/json" })
      );
    }
  });

  // Configuración al final: el navegador puede resolver el almacenamiento en el
  // acto, y leerlo antes de definir la interfaz dejaría la extensión sin arrancar.
  function loadConfig() {
    const code = meetCode();
    const keys = ["serverBase", "appBase", "token", "lang"];
    if (code) keys.push(`roles:${code}`);
    // `lang` AUSENTE es "nunca eligió": la traducción arranca sola en el
    // idioma del navegador. `lang: ""` es "eligió Sin traducir": se respeta.
    const IDIOMAS = ["es", "en", "pt", "fr", "de", "it", "zh", "ja"];
    const delNavegador = () => {
      const dos = String(navigator.language || "").slice(0, 2).toLowerCase();
      return IDIOMAS.includes(dos) ? dos : "";
    };
    chrome.storage.local.get(keys, (v) => {
      if (v?.serverBase?.startsWith?.("http")) cfg.serverBase = v.serverBase.replace(/\/+$/, "");
      if (v?.appBase?.startsWith?.("http")) cfg.appBase = v.appBase.replace(/\/+$/, "");
      cfg.token = v?.token ?? null;
      cfg.lang = typeof v?.lang === "string" ? v.lang : delNavegador();
      if (code && v?.[`roles:${code}`]) state.roles = v[`roles:${code}`];
      ui.refreshAccount();
      ui.renderRoles();
      ui.syncLang();
    });
    chrome.storage.onChanged.addListener((c, area) => {
      if (area !== "local") return;
      if (c.token) {
        cfg.token = c.token.newValue ?? null;
        ui.refreshAccount();
      }
      if (c.lang) cfg.lang = c.lang.newValue ?? "";
    });
  }

  loadConfig();
  ensureAll();
  void ensureSession();
  log("Unify activo en", location.pathname);
})();
