import { ReactNode, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import AiChatBox from "../components/AiChatBox";
import Button from "../components/Button";
import { DownloadIcon } from "../components/icons";
import Logo from "../components/Logo";
import RoleBadge from "../components/RoleBadge";
import { askMeetingAI, fetchMeetingDetail, MeetingHistoryDetail } from "../lib/api";
import { isExternalMeeting, meetingSourceLabel } from "../lib/meetingPlatforms";
import { cardClass } from "../lib/ui";

export default function MeetingDetail() {
  const { id } = useParams<{ id: string }>();
  const [meeting, setMeeting] = useState<MeetingHistoryDetail | null | undefined>(undefined);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setError(false);
    setMeeting(undefined);
    fetchMeetingDetail(id)
      .then((data) => {
        if (!cancelled) setMeeting(data);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  if (error) {
    return (
      <StatusMessage text="No pudimos conectar con el servidor. Si hace rato que no se usa la app, puede estar 'despertando' (tarda hasta un minuto).">
        <Button variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>
          Reintentar
        </Button>
      </StatusMessage>
    );
  }
  if (meeting === undefined) {
    return <StatusMessage text="Cargando…" />;
  }
  if (meeting === null) {
    return <StatusMessage text="No encontramos esa reunión." />;
  }

  return (
    <div className="min-h-screen bg-ink-950 px-6 py-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center justify-between">
          <Logo />
          <Link to="/historial" className="text-sm font-medium text-ink-300 hover:text-strong">
            Volver al historial
          </Link>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-strong">Reunión de {meeting.hostName}</h1>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              isExternalMeeting(meeting.joinCode)
                ? "bg-brand-500/15 text-brand-300"
                : "bg-ink-700/70 text-ink-300"
            }`}
          >
            {meetingSourceLabel(meeting.joinCode)}
          </span>
        </div>
        <p className="mt-1 text-sm text-ink-400">
          {new Date(meeting.startedAt).toLocaleString([], {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          {meeting.participants.map((p) => {
            const role = meeting.roles.find((r) => r.id === p.roleId) ?? null;
            return (
              <span
                key={p.id}
                className="flex items-center gap-1.5 rounded-full bg-ink-800 px-2.5 py-1 text-xs text-strong"
              >
                {p.name}
                <RoleBadge role={role} size="sm" />
              </span>
            );
          })}
        </div>

        {meeting.recordingUrl && (
          <div className={`${cardClass} mt-6`}>
            <video controls src={meeting.recordingUrl} className="w-full rounded-lg" />
            <a
              href={meeting.recordingUrl}
              download
              className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand-300 transition-colors hover:text-brand-200"
            >
              <DownloadIcon className="h-4 w-4" />
              Descargar video
            </a>
          </div>
        )}

        <AiChatBox
          className="mt-6"
          title="Preguntale a la IA sobre esta reunión"
          description="Responde solo con lo que se dijo en esta reunión (chat y transcripción de voz) — no inventa información."
          placeholder="Ej: ¿Qué dijo Germán sobre el presupuesto?"
          onAsk={(q) => askMeetingAI(meeting.id, q)}
        />

        <div className={`${cardClass} mt-6`}>
          <h2 className="mb-3 text-lg font-semibold text-strong">Transcripción y chat</h2>
          {meeting.messages.length === 0 ? (
            <p className="text-sm text-ink-400">No se guardó nada en esta reunión.</p>
          ) : (
            <ul className="space-y-3">
              {meeting.messages.map((m) => (
                <li
                  key={`${m.kind}-${m.id}`}
                  className="rounded-xl border border-ink-700 bg-ink-800/60 p-3"
                >
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-400">
                    <span className="font-semibold text-strong">{m.senderName}</span>
                    {m.roleName && (
                      <span className="rounded-full bg-ink-700 px-2 py-0.5 text-[11px] text-ink-200">
                        {m.roleName}
                      </span>
                    )}
                    <span className="rounded-full bg-ink-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-400">
                      {m.kind === "chat" ? "chat" : "voz"}
                    </span>
                    <span className="ml-auto shrink-0 text-[11px] text-ink-500">
                      {new Date(m.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm text-ink-100">{m.text}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusMessage({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-ink-950 px-6 text-center">
      <Logo />
      <p className="max-w-sm text-sm text-ink-300">{text}</p>
      {children}
      <Link to="/historial" className="text-sm font-medium text-brand-300 hover:text-brand-200">
        Volver al historial
      </Link>
    </div>
  );
}

