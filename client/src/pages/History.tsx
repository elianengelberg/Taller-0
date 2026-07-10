import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import AccountMenu from "../components/AccountMenu";
import AiChatBox from "../components/AiChatBox";
import Button from "../components/Button";
import Logo from "../components/Logo";
import { askAllMeetingsAI, fetchMeetingsHistory, MeetingHistorySummary } from "../lib/api";
import { isExternalMeeting, meetingSourceLabel } from "../lib/meetingPlatforms";
import { cardClass } from "../lib/ui";

export default function History() {
  const [meetings, setMeetings] = useState<MeetingHistorySummary[] | null>(null);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    setMeetings(null);
    fetchMeetingsHistory()
      .then((data) => {
        if (!cancelled) setMeetings(data);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <div className="min-h-screen bg-ink-950 px-6 py-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-center justify-between gap-3">
          <Logo />
          <div className="flex items-center gap-4 sm:gap-6">
            <Link to="/" className="whitespace-nowrap text-sm font-medium text-ink-300 hover:text-white">
              Volver al inicio
            </Link>
            <AccountMenu />
          </div>
        </div>

        <h1 className="text-2xl font-bold text-white">Historial de reuniones</h1>
        <p className="mt-1 text-sm text-ink-400">
          Reuniones guardadas con su chat, transcripción y grabación (si se guardó una).
        </p>

        {!error && meetings !== null && meetings.length > 0 && (
          <AiChatBox
            className="mt-6"
            title="Preguntale a la IA sobre tus reuniones"
            description="Busca en todo tu historial, no solo en una reunión puntual — preguntale por fecha, por quién participó o por lo que se habló."
            placeholder='Ej: "¿qué se habló en mi última reunión?" o "¿tuve una reunión el 17 de junio?"'
            emptyHint="Esta IA busca en todas tus reuniones guardadas a la vez. Para preguntar sobre una en particular, también podés entrar a esa reunión y preguntarle ahí."
            onAsk={askAllMeetingsAI}
          />
        )}

        <div className="mt-8 space-y-3">
          {error && (
            <div className={`${cardClass} space-y-3`}>
              <p className="text-sm text-brand-300">
                No pudimos conectar con el servidor. Si hace rato que no se usa la app, puede
                estar "despertando" (tarda hasta un minuto la primera vez).
              </p>
              <Button variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>
                Reintentar
              </Button>
            </div>
          )}
          {!error && meetings === null && (
            <p className={`${cardClass} text-sm text-ink-400`}>Cargando…</p>
          )}
          {!error && meetings !== null && meetings.length === 0 && (
            <p className={`${cardClass} text-sm text-ink-400`}>
              Todavía no hay reuniones guardadas. Si el servidor no tiene una base de datos
              configurada, el historial no está disponible.
            </p>
          )}
          {!error &&
            meetings?.map((m) => (
              <Link
                key={m.id}
                to={`/historial/${m.id}`}
                className={`${cardClass} block transition hover:border-brand-400`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate font-semibold text-white">Reunión de {m.hostName}</p>
                      <SourceChip joinCode={m.joinCode} />
                    </div>
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

// Shows WHERE the meeting happened (Unify / Zoom / Teams / Jitsi) instead
// of the raw join code or external link, which was long and confusing.
function SourceChip({ joinCode }: { joinCode: string }) {
  const external = isExternalMeeting(joinCode);
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
        external ? "bg-brand-500/15 text-brand-300" : "bg-ink-700/70 text-ink-300"
      }`}
    >
      {meetingSourceLabel(joinCode)}
    </span>
  );
}
