import { FormEvent, ReactNode, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Button from "../components/Button";
import { SparklesIcon } from "../components/icons";
import Logo from "../components/Logo";
import RoleBadge from "../components/RoleBadge";
import { askMeetingAI, fetchMeetingDetail, MeetingHistoryDetail } from "../lib/api";
import { cardClass, inputClass } from "../lib/ui";

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
          <Link to="/historial" className="text-sm font-medium text-ink-300 hover:text-white">
            Volver al historial
          </Link>
        </div>

        <h1 className="text-2xl font-bold text-white">
          Reunión de {meeting.hostName} <span className="text-ink-500">· {meeting.joinCode}</span>
        </h1>
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
                className="flex items-center gap-1.5 rounded-full bg-ink-800 px-2.5 py-1 text-xs text-white"
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
              className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-brand-300 hover:text-brand-200"
            >
              Descargar video
            </a>
          </div>
        )}

        <AiAsk meetingId={meeting.id} />

        <div className={`${cardClass} mt-6`}>
          <h2 className="mb-3 text-lg font-semibold text-white">Transcripción y chat</h2>
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
                    <span className="font-semibold text-white">{m.senderName}</span>
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

interface QA {
  question: string;
  answer?: string;
  error?: string;
  loading: boolean;
}

function AiAsk({ meetingId }: { meetingId: string }) {
  const [question, setQuestion] = useState("");
  const [items, setItems] = useState<QA[]>([]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const q = question.trim();
    if (!q) return;
    setQuestion("");
    setItems((prev) => [...prev, { question: q, loading: true }]);
    const result = await askMeetingAI(meetingId, q);
    setItems((prev) =>
      prev.map((item, index) =>
        index === prev.length - 1
          ? { ...item, loading: false, answer: result.answer, error: result.error }
          : item
      )
    );
  }

  return (
    <div className={`${cardClass} mt-6`}>
      <div className="mb-3 flex items-center gap-2">
        <SparklesIcon className="h-5 w-5 text-brand-400" />
        <h2 className="text-lg font-semibold text-white">Preguntale a la IA sobre esta reunión</h2>
      </div>
      <p className="mb-3 text-xs text-ink-400">
        Responde solo con lo que se dijo en esta reunión (chat y transcripción de voz) — no
        inventa información.
      </p>

      {items.length > 0 && (
        <ul className="mb-3 space-y-3">
          {items.map((item, index) => (
            <li key={index} className="rounded-xl border border-ink-700 bg-ink-800/60 p-3">
              <p className="text-sm font-semibold text-white">{item.question}</p>
              {item.loading ? (
                <p className="mt-1 text-sm text-ink-400">Pensando…</p>
              ) : item.error ? (
                <p className="mt-1 text-sm text-red-400">{item.error}</p>
              ) : (
                <p className="mt-1 text-sm text-ink-100">{item.answer}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <input
          className={`${inputClass} py-2.5 text-sm`}
          placeholder="Ej: ¿Qué dijo Germán sobre el presupuesto?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={500}
        />
        <Button type="submit" className="px-4 py-2.5 text-sm" disabled={!question.trim()}>
          Preguntar
        </Button>
      </form>
    </div>
  );
}
