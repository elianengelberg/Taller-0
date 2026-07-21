// Unify <-> Google Meet bridge (content script).
//
// Google Meet has NO public API for third-party in-call state, and a normal
// web page can't reach into meet.google.com at all (cross-origin). The only
// technically possible integration is exactly this: an extension observing
// Meet's own DOM and relaying what it can see to Unify's backend, which
// forwards it live to the Unify companion room for the same meeting.
//
// Everything here is BEST-EFFORT by nature: Google changes Meet's DOM
// without notice, and most state only exists in the DOM while its UI is
// rendered. We therefore prefer signals that have stayed stable for years
// (URL meeting code, data-is-muted on the mic/camera buttons, the
// participant-count badge) and degrade field-by-field to null instead of
// breaking. Nothing scraped here is treated as authoritative by Unify.

(() => {
  const DEFAULT_SERVER = "https://taller-0.onrender.com";
  const DEFAULT_APP = "https://www.unify-meet.com";
  const MEET_CODE_RE = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/;

  let serverBase = DEFAULT_SERVER;
  let appBase = DEFAULT_APP;
  try {
    chrome.storage.sync.get({ serverBase: DEFAULT_SERVER, appBase: DEFAULT_APP }, (v) => {
      if (v && typeof v.serverBase === "string" && v.serverBase.startsWith("http")) {
        serverBase = v.serverBase.replace(/\/+$/, "");
      }
      if (v && typeof v.appBase === "string" && v.appBase.startsWith("http")) {
        appBase = v.appBase.replace(/\/+$/, "");
      }
    });
  } catch (e) {
    /* storage unavailable -- keep the defaults */
  }

  const log = (...args) => console.debug("[unify-meet]", ...args);

  function meetCode() {
    const m = location.pathname.match(MEET_CODE_RE);
    return m ? m[1] : null;
  }

  // ---- DOM readers (each returns null when Meet doesn't expose it) ----

  // In-call vs lobby: the "Leave call / Salir de la llamada" button only
  // exists while actually inside the call.
  function readInCall() {
    return Boolean(
      document.querySelector(
        'button[aria-label*="Salir de la llamada"], button[aria-label*="Leave call"], button[aria-label*="abandonar la llamada"]'
      )
    );
  }

  // Own mic/cam: Meet marks its toggle buttons with data-is-muted (one of
  // its most stable attributes across redesigns).
  function readOwnToggle(kind) {
    const byLabel =
      kind === "mic"
        ? document.querySelector('[data-is-muted][aria-label*="icróf"], [data-is-muted][aria-label*="icrophone"]')
        : document.querySelector('[data-is-muted][aria-label*="ámara"], [data-is-muted][aria-label*="amera"]');
    const el = byLabel || document.querySelectorAll("[data-is-muted]")[kind === "mic" ? 0 : 1];
    if (!el) return null;
    return el.getAttribute("data-is-muted") === "true";
  }

  // Participant count: the people-button badge ("Show everyone (N)").
  function readParticipantCount() {
    const btn = document.querySelector(
      'button[aria-label*="Mostrar a todos"], button[aria-label*="Show everyone"], button[aria-label*="participante"], button[aria-label*="participant"]'
    );
    const label = btn?.getAttribute("aria-label") ?? "";
    const m = label.match(/\((\d+)\)/) || label.match(/(\d+)/);
    return m ? Number(m[1]) : null;
  }

  // Whether ANYONE is presenting: our own "Stop presenting" button, or a
  // presentation tile label.
  function readPresenting() {
    if (
      document.querySelector(
        'button[aria-label*="Dejar de compartir"], button[aria-label*="Stop presenting"], button[aria-label*="Stop sharing"]'
      )
    ) {
      return true;
    }
    const text = (document.body?.innerText ?? "").slice(0, 20000);
    if (/está presentando|is presenting/i.test(text)) return true;
    return null;
  }

  // Names highlighted as speaking. Meet only exposes this semi-reliably;
  // best-effort by design.
  function readActiveSpeakers() {
    const speakers = new Set();
    document
      .querySelectorAll('[class*="speaking"], [data-self-name][data-speaking="true"]')
      .forEach((el) => {
        const name = (el.getAttribute("data-self-name") || el.textContent || "").trim();
        if (name && name.length <= 60) speakers.add(name);
      });
    return Array.from(speakers).slice(0, 10);
  }

  // Roster names -- only available while Meet's people panel is open (Meet
  // doesn't render the list otherwise). Null when unavailable.
  function readParticipants() {
    const panel = document.querySelector('[aria-label*="Participantes"], [aria-label*="Participants"]');
    if (!panel) return null;
    const names = [];
    panel.querySelectorAll('[data-participant-id], [role="listitem"]').forEach((row) => {
      const name = row.textContent?.split("\n")[0]?.trim();
      if (name && name.length <= 60 && !names.includes(name)) names.push(name);
    });
    return names.length ? names.slice(0, 100) : null;
  }

  // ---- "Grabar con Unify" button injected into the call ----
  //
  // A content script cannot start a recording by itself (getDisplayMedia and
  // tabCapture both require a user gesture on the extension/app side), so
  // the honest integrated flow is: one click here opens the Unify companion
  // pre-filled with THIS meeting's link, where a remembered user lands
  // already joined and one tap away from recording the Meet tab.
  const BTN_ID = "unify-record-launcher";
  function ensureRecordButton(inCall) {
    const existing = document.getElementById(BTN_ID);
    if (!inCall || sessionStorage.getItem("unify-btn-hidden") === "1") {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;

    const wrap = document.createElement("div");
    wrap.id = BTN_ID;
    wrap.style.cssText =
      "position:fixed;bottom:92px;right:16px;z-index:2147483000;display:flex;align-items:center;gap:6px;font-family:'Google Sans',Roboto,Arial,sans-serif;";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "⏺ Grabar con Unify";
    btn.title = "Abre Unify con esta reunión lista para grabar, transcribir y traducir";
    btn.style.cssText =
      "border:none;cursor:pointer;background:#2563EB;color:#fff;font-size:13px;font-weight:600;padding:10px 14px;border-radius:999px;box-shadow:0 4px 14px rgba(37,99,235,.45);";
    btn.addEventListener("click", () => {
      const link = `${location.origin}${location.pathname}`;
      window.open(`${appBase}/externa?link=${encodeURIComponent(link)}&rec=1`, "_blank", "noopener");
    });

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "✕";
    close.setAttribute("aria-label", "Ocultar el botón de Unify en esta pestaña");
    close.style.cssText =
      "border:none;cursor:pointer;background:rgba(32,33,36,.85);color:#e8eaed;font-size:11px;width:22px;height:22px;border-radius:50%;";
    close.addEventListener("click", () => {
      sessionStorage.setItem("unify-btn-hidden", "1");
      wrap.remove();
    });

    wrap.append(btn, close);
    document.body.appendChild(wrap);
  }

  // ---- State collection + sync ----

  function collect() {
    return {
      inCall: readInCall(),
      micMuted: readOwnToggle("mic"),
      cameraOff: readOwnToggle("cam"),
      participantCount: readParticipantCount(),
      presenting: readPresenting(),
      activeSpeakers: readActiveSpeakers(),
      participants: readParticipants(),
    };
  }

  let lastSent = "";
  let backoffMs = 0;
  let lastCode = null;

  function setBadge(ok) {
    try {
      chrome.runtime.sendMessage({ kind: "unify-status", ok });
    } catch (e) {
      /* extension context gone (update/reload) -- harmless */
    }
  }

  async function send(code, state, isFinal) {
    try {
      const res = await fetch(`${serverBase}/api/meet-bridge/${code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
        keepalive: isFinal, // survives tab close for the goodbye ping
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (backoffMs) log("reconectado con Unify");
      backoffMs = 0;
      setBadge(true);
    } catch (err) {
      // Server asleep/unreachable: exponential backoff, then resend the
      // full state so nothing stays stale from the offline gap.
      backoffMs = Math.min(backoffMs ? backoffMs * 2 : 2000, 60000);
      log(`sin conexión con Unify, reintento en ${backoffMs / 1000}s:`, err?.message);
      setBadge(false);
      setTimeout(() => void sync(true), backoffMs);
    }
  }

  async function sync(force = false) {
    const code = meetCode();
    // Meeting changed inside the same tab (Meet is a SPA): close out the
    // old room before reporting the new one.
    if (lastCode && code !== lastCode) {
      void send(lastCode, { inCall: false }, true);
      lastSent = "";
    }
    lastCode = code;
    if (!code) return;

    const state = collect();
    ensureRecordButton(state.inCall);
    const body = JSON.stringify(state);
    if (!force && body === lastSent) return; // only sync real changes
    lastSent = body;
    await send(code, state, false);
  }

  // Observe Meet's DOM (throttled to 1/s) + a 10s heartbeat so Unify can
  // show connection freshness even when nothing changes.
  let pending = null;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      void sync();
    }, 1000);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-is-muted", "aria-label"],
  });

  setInterval(() => void sync(true), 10000);
  window.addEventListener("pagehide", () => {
    const code = meetCode();
    if (code) void send(code, { inCall: false }, true);
  });

  log("extensión Unify activa en", location.pathname);
  void sync(true);
})();
