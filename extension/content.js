// Unify para Google Meet -- content script.
//
// Esta extensión vive DENTRO de meet.google.com. No abre pestañas, no divide la
// pantalla: inyecta un panel flotante con la transcripción de TODOS, los
// subtítulos traducidos y el asistente de IA, más la grabación de la reunión
// completa.
//
// Las dos decisiones que hacen que esto funcione de verdad:
//
//  1. TRANSCRIBIR A TODOS. Un navegador solo puede escuchar TU micrófono
//     (reconocimiento de voz local), por eso cualquier herramienta que grabe
//     "desde afuera" captura una sola voz. Google Meet, en cambio, YA transcribe
//     a todos con sus propios subtítulos y les pone el nombre de quien habla.
//     Leemos ESOS subtítulos: es la única forma de tener a toda la reunión.
//
//  2. GRABAR A TODOS. La grabación no usa "compartir pantalla" (que depende de
//     que el usuario elija bien la pestaña y tilde el audio): usa la captura de
//     pestaña de la extensión, que toma el audio y el video de Meet tal como
//     suenan y se ven, con todos los participantes.
//
// Todo lo que se lee del DOM de Meet es best-effort por naturaleza: Google
// cambia su interfaz sin avisar, así que cada lectura degrada a "no disponible"
// en vez de romper el panel.

(() => {
  if (window.__unifyMeetLoaded) return;
  window.__unifyMeetLoaded = true;

  const DEFAULT_SERVER = "https://taller-0.onrender.com";
  const DEFAULT_APP = "https://www.unify-meet.com";
  const MEET_CODE_RE = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/;

  const cfg = { serverBase: DEFAULT_SERVER, appBase: DEFAULT_APP, token: null, targetLang: "" };
  const log = (...a) => console.debug("[unify]", ...a);

  // Se invoca al final del archivo, cuando `ui` ya existe: el navegador puede
  // resolver el almacenamiento en el acto, y leerlo antes de definir el panel
  // dejaría la extensión sin arrancar.
  function loadConfig() {
    chrome.storage.local.get(
      { serverBase: DEFAULT_SERVER, appBase: DEFAULT_APP, token: null, targetLang: "" },
      (v) => {
        if (v?.serverBase?.startsWith?.("http")) cfg.serverBase = v.serverBase.replace(/\/+$/, "");
        if (v?.appBase?.startsWith?.("http")) cfg.appBase = v.appBase.replace(/\/+$/, "");
        cfg.token = v?.token ?? null;
        cfg.targetLang = v?.targetLang ?? "";
        ui.refreshAccount();
      }
    );
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.token) {
        cfg.token = changes.token.newValue ?? null;
        ui.refreshAccount();
      }
      if (changes.targetLang) cfg.targetLang = changes.targetLang.newValue ?? "";
    });
  }

  const meetCode = () => location.pathname.match(MEET_CODE_RE)?.[1] ?? null;

  // ===========================================================================
  // Lecturas del DOM de Meet (cada una devuelve null si Meet no lo expone)
  // ===========================================================================
  const inCall = () =>
    Boolean(
      document.querySelector(
        'button[aria-label*="Salir de la llamada"], button[aria-label*="Leave call"], button[aria-label*="abandonar la llamada"]'
      )
    );

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
    const m = (btn?.getAttribute("aria-label") ?? "").match(/\((\d+)\)/) || (btn?.getAttribute("aria-label") ?? "").match(/(\d+)/);
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
  // MOTOR DE SUBTÍTULOS -- de acá sale la transcripción de TODOS
  // ===========================================================================
  //
  // Meet va reescribiendo la MISMA fila mientras alguien habla (el texto crece),
  // y la borra unos segundos después de que termina. Entonces no alcanza con
  // "leer lo que hay": hay que seguir cada fila y decidir cuándo una frase
  // quedó cerrada. La regla: si el texto nuevo empieza con el anterior, es la
  // misma frase creciendo; si cambia de raíz, la anterior terminó. Y si una fila
  // deja de cambiar por un rato, también se da por cerrada.

  const SETTLE_MS = 1600; // silencio tras el cual una frase se considera terminada
  const captions = {
    region: null,
    entries: new Map(), // nodo -> { speaker, text, at, timer }
    seq: 0,
  };

  function findCaptionRegion() {
    return (
      document.querySelector('[role="region"][aria-label*="ubtítul"]') ||
      document.querySelector('[role="region"][aria-label*="aption"]') ||
      document.querySelector('div[jsname="dsyhDe"]') ||
      document.querySelector('[data-use-tweaked-caption-styles]') ||
      null
    );
  }

  // Botón CC de Meet. Lo prendemos solo si hace falta: sin subtítulos activos
  // no hay nada que leer, y es el único requisito real de la extensión.
  function captionsButton() {
    return document.querySelector(
      'button[aria-label*="ubtítulos"], button[aria-label*="aptions"], button[jsname="r8qRAd"]'
    );
  }

  let captionsNudged = false;
  function ensureCaptionsOn() {
    if (findCaptionRegion()) return true;
    const btn = captionsButton();
    if (!btn) return false;
    const label = (btn.getAttribute("aria-label") || "").toLowerCase();
    const isOff = /activar|turn on/.test(label) || btn.getAttribute("aria-pressed") === "false";
    if (isOff && !captionsNudged) {
      captionsNudged = true;
      btn.click();
      log("subtítulos de Meet activados por Unify");
      return true;
    }
    return false;
  }

  // ¿Ese texto parece un nombre y no una frase? Meet pone el nombre de quien
  // habla en su propio elemento, pero no siempre podemos distinguirlo por
  // posición, así que lo validamos por forma.
  const looksLikeName = (s) =>
    s.length > 0 && s.length <= 60 && s.split(/\s+/).length <= 6 && !/[.?!,]$/.test(s);

  // Extrae { speaker, text } de una fila de subtítulo. Se apoya en la ESTRUCTURA
  // (el nombre y el texto viven en elementos distintos) y no en el largo: al
  // arrancar una frase el texto es más corto que el nombre, y cualquier
  // heurística de "el bloque más largo es el texto" se equivoca justo ahí.
  function parseEntry(node) {
    const leaves = [];
    node.querySelectorAll("*").forEach((el) => {
      if (el.children.length === 0) {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (t) leaves.push(t);
      }
    });
    if (leaves.length === 0) {
      const raw = (node.textContent || "").replace(/\s+/g, " ").trim();
      return raw ? { speaker: "", text: raw } : null;
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
    return body ? { speaker, text: body } : null;
  }

  // Emite lo que todavía no se envió de esa fila. Meet reescribe la misma fila
  // mientras la persona sigue hablando, así que guardamos qué parte ya salió y
  // mandamos únicamente lo nuevo -- nunca la frase entera de nuevo.
  function finalizeEntry(node) {
    const rec = captions.entries.get(node);
    if (!rec) return;
    clearTimeout(rec.timer);
    rec.timer = null;
    const pending = rec.text.startsWith(rec.emitted)
      ? rec.text.slice(rec.emitted.length).trim()
      : rec.text.trim();
    if (pending) {
      rec.emitted = rec.text;
      pushLine(rec.speaker || "Participante", pending);
    }
  }

  function touchEntry(node) {
    const parsed = parseEntry(node);
    if (!parsed) return;
    let rec = captions.entries.get(node);
    if (!rec) {
      rec = { speaker: parsed.speaker, text: parsed.text, emitted: "", timer: null };
      captions.entries.set(node, rec);
    } else {
      if (parsed.speaker) rec.speaker = parsed.speaker;
      if (parsed.text === rec.text) return; // nada cambió: no reprogramar nada
      if (!parsed.text.startsWith(rec.emitted)) {
        // La fila se reusó para una frase nueva: cerramos lo anterior primero.
        finalizeEntry(node);
        rec.emitted = "";
      }
      rec.text = parsed.text;
    }
    clearTimeout(rec.timer);
    rec.timer = setTimeout(() => finalizeEntry(node), SETTLE_MS);
    ui.setLiveCaption(rec.speaker || "Participante", rec.text);
  }

  let captionObserver = null;
  function scanCaptions(region) {
    region.querySelectorAll(":scope > *").forEach((node) => touchEntry(node));
    // Filas que Meet ya sacó del DOM: cerrarlas para no perder la última frase,
    // y recién ahí olvidarlas (si se olvidaran antes, el próximo escaneo las
    // tomaría como nuevas y reenviaría todo).
    for (const node of Array.from(captions.entries.keys())) {
      if (!region.contains(node)) {
        finalizeEntry(node);
        clearTimeout(captions.entries.get(node)?.timer);
        captions.entries.delete(node);
      }
    }
  }

  function watchCaptions() {
    const region = findCaptionRegion();
    if (!region || region === captions.region) return;
    captions.region = region;
    captionObserver?.disconnect();
    captionObserver = new MutationObserver(() => scanCaptions(region));
    captionObserver.observe(region, { childList: true, subtree: true, characterData: true });
    ui.setCaptionsReady(true);
    log("leyendo subtítulos de Meet");
  }

  // ===========================================================================
  // Envío al backend de Unify
  // ===========================================================================
  const session = { dbId: null, code: null };
  const lines = []; // transcripción local para el panel

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
    if (session.code === code && session.dbId) return session.dbId;
    try {
      const s = await api(`/api/meet-bridge/${code}/session`);
      session.code = code;
      session.dbId = s.dbId;
      // Al abrir el panel, mostrar lo que ya se dijo (no arrancar en blanco).
      if (Array.isArray(s.transcript) && lines.length === 0) {
        s.transcript.forEach((l) => addLocalLine(l.speakerName, l.text, false));
        ui.renderTranscript();
      }
      return session.dbId;
    } catch {
      return null;
    }
  }

  function addLocalLine(speaker, text, translate = true) {
    // Une frases cortas seguidas del mismo hablante para que se lea como habla
    // real y no como fragmentos sueltos.
    const last = lines[lines.length - 1];
    if (last && last.speaker === speaker && Date.now() - last.at < 8000 && last.text.length < 400) {
      last.text = `${last.text} ${text}`.trim();
      last.at = Date.now();
      if (translate) void translateLine(last);
      return last;
    }
    const line = { speaker, text, at: Date.now(), translated: null };
    lines.push(line);
    if (lines.length > 400) lines.shift();
    if (translate) void translateLine(line);
    return line;
  }

  async function translateLine(line) {
    if (!cfg.targetLang) return;
    try {
      const r = await api("/api/translate", {
        method: "POST",
        body: JSON.stringify({ text: line.text, source: "auto", target: cfg.targetLang }),
      });
      if (r?.translatedText) {
        line.translated = r.translatedText;
        ui.renderTranscript();
      }
    } catch {
      /* traducción best-effort */
    }
  }

  async function pushLine(speaker, text) {
    const code = meetCode();
    if (!code || !text) return;
    addLocalLine(speaker, text);
    ui.renderTranscript();
    try {
      const r = await api(`/api/meet-bridge/${code}/transcript`, {
        method: "POST",
        body: JSON.stringify({ speaker, text, lang: navigator.language || "es-AR" }),
      });
      if (r?.dbId) session.dbId = r.dbId;
      ui.setSync(true);
    } catch (e) {
      ui.setSync(false);
    }
  }

  // Estado de la llamada (lo que ya hacía la versión anterior).
  let lastState = "";
  async function syncState(force = false) {
    const code = meetCode();
    if (!code) return;
    const state = {
      inCall: inCall(),
      micMuted: ownToggle("mic"),
      cameraOff: ownToggle("cam"),
      participantCount: participantCount(),
      presenting: presenting(),
      activeSpeakers: [],
      participants: null,
    };
    const body = JSON.stringify(state);
    if (!force && body === lastState) return;
    lastState = body;
    try {
      await fetch(`${cfg.serverBase}/api/meet-bridge/${code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch {
      /* el panel ya muestra el estado de conexión */
    }
  }

  // ===========================================================================
  // PANEL dentro de Meet
  // ===========================================================================
  const ui = (() => {
    let root = null;
    let els = {};
    let tab = "transcript";
    let recording = false;

    function build() {
      if (root) return;
      root = document.createElement("div");
      root.id = "unify-panel";
      root.innerHTML = `
        <div class="uf-head" data-drag>
          <span class="uf-logo"></span>
          <span class="uf-title">Unify</span>
          <span class="uf-dot" data-el="sync" title="Conexión con Unify"></span>
          <button class="uf-icon" data-el="rec" title="Grabar la reunión completa (todos los participantes)">⏺</button>
          <button class="uf-icon" data-el="min" title="Minimizar">—</button>
        </div>
        <div class="uf-tabs">
          <button class="uf-tab is-on" data-tab="transcript">Transcripción</button>
          <button class="uf-tab" data-tab="subs">Subtítulos</button>
          <button class="uf-tab" data-tab="ai">IA</button>
        </div>
        <div class="uf-body">
          <div class="uf-pane" data-pane="transcript">
            <div class="uf-hint" data-el="capHint">Activando los subtítulos de Meet…</div>
            <ul class="uf-lines" data-el="lines"></ul>
          </div>
          <div class="uf-pane uf-hidden" data-pane="subs">
            <label class="uf-field">
              <span>Traducir a</span>
              <select data-el="lang">
                <option value="">Sin traducir</option>
                <option value="es">Español</option>
                <option value="en">Inglés</option>
                <option value="pt">Portugués</option>
                <option value="fr">Francés</option>
                <option value="de">Alemán</option>
                <option value="it">Italiano</option>
                <option value="zh">Chino</option>
              </select>
            </label>
            <label class="uf-check"><input type="checkbox" data-el="overlay" checked> Mostrar subtítulos sobre el video</label>
            <div class="uf-live" data-el="live"><span class="uf-live-empty">Cuando alguien hable, lo vas a ver acá.</span></div>
          </div>
          <div class="uf-pane uf-hidden" data-pane="ai">
            <div class="uf-ai" data-el="aiLog"></div>
            <div class="uf-ask">
              <input type="text" data-el="aiInput" placeholder="Ej: resumime lo que se dijo" />
              <button data-el="aiSend">Preguntar</button>
            </div>
            <div class="uf-hint" data-el="aiHint"></div>
          </div>
        </div>`;
      document.body.appendChild(root);
      els = {};
      root.querySelectorAll("[data-el]").forEach((n) => (els[n.dataset.el] = n));

      root.querySelectorAll(".uf-tab").forEach((b) =>
        b.addEventListener("click", () => setTab(b.dataset.tab))
      );
      els.min.addEventListener("click", toggleMin);
      els.rec.addEventListener("click", toggleRecording);
      els.lang.addEventListener("change", () => {
        cfg.targetLang = els.lang.value;
        chrome.storage.local.set({ targetLang: cfg.targetLang });
        renderTranscript();
      });
      els.overlay.addEventListener("change", () => {
        overlayEl.style.display = els.overlay.checked ? "" : "none";
      });
      els.aiSend.addEventListener("click", ask);
      els.aiInput.addEventListener("keydown", (e) => e.key === "Enter" && ask());
      makeDraggable(root, root.querySelector("[data-drag]"));
      restorePosition();
      els.lang.value = cfg.targetLang || "";
    }

    // --- overlay de subtítulos sobre el video de Meet ---
    const overlayEl = document.createElement("div");
    overlayEl.id = "unify-subs";
    function ensureOverlay() {
      if (!overlayEl.isConnected) document.body.appendChild(overlayEl);
    }

    function setTab(name) {
      tab = name;
      root.querySelectorAll(".uf-tab").forEach((b) => b.classList.toggle("is-on", b.dataset.tab === name));
      root.querySelectorAll(".uf-pane").forEach((p) => p.classList.toggle("uf-hidden", p.dataset.pane !== name));
      if (name === "ai") void ensureSession();
    }

    function toggleMin() {
      root.classList.toggle("is-min");
      els.min.textContent = root.classList.contains("is-min") ? "▢" : "—";
      chrome.storage.local.set({ minimized: root.classList.contains("is-min") });
    }

    function makeDraggable(box, handle) {
      let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
      handle.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".uf-icon")) return;
        dragging = true;
        sx = e.clientX; sy = e.clientY;
        const r = box.getBoundingClientRect();
        ox = r.left; oy = r.top;
        handle.setPointerCapture(e.pointerId);
      });
      handle.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const x = Math.max(8, Math.min(window.innerWidth - 80, ox + e.clientX - sx));
        const y = Math.max(8, Math.min(window.innerHeight - 60, oy + e.clientY - sy));
        box.style.left = `${x}px`;
        box.style.top = `${y}px`;
        box.style.right = "auto";
        box.style.bottom = "auto";
      });
      handle.addEventListener("pointerup", () => {
        if (!dragging) return;
        dragging = false;
        chrome.storage.local.set({ pos: { left: box.style.left, top: box.style.top } });
      });
    }

    function restorePosition() {
      chrome.storage.local.get({ pos: null, minimized: false }, (v) => {
        if (v?.pos?.left) {
          root.style.left = v.pos.left;
          root.style.top = v.pos.top;
          root.style.right = "auto";
          root.style.bottom = "auto";
        }
        if (v?.minimized) toggleMin();
      });
    }

    // --- render ---
    function renderTranscript() {
      if (!els.lines) return;
      const atBottom = els.lines.scrollHeight - els.lines.scrollTop - els.lines.clientHeight < 40;
      els.lines.innerHTML = lines
        .slice(-120)
        .map((l) => {
          const t = l.translated && l.translated !== l.text
            ? `<div class="uf-tr">${esc(l.translated)}</div>`
            : "";
          return `<li><span class="uf-who">${esc(l.speaker)}</span>${esc(l.text)}${t}</li>`;
        })
        .join("");
      if (atBottom) els.lines.scrollTop = els.lines.scrollHeight;
    }

    function setLiveCaption(speaker, text) {
      if (!els.live) return;
      els.live.innerHTML = `<span class="uf-who">${esc(speaker)}</span>${esc(text)}`;
      ensureOverlay();
      overlayEl.textContent = `${speaker}: ${text}`;
      overlayEl.classList.add("is-on");
      clearTimeout(overlayEl._t);
      overlayEl._t = setTimeout(() => overlayEl.classList.remove("is-on"), 6000);
    }

    function setCaptionsReady(ok) {
      if (!els.capHint) return;
      els.capHint.textContent = ok
        ? "Escuchando a todos los participantes desde los subtítulos de Meet."
        : "Activá los subtítulos de Meet (botón CC) para transcribir a todos.";
      els.capHint.classList.toggle("uf-ok", ok);
    }

    function setSync(ok) {
      els.sync?.classList.toggle("is-bad", !ok);
    }

    function setRecording(on) {
      recording = on;
      els.rec?.classList.toggle("is-rec", on);
      if (els.rec) els.rec.title = on ? "Detener la grabación" : "Grabar la reunión completa (todos los participantes)";
    }

    function refreshAccount() {
      if (!els.aiHint) return;
      els.aiHint.innerHTML = cfg.token
        ? ""
        : `Para usar la IA, <a href="${cfg.appBase}/ingresar" target="_blank" rel="noreferrer">iniciá sesión en Unify</a> y volvé a esta pestaña.`;
    }

    async function toggleRecording() {
      const code = meetCode();
      if (!code) return;
      if (recording) {
        chrome.runtime.sendMessage({ kind: "unify-record-stop" });
        setRecording(false);
        return;
      }
      const dbId = await ensureSession();
      chrome.runtime.sendMessage(
        { kind: "unify-record-start", dbId, serverBase: cfg.serverBase, token: cfg.token },
        (r) => {
          if (r?.ok) setRecording(true);
          else alert(r?.error || "No pudimos empezar a grabar. Probá de nuevo.");
        }
      );
    }

    async function ask() {
      const q = els.aiInput.value.trim();
      if (!q) return;
      if (!cfg.token) {
        refreshAccount();
        return;
      }
      const code = meetCode();
      els.aiInput.value = "";
      addAi("vos", q);
      const pending = addAi("Unify", "Pensando…");
      try {
        const r = await api(`/api/meet-bridge/${code}/ask`, {
          method: "POST",
          body: JSON.stringify({ question: q }),
        });
        pending.textContent = r.answer || "Sin respuesta.";
      } catch (e) {
        pending.textContent =
          e?.message === "401"
            ? "Tu sesión de Unify venció. Volvé a iniciar sesión."
            : "No pudimos consultar a la IA en este momento.";
      }
      els.aiLog.scrollTop = els.aiLog.scrollHeight;
    }

    function addAi(who, text) {
      const d = document.createElement("div");
      d.className = `uf-msg ${who === "vos" ? "is-me" : ""}`;
      d.innerHTML = `<b>${esc(who)}</b> `;
      const span = document.createElement("span");
      span.textContent = text;
      d.appendChild(span);
      els.aiLog.appendChild(d);
      els.aiLog.scrollTop = els.aiLog.scrollHeight;
      return span;
    }

    const esc = (s) =>
      String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

    return {
      build,
      destroy() {
        root?.remove();
        root = null;
        overlayEl.remove();
      },
      renderTranscript,
      setLiveCaption,
      setCaptionsReady,
      setSync,
      setRecording,
      refreshAccount,
      get mounted() {
        return Boolean(root);
      },
    };
  })();

  // El servicio de fondo avisa cuando la grabación termina o falla.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.kind === "unify-record-state") ui.setRecording(Boolean(msg.recording));
    if (msg?.kind === "unify-record-error") {
      ui.setRecording(false);
      alert(msg.message || "Se cortó la grabación.");
    }
  });

  // ===========================================================================
  // Ciclo principal
  // ===========================================================================
  function tick() {
    const code = meetCode();
    if (!code || !inCall()) {
      if (ui.mounted) ui.destroy();
      return;
    }
    if (!ui.mounted) {
      ui.build();
      void ensureSession();
    }
    const ok = ensureCaptionsOn();
    ui.setCaptionsReady(Boolean(findCaptionRegion()) || ok);
    watchCaptions();
  }

  setInterval(tick, 1500);
  setInterval(() => void syncState(true), 10000);
  new MutationObserver(() => void syncState()).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-is-muted", "aria-label"],
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

  loadConfig();
  tick();
  log("Unify activo en", location.pathname);
})();
