import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import AiChatBox from "../components/AiChatBox";
import Button from "../components/Button";
import MarkdownText from "../components/MarkdownText";
import { DownloadIcon, SparklesIcon } from "../components/icons";
import Logo from "../components/Logo";
import RoleBadge from "../components/RoleBadge";
import {
  fetchFolders,
  fetchMeetingDetail,
  FolderSummary,
  generateMeetingReport,
  askMeetingAI,
  MeetingHistoryDetail,
  MeetingHistoryMessage,
  moveMeetingToFolderApi,
} from "../lib/api";
import { isExternalMeeting, meetingSourceLabel } from "../lib/meetingPlatforms";
import { groupConsecutive } from "../lib/transcriptGroups";
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

  return <MeetingDetailView meeting={meeting} />;
}

function MeetingDetailView({ meeting }: { meeting: MeetingHistoryDetail }) {
  const readOnly = Boolean(meeting.sharedView);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [folderId, setFolderId] = useState<string | null>(meeting.folderId);
  // Video <-> transcript sync: the player's current time drives which line is
  // highlighted, and clicking a line seeks the player.
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  // t=0 of the video in wall-clock ms: the recording's real start when we have
  // it, else the meeting start (a reasonable fallback for older recordings).
  const baseMs = new Date(meeting.recordingStartedAt ?? meeting.startedAt).getTime();

  function seekTo(offsetSec: number) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, offsetSec);
    void v.play().catch(() => {});
  }

  // Only owners get the move control -- a shared viewer can't refile someone
  // else's meeting.
  useEffect(() => {
    if (readOnly) return;
    fetchFolders().then(({ folders }) => setFolders(folders));
  }, [readOnly]);

  async function moveTo(target: string | null) {
    const prev = folderId;
    setFolderId(target); // optimistic
    const ok = await moveMeetingToFolderApi(meeting.id, target);
    if (!ok) setFolderId(prev);
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

        {readOnly ? (
          <p className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-ink-800 px-3 py-1 text-xs text-ink-300">
            Reunión compartida con vos (solo lectura)
          </p>
        ) : (
          <div className="mt-4 flex items-center gap-2">
            <label htmlFor="folder" className="text-xs text-ink-400">
              Carpeta:
            </label>
            <select
              id="folder"
              aria-label="Carpeta de la reunión"
              value={folderId ?? ""}
              onChange={(e) => moveTo(e.target.value || null)}
              className="rounded-lg border border-ink-600 bg-ink-800 px-2.5 py-1.5 text-xs text-strong focus:border-brand-400 focus:outline-none"
            >
              <option value="">Sin carpeta</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <MeetingReportCard meeting={meeting} />

        {meeting.recordingUrl && (
          <div className={`${cardClass} mt-6`}>
            <video
              ref={videoRef}
              controls
              src={meeting.recordingUrl}
              className="w-full rounded-lg"
              onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
            />
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
          <h2 className="mb-3 flex items-center justify-between gap-2 text-lg font-semibold text-strong">
            Transcripción y chat
            {meeting.recordingUrl && meeting.messages.length > 0 && (
              <span className="text-xs font-normal text-ink-400">Tocá una línea para saltar el video ahí</span>
            )}
          </h2>
          {meeting.messages.length === 0 ? (
            <p className="text-sm text-ink-400">No se guardó nada en esta reunión.</p>
          ) : meeting.recordingUrl ? (
            <SyncedTranscript
              messages={meeting.messages}
              baseMs={baseMs}
              currentTime={currentTime}
              onSeek={seekTo}
            />
          ) : (
            <ul className="space-y-3">
              {/* Consecutive VOICE entries from the same person merge into one
                  readable paragraph (chat messages stay individual: they're
                  discrete on purpose). */}
              {groupConsecutive(meeting.messages, (m) => ({
                speakerKey: m.kind === "transcript" ? `voz:${m.senderName}` : `chat:${m.id}`,
                timestamp: new Date(m.createdAt).getTime(),
              })).map((group) => {
                const m = group[0];
                return (
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
                    <p className="mt-1.5 text-sm leading-relaxed text-ink-100">
                      {group.map((g) => g.text).join(" ")}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtOffset(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Bolds words up to (and including) the current one -- a karaoke-style fill so
// you can see which word is being said as the video plays.
function highlightWords(text: string, uptoIdx: number): ReactNode[] {
  let word = -1;
  return text.split(/(\s+)/).map((tok, i) => {
    if (/^\s+$/.test(tok) || tok === "") return tok;
    word += 1;
    const cls =
      word === uptoIdx
        ? "font-bold text-strong"
        : word < uptoIdx
          ? "font-semibold text-ink-50"
          : "text-ink-300";
    return (
      <span key={i} className={cls}>
        {tok}
      </span>
    );
  });
}

// Transcript that follows the recording: each line carries its offset into the
// video (from real per-line timestamps); the line being spoken at the current
// playback time is highlighted and its words fill in, and clicking any line
// (or its timestamp) seeks the video there. Chat lines are placed on the same
// timeline but aren't "spoken", so they don't get the word-fill.
function SyncedTranscript({
  messages,
  baseMs,
  currentTime,
  onSeek,
}: {
  messages: MeetingHistoryMessage[];
  baseMs: number;
  currentTime: number;
  onSeek: (offsetSec: number) => void;
}) {
  const entries = useMemo(
    () => messages.map((m) => ({ ...m, offset: (new Date(m.createdAt).getTime() - baseMs) / 1000 })),
    [messages, baseMs]
  );
  const voice = useMemo(() => entries.filter((e) => e.kind === "transcript"), [entries]);

  const { activeId, wordIdx } = useMemo(() => {
    for (let i = 0; i < voice.length; i++) {
      const start = voice[i].offset;
      const words = voice[i].text.split(/\s+/).filter(Boolean);
      // Estimate the line's spoken length from its word count, but never run
      // past the next line's start (+ a little grace).
      const est = Math.max(1.5, words.length * 0.45);
      const end = i + 1 < voice.length ? Math.min(voice[i + 1].offset, start + est + 3) : start + est;
      if (currentTime >= start && currentTime < end) {
        const prog = end > start ? (currentTime - start) / (end - start) : 1;
        return { activeId: voice[i].id, wordIdx: Math.min(words.length - 1, Math.floor(prog * words.length)) };
      }
    }
    return { activeId: null as number | null, wordIdx: -1 };
  }, [voice, currentTime]);

  const activeRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeId]);

  return (
    <ul className="max-h-[26rem] space-y-2 overflow-y-auto pr-1">
      {entries.map((e) => {
        const active = e.kind === "transcript" && e.id === activeId;
        return (
          <li
            key={`${e.kind}-${e.id}`}
            ref={active ? activeRef : undefined}
            className={`rounded-xl border p-3 transition-colors ${
              active ? "border-brand-400 bg-brand-500/10" : "border-ink-700 bg-ink-800/60"
            }`}
          >
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-400">
              <button
                type="button"
                onClick={() => onSeek(e.offset)}
                title="Saltar a este momento del video"
                className="rounded bg-ink-700 px-1.5 py-0.5 font-mono text-[11px] font-medium text-brand-300 hover:bg-ink-600"
              >
                {fmtOffset(e.offset)}
              </button>
              <span className="font-semibold text-strong">{e.senderName}</span>
              {e.roleName && (
                <span className="rounded-full bg-ink-700 px-2 py-0.5 text-[11px] text-ink-200">
                  {e.roleName}
                </span>
              )}
              {e.kind === "chat" && (
                <span className="rounded-full bg-ink-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-400">
                  chat
                </span>
              )}
            </div>
            <p
              onClick={() => onSeek(e.offset)}
              className="mt-1.5 cursor-pointer text-sm leading-relaxed text-ink-100"
            >
              {active ? highlightWords(e.text, wordIdx) : e.text}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

// AI report: generated on demand, then persisted server-side so it's instant
// on later opens. Shows the saved report right away when there is one.
function MeetingReportCard({ meeting }: { meeting: MeetingHistoryDetail }) {
  const [report, setReport] = useState<string | null>(meeting.report);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasContent = meeting.messages.length > 0;

  async function generate(regenerate: boolean) {
    setLoading(true);
    setError(null);
    const res = await generateMeetingReport(meeting.id, regenerate);
    if (res.error) setError(res.error);
    else if (res.report) setReport(res.report);
    setLoading(false);
  }

  return (
    <div className={`${cardClass} mt-6`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-strong">
          <SparklesIcon className="h-5 w-5 text-brand-300" />
          Informe de la reunión
        </h2>
        {report && !loading && (
          <button
            type="button"
            onClick={() => generate(true)}
            className="text-xs font-medium text-ink-400 hover:text-brand-300"
          >
            Regenerar
          </button>
        )}
      </div>

      {report ? (
        <div className="mt-3">
          <MarkdownText text={report} />
        </div>
      ) : (
        <div className="mt-2">
          <p className="text-sm text-ink-400">
            {hasContent
              ? "Generá un informe con resumen, decisiones, tareas y participación, a partir de la transcripción."
              : "Esta reunión no tiene transcripción guardada, así que no hay con qué armar un informe."}
          </p>
          {hasContent && (
            <Button className="mt-3" onClick={() => generate(false)} disabled={loading}>
              {loading ? "Generando informe…" : "Generar informe con IA"}
            </Button>
          )}
        </div>
      )}
      {loading && report && <p className="mt-2 text-xs text-ink-400">Regenerando…</p>}
      {error && <p className="mt-2 text-sm text-brand-300">{error}</p>}
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

