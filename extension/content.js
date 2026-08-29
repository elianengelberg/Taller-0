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

  function pushLocal(speaker, text, { translate = true, at = Date.now() } = {}) {
    const name = speaker || "Participante";
    state.speakers.add(name);
    const last = state.lines[state.lines.length - 1];
    if (last && last.speaker === name && at - last.at < 8000 && last.text.length < 400) {
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
    try {
      const r = await api("/api/translate", {
        method: "POST",
        body: JSON.stringify({ text: line.text, source: "auto", target: cfg.lang }),
      });
      if (r?.translatedText && r.translatedText !== line.text) {
        line.translated = r.translatedText;
        ui.renderStream();
      }
    } catch {
      /* la traducción es un extra: si falla, queda el original */
    }
  }

  async function emit(speaker, text, alts = []) {
    const code = meetCode();
    if (!code || !text) return;
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
  // El botón de ENTRAR: es lo que distingue la sala de espera de la llamada.
  // Hace falta porque los controles de micrófono y cámara ([data-is-muted])
  // existen en LAS DOS pantallas -- Meet muestra la vista previa antes de
  // entrar -- así que sin esto la sala de espera se confundiría con estar
  // adentro, y la extensión pediría el micrófono antes de que la persona
  // decidiera entrar.
  const ENTRAR_RE = /unirte ahora|unirse ahora|pedir unirse|participar ahora|join now|ask to join|entrar agora|pedir para participar|rejoindre|demander à participer|jetzt teilnehmen|partecipa ora/i;
  const botonEntrar = () => {
    for (const b of document.querySelectorAll("button, [role='button']")) {
      const t = `${b.getAttribute("aria-label") || ""} ${b.textContent || ""}`;
      if (ENTRAR_RE.test(t)) return true;
    }
    return false;
  };

  const controlesLlamada = () => document.querySelectorAll("[data-is-muted]").length >= 2;

  const inCall = () => {
    for (const b of document.querySelectorAll("button[aria-label]")) {
      if (COLGAR_RE.test(b.getAttribute("aria-label") || "")) return true;
    }
    // Camino estructural, independiente del idioma: los controles de la
    // llamada están presentes y YA NO hay botón de entrar.
    return controlesLlamada() && !botonEntrar();
  };

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
  const caps = { region: null, entries: new Map(), observer: null, nudged: false };

  const findCaptionRegion = () =>
    document.querySelector('[role="region"][aria-label*="ubtítul"]') ||
    document.querySelector('[role="region"][aria-label*="aption"]') ||
    document.querySelector('div[jsname="dsyhDe"]') ||
    document.querySelector("[data-use-tweaked-caption-styles]") ||
    null;

  function ensureCaptionsOn() {
    if (findCaptionRegion()) return true;
    const btn = document.querySelector(
      'button[aria-label*="ubtítulos"], button[aria-label*="aptions"], button[jsname="r8qRAd"]'
    );
    if (!btn) return false;
    const label = (btn.getAttribute("aria-label") || "").toLowerCase();
    const isOff = /activar|turn on/.test(label) || btn.getAttribute("aria-pressed") === "false";
    if (isOff && !caps.nudged) {
      caps.nudged = true;
      btn.click();
      log("subtítulos de Meet activados");
      return true;
    }
    return false;
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

  function parseEntry(node) {
    const leaves = [];
    node.querySelectorAll("*").forEach((el) => {
      if (el.children.length === 0) {
        if (esControlDeMeet(el)) return;
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (t && !esLigaduraDeIcono(t)) leaves.push(t);
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
    return body ? { speaker, text: body } : null;
  }

  // Meet reescribe la MISMA fila mientras la persona habla, así que guardamos
  // qué parte ya se envió y mandamos únicamente lo nuevo.
  function finalizeEntry(node) {
    const rec = caps.entries.get(node);
    if (!rec) return;
    clearTimeout(rec.timer);
    rec.timer = null;
    const pending = rec.text.startsWith(rec.emitted) ? rec.text.slice(rec.emitted.length).trim() : rec.text.trim();
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
      if (parsed.text === rec.text) return;
      if (!parsed.text.startsWith(rec.emitted)) {
        finalizeEntry(node);
        rec.emitted = "";
      }
      rec.text = parsed.text;
    }
    clearTimeout(rec.timer);
    rec.timer = setTimeout(() => finalizeEntry(node), SETTLE_MS);
    ui.showSubtitle({ speaker: rec.speaker || "Participante", text: rec.text, translated: null });
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

  function watchCaptions() {
    const region = findCaptionRegion();
    if (!region) {
      caps.region = null;
      return false;
    }
    if (region === caps.region) return true;
    caps.region = region;
    caps.observer?.disconnect();
    caps.observer = new MutationObserver(() => scanCaptions(region));
    caps.observer.observe(region, { childList: true, subtree: true, characterData: true });
    log("leyendo subtítulos de Meet");
    return true;
  }

  // ===========================================================================
  // Respaldo por micrófono (solo TU voz) cuando Meet no da subtítulos
  // ===========================================================================
  const mic = { rec: null, running: false };

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
    r.onresult = (ev) => {
      state.micDenied = false;
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
          void emit("Vos", text, alts);
        } else {
          ui.showSubtitle({ speaker: "Vos", text, translated: null });
        }
      }
    };
    r.onerror = (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        state.micDenied = true;
        mic.running = false;
        ui.renderMicCard();
      }
    };
    r.onend = () => {
      if (mic.running) {
        try { r.start(); } catch { /* ya arrancando */ }
      }
    };
    try {
      r.start();
      mic.rec = r;
      mic.running = true;
      state.usingMic = true;
    } catch {
      /* no se pudo: la tarjeta de permisos lo explica */
    }
  }

  function stopMicFallback() {
    mic.running = false;
    state.usingMic = false;
    try { mic.rec?.stop(); } catch { /* noop */ }
    mic.rec = null;
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
  // Interfaz (Shadow DOM)
  // ===========================================================================
  const ui = (() => {
    let host = null, shadow = null, el = {}, tab = "stream", drawerOpen = false;
    let subsTimer = null;

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
        <div class="badge glass" part="badge">
          <span class="live"></span>
          <span class="txt"><b>Unify</b>: <span data-el="statusTxt">Companion activo</span></span>
          <span class="tradlbl" aria-hidden="true">Traducir</span>
          <select class="langsel" data-el="lang" title="Traducir los subtítulos a este idioma" aria-label="Traducir los subtítulos a este idioma">
            <option value="">—</option>
            <option value="es">ES</option>
            <option value="en">EN</option>
            <option value="pt">PT</option>
            <option value="fr">FR</option>
            <option value="de">DE</option>
            <option value="it">IT</option>
            <option value="zh">中文</option>
            <option value="ja">日本語</option>
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
      el.close.addEventListener("click", () => toggleDrawer(false));
      el.rec.addEventListener("click", toggleRecording);
      el.lang.addEventListener("change", () => {
        cfg.lang = el.lang.value;
        chrome.storage.local.set({ lang: cfg.lang });
        state.lines.forEach((l) => (l.translated = null));
        renderStream();
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
      barButton.setActive(drawerOpen);
    }

    function setStatus(kind) {
      const badge = shadow.querySelector(".badge");
      badge.classList.toggle("is-off", kind === "off");
      badge.classList.toggle("is-warn", kind === "offline");
      el.statusTxt.textContent =
        kind === "off" ? "Fuera de la llamada" : kind === "offline" ? "Sin conexión" : "Companion activo";
    }

    function setCaptionsReady(ok) {
      el.capHint.textContent = ok
        ? "Escuchando a todos los participantes desde los subtítulos de Meet."
        : state.usingMic
          ? "Meet no está dando subtítulos: por ahora solo se transcribe tu micrófono. Activá el botón CC de Meet para capturar a todos."
          : "Activá los subtítulos de Meet (botón CC) para transcribir a todos.";
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
          const tr = l.translated ? `<div class="tr">${esc(l.translated)}</div>` : "";
          return `<div class="entry">
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
      const r = roleOf(state.roles[line.speaker] ?? "");
      el.subRole.textContent = r.label;
      el.subRole.style.setProperty("--role", r.color);
      el.subRole.hidden = !r.id;
      el.subName.textContent = line.speaker;
      el.subLang.textContent = (cfg.lang || navigator.language || "es").slice(0, 2).toUpperCase();
      el.subText.textContent = line.text;
      if (line.translated) {
        el.subTr.textContent = line.translated;
        el.subTr.hidden = false;
      } else {
        el.subTr.hidden = true;
      }
      el.subs.classList.add("is-on");
      clearTimeout(subsTimer);
      subsTimer = setTimeout(() => el.subs.classList.remove("is-on"), 6500);
    }

    function refreshAccount() {
      if (!el.aiHint) return;
      el.aiHint.innerHTML = cfg.token
        ? ""
        : `Para usar la IA, <a href="${cfg.appBase}/ingresar" target="_blank" rel="noreferrer">iniciá sesión en Unify</a> y volvé a esta pestaña.`;
    }

    async function toggleRecording() {
      const code = meetCode();
      if (!code) return;
      if (state.recording) {
        chrome.runtime.sendMessage({ kind: "unify-record-stop" });
        setRecording(false);
        return;
      }
      const dbId = await ensureSession();
      chrome.runtime.sendMessage(
        { kind: "unify-record-start", dbId, serverBase: cfg.serverBase, token: cfg.token },
        (r) => {
          if (r?.ok) {
            setRecording(true);
            el.recCard.innerHTML = "";
          } else if (r?.needsInvoke) {
            // Chrome no deja capturar la pestaña desde un clic dentro de la
            // página: hace falta el atajo o el ícono de la barra. Se explica
            // en el lugar, con la tecla a la vista.
            showInvokeCard();
          } else {
            addMsg("Unify", r?.error || "No pudimos empezar a grabar.");
          }
        }
      );
    }

    function showInvokeCard() {
      if (!el.recCard) return;
      const mac = /Mac/i.test(navigator.platform);
      el.recCard.innerHTML = `
        <div class="card">
          <p>Para grabar, Chrome pide que la orden venga del navegador y no de la página.
          Apretá <b>${mac ? "⌘ + ⇧ + U" : "Ctrl + Shift + U"}</b> ahora mismo — o tocá el ícono de Unify
          en la barra y después <b>Grabar la reunión</b>.</p>
          <button data-el="invokeOk">Entendido</button>
        </div>`;
      el.recCard.querySelector("[data-el=invokeOk]").addEventListener("click", () => {
        el.recCard.innerHTML = "";
      });
    }

    function setRecording(on) {
      state.recording = on;
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
        pending.textContent = r.answer || "Sin respuesta.";
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
      toggleDrawer, setStatus, setCaptionsReady, setRecording,
      renderStream, renderRoles, renderMicCard, showSubtitle, refreshAccount,
      // El idioma puede resolverse DESPUÉS de montar la interfaz (el storage
      // es asíncrono): esto empareja el selector con cfg.lang cuando llega.
      syncLang() { if (el.lang) el.lang.value = cfg.lang || ""; },
    };
  })();

  // ===========================================================================
  // Botón en la barra inferior de Meet (va en el DOM de Meet, no en el shadow)
  // ===========================================================================
  const barButton = (() => {
    const ID = "unify-bar-btn";
    let node = null;

    // La barra es el ancestro del botón de micrófono que ya contiene varios
    // botones: buscarla así sobrevive a los cambios de clases de Meet.
    function findBar() {
      const micBtn =
        document.querySelector('[data-is-muted][aria-label*="icróf"], [data-is-muted][aria-label*="icrophone"]') ||
        document.querySelector("[data-is-muted]");
      if (!micBtn) return null;
      let cur = micBtn;
      for (let i = 0; i < 6 && cur.parentElement; i++) {
        cur = cur.parentElement;
        if (cur.querySelectorAll('button, [role="button"]').length >= 3) return cur;
      }
      return null;
    }

    function ensure() {
      const existing = document.getElementById(ID);
      if (existing && existing.isConnected) {
        node = existing;
        return;
      }
      const bar = findBar();
      if (!bar) return;
      node = document.createElement("button");
      node.id = ID;
      node.type = "button";
      node.setAttribute("aria-label", "Abrir el panel de Unify");
      node.title = "Unify: transcripción, IA y grabación";
      node.style.cssText = [
        "width:48px", "height:48px", "border-radius:50%", "border:0", "cursor:pointer",
        "margin:0 4px", "display:inline-flex", "align-items:center", "justify-content:center",
        "background:linear-gradient(160deg,#a78bfa,#8b5cf6)", "color:#fff",
        "box-shadow:0 4px 14px rgba(139,92,246,.45)", "flex:none",
        "font-family:'Google Sans',Roboto,Arial,sans-serif", "font-size:17px", "font-weight:700",
        "transition:filter .15s ease",
      ].join(";");
      node.textContent = "U";
      node.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        ui.toggleDrawer();
      });
      node.addEventListener("mouseenter", () => (node.style.filter = "brightness(1.1)"));
      node.addEventListener("mouseleave", () => (node.style.filter = ""));
      bar.appendChild(node);
    }

    return {
      ensure,
      setActive(on) {
        if (node) node.style.outline = on ? "2px solid rgba(255,255,255,.85)" : "";
      },
      remove() {
        document.getElementById(ID)?.remove();
        node = null;
      },
    };
  })();

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
        <div class="fila"><button class="si">Sí, dale</button><button class="no">Ahora no</button></div>
        <div class="pie"></div>
      </div>`;
    // El texto cambia según el momento: en la sala de espera se está
    // "uniendo" (es el caso del enlace que te mandaron por WhatsApp), ya
    // adentro se está "en" la reunión. Decirlo mal suena a robot.
    root.querySelector(".msg").textContent = enEspera
      ? "Veo que te estás uniendo a una reunión de Google Meet. ¿Querés los subtítulos y grabar la reunión?"
      : "Veo que estás en una reunión de Google Meet. ¿Querés los subtítulos y grabar la reunión?";
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
      // Auto-SÍ: se abre el panel con la transcripción. La GRABACIÓN sigue
      // necesitando tu gesto (Chrome sólo la habilita así), y está a un clic
      // en el panel que se acaba de abrir.
      aceptar();
    }, 1000);

    // Aceptar en la SALA DE ESPERA no puede abrir un panel que todavía no
    // existe: se recuerda la respuesta y el panel se abre solo al entrar a la
    // llamada. Así, quien abrió el enlace de WhatsApp y dijo "sí" no tiene
    // que volver a decirlo del otro lado.
    const aceptar = () => {
      aceptado = code;
      if (ui.mounted) ui.toggleDrawer(true);
    };

    root.querySelector(".si").addEventListener("click", () => {
      cerrar();
      aceptar();
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
      caps.region = null;
      caps.observer?.disconnect();

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
    } else {
      avisarEnMeet(code);
    }

    const captionsOn = watchCaptions() || ensureCaptionsOn();
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

  setInterval(() => {
    try {
      ensureAll();
    } catch (e) {
      log("ensureAll falló, se reintenta:", e?.message);
    }
  }, 2000);
  setInterval(() => void syncState(true), 10000);

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
