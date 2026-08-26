import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarEvent, fetchUpcomingMeetings } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import { ClockIcon, CloseIcon, RecordIcon } from "./icons";

// Watches the connected Outlook calendar (while the app is open and the user
// is logged in) and, just before a meeting with a join link starts, offers to
// start recording -- "veo que tenés una reunión, ¿grabo?". If the countdown
// runs out without a cancel, it opens the meeting in Unify ready to record.
//
// Honest limitation: a web page can't grab the screen without a user gesture,
// and can't run when closed. So this can't literally press record for you in
// the background -- what it does is make sure that when the app is open you're
// never more than one tap from recording, and never forget a meeting is
// starting.

const POLL_MS = 60_000;
// Prompt this many ms before the meeting's start time.
const LEAD_MS = 2 * 60_000;
// Countdown shown in the prompt before it auto-proceeds.
const COUNTDOWN_S = 8;
// Don't prompt for the same event twice (persisted so a reload doesn't renag).
const DISMISS_KEY = "unify_calendar_dismissed";

// El aviso del SISTEMA (la jugada de Granola): si Unify está minimizada o
// detrás de otra ventana cuando la reunión empieza, el cartel de adentro no
// se ve -- la notificación del sistema sí, y el clic trae la app al frente,
// donde la cuenta regresiva ya está corriendo.
function avisarPorSistema(ev: CalendarEvent): void {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible" && document.hasFocus()) return;
    const n = new Notification("Tenés una reunión ahora", {
      body: `${ev.subject} — Unify puede entrar con subtítulos, transcripción y grabación.`,
      tag: `unify-cal-${ev.id}`,
      icon: "/icons/icon-192.png",
    });
    n.onclick = () => {
      try { window.focus(); n.close(); } catch { /* nada que hacer */ }
    };
  } catch { /* notificaciones bloqueadas: el cartel de adentro sigue */ }
}

// El permiso se pide UNA vez, recién cuando sabemos que hay calendario
// conectado (pedirlo antes sería ruido para quien nunca lo conectó).
function pedirPermisoDeAvisos(): void {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "default") return;
    if (localStorage.getItem("unify_avisos_pedidos")) return;
    localStorage.setItem("unify_avisos_pedidos", "1");
    void Notification.requestPermission();
  } catch { /* sin permiso, el cartel de adentro alcanza */ }
}

function loadDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(DISMISS_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function saveDismissed(ids: Set<string>) {
  sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...ids].slice(-50)));
}

export default function CalendarRecordWatcher() {
  const { user } = useAuth();
  const [prompt, setPrompt] = useState<CalendarEvent | null>(null);
  const [countdown, setCountdown] = useState(COUNTDOWN_S);
  const dismissedRef = useRef<Set<string>>(loadDismissed());
  const connectedRef = useRef(false);

  const goRecord = useCallback((event: CalendarEvent) => {
    dismissedRef.current.add(event.id);
    saveDismissed(dismissedRef.current);
    setPrompt(null);
    if (event.joinUrl) {
      // Route through the external-join deep link: it detects the platform and
      // (with a remembered name, for Meet) lands in the companion ready to
      // record. For non-Meet links it prefills so it's one tap away.
      window.location.href = `/externa?link=${encodeURIComponent(event.joinUrl)}&rec=1`;
    }
  }, []);

  const dismiss = useCallback((event: CalendarEvent) => {
    dismissedRef.current.add(event.id);
    saveDismissed(dismissedRef.current);
    setPrompt(null);
  }, []);

  // Poll the calendar and decide whether to surface a prompt.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const tick = async () => {
      // Skip polling entirely once we know the calendar isn't connected, to
      // avoid hammering the endpoint for users who never linked Outlook.
      const res = await fetchUpcomingMeetings();
      if (cancelled) return;
      connectedRef.current = res.connected;
      if (!res.connected) return;
      pedirPermisoDeAvisos();
      const now = Date.now();
      const imminent = res.events.find((ev) => {
        if (!ev.joinUrl) return false; // nothing to record without a link
        if (dismissedRef.current.has(ev.id)) return false;
        const startMs = new Date(ev.start).getTime();
        // Between LEAD_MS before start and 5 min after (in case the app was
        // just opened right as the meeting began).
        return startMs - now <= LEAD_MS && now - startMs <= 5 * 60_000;
      });
      if (imminent) {
        setPrompt((current) => {
          if (current) return current;
          avisarPorSistema(imminent);
          return imminent;
        });
      }
    };

    void tick();
    const interval = setInterval(() => {
      // Once connected we keep polling; if never connected the first tick
      // already returned and this stays cheap (one request/min).
      void tick();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user]);

  // Drive the countdown once a prompt is showing.
  useEffect(() => {
    if (!prompt) return;
    setCountdown(COUNTDOWN_S);
    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(timer);
          goRecord(prompt);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [prompt, goRecord]);

  if (!prompt) return null;

  return (
    <div className="fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-brand-500/40 bg-ink-900/95 p-4 shadow-top backdrop-blur-md">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-500/15">
            <ClockIcon className="h-5 w-5 text-brand-300" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-strong">Tenés una reunión ahora</p>
            <p className="mt-0.5 truncate text-sm text-ink-300">{prompt.subject}</p>
            <p className="mt-1 text-xs text-ink-400">
              Empiezo a preparar la grabación en <span className="font-semibold text-brand-300">{countdown}s</span>.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => goRecord(prompt)}
                className="flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2.5 text-sm font-semibold text-on-accent hover:bg-brand-600"
              >
                <RecordIcon className="h-4 w-4" />
                Grabar ahora
              </button>
              <button
                type="button"
                onClick={() => dismiss(prompt)}
                className="rounded-lg bg-ink-800 px-3 py-2.5 text-sm font-medium text-ink-200 hover:bg-ink-700"
              >
                Ahora no
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={() => dismiss(prompt)}
            aria-label="Cerrar"
            className="rounded-full p-1 text-ink-400 hover:bg-ink-700 hover:text-strong"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
