// Detecta que la persona está entrando a una reunión externa (Zoom, Teams,
// Jitsi, Webex) y le ofrece grabarla y transcribirla con Unify, ahí mismo.
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
  const cfg = { serverBase: DEFAULT_SERVER, appBase: DEFAULT_APP, token: null, lang: "" };
  // Traducciones por id de línea, para no volver a pedir la misma dos veces.
  // Se vacía al cambiar el idioma.
  const traducciones = new Map();

  function safeDecode(value) {
    try { return decodeURIComponent(value); } catch { return value; }
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

  // --- Derivación de clave de sala (espejo de meetingPlatforms.ts) ----------
  function detectar() {
    let url;
    try { url = new URL(location.href); } catch { return null; }
    const host = url.hostname.toLowerCase();

    // Zoom: el número vive tras /j/, /w/ o /wc/; puede venir con separadores.
    if (host === "zoom.us" || host.endsWith(".zoom.us")) {
      const id = url.pathname
        .replace(/(\d)[\s-](?=\d)/g, "$1")
        .match(/\/(?:j|w|wc)\/(\d{9,11})/)?.[1];
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

    // Webex: clave = host + path, igual que la tabla SIMPLE_PLATFORMS.
    if (host.endsWith(".webex.com") || host === "webex.com") {
      const path = url.pathname.replace(/\/+$/, "").toLowerCase();
      if (!/^\/(meet|join|wbxmjs|webappng)\//.test(path)) return null;
      return { plataforma: "webex", nombre: "Webex", roomKey: `webex:${host}${path}` };
    }

    return null;
  }

  // --- Estado ----------------------------------------------------------------
  let actual = null;       // { plataforma, nombre, roomKey } detectada acá
  let recorder = null;     // MediaRecorder del carril B (si está grabando acá)
  let port = null;         // canal con el background para los chunks
  let overlayTimer = null; // sondeo de la transcripción en vivo
  let host = null;         // nodo raíz de nuestra UI
  let rootRef = null;      // la shadow root de la UI activa

  // --- Estilos: hoja construida, no <style> inyectado -------------------------
  // Una hoja creada desde el mundo aislado no depende del CSP de la página,
  // así que esto se ve igual en Zoom, Teams o Jitsi.
  const css = new CSSStyleSheet();
  css.replaceSync(`
    :host { all: initial; }
    .caja { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      width: 330px; max-width: calc(100vw - 32px); box-sizing: border-box;
      background: #0f172a; color: #f5f6fb; border: 1px solid #334155;
      border-radius: 14px; padding: 14px 16px;
      font: 14px/1.45 system-ui, -apple-system, sans-serif;
      box-shadow: 0 8px 30px rgba(0,0,0,.45); }
    .fila { display: flex; gap: 8px; margin-top: 10px; }
    button { border: 0; border-radius: 9px; padding: 8px 14px; font: inherit;
      font-weight: 600; cursor: pointer; }
    .si { background: #6366f1; color: #fff; }
    .si:hover { background: #4f46e5; }
    .no { background: transparent; color: #94a3b8; }
    .no:hover { color: #e2e8f0; }
    .pie { margin-top: 8px; font-size: 11.5px; color: #64748b; }
    .rec { display: flex; align-items: center; gap: 8px; font-weight: 600; }
    .punto { width: 9px; height: 9px; border-radius: 50%; background: #dc2626;
      animation: latir 1.2s infinite; flex: none; }
    @keyframes latir { 50% { opacity: .35; } }
    .subs { margin-top: 10px; display: grid; gap: 7px; max-height: 220px;
      overflow-y: auto; }
    .linea { display: flex; gap: 8px; align-items: flex-start; }
    .foto { width: 22px; height: 22px; border-radius: 50%; flex: none;
      object-fit: cover; background: #334155; color: #fff; font-size: 11px;
      font-weight: 700; display: flex; align-items: center; justify-content: center; }
    .quien { font-size: 11.5px; color: #94a3b8; }
    .dijo { font-size: 13px; color: #e2e8f0; overflow-wrap: anywhere; }
    .vacio { font-size: 12.5px; color: #64748b; }
    .sel { margin-top: 8px; width: 100%; background: #1e293b; color: #e2e8f0;
      border: 1px solid #334155; border-radius: 8px; padding: 5px 8px;
      font: 12px system-ui, sans-serif; }
    .trad { font-size: 12.5px; color: #a5b4fc; margin-top: 1px; }
    .aviso { margin-top: 8px; font-size: 12px; color: #fca5a5; }
    .ok { margin-top: 8px; font-size: 12px; color: #6ee7b7; }
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

  function quitarUI() {
    if (overlayTimer) { clearInterval(overlayTimer); overlayTimer = null; }
    if (host) { host.remove(); host = null; }
    rootRef = null;
  }

  // Color determinístico por nombre para la inicial (mismo espíritu que
  // lib/avatar.ts: la misma persona siempre con el mismo color).
  const PALETA = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6"];
  function colorDe(nombre) {
    let h = 0;
    for (let i = 0; i < nombre.length; i++) h = (h * 31 + nombre.charCodeAt(i)) >>> 0;
    return PALETA[h % PALETA.length];
  }

  // --- Toast inicial -----------------------------------------------------------
  function mostrarToast(det) {
    const root = raiz();
    const caja = document.createElement("div");
    caja.className = "caja";

    const texto = document.createElement("div");
    texto.textContent = `Veo que te estás uniendo a una reunión de ${det.nombre}. ¿Querés los subtítulos y grabar la reunión?`;

    const fila = document.createElement("div");
    fila.className = "fila";
    const si = document.createElement("button");
    si.className = "si";
    si.textContent = "Sí, dale";
    const no = document.createElement("button");
    no.className = "no";
    no.textContent = "Ahora no";
    fila.append(si, no);

    // Si no contestás, a los 5 segundos es un SÍ solo: los subtítulos y la
    // transcripción arrancan sin permiso del navegador. La GRABACIÓN no puede
    // arrancar por timer -- Chrome sólo entrega la pantalla con un gesto tuyo
    // -- así que queda "armada": tu próximo clic en la página (el de "Unirse",
    // sin ir más lejos) dispara el pedido con la pestaña ya elegida.
    const cuenta = document.createElement("div");
    cuenta.className = "pie";
    let restante = 5;
    cuenta.textContent = `Si no respondés, en ${restante} arranco solo con los subtítulos.`;

    const pie = document.createElement("div");
    pie.className = "pie";
    pie.textContent = "Consejo: con Ctrl+Shift+U (⌘⇧U en Mac) grabás directo, sin el selector de pestaña.";

    caja.append(texto, fila, cuenta, pie);
    root.appendChild(caja);

    const timer = setInterval(() => {
      restante -= 1;
      if (restante > 0) {
        cuenta.textContent = `Si no respondés, en ${restante} arranco solo con los subtítulos.`;
        return;
      }
      clearInterval(timer);
      // Auto-SÍ: subtítulos ya, grabación armada al próximo gesto.
      mostrarOverlay(det, { grabandoAca: false });
      armarGrabacionAlProximoGesto(det);
    }, 1000);

    no.addEventListener("click", () => {
      clearInterval(timer);
      // Sólo esta reunión, en esta pestaña. No es un "nunca más".
      try { sessionStorage.setItem(`unify-no:${det.roomKey}`, "1"); } catch { /* sin storage */ }
      quitarUI();
    });

    // CARRIL B: este clic ES la activación que getDisplayMedia necesita.
    si.addEventListener("click", () => {
      clearInterval(timer);
      void iniciarCarrilB(det, caja);
    });
  }

  // El auto-SÍ no puede pedir la pantalla (un timer no es un gesto): deja el
  // pedido listo para el PRÓXIMO clic real en la página. Si la persona cancela
  // el selector, no se insiste: queda el botón Grabar del overlay.
  let desarmar = null;
  function armarGrabacionAlProximoGesto(det) {
    if (desarmar) desarmar();
    const handler = () => {
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

  async function iniciarCarrilB(det, caja) {
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
      // Canceló el selector: no es un error y no se insiste. El toast queda.
      return;
    }

    try {
      port = chrome.runtime.connect({ name: "unify-ext-rec" });
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
      caja?.appendChild(Object.assign(document.createElement("div"), {
        className: "aviso",
        textContent: "La extensión se recargó: recargá la página y probá de nuevo.",
      }));
      return;
    }

    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? "video/webm;codecs=vp9,opus"
      : "video/webm";
    recorder = new MediaRecorder(stream, {
      mimeType: mime,
      // Misma calidad que el grabador del documento offscreen (carril A).
      videoBitsPerSecond: 5_000_000,
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
    // Si la persona corta desde la barra nativa de "dejar de compartir".
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    });
    recorder.start(3000);
    mostrarOverlay(det, { grabandoAca: true });
  }

  // --- Overlay en vivo -----------------------------------------------------------
  // Transcripción de la sala companion con la foto de cada quien, como los
  // subtítulos de la web. Se sondea /session (el mismo endpoint que usa el
  // panel de Meet): simple, sin CORS nuevos, y 2,5 s de retraso es invisible
  // para leer una conversación.
  function mostrarOverlay(det, { grabandoAca }) {
    const root = raiz();
    const caja = document.createElement("div");
    caja.className = "caja";

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
      ["fr", "Français"], ["de", "Deutsch"], ["it", "Italiano"], ["zh", "中文"],
    ]) {
      const op = document.createElement("option");
      op.value = valor;
      op.textContent = etiqueta;
      idioma.appendChild(op);
    }
    idioma.value = cfg.lang || "";
    idioma.addEventListener("change", () => {
      cfg.lang = idioma.value;
      traducciones.clear(); // re-traducir lo visible al idioma nuevo
      try { chrome.storage.local.set({ lang: cfg.lang }); } catch { /* sin permiso */ }
    });

    const subs = document.createElement("div");
    subs.className = "subs";
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
    // Sin grabación local: ofrecer arrancarla acá (este clic es un gesto
    // válido para getDisplayMedia).
    if (!grabandoAca) {
      const grabar = document.createElement("button");
      grabar.className = "si";
      grabar.textContent = "Grabar";
      grabar.addEventListener("click", () => void iniciarCarrilB(det, caja));
      fila.prepend(grabar);
    }

    const pie = document.createElement("div");
    pie.className = "pie";
    pie.textContent =
      "Acordate: una pestaña sólo escucha tu micrófono. Para transcribir a TODOS, que cada quien abra Unify al lado, o usá la extensión dentro de Google Meet.";

    caja.append(rec, idioma, subs, fila, pie);
    root.appendChild(caja);

    abrir.addEventListener("click", () => {
      window.open(
        `${cfg.appBase.replace(/\/+$/, "")}/externa?url=${encodeURIComponent(location.href)}`,
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
      chrome.runtime.sendMessage({ kind: "unify-record-stop" }).catch(() => {});
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
      traducciones.set(linea.id, ""); // reserva: no pedir dos veces
      try {
        const res = await fetch(`${cfg.serverBase}/api/translate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: linea.text, source: "auto", target: cfg.lang }),
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
        if (trad) {
          const t = document.createElement("div");
          t.className = "trad";
          t.textContent = trad;
          cuerpo.appendChild(t);
        }
        row.append(foto, cuerpo);
        subs.appendChild(row);
      }
      subs.scrollTop = subs.scrollHeight;
    };

    const sondear = async () => {
      try {
        const res = await fetch(
          `${cfg.serverBase}/api/meet-bridge/${encodeURIComponent(det.roomKey)}/session`
        );
        if (!res.ok) return;
        const s = await res.json();
        pintar(s.transcript, s.participants);
      } catch { /* red caída: el próximo tick reintenta */ }
    };
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
  const claves = { serverBase: DEFAULT_SERVER, appBase: DEFAULT_APP, token: null, lang: "" };
  chrome.storage?.local?.get(claves, (v) => {
    if (v?.serverBase?.startsWith?.("http")) cfg.serverBase = v.serverBase.replace(/\/+$/, "");
    if (v?.appBase?.startsWith?.("http")) cfg.appBase = v.appBase.replace(/\/+$/, "");
    cfg.token = v?.token ?? null;
    cfg.lang = typeof v?.lang === "string" ? v.lang : "";
  });

  let ultimaUrl = "";
  function tick() {
    if (location.href === ultimaUrl) return;
    ultimaUrl = location.href;
    const det = detectar();
    if (!det || det.roomKey === actual?.roomKey) return;
    actual = det;
    // Registrar la sala en el background: si la persona aprieta Ctrl+Shift+U
    // (carril A), ya sabe qué capturar sin volver a preguntar nada.
    chrome.runtime
      .sendMessage({ kind: "unify-external-info", ...det, url: location.href })
      .catch(() => {});
    let silenciada = false;
    try { silenciada = Boolean(sessionStorage.getItem(`unify-no:${det.roomKey}`)); } catch { /* sin storage */ }
    if (!silenciada && !recorder) mostrarToast(det);
  }
  tick();
  setInterval(tick, 1500);
})();
