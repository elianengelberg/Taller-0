import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  CalendarEvent,
  disconnectCalendar,
  fetchUpcomingMeetings,
  startCalendarConnect,
} from "../lib/api";
import { ClockIcon, RecordIcon } from "./icons";

// Outlook/365 calendar card on the History page: connect the calendar, then
// see upcoming meetings with a one-tap "grabar" for those that have a join
// link. The background CalendarRecordWatcher handles the automatic prompt;
// this is the always-visible surface.
export default function CalendarPanel() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [state, setState] = useState<{
    loading: boolean;
    configured: boolean;
    connected: boolean;
    events: CalendarEvent[];
    error?: string;
  }>({ loading: true, configured: false, connected: false, events: [] });
  const [banner, setBanner] = useState<string | null>(null);

  async function load() {
    const res = await fetchUpcomingMeetings();
    setState({
      loading: false,
      configured: res.configured,
      connected: res.connected,
      events: res.events,
      error: res.error,
    });
  }

  useEffect(() => {
    load();
  }, []);

  // One-shot banner from the OAuth callback redirect (?calendar=connected|error).
  useEffect(() => {
    const status = searchParams.get("calendar");
    if (!status) return;
    setBanner(
      status === "connected"
        ? "¡Outlook conectado! Vas a ver tus próximas reuniones acá."
        : "No se pudo conectar Outlook. Probá de nuevo."
    );
    searchParams.delete("calendar");
    setSearchParams(searchParams, { replace: true });
    if (status === "connected") load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Not configured on the server at all -> hide the panel entirely (keeps the
  // history clean for deployments without Microsoft credentials).
  if (!state.loading && !state.configured) return null;

  return (
    <div className="mt-6 rounded-2xl border border-ink-700 bg-ink-900/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-strong">
          <ClockIcon className="h-4 w-4 text-brand-300" />
          Agenda de Outlook
        </h2>
        {state.connected ? (
          <button
            type="button"
            onClick={async () => {
              await disconnectCalendar();
              setState((s) => ({ ...s, connected: false, events: [] }));
            }}
            className="text-xs font-medium text-ink-400 hover:text-brand-300"
          >
            Desconectar
          </button>
        ) : null}
      </div>

      {banner && <p className="mt-2 text-xs text-brand-300">{banner}</p>}

      {!state.connected ? (
        <div className="mt-2">
          <p className="text-sm text-ink-400">
            Conectá tu calendario y acá vas a ver tus próximas reuniones. Cuando una esté por
            empezar, te avisamos y te ofrecemos grabarla con un toque.
          </p>
          <button
            type="button"
            onClick={() => startCalendarConnect()}
            className="mt-3 rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-on-accent hover:bg-brand-600"
          >
            Conectar Outlook
          </button>
        </div>
      ) : state.events.length === 0 ? (
        <p className="mt-2 text-sm text-ink-400">
          {state.error === "refresh-failed"
            ? "Se perdió el acceso al calendario. Volvé a conectar Outlook."
            : "No tenés reuniones próximas en las próximas horas."}
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {state.events.map((ev) => (
            <li
              key={ev.id}
              className="flex items-center justify-between gap-3 rounded-xl bg-ink-800/60 px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-strong">{ev.subject}</p>
                <p className="text-xs text-ink-400">
                  {new Date(ev.start).toLocaleString([], {
                    weekday: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {ev.platform && ev.platform !== "other" && (
                    <span className="ml-1.5 rounded-full bg-ink-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                      {platformLabel(ev.platform)}
                    </span>
                  )}
                </p>
              </div>
              {ev.joinUrl && (
                <a
                  href={`/externa?link=${encodeURIComponent(ev.joinUrl)}&rec=1`}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-500/15 px-3 py-1.5 text-xs font-semibold text-brand-300 hover:bg-brand-500/25"
                >
                  <RecordIcon className="h-3.5 w-3.5" />
                  Grabar
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function platformLabel(p: CalendarEvent["platform"]): string {
  switch (p) {
    case "google-meet":
      return "Meet";
    case "microsoft-teams":
      return "Teams";
    case "zoom":
      return "Zoom";
    default:
      return "";
  }
}
