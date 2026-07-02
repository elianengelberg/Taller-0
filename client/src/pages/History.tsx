import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Logo from "../components/Logo";
import { fetchMeetingsHistory, MeetingHistorySummary } from "../lib/api";
import { cardClass } from "../lib/ui";

export default function History() {
  const [meetings, setMeetings] = useState<MeetingHistorySummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMeetingsHistory().then((data) => {
      if (!cancelled) setMeetings(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen bg-ink-950 px-6 py-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-center justify-between">
          <Logo />
          <Link to="/" className="text-sm font-medium text-ink-300 hover:text-white">
            Volver al inicio
          </Link>
        </div>

        <h1 className="text-2xl font-bold text-white">Historial de reuniones</h1>
        <p className="mt-1 text-sm text-ink-400">
          Reuniones guardadas con su chat, transcripción y grabación (si se guardó una).
        </p>

        <div className="mt-8 space-y-3">
          {meetings === null && <p className="text-sm text-ink-400">Cargando…</p>}
          {meetings !== null && meetings.length === 0 && (
            <p className={`${cardClass} text-sm text-ink-400`}>
              Todavía no hay reuniones guardadas. Si el servidor no tiene una base de datos
              configurada, el historial no está disponible.
            </p>
          )}
          {meetings?.map((m) => (
            <Link
              key={m.id}
              to={`/historial/${m.id}`}
              className={`${cardClass} block transition hover:border-brand-400`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-white">
                    Reunión de {m.hostName} <span className="text-ink-500">· {m.joinCode}</span>
                  </p>
                  <p className="mt-1 text-sm text-ink-400">
                    {new Date(m.startedAt).toLocaleString([], {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                    {" · "}
                    {m.participants.length} participante{m.participants.length === 1 ? "" : "s"}
                    {" · "}
                    {m.messageCount} mensaje{m.messageCount === 1 ? "" : "s"}
                  </p>
                </div>
                {m.recordingUrl && (
                  <span className="shrink-0 rounded-full bg-brand-500/15 px-2.5 py-1 text-xs font-medium text-brand-300">
                    Con video
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
