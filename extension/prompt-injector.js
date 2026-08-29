// Detecta que la persona está entrando a una reunión externa (Zoom, Teams,
// Jitsi, Webex, Whereby, GoTo) y le ofrece grabarla y transcribirla con
// Unify, ahí mismo.
//
// Este archivo NO corre en Google Meet: ahí manda content.js, que tiene la
// integración profunda (lee los subtítulos nativos). Acá el trabajo es otro:
// avisar a tiempo, conseguir el permiso con el clic de la persona, grabar y
// mostrar el overlay con la transcripción en vivo de la sala companion.
//
// Las DOS verdades del navegador que definen todo el diseño:
//
//  1. El clic en nuestro botón [Sí] da "activación de usuario" EN LA PÁGINA:
//     alcanza para getDisplayMedia (carril B, acá mismo, con la pestaña ya
//     preseleccionada). NO cuenta como "invocación de la extensión", así que
//     no alcanza para tabCapture.
//  2. tabCapture (carril A: sin selector, audio de pestaña garantizado) sólo
//     se habilita con una invocación real: el ícono de la barra o el atajo
//     Ctrl+Shift+U. Por eso el pie del toast lo ofrece como camino directo.
//
// La tabla de plataformas de acá abajo ESPEJA la derivación de claves de
// client/src/lib/meetingPlatforms.ts. Si las claves difieren, el overlay
// fabrica una sala aparte y las transcripciones no se funden: hay una prueba
// (sim_toast.js) que compara ambas derivaciones URL por URL.
(() => {
  if (window.top !== window) return; // sólo la página principal

  const DEFAULT_SERVER = "https://taller-0.onrender.com";
  const DEFAULT_APP = "https://www.unify-meet.com";
  const cfg = { serverBase: DEFAULT_SERVER, appBase: DEFAULT_APP, token: null, lang: "", langVoz: "" };
  // Traducciones por id de línea, para no volver a pedir la misma dos veces.
  // Se vacía al cambiar el idioma.
  const traducciones = new Map();

  function safeDecode(value) {
    try { return decodeURIComponent(value); } catch { return value; }
  }

  // --- Sobrevivir a una actualización de la extensión ------------------------
  //
  // Cuando la extensión se actualiza (ahora se actualiza sola), Chrome deja
  // HUÉRFANO al content script de cada pestaña ya abierta: sigue corriendo,
  // pero su puente con la extensión está muerto. Y ahí hay una trampa fea:
  // chrome.runtime.sendMessage LANZA EL ERROR DE FORMA SÍNCRONA
  // ("Extension context invalidated"), así que un .catch() no lo atrapa --
  // el error sube, corta la función a la mitad y el aviso de la reunión no
  // vuelve a aparecer NUNCA en esa pestaña. Con la auto-actualización recién
  // estrenada, eso pasaría en todas las reuniones abiertas.
  //
  // `chrome.runtime.id` es undefined exactamente en ese estado: sirve para
  // detectarlo, apagar la UI con prolijidad y dejar de intentar.
  let contextoVivo = true;
  function extensionViva() {
    if (!contextoVivo) return false;
    try {
      if (chrome.runtime?.id) return true;
    } catch { /* acceder también puede tirar */ }
    contextoVivo = false;
    return false;
  }

  /** Llama a la API de la extensión sin que un contexto muerto rompa nada. */
  function seguro(fn, siFalla) {
    if (!extensionViva()) return siFalla;
    try {
      return fn();
    } catch {
      contextoVivo = false; // la próxima ni se intenta
      return siFalla;
    }
  }

  // ArrayBuffer -> base64 por tramos: String.fromCharCode(...todo) revienta la
  // pila con chunks de más de ~100 KB.
  function aBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    const PASO = 0x8000;
    for (let i = 0; i < bytes.length; i += PASO) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + PASO));
    }
    return btoa(bin);
  }

  // Espejo de SIMPLE_PLATFORMS (client/src/lib/meetingPlatforms.ts). Mismo
  // orden, mismos hosts, mismos idParams: si allá se agrega una plataforma,
  // acá también, y la prueba de paridad avisa si se olvidan.
  const SIMPLES = [
    { plataforma: "webex", nombre: "Webex", hosts: [".webex.com", "webex.com", ".webex.com.cn"] },
    { plataforma: "skype", nombre: "Skype", hosts: ["join.skype.com", "skype.com", ".skype.com"] },
    { plataforma: "discord", nombre: "Discord", hosts: ["discord.gg", "discord.com", ".discord.com"] },
    { plataforma: "goto", nombre: "GoTo Meeting", hosts: ["gotomeet.me", "goto.com", ".goto.com", "gotomeeting.com", ".gotomeeting.com", "global.gotomeeting.com"] },
    { plataforma: "bluejeans", nombre: "BlueJeans", hosts: ["bluejeans.com", ".bluejeans.com"] },
    { plataforma: "chime", nombre: "Amazon Chime", hosts: ["chime.aws", ".chime.aws", "app.chime.aws"], idParams: ["pin", "meetingId"] },
    { plataforma: "slack", nombre: "Slack", hosts: ["app.slack.com", ".slack.com"] },
    { plataforma: "whatsapp", nombre: "WhatsApp", hosts: ["call.whatsapp.com"] },
    { plataforma: "zoho", nombre: "Zoho Meeting", hosts: ["meeting.zoho.com", ".zoho.com", ".zohomeeting.com"], idParams: ["key", "sessionKey"] },
    { plataforma: "dialpad", nombre: "Dialpad", hosts: ["dialpad.com", ".dialpad.com", "meetings.dialpad.com"] },
    { plataforma: "ringcentral", nombre: "RingCentral", hosts: ["v.ringcentral.com", ".ringcentral.com", "ringcentral.com"] },
    { plataforma: "livestorm", nombre: "Livestorm", hosts: ["app.livestorm.co", ".livestorm.co"] },
    { plataforma: "gather", nombre: "Gather", hosts: ["app.gather.town", ".gather.town", "gather.town"] },
  ];

  // --- Derivación de clave de sala (espejo de meetingPlatforms.ts) ----------
  function detectar() {
    let url;
    try { url = new URL(location.href); } catch { return null; }
    const host = url.hostname.toLowerCase();

    // Zoom: el número vive tras /j/, /w/ o /wc/; puede venir con separadores.
    if (host === "zoom.us" || host.endsWith(".zoom.us")) {
      const id = url.pathname
        .replace(/(\d)[\s-](?=\d)/g, "$1")
        // "/wc/join/<id>": la URL de "unirse desde el navegador" de Zoom,
        // con el segmento "join" ANTES del número. Espeja a la web.
        .match(/\/(?:j|w|wc)\/(?:join\/)?(\d{9,11})/)?.[1];
      if (!id) return null; // página de Zoom que no es una reunión: silencio
      return { plataforma: "zoom", nombre: "Zoom", roomKey: `zoom:${id}` };
    }

    // Teams corporativo: la identidad estable es el thread id del path.
    if (host === "teams.microsoft.com" || host.endsWith(".teams.microsoft.com")) {
      const decodedPath = safeDecode(url.pathname);
      const threadId = decodedPath.match(/(19:meeting_[^/@]+@thread\.v2)/i)?.[1]?.toLowerCase();
      const enReunion = threadId || /\/l\/meetup-join\//i.test(url.pathname);
      if (!enReunion) return null;
      return {
        plataforma: "teams",
        nombre: "Microsoft Teams",
        roomKey: `teams:${threadId ?? `${url.origin}${url.pathname}`.toLowerCase()}`,
      };
    }

    // Teams personal (teams.live.com/meet/123456...).
    if (host === "teams.live.com" || host.endsWith(".teams.live.com")) {
      const meetId = url.pathname.match(/\/meet\/(\d{6,})/)?.[1];
      if (!meetId) return null;
      return { plataforma: "teams", nombre: "Microsoft Teams", roomKey: `teams:${meetId}` };
    }

    // Familia Jitsi: meet.jit.si y 8x8.vc (ahí la sala es inquilino/sala).
    const esJitsi = host === "meet.jit.si" || host === "8x8.vc" || host.endsWith(".8x8.vc");
    if (esJitsi) {
      const segments = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
      const take = host === "meet.jit.si" ? 1 : 2;
      const raw = segments.slice(0, take).join("/");
      if (!raw) return null;
      return {
        plataforma: "jitsi",
        nombre: "Jitsi",
        roomKey: `jitsi:${host}/${safeDecode(raw).toLowerCase()}`,
      };
    }

    // Whereby: la sala es el primer segmento del path (mismo cálculo que la web).
    if (host === "whereby.com" || host.endsWith(".whereby.com")) {
      const room = url.pathname.replace(/^\/+/, "").split("/")[0];
      if (!room) return null;
      return { plataforma: "whereby", nombre: "Whereby", roomKey: `whereby:${host}/${room.toLowerCase()}` };
    }

    // Element Call: la clave sale del path (el hash identifica la sala pero
    // no viaja al servidor), igual que en la web.
    if (host === "call.element.io" || host.endsWith(".element.io")) {
      const room = `${url.pathname}${url.hash}`.replace(/^\/+/, "");
      if (!room) return null;
      return {
        plataforma: "element",
        nombre: "Element Call",
        roomKey: `element:${host}${url.pathname.toLowerCase()}`,
      };
    }

    // --- El resto: la MISMA tabla de plataformas simples que la web ---------
    //
    // Un enlace de reunión puede llegarte de cualquier lado, así que la
    // extensión reconoce todo lo que la web ya sabe reconocer. La clave se
    // arma igual que en SIMPLE_PLATFORMS (host + path + los ids que viajan en
    // el query de algunas plataformas), para que overlay y web caigan en la
    // misma sala. La prueba de paridad (sim_puente_salas) compara las dos
    // derivaciones URL por URL, así que esto no puede desincronizarse en
    // silencio.
    for (const s of SIMPLES) {
      const pega = s.hosts.some((h) => (h.startsWith(".") ? host.endsWith(h) : host === h));
      if (!pega) continue;
      const path = url.pathname.replace(/\/+$/, "").toLowerCase();
      // Webex tiene portada, ayuda y mil páginas más: sólo sus rutas de
      // reunión cuentan, si no el aviso saltaría leyendo el sitio.
      if (s.plataforma === "webex" && !/^\/(meet|join|wbxmjs|webappng)\//.test(path)) return null;
      const ids = (s.idParams ?? [])
        .map((k) => url.searchParams.get(k))
        .filter(Boolean)
        .map((v) => v.toLowerCase());
      const tail = [path, ...ids].filter(Boolean).join("/");
      // Sin nada que distinga ESTA reunión de otra de la misma plataforma no
      // se arma clave: la portada de discord.com no es una reunión.
      if (!tail) return null;
      return { plataforma: s.plataforma, nombre: s.nombre, roomKey: `${s.plataforma}:${host}${tail}` };
    }

    return null;
  }

  // --- Estado ----------------------------------------------------------------
  let actual = null;       // { plataforma, nombre, roomKey } detectada acá
  let recorder = null;     // MediaRecorder del carril B (si está grabando acá)
  let port = null;         // canal con el background para los chunks
  let overlayTimer = null; // sondeo de la transcripción en vivo
  let toastTimer = null;   // cuenta regresiva del toast (módulo: si la URL
                           // cambia de reunión, hay que poder matarla desde
                           // afuera; un timer huérfano dispararía el auto-SÍ
                           // de la reunión ANTERIOR)
  let host = null;         // nodo raíz de nuestra UI
  let rootRef = null;      // la shadow root de la UI activa
  let pipWin = null;       // la ventanita de subtítulos flotantes (si está abierta)

  // --- Estilos: hoja construida, no <style> inyectado -------------------------
  // Una hoja creada desde el mundo aislado no depende del CSP de la página,
  // así que esto se ve igual en Zoom, Teams o Jitsi.
  const css = new CSSStyleSheet();
  css.replaceSync(`
    :host { all: initial; }
    .caja { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      width: 368px; max-width: calc(100vw - 32px); box-sizing: border-box;
      /* Blanco protagonista (la marca es blanco + azul); el azul, de acento. */
      background: linear-gradient(170deg, #ffffff 0%, #f6f9ff 100%);
      color: #1c2a4f; border: 1px solid #dbe7fb;
      border-radius: 18px; padding: 16px 18px;
      font: 15px/1.5 system-ui, -apple-system, sans-serif;
      box-shadow: 0 18px 46px rgba(30, 64, 175, .25), 0 3px 10px rgba(30, 64, 175, .12);
      animation: entrar .28s cubic-bezier(.2, .9, .3, 1.15); }
    @keyframes entrar { from { opacity: 0; transform: translateY(14px) scale(.97); }
      to { opacity: 1; transform: none; } }
    /* El cartel de PREGUNTA va AL MEDIO y grande: en la esquina se perdía
       entre los controles de la reunión y con 368px no se llegaba a leer.
       Sólo la pregunta -- el overlay de subtítulos sigue en su esquina. */
    .caja.centro { right: auto; bottom: auto; left: 50%; top: 50%;
      width: 520px; padding: 26px 28px;
      font-size: 17px;
      transform: translate(-50%, -50%);
      animation: entrarCentro .28s cubic-bezier(.2, .9, .3, 1.15);
      box-shadow: 0 26px 70px rgba(15, 23, 42, .35), 0 4px 14px rgba(30, 64, 175, .14); }
    @keyframes entrarCentro {
      from { opacity: 0; transform: translate(-50%, -46%) scale(.97); }
      to { opacity: 1; transform: translate(-50%, -50%); } }
    .caja.centro .fila { margin-top: 18px; gap: 10px; }
    .caja.centro button { font-size: 16px; min-height: 48px; padding: 12px 22px; }
    .caja.centro .si { flex: 1; }
    .caja.centro .pie { font-size: 13.5px; margin-top: 10px; }
    /* La firma de la marca arriba del mensaje: el punto azul de Unify. */
    .marca { display: flex; align-items: center; gap: 7px; margin-bottom: 8px;
      font-size: 12.5px; font-weight: 800; letter-spacing: .04em;
      text-transform: uppercase; color: #2563EB; }
    .marcaPunto { width: 10px; height: 10px; border-radius: 50%; flex: none;
      background: radial-gradient(circle at 35% 30%, #7fb0ff, #2563EB);
      box-shadow: 0 0 7px rgba(59, 130, 246, .5); }
    .fila { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    /* Botones grandes y con foco visible: esto lo usa gente de todas las
       edades, y un botón de 40px de alto con contraste real es la
       diferencia entre "lo toco" y "ni lo vi". */
    button { border: 0; border-radius: 999px; padding: 10px 18px; font: inherit;
      font-weight: 700; cursor: pointer; min-height: 40px;
      transition: transform .15s ease, box-shadow .15s ease, background .15s ease; }
    button:focus-visible, .sel:focus-visible, .iain:focus-visible {
      outline: 2px solid #2563EB; outline-offset: 2px; }
    .si { background: linear-gradient(180deg, #3B82F6, #2563EB); color: #fff;
      box-shadow: 0 4px 14px rgba(37, 99, 235, .3); }
    .si:hover { transform: translateY(-1px); box-shadow: 0 7px 18px rgba(37, 99, 235, .4); }
    .no { background: #ffffff; color: #3d4d73; border: 1px solid #cfdcf5; }
    .no:hover { background: #eef4ff; border-color: #9db9ff; }
    .pie { margin-top: 8px; font-size: 12.5px; color: #5b6b8f; }
    .rec { display: flex; align-items: center; gap: 8px; font-weight: 600; }
    .punto { width: 9px; height: 9px; border-radius: 50%; background: #dc2626;
      animation: latir 1.2s infinite; flex: none; }
    @keyframes latir { 50% { opacity: .35; } }
    .subs { margin-top: 10px; display: grid; gap: 8px; max-height: 240px;
      overflow-y: auto; }
    .linea { display: flex; gap: 8px; align-items: flex-start; }
    .foto { width: 24px; height: 24px; border-radius: 50%; flex: none;
      object-fit: cover; background: #c7d6f2; color: #1c2a4f; font-size: 11px;
      font-weight: 700; display: flex; align-items: center; justify-content: center; }
    .quien { font-size: 12px; color: #5b6b8f; }
    .dijo { font-size: 15px; line-height: 1.4; color: #101c40; overflow-wrap: anywhere; }
    .vacio { font-size: 13px; color: #7d8bae; }
    .sel { margin-top: 8px; width: 100%; background: #ffffff;
      color: #1c2a4f; border: 1px solid #cfdcf5;
      border-radius: 10px; padding: 7px 9px;
      font: 13px system-ui, sans-serif; cursor: pointer; }
    .sel:hover { border-color: #2563EB; }
    .trad { font-size: 14px; line-height: 1.4; color: #1d4ed8; margin-top: 1px;
      overflow-wrap: anywhere; }
    .interina { font-size: 14px; line-height: 1.4; color: #7d8bae; font-style: italic;
      overflow-wrap: anywhere; margin-top: 4px; }
    .aviso { margin-top: 8px; font-size: 12px; color: #b91c1c; }
    .ok { margin-top: 8px; font-size: 12px; color: #047857; }
    .iafila { display: flex; gap: 6px; margin-top: 10px; }
    .iain { flex: 1; min-width: 0; background: #ffffff; color: #1c2a4f;
      border: 1px solid #cfdcf5; border-radius: 8px; padding: 8px 10px;
      font: 14px system-ui, sans-serif; }
    .iain::placeholder { color: #7d8bae; }
    .iabtn { background: #e7efff; color: #1d4ed8; padding: 7px 12px; }
    .iabtn:hover { background: #d8e5ff; }
    .iaresp { margin-top: 8px; font-size: 13px; line-height: 1.5; color: #1c2a4f;
      background: #f4f8ff; border: 1px solid #dbe7fb; border-radius: 8px;
      padding: 8px 10px; max-height: 150px; overflow-y: auto;
      white-space: pre-wrap; overflow-wrap: anywhere; }
  `);

  function raiz() {
    if (host) host.remove();
    host = document.createElement("div");
    (document.documentElement || document.body).appendChild(host);
    // "open" como el panel de Meet: "closed" no protege nada real (la página
    // igual puede borrar el host entero) y de paso deja probar esta UI con
    // herramientas normales.
    rootRef = host.attachShadow({ mode: "open" });
    rootRef.adoptedStyleSheets = [css];
    return rootRef;
  }

  // --- El cartel sobrevive a la PANTALLA COMPLETA -----------------------------
  // Cuando alguien presenta y la página pone un elemento en fullscreen, el
  // navegador muestra SOLO el subárbol de ese elemento: nuestro cartel (hijo
  // de <html>) desaparecía justo cuando más se lo necesita. La salida es
  // mudarse ADENTRO del elemento fullscreen mientras dure, y volver a <html>
  // al salir. Los subtítulos, la traducción y la IA siguen a la vista sin
  // importar dónde estés en la reunión.
  document.addEventListener("fullscreenchange", () => {
    if (!host) return;
    const fs = document.fullscreenElement;
    try {
      if (fs && !fs.contains(host)) fs.appendChild(host);
      else if (!fs && host.parentElement !== document.documentElement) {
        (document.documentElement || document.body).appendChild(host);
      }
    } catch {
      // Un fullscreen exótico (iframe de otro origen) no puede romper la UI.
    }
  });

  function quitarUI() {
    if (vozPropia) { vozPropia.parar(); vozPropia = null; }
    if (vozPantalla) { vozPantalla.parar(); vozPantalla = null; }
    if (overlayTimer) { clearInterval(overlayTimer); overlayTimer = null; }
    if (toastTimer) { clearInterval(toastTimer); toastTimer = null; }
    // Cerrada la UI, ningún clic suelto debe abrir el selector de pantalla.
    if (desarmar) desarmar();
    if (host) { host.remove(); host = null; }
    rootRef = null;
    // La ventanita flotante no queda huérfana al cerrarse el cartel.
    if (pipWin) { try { pipWin.close(); } catch { /* ya cerrada */ } pipWin = null; }
  }

  // Color determinístico por nombre para la inicial (mismo espíritu que
  // lib/avatar.ts: la misma persona siempre con el mismo color).
  const PALETA = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6"];
  function colorDe(nombre) {
    let h = 0;
    for (let i = 0; i < nombre.length; i++) h = (h * 31 + nombre.charCodeAt(i)) >>> 0;
    return PALETA[h % PALETA.length];
  }

  // Que decir "sí" valga para toda la reunión, no para una sola página.
  //
  // Zoom es el caso que lo pide: al abrir el enlace caés en la página de
  // lanzamiento (/j/…), y si elegís "unirse desde el navegador" pasás al
  // cliente web (/wc/…). Es una navegación completa: el content script
  // arranca de cero y, sin esta memoria, te preguntaba LO MISMO otra vez a
  // los pocos segundos. sessionStorage vive en la pestaña y en el mismo
  // dominio, así que cruza ese salto y muere al cerrarla.
  function recordarSi(roomKey) {
    try { sessionStorage.setItem(`unify-si:${roomKey}`, "1"); } catch { /* sin storage */ }
  }
  function yaDijoQueSi(roomKey) {
    try { return Boolean(sessionStorage.getItem(`unify-si:${roomKey}`)); } catch { return false; }
  }

  // --- Tu voz, transcripta de verdad -----------------------------------------
  // El overlay muestra lo que llega al bridge, pero alguien tiene que PONER
  // líneas ahí. En Meet lo hace el panel leyendo los subtítulos nativos; en
  // las demás plataformas no hay subtítulos que leer, así que se escucha el
  // micrófono con el reconocimiento del navegador (la misma técnica del
  // respaldo por micrófono del panel de Meet). Una pestaña sólo escucha TU
  // voz: los demás aparecen cuando cada quien abre Unify de su lado.
  function crearVozPropia({ lang, track = null, alTextoFinal, alTextoInterino, alFaltarPermiso }) {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    let rec = null;
    let activa = false;
    let fallasSeguidas = 0;
    function arrancar() {
      if (!Ctor || activa) return false;
      // Con una pista como entrada (el audio de la pantalla capturada) hace
      // falta el Web Speech de Chrome 139+, que llegó junto con available().
      // En un Chrome viejo start(pista) IGNORA el argumento y escucharía el
      // micrófono DOS veces: mejor no arrancar.
      if (track && typeof Ctor.available !== "function") return false;
      const r = new Ctor();
      r.lang = lang;
      r.continuous = true;
      r.interimResults = true;
      // Tres lecturas candidatas por fragmento: la primera es la mejor, y
      // las otras dos le dan a la IA de limpieza del servidor más hipótesis
      // para reconstruir la palabra que de verdad se dijo.
      r.maxAlternatives = 3;
      r.onresult = (ev) => {
        fallasSeguidas = 0;
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i];
          const texto = res[0]?.transcript?.trim();
          if (!texto) continue;
          if (res.isFinal) {
            const alts = [];
            for (let j = 1; j < res.length && j < 3; j++) {
              const otra = res[j]?.transcript?.trim();
              if (otra && otra !== texto) alts.push(otra);
            }
            alTextoFinal(texto, alts);
          } else {
            alTextoInterino(texto);
          }
        }
      };
      r.onerror = (ev) => {
        if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
          // Sin micrófono no hay drama: los subtítulos de los DEMÁS siguen
          // llegando por el bridge. Se avisa una vez y no se insiste.
          activa = false;
          alFaltarPermiso();
          return;
        }
        fallasSeguidas += 1;
      };
      r.onend = () => {
        // El reconocimiento se corta solo tras un silencio: relevantarlo es
        // lo que lo vuelve continuo. Pero si falla y falla (sin red hacia el
        // servicio de voz), insistir sería martillar: varias seguidas y listo.
        if (!activa) return;
        if (fallasSeguidas >= 8) { activa = false; return; }
        setTimeout(() => {
          if (activa) { try { track ? r.start(track) : r.start(); } catch { /* ya estaba arrancando */ } }
        }, fallasSeguidas ? 800 : 0);
      };
      try { track ? r.start(track) : r.start(); } catch { return false; }
      rec = r;
      activa = true;
      return true;
    }
    function parar() {
      activa = false;
      try { rec?.stop(); } catch { /* ya estaba muerto */ }
      rec = null;
    }
    return { arrancar, parar };
  }
  let vozPropia = null;
  let vozPantalla = null;
  // Para re-arrancar el reconocimiento cuando cambia el idioma hablado desde
  // el selector, sin recargar la reunión.
  let reiniciarVozHook = null;

  // La línea final viaja al bridge de ESTA sala: así la ven el overlay (al
  // próximo sondeo), el companion web si está abierto, el historial y la IA.
  async function publicarVozPropia(det, texto, lang, alts = [], speaker = "Vos") {
    try {
      const res = await fetch(`${cfg.serverBase}/api/meet-bridge/${encodeURIComponent(det.roomKey)}/transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speaker, text: texto, lang, alts }),
      });
      // La IA del servidor detecta el idioma REAL de cada frase: si difiere
      // del que estamos usando para escuchar, lo devuelve. Es la llave del
      // auto-arreglo de abajo: escuchar castellano con oído inglés atrapa
      // dos palabras con suerte, y nadie encuentra el selector a tiempo.
      const datos = await res.json().catch(() => null);
      return datos?.idiomaDistinto ?? null;
    } catch { /* sin red: la próxima línea lo reintenta sola */ }
    return null;
  }

  // El mapa corto -> código completo del selector (para que el selector
  // refleje el cambio y el reconocimiento reciba un código que conoce bien).
  const CODIGO_VOZ = { es: "es-AR", en: "en-US", pt: "pt-BR", fr: "fr-FR", de: "de-DE", it: "it-IT", zh: "zh-CN", ja: "ja-JP" };
  const NOMBRES_IDIOMA = { es: "español", en: "inglés", pt: "portugués", fr: "francés", de: "alemán", it: "italiano", zh: "chino", ja: "japonés" };

  // --- Toast inicial -----------------------------------------------------------
  // ¿Estamos en la página de LANZAMIENTO de Zoom (zoom.us/j/… o /w/…)? Es la
  // pantalla que abre la app de escritorio: si la app se la lleva, Unify no
  // puede hacer nada (una extensión no ve adentro de un programa de escritorio
  // -- es un límite del sistema, no de permisos). El camino que SÍ sirve es
  // quedarse en el navegador: /wc/join/<id> abre la reunión ahí mismo.
  function esLanzamientoZoom(det) {
    return (
      det.plataforma === "zoom" &&
      /\/(?:j|w)\//.test(location.pathname) &&
      !/\/wc\//.test(location.pathname)
    );
  }
  function urlWebClientZoom(det) {
    const id = (det.roomKey.split(":")[1] || "").trim();
    if (!id) return null;
    const pwd = new URLSearchParams(location.search).get("pwd");
    return `https://${location.hostname}/wc/join/${id}${pwd ? `?pwd=${encodeURIComponent(pwd)}` : ""}`;
  }

  function mostrarToast(det) {
    // Borrón y cuenta nueva: si quedó un overlay sondeando la reunión
    // ANTERIOR (o un gesto armado, o una cuenta regresiva vieja), acá muere.
    // Sin esto, navegar de una reunión a otra dejaba un setInterval huérfano
    // sondeando la sala equivocada para siempre.
    quitarUI();
    const root = raiz();
    const caja = document.createElement("div");
    caja.className = "caja centro";
    // Para lectores de pantalla: es un diálogo con nombre, no un div mudo.
    caja.setAttribute("role", "dialog");
    caja.setAttribute("aria-label", "Aviso de Unify");

    // La firma visual: el punto azul + "Unify" arriba del mensaje, para que
    // se sepa al primer vistazo de quién es el cartel.
    const marca = document.createElement("div");
    marca.className = "marca";
    const marcaPunto = document.createElement("span");
    marcaPunto.className = "marcaPunto";
    marca.append(marcaPunto, document.createTextNode("Unify"));
    caja.appendChild(marca);

    const texto = document.createElement("div");
    texto.textContent = `Uy, veo que te estás uniendo a una reunión de ${det.nombre}. ¿Querés grabarla? Los subtítulos con traducción y la transcripción van incluidos.`;

    // Página de lanzamiento de Zoom: Zoom va a abrir su app de escritorio, y
    // ahí Unify no llega. El aviso + un botón que abre el cliente web
    // (/wc/join/<id>) para quedarse en el navegador, donde Unify sí funciona.
    const urlNavegador = esLanzamientoZoom(det) ? urlWebClientZoom(det) : null;
    let bloqueZoom = null;
    if (urlNavegador) {
      bloqueZoom = document.createElement("div");
      const aviso = document.createElement("div");
      aviso.className = "pie";
      aviso.textContent = "Zoom va a abrir su app de escritorio, donde Unify no puede grabar ni traducir. Unite desde el navegador y tenés todo:";
      const filaNav = document.createElement("div");
      filaNav.className = "fila";
      const abrirNav = document.createElement("button");
      abrirNav.className = "si";
      abrirNav.textContent = "Unirme desde el navegador";
      abrirNav.addEventListener("click", () => {
        recordarSi(det.roomKey); // al caer en /wc/ no vuelve a preguntar
        location.href = urlNavegador;
      });
      filaNav.append(abrirNav);
      bloqueZoom.append(aviso, filaNav);
    }

    const fila = document.createElement("div");
    fila.className = "fila";
    const si = document.createElement("button");
    si.className = "si";
    si.textContent = "Sí, dale";
    const no = document.createElement("button");
    no.className = "no";
    no.textContent = "Ahora no";
    fila.append(si, no);

    // Si no contestás, a los 15 segundos es un SÍ solo: los subtítulos y la
    // transcripción arrancan sin permiso del navegador. La GRABACIÓN no puede
    // arrancar por timer -- Chrome sólo entrega la pantalla con un gesto tuyo
    // -- así que queda "armada": tu próximo clic en la página (el de "Unirse",
    // sin ir más lejos) dispara el pedido con la pestaña ya elegida.
    const cuenta = document.createElement("div");
    cuenta.className = "pie";
    let restante = 15;
    const textoCuenta = (n) => `Si no respondés, en ${n} segundo${n === 1 ? "" : "s"} arranco solo con los subtítulos y la transcripción.`;
    cuenta.textContent = textoCuenta(restante);

    const pie = document.createElement("div");
    pie.className = "pie";
    pie.textContent = "Consejo: con Ctrl+Shift+U (⌘⇧U en Mac) grabás directo, sin el selector de pestaña.";

    if (bloqueZoom) caja.append(texto, bloqueZoom, fila, cuenta, pie);
    else caja.append(texto, fila, cuenta, pie);
    root.appendChild(caja);

    if (toastTimer) clearInterval(toastTimer);
    toastTimer = setInterval(() => {
      // Si mientras corría la cuenta la persona navegó a OTRA reunión (o a
      // ninguna), este timer es de una pantalla que ya no existe: morir en
      // silencio, no arrancar los subtítulos de la sala equivocada.
      if (actual?.roomKey !== det.roomKey) {
        clearInterval(toastTimer);
        toastTimer = null;
        return;
      }
      restante -= 1;
      if (restante > 0) {
        cuenta.textContent = textoCuenta(restante);
        return;
      }
      clearInterval(toastTimer);
      toastTimer = null;
      // Auto-SÍ: subtítulos ya, grabación armada al próximo gesto.
      recordarSi(det.roomKey);
      mostrarOverlay(det, { grabandoAca: false });
      armarGrabacionAlProximoGesto(det);
    }, 1000);

    no.addEventListener("click", () => {
      // Sólo esta reunión, en esta pestaña. No es un "nunca más".
      try { sessionStorage.setItem(`unify-no:${det.roomKey}`, "1"); } catch { /* sin storage */ }
      quitarUI(); // limpia el timer también
    });

    // CARRIL B: este clic ES la activación que getDisplayMedia necesita.
    si.addEventListener("click", () => {
      recordarSi(det.roomKey);
      if (toastTimer) { clearInterval(toastTimer); toastTimer = null; }
      void iniciarCarrilB(det, caja);
    });
  }

  // El auto-SÍ no puede pedir la pantalla (un timer no es un gesto): deja el
  // pedido listo para el PRÓXIMO clic real en la página. Si la persona cancela
  // el selector, no se insiste: queda el botón Grabar del overlay.
  let desarmar = null;
  function armarGrabacionAlProximoGesto(det) {
    if (desarmar) desarmar();
    const handler = (e) => {
      // Un clic sobre NUESTRA UI no es "el próximo gesto en la página": tocar
      // el selector de idioma o "Cerrar" no debe abrir el selector de
      // pantalla. Esos clics se ignoran y el pedido queda armado.
      try { if (host && e.composedPath().includes(host)) return; } catch { /* sin composedPath */ }
      limpiar();
      if (recorder) return; // ya está grabando por otro camino
      void iniciarCarrilB(det, null);
    };
    const limpiar = () => {
      window.removeEventListener("click", handler, true);
      desarmar = null;
    };
    window.addEventListener("click", handler, true);
    desarmar = limpiar;
  }

  // Candado contra la doble captura: dos clics rápidos en "Grabar" (o un
  // clic armado mientras el selector ya está abierto) dispararían DOS
  // getDisplayMedia, y los chunks de ambos grabadores se entrelazarían en el
  // mismo puerto: un webm corrupto. Con el candado, el segundo pedido muere
  // acá y la grabación que ya está en marcha sigue intacta.
  let pidiendoPantalla = false;
  async function iniciarCarrilB(det, caja) {
    if (recorder || pidiendoPantalla) return;
    pidiendoPantalla = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        // 30 fps pedidos explícitamente: sin esto, Chrome puede entregar la
        // captura de pestaña a 5-10 fps y el video queda a los saltos.
        video: { frameRate: { ideal: 30 } },
        audio: true,
        // Al revés que en la web de Unify (selfBrowserSurface: "exclude" para
        // no grabar a Unify mismo): acá la pestaña actual ES la reunión.
        preferCurrentTab: true,
        selfBrowserSurface: "include",
        systemAudio: "include",
      });
    } catch {
      // Canceló el selector: no es un error y no se insiste con la pantalla
      // (queda el botón Grabar del overlay). Pero dijo que SÍ: si el overlay
      // no está todavía (venía del toast), los subtítulos arrancan igual.
      pidiendoPantalla = false;
      if (!rootRef?.querySelector(".subs")) mostrarOverlay(det, { grabandoAca: false });
      return;
    }

    try {
      port = chrome.runtime.connect({ name: "unify-ext-rec" });
      // Si el canal con el background muere en plena grabación (la extensión
      // se actualizó o se recargó), seguir grabando sería grabar a la nada:
      // se corta acá y se avisa. Lo que ya viajó, el background lo sube igual
      // desde su propio onDisconnect.
      port.onDisconnect.addListener(() => {
        port = null;
        if (recorder && recorder.state !== "inactive") {
          recorder.stop();
          notaEnOverlay(
            "Se cortó el canal con la extensión y la grabación se detuvo. Lo que alcanzó a llegar se está guardando en tu historial.",
            "aviso"
          );
        }
      });
      port.onMessage.addListener((msg) => {
        if (msg?.kind === "subida-ok") {
          notaEnOverlay("Grabación guardada en tu historial de Unify.", "ok");
          // Con la buena noticia dada, la UI se despide sola.
          setTimeout(() => quitarUI(), 6000);
        }
        if (msg?.kind === "subida-error") {
          // La mala noticia NO se despide sola: se queda hasta que la cierren.
          notaEnOverlay(msg.message || "No pudimos subir la grabación.", "aviso");
        }
        // El background corta cuando la grabación llegó al tope de tamaño.
        if (msg?.kind === "cortar" && recorder && recorder.state !== "inactive") recorder.stop();
      });
      port.postMessage({ kind: "inicio", roomKey: det.roomKey, plataforma: det.plataforma });
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      pidiendoPantalla = false;
      caja?.appendChild(Object.assign(document.createElement("div"), {
        className: "aviso",
        textContent: "La extensión se recargó: recargá la página y probá de nuevo.",
      }));
      return;
    }

    // VP8 primero: VP9 en vivo come la CPU que la reunión necesita y el video
    // salía a los saltos (misma corrección que el carril A y el bot).
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
      ? "video/webm;codecs=vp8,opus"
      : "video/webm";
    const pistaV = stream.getVideoTracks()[0];
    if (pistaV) pistaV.contentHint = "motion";
    recorder = new MediaRecorder(stream, {
      mimeType: mime,
      // Misma calidad que el grabador del documento offscreen (carril A).
      videoBitsPerSecond: 3_500_000,
      audioBitsPerSecond: 192_000,
    });
    recorder.ondataavailable = async (e) => {
      if (!e.data || e.data.size === 0) return;
      // Los chunks viajan al background apenas existen: si la pestaña muere de
      // golpe, lo ya enviado se salva igual (mismo espíritu que recordingVault
      // en la web). El Port además mantiene despierto al service worker.
      //
      // En base64 porque los mensajes de un Port se serializan como JSON: un
      // ArrayBuffer no sobrevive el viaje (llega como objeto vacío). El 33% de
      // sobrepeso es el precio de que lo grabado salga de la página en vivo.
      try {
        port?.postMessage({ kind: "chunk", b64: aBase64(await e.data.arrayBuffer()) });
      } catch { /* port muerto */ }
    };
    recorder.onstop = () => {
      try { port?.postMessage({ kind: "fin" }); } catch { /* port muerto */ }
      stream.getTracks().forEach((t) => t.stop());
      recorder = null;
    };
    // Un error del grabador (códec, disco, pestaña descartada) no puede morir
    // en silencio: se cierra prolijo -- onstop manda el "fin" y el background
    // sube lo que llegó -- y se DICE, que es la diferencia entre "perdí la
    // reunión sin saberlo" y "sé exactamente qué tengo".
    recorder.onerror = () => {
      notaEnOverlay(
        "El grabador falló a mitad de camino. Lo grabado hasta acá se está guardando en tu historial.",
        "aviso"
      );
      if (recorder && recorder.state !== "inactive") recorder.stop();
    };
    // Si la persona corta desde la barra nativa de "dejar de compartir".
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    });
    recorder.start(3000);

    // El audio de la captura (las voces de la reunión, un video que pongan)
    // también se transcribe, no sólo tu micrófono: la pista entra al
    // reconocimiento (Chrome 139+) y sale al bridge como "Pantalla
    // compartida", con la misma IA correctora y traducción que todo lo demás.
    const pistaAudio = stream.getAudioTracks()[0] ?? null;
    if (pistaAudio) {
      if (vozPantalla) vozPantalla.parar();
      vozPantalla = crearVozPropia({
        lang: cfg.langVoz || navigator.language || "es-AR",
        track: pistaAudio,
        alTextoFinal: (texto, alts) =>
          void publicarVozPropia(det, texto, navigator.language || "es-AR", alts, "Pantalla compartida"),
        alTextoInterino: () => {},
        alFaltarPermiso: () => {},
      });
      vozPantalla.arrancar();
      pistaAudio.addEventListener("ended", () => {
        if (vozPantalla) { vozPantalla.parar(); vozPantalla = null; }
      });
    }

    pidiendoPantalla = false;
    mostrarOverlay(det, { grabandoAca: true });
  }

  // --- Overlay en vivo -----------------------------------------------------------
  // Transcripción de la sala companion con la foto de cada quien, como los
  // subtítulos de la web. Se sondea /session (el mismo endpoint que usa el
  // panel de Meet): simple, sin CORS nuevos, y 2,5 s de retraso es invisible
  // para leer una conversación.
  function mostrarOverlay(det, { grabandoAca }) {
    // Un solo sondeo vivo a la vez, y ningún gesto armado de una pantalla
    // anterior (si carril A arrancó por atajo, un clic armado sumaría una
    // SEGUNDA grabación de lo mismo). Quien necesite armar, arma DESPUÉS.
    if (overlayTimer) { clearInterval(overlayTimer); overlayTimer = null; }
    if (toastTimer) { clearInterval(toastTimer); toastTimer = null; }
    if (desarmar) desarmar();
    const root = raiz();
    const caja = document.createElement("div");
    caja.className = "caja";
    caja.setAttribute("role", "dialog");
    caja.setAttribute("aria-label", "Subtítulos y grabación de Unify");

    const rec = document.createElement("div");
    rec.className = "rec";
    const punto = document.createElement("span");
    punto.className = "punto";
    if (!grabandoAca) punto.style.background = "#10b981"; // verde: subtítulos sin grabar
    rec.append(
      punto,
      document.createTextNode(grabandoAca ? " Grabando y transcribiendo con Unify" : " Subtítulos de Unify activos")
    );

    // Idioma de la traducción de los subtítulos. La misma clave de storage que
    // usa el panel de Meet (`lang`), así se elige una vez para toda la
    // extensión. Vacío = sin traducir.
    const idioma = document.createElement("select");
    idioma.className = "sel";
    for (const [valor, etiqueta] of [
      ["", "Sin traducir"], ["es", "Español"], ["en", "English"], ["pt", "Português"],
      ["fr", "Français"], ["de", "Deutsch"], ["it", "Italiano"], ["zh", "中文"], ["ja", "日本語"],
    ]) {
      const op = document.createElement("option");
      op.value = valor;
      op.textContent = etiqueta;
      idioma.appendChild(op);
    }
    idioma.value = cfg.lang || "";
    idioma.title = "Traducirme los subtítulos a este idioma";
    idioma.setAttribute("aria-label", "Traducirme a");
    idioma.addEventListener("change", () => {
      cfg.lang = idioma.value;
      traducciones.clear(); // re-traducir lo visible al idioma nuevo
      seguro(() => chrome.storage.local.set({ lang: cfg.lang }));
    });

    // Idioma QUE SE HABLA en la reunión (el del reconocimiento de voz). Sin
    // esto, la extensión suponía el idioma de tu Chrome: si tus compañeros
    // hablan inglés y tu navegador está en español, la transcripción salía
    // mal. Vacío = el idioma del navegador (el comportamiento de siempre).
    const idiomaVozSel = document.createElement("select");
    idiomaVozSel.className = "sel";
    idiomaVozSel.title = "Idioma en el que se habla en la reunión";
    idiomaVozSel.setAttribute("aria-label", "Idioma que se habla en la reunión");
    for (const [valor, etiqueta] of [
      ["", "Se habla: el idioma de tu Chrome"], ["es-AR", "Se habla: Español"],
      ["en-US", "Se habla: English"], ["pt-BR", "Se habla: Português"],
      ["fr-FR", "Se habla: Français"], ["de-DE", "Se habla: Deutsch"],
      ["it-IT", "Se habla: Italiano"], ["zh-CN", "Se habla: 中文"], ["ja-JP", "Se habla: 日本語"],
    ]) {
      const op = document.createElement("option");
      op.value = valor;
      op.textContent = etiqueta;
      idiomaVozSel.appendChild(op);
    }
    idiomaVozSel.value = cfg.langVoz || "";
    idiomaVozSel.addEventListener("change", () => {
      cfg.langVoz = idiomaVozSel.value;
      seguro(() => chrome.storage.local.set({ langVoz: cfg.langVoz }));
      reiniciarVozHook?.(); // aplica al instante, sin recargar la reunión
    });

    const subs = document.createElement("div");
    subs.className = "subs";
    // Los subtítulos nuevos se anuncian a los lectores de pantalla sin
    // interrumpir (polite): accesible también para quien no ve la caja.
    subs.setAttribute("aria-live", "polite");
    subs.innerHTML = `<div class="vacio">Esperando que alguien hable…</div>`;

    const fila = document.createElement("div");
    fila.className = "fila";
    const abrir = document.createElement("button");
    abrir.className = "si";
    abrir.textContent = "Abrir Unify al lado";
    const parar = document.createElement("button");
    parar.className = "no";
    parar.textContent = grabandoAca ? "Detener" : "Cerrar";
    fila.append(abrir, parar);

    // --- Subtítulos FLOTANTES (Picture-in-Picture de documento) --------------
    // La ventanita que queda SIEMPRE encima -- de la reunión, de la pantalla
    // compartida, de cualquier app -- con las últimas frases y su traducción.
    // Chrome 116+ de escritorio; donde el API no existe, el botón no aparece.
    const flot = document.createElement("button");
    flot.className = "no";
    flot.textContent = "Subtítulos flotantes";
    if (!("documentPictureInPicture" in window)) flot.style.display = "none";
    const pintarPip = (lineas) => {
      if (!pipWin) return;
      try {
        const cont = pipWin.document.getElementById("subs");
        if (!cont) return;
        cont.textContent = "";
        for (const linea of (lineas ?? []).slice(-3)) {
          const filaPip = pipWin.document.createElement("div");
          filaPip.style.cssText = "font-size:15px;line-height:1.35";
          const quien = pipWin.document.createElement("span");
          quien.textContent = `${linea.speakerName ?? "Alguien"}: `;
          quien.style.cssText = "color:#2563EB;font-weight:700";
          const texto = pipWin.document.createElement("span");
          const trad = traducciones.get(linea.id);
          texto.textContent = trad && trad !== linea.text ? trad : (linea.text ?? "");
          filaPip.append(quien, texto);
          cont.appendChild(filaPip);
        }
      } catch { /* la ventanita se cerró en el medio: el próximo pintar la ignora */ }
    };
    flot.addEventListener("click", async () => {
      if (pipWin) {
        try { pipWin.close(); } catch { /* ya cerrada */ }
        pipWin = null;
        flot.textContent = "Subtítulos flotantes";
        return;
      }
      try {
        const win = await window.documentPictureInPicture.requestWindow({ width: 440, height: 190 });
        win.document.body.style.cssText =
          "margin:0;background:linear-gradient(170deg,#ffffff,#f6f9ff);color:#101c40;font-family:system-ui,sans-serif;overflow:hidden";
        const cont = win.document.createElement("div");
        cont.id = "subs";
        cont.style.cssText =
          "display:flex;flex-direction:column;justify-content:flex-end;gap:6px;height:100vh;padding:10px 14px;box-sizing:border-box";
        win.document.body.appendChild(cont);
        win.addEventListener("pagehide", () => {
          pipWin = null;
          try { flot.textContent = "Subtítulos flotantes"; } catch { /* overlay ya no está */ }
        });
        pipWin = win;
        flot.textContent = "Flotantes ✓";
        pintarPip(ultimasLineas);
      } catch {
        // Bloqueado (política de la página, Chrome viejo): decirlo, no callar.
        flot.textContent = "No se pudo abrir";
        setTimeout(() => { if (!pipWin) flot.textContent = "Subtítulos flotantes"; }, 2500);
      }
    });
    fila.append(flot);
    // Las últimas líneas pintadas, para espejarlas al abrir la ventanita.
    let ultimasLineas = [];
    // Sin grabación local: ofrecer arrancarla acá (este clic es un gesto
    // válido para getDisplayMedia).
    if (!grabandoAca) {
      const grabar = document.createElement("button");
      grabar.className = "si";
      grabar.textContent = "Grabar";
      grabar.addEventListener("click", () => void iniciarCarrilB(det, caja));
      fila.prepend(grabar);
    }

    // La IA de la reunión, acá mismo: la misma que responde en la web, contra
    // la sala companion (con la transcripción como contexto). Pide sesión de
    // Unify porque cada pregunta cuesta plata -- misma regla que el panel de
    // Meet -- pero se DICE en vez de fallar mudo.
    const iaFila = document.createElement("div");
    iaFila.className = "iafila";
    const iaIn = document.createElement("input");
    iaIn.className = "iain";
    iaIn.type = "text";
    iaIn.placeholder = "Preguntale a la IA sobre la reunión…";
    const iaBtn = document.createElement("button");
    iaBtn.className = "iabtn";
    iaBtn.textContent = "IA";
    iaFila.append(iaIn, iaBtn);
    const iaResp = document.createElement("div");
    iaResp.className = "iaresp";
    iaResp.hidden = true;

    const preguntar = async () => {
      const question = iaIn.value.trim();
      if (!question || iaBtn.disabled) return;
      iaResp.hidden = false;
      if (!cfg.token) {
        iaResp.textContent =
          'Iniciá sesión en Unify para usar la IA: tocá "Abrir Unify al lado" y entrá con tu cuenta.';
        return;
      }
      iaBtn.disabled = true;
      iaResp.textContent = "Pensando…";
      try {
        const res = await fetch(
          `${cfg.serverBase}/api/meet-bridge/${encodeURIComponent(det.roomKey)}/ask`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
            body: JSON.stringify({ question }),
          }
        );
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) {
          iaResp.textContent = 'Tu sesión de Unify venció: entrá de nuevo desde "Abrir Unify al lado".';
        } else if (!res.ok) {
          iaResp.textContent = data?.error || "La IA no pudo responder. Probá de nuevo en un rato.";
        } else {
          iaResp.textContent = data.answer || "La IA no devolvió respuesta.";
          iaIn.value = "";
        }
      } catch {
        iaResp.textContent = "Sin conexión con el servidor de Unify. Revisá tu red y probá de nuevo.";
      } finally {
        iaBtn.disabled = false;
      }
    };
    iaBtn.addEventListener("click", () => void preguntar());
    iaIn.addEventListener("keydown", (e) => {
      // Que escribirle a la IA no dispare los atajos de teclado de Zoom/Teams.
      e.stopPropagation();
      if (e.key === "Enter") void preguntar();
    });

    const pie = document.createElement("div");
    pie.className = "pie";
    pie.textContent =
      "Unify transcribe TU voz con el micrófono. Para transcribir a TODOS, que cada quien abra Unify de su lado (o usá la extensión dentro de Google Meet).";

    caja.append(rec, idioma, idiomaVozSel, subs, iaFila, iaResp, fila, pie);
    root.appendChild(caja);

    abrir.addEventListener("click", () => {
      window.open(
        // auto=1: derecho al companion, sin formulario (como en Meet).
        `${cfg.appBase.replace(/\/+$/, "")}/externa?url=${encodeURIComponent(location.href)}&auto=1`,
        "_blank"
      );
    });
    parar.addEventListener("click", () => {
      if (recorder && recorder.state !== "inactive") {
        // Detener NO borra la UI: la subida recién empieza, y si falla hay
        // que poder DECIRLO acá mismo. (Bug real que encontró sim_toast.js:
        // el aviso de error llegaba a un overlay que ya no existía, y la
        // persona perdía la grabación sin enterarse.)
        recorder.stop();
        rec.replaceChildren(document.createTextNode("Guardando la grabación…"));
        parar.textContent = "Cerrar";
        return;
      }
      seguro(() => chrome.runtime.sendMessage({ kind: "unify-record-stop" }).catch(() => {}));
      quitarUI();
    });

    // El sondeo arranca RECIÉN acá, con la reunión aceptada: pedir /session ya
    // crea la sala companion en el servidor, y eso no debe pasar por el solo
    // hecho de mostrar el toast.
    // Traducción de una línea, con caché y de a una: los subtítulos de los
    // idiomas que ya maneja la web (chino, inglés, alemán, francés, portugués
    // y demás) salen del MISMO endpoint /api/translate del servidor.
    const traducir = async (linea) => {
      if (!cfg.lang || traducciones.has(linea.id)) return;
      // El idioma de origen viene en la línea: si ya es el tuyo, ni se pide
      // (ahorra red y rate limit; el render igual oculta las idénticas).
      const origen = (linea.sourceLang || "").split("-")[0].toLowerCase();
      if (origen && origen === cfg.lang) return;
      // Si el servidor ya la calculó (viene pegada a la línea), ni se pide.
      const hecha = linea.translations?.[cfg.lang];
      if (hecha) { traducciones.set(linea.id, hecha); return; }
      // Techo de memoria para reuniones de horas: pasado el tope se vacía y
      // se re-traduce sólo lo visible (4 líneas), que es barato.
      if (traducciones.size > 400) traducciones.clear();
      traducciones.set(linea.id, ""); // reserva: no pedir dos veces
      try {
        const res = await fetch(`${cfg.serverBase}/api/translate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: linea.text, source: linea.sourceLang || "auto", target: cfg.lang }),
        });
        if (!res.ok) { traducciones.delete(linea.id); return; }
        const data = await res.json();
        if (typeof data.translatedText === "string") traducciones.set(linea.id, data.translatedText);
      } catch {
        traducciones.delete(linea.id); // red caída: se reintenta al próximo tick
      }
    };

    const pintar = (transcript, participantes) => {
      const ultimas = (transcript ?? []).slice(-4);
      if (ultimas.length === 0) return;
      const fotos = new Map((participantes ?? []).map((p) => [p.name, p.avatarUrl ?? null]));
      for (const linea of ultimas) void traducir(linea);
      subs.textContent = "";
      for (const linea of ultimas) {
        const row = document.createElement("div");
        row.className = "linea";
        const url = fotos.get(linea.speakerName) ?? null;
        let foto;
        if (url) {
          foto = document.createElement("img");
          foto.className = "foto";
          foto.src = url;
          foto.alt = "";
        } else {
          foto = document.createElement("div");
          foto.className = "foto";
          foto.style.background = colorDe(linea.speakerName ?? "?");
          foto.textContent = (linea.speakerName ?? "?").trim().charAt(0).toUpperCase() || "?";
        }
        const cuerpo = document.createElement("div");
        const quien = document.createElement("div");
        quien.className = "quien";
        quien.textContent = linea.speakerName ?? "Participante";
        const dijo = document.createElement("div");
        dijo.className = "dijo";
        dijo.textContent = linea.text ?? "";
        cuerpo.append(quien, dijo);
        const trad = traducciones.get(linea.id);
        // Si la traducción es idéntica al original (ya hablaban en tu idioma),
        // repetir la línea abajo sólo ensucia: no se muestra.
        if (trad && trad !== linea.text) {
          const t = document.createElement("div");
          t.className = "trad";
          t.textContent = trad;
          cuerpo.appendChild(t);
        }
        row.append(foto, cuerpo);
        subs.appendChild(row);
      }
      // Espejo hacia la ventanita flotante (si está abierta), con lo mismo.
      ultimasLineas = ultimas;
      pintarPip(ultimas);
      // La línea interina (lo que estás diciendo AHORA) va siempre última.
      if (textoInterino) pintarInterina();
      subs.scrollTop = subs.scrollHeight;
    };

    const sondear = async () => {
      try {
        const res = await fetch(
          `${cfg.serverBase}/api/meet-bridge/${encodeURIComponent(det.roomKey)}/session`,
          // Con tu sesión: es lo que hace que ESTA reunión (video y
          // transcripción) quede en TU historial y no en el limbo.
          { headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {} }
        );
        if (!res.ok) return;
        const s = await res.json();
        pintar(s.transcript, s.participants);
      } catch { /* red caída: el próximo tick reintenta */ }
    };
    // Tu voz: arranca junto con el overlay. Lo interino se pinta al instante
    // (sin esperar al sondeo) y lo final viaja al bridge.
    let textoInterino = "";
    const pintarInterina = () => {
      if (textoInterino) subs.querySelector(".vacio")?.remove();
      let el = subs.querySelector(".interina");
      if (!textoInterino) { el?.remove(); return; }
      if (!el) {
        el = document.createElement("div");
        el.className = "interina";
        subs.appendChild(el);
      }
      el.textContent = `Vos: ${textoInterino}`;
      subs.scrollTop = subs.scrollHeight;
    };
    // EL IDIOMA SE CORRIGE SOLO. Dos frases seguidas que el servidor detecta
    // en OTRO idioma que el del oído -> se cambia el oído, se refleja en el
    // selector, se avisa en los subtítulos y se guarda para la próxima. Es la
    // causa número uno de "me escucha dos palabras con suerte": el default es
    // el idioma de Chrome, y un Chrome en inglés escucha castellano en inglés.
    let rachaIdioma = { codigo: null, veces: 0 };
    const aplicarIdiomaDetectado = (corto) => {
      const completo = CODIGO_VOZ[corto] || corto;
      cfg.langVoz = completo;
      seguro(() => chrome.storage.local.set({ langVoz: completo }));
      if ([...idiomaVozSel.options].some((o) => o.value === completo)) idiomaVozSel.value = completo;
      rachaIdioma = { codigo: null, veces: 0 };
      const nota = document.createElement("div");
      nota.className = "ok";
      nota.textContent = `Detecté que se habla en ${NOMBRES_IDIOMA[corto] || corto}: ya te escucho en ese idioma.`;
      subs.appendChild(nota);
      subs.scrollTop = subs.scrollHeight;
      arrancarVozPropia(); // re-arranca el reconocimiento con el oído correcto
    };
    const anotarIdiomaDetectado = (corto, idiomaActual) => {
      if (!corto || corto === (idiomaActual || "").split("-")[0]) {
        rachaIdioma = { codigo: null, veces: 0 };
        return;
      }
      rachaIdioma = rachaIdioma.codigo === corto
        ? { codigo: corto, veces: rachaIdioma.veces + 1 }
        : { codigo: corto, veces: 1 };
      if (rachaIdioma.veces >= 2) aplicarIdiomaDetectado(corto);
    };

    // Función (y no inline) para poder RE-arrancar con otro idioma cuando la
    // persona lo cambia en el selector "Se habla: …" del overlay.
    const arrancarVozPropia = () => {
    const idiomaVoz = cfg.langVoz || navigator.language || "es-AR";
    if (vozPropia) vozPropia.parar();
    vozPropia = crearVozPropia({
      lang: idiomaVoz,
      alTextoFinal: (texto, alts) => {
        textoInterino = "";
        pintarInterina();
        void publicarVozPropia(det, texto, idiomaVoz, alts).then((detectado) => {
          anotarIdiomaDetectado(detectado, idiomaVoz);
          sondear();
        });
      },
      alTextoInterino: (texto) => {
        textoInterino = texto;
        pintarInterina();
      },
      alFaltarPermiso: () => {
        // En el lugar de los subtítulos, no como alarma aparte: sin micrófono
        // el overlay sigue sirviendo (los demás llegan por el bridge).
        const vacio = subs.querySelector(".vacio");
        if (vacio) {
          vacio.textContent =
            "Sin permiso de micrófono no puedo transcribir tu voz; los subtítulos de los demás llegan igual.";
        }
      },
    });
    vozPropia.arrancar();
    };
    arrancarVozPropia();
    reiniciarVozHook = arrancarVozPropia;

    void sondear();
    overlayTimer = setInterval(sondear, 2500);
  }

  function notaEnOverlay(texto, clase) {
    const caja = rootRef?.querySelector?.(".caja");
    if (!caja) return;
    const nota = document.createElement("div");
    nota.className = clase;
    nota.textContent = texto;
    caja.appendChild(nota);
  }

  // --- Carril A: el background avisa cuando el atajo/ícono arranca o corta ----
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.kind === "unify-record-state" && actual) {
      if (msg.recording) mostrarOverlay(actual, { grabandoAca: false });
      else if (!recorder) quitarUI();
    }
    if (msg?.kind === "unify-record-error" && actual) {
      if (host) notaEnOverlay(msg.message, "aviso");
      else {
        mostrarToast(actual);
        notaEnOverlay(msg.message, "aviso");
      }
    }
  });

  // --- Arranque: config + vigilar la URL (Zoom y Teams son SPAs) --------------
  // La traducción arranca sola en el idioma del navegador. La distinción que
  // importa: `lang` AUSENTE del storage es "nunca eligió" (traducir al idioma
  // de su Chrome); `lang: ""` es "eligió Sin traducir" (respetarlo).
  const IDIOMAS = ["es", "en", "pt", "fr", "de", "it", "zh", "ja"];
  function idiomaDelNavegador() {
    const dos = String(navigator.language || "").slice(0, 2).toLowerCase();
    return IDIOMAS.includes(dos) ? dos : "";
  }
  seguro(() =>
    chrome.storage?.local?.get(["serverBase", "appBase", "token", "lang", "langVoz"], (v) => {
      if (v?.serverBase?.startsWith?.("http")) cfg.serverBase = v.serverBase.replace(/\/+$/, "");
      if (v?.appBase?.startsWith?.("http")) cfg.appBase = v.appBase.replace(/\/+$/, "");
      cfg.token = v?.token ?? null;
      cfg.lang = typeof v?.lang === "string" ? v.lang : idiomaDelNavegador();
      cfg.langVoz = typeof v?.langVoz === "string" ? v.langVoz : "";
    })
  );
  // La config puede cambiar con el overlay ya abierto (la persona inicia
  // sesión en Unify en otra pestaña y auth-sync guarda el token): tomarla en
  // vivo, sin exigir recargar la reunión.
  seguro(() =>
  chrome.storage?.onChanged?.addListener((c, area) => {
    if (area !== "local") return;
    if (c.token) cfg.token = c.token.newValue ?? null;
    if (c.lang) { cfg.lang = c.lang.newValue ?? ""; traducciones.clear(); }
    if (c.langVoz) { cfg.langVoz = c.langVoz.newValue ?? ""; reiniciarVozHook?.(); }
    if (c.serverBase?.newValue?.startsWith?.("http")) cfg.serverBase = c.serverBase.newValue.replace(/\/+$/, "");
    if (c.appBase?.newValue?.startsWith?.("http")) cfg.appBase = c.appBase.newValue.replace(/\/+$/, "");
  })
  );

  let ultimaUrl = "";
  function tick() {
    if (location.href === ultimaUrl) return;
    ultimaUrl = location.href;
    const det = detectar();
    if (!det) {
      // Se fue de la reunión ANTES de contestar el toast: la cuenta regresiva
      // no puede seguir corriendo en una página que ya no es la reunión. El
      // overlay (subtítulos/grabación) sí se queda: las SPAs de Zoom y Teams
      // pasan por URLs intermedias en plena llamada y tirarlo sería un corte.
      if (toastTimer) quitarUI();
      return;
    }
    if (det.roomKey === actual?.roomKey) return;
    actual = det;
    // Registrar la sala en el background: si la persona aprieta Ctrl+Shift+U
    // (carril A), ya sabe qué capturar sin volver a preguntar nada.
    seguro(() =>
      chrome.runtime
        .sendMessage({ kind: "unify-external-info", ...det, url: location.href })
        .catch(() => {})
    );
    let silenciada = false;
    try { silenciada = Boolean(sessionStorage.getItem(`unify-no:${det.roomKey}`)); } catch { /* sin storage */ }
    if (silenciada || recorder) return;
    if (yaDijoQueSi(det.roomKey)) {
      // Ya aceptaste en esta reunión: se sigue de largo con los subtítulos.
      // La grabación necesita un gesto nuevo (la pestaña se recargó y con
      // ella murió el permiso de pantalla), así que queda armada.
      mostrarOverlay(det, { grabandoAca: false });
      armarGrabacionAlProximoGesto(det);
      return;
    }
    mostrarToast(det);
  }
  tick();
  const vigilante = setInterval(() => {
    // Con la extensión actualizada (o recargada), este script es un fantasma:
    // no puede hablar con el background ni subir nada. Se apaga con prolijidad
    // en vez de seguir latiendo para siempre. La pestaña recién cargada -- o
    // esta misma al recargarla -- ya trae la versión nueva funcionando.
    if (!extensionViva()) {
      clearInterval(vigilante);
      if (recorder && recorder.state !== "inactive") {
        // Había una grabación en curso: se cierra para que lo capturado hasta
        // acá se guarde por el camino de siempre (el background sube lo que
        // ya recibió), en lugar de perderse entero.
        try { recorder.stop(); } catch { /* ya estaba muerto */ }
      }
      notaEnOverlay("Unify se actualizó. Recargá esta pestaña para seguir con la versión nueva.", "aviso");
      return;
    }
    tick();
  }, 1500);
})();
