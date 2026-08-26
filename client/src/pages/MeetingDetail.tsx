import { memo, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import AiChatBox from "../components/AiChatBox";
import Button from "../components/Button";
import MarkdownText from "../components/MarkdownText";
import { DownloadIcon, SparklesIcon } from "../components/icons";
import Logo from "../components/Logo";
import RoleBadge from "../components/RoleBadge";
import {
  AiVideoFrame,
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
import { analizarReunion, seguirPalabras } from "../lib/meetingAnalytics";
import { fetchTrackedWords } from "../lib/api";
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


// La IA "ve" el video: el navegador -- que ya tiene la grabación en el
// reproductor -- la recorre a N momentos parejos, dibuja cada cuadro en un
// canvas y manda JPEGs chicos junto con la pregunta. El servidor nunca
// procesa video (sin ffmpeg, sin descargas): sólo recibe imágenes acotadas.
//
// Se usa un <video> oculto propio (no el del reproductor visible) por dos
// motivos: no patear la posición donde la persona está mirando, y poder pedir
// crossOrigin="anonymous" sin arriesgar la reproducción visible -- si el
// bucket no manda CORS, este video falla y simplemente no hay fotogramas
// (la IA responde igual, desde la transcripción).
const FRAME_COUNT = 6;
const FRAME_WIDTH = 480;

async function captureVideoFrames(url: string): Promise<AiVideoFrame[]> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";
    const frames: AiVideoFrame[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeAttribute("src");
      video.load();
      resolve(frames);
    };
    // Nunca colgar la pregunta por culpa de la captura.
    const timeout = setTimeout(finish, 20_000);

    video.addEventListener("error", () => { clearTimeout(timeout); finish(); });
    video.addEventListener("loadedmetadata", async () => {
      let dur = video.duration;
      // Los webm que produce MediaRecorder -- o sea, TODAS nuestras
      // grabaciones -- declaran duración Infinity en los metadatos. El truco
      // estándar: pedir un instante enorme; el navegador se ve obligado a
      // calcular la duración real y la corrige.
      if (!Number.isFinite(dur) || dur <= 0) {
        dur = await new Promise<number>((res) => {
          const listo = () => {
            if (Number.isFinite(video.duration) && video.duration > 0) {
              video.removeEventListener("durationchange", listo);
              video.removeEventListener("seeked", listo);
              res(video.duration);
            }
          };
          video.addEventListener("durationchange", listo);
          video.addEventListener("seeked", listo);
          video.currentTime = 1e9;
          setTimeout(() => res(video.duration), 6000);
        });
      }
      if (!Number.isFinite(dur) || dur <= 0) { clearTimeout(timeout); finish(); return; }
      // Momentos parejos, evitando el primer y el último instante (suelen ser
      // negro de arranque o el cierre de la llamada).
      const times = Array.from({ length: FRAME_COUNT }, (_, i) => ((i + 0.5) / FRAME_COUNT) * dur);
      const canvas = document.createElement("canvas");
      const scale = FRAME_WIDTH / Math.max(1, video.videoWidth);
      canvas.width = FRAME_WIDTH;
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const g = canvas.getContext("2d");
      if (!g || canvas.height <= 1) { clearTimeout(timeout); finish(); return; }
      let i = 0;
      const next = () => {
        if (i >= times.length) { clearTimeout(timeout); finish(); return; }
        video.currentTime = times[i];
      };
      video.addEventListener("seeked", () => {
        try {
          g.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
          frames.push({ atSec: Math.floor(times[i]), data: dataUrl.split(",")[1] ?? "" });
        } catch {
          // Canvas contaminado (bucket sin CORS): sin fotogramas y a otra cosa.
          clearTimeout(timeout);
          frames.length = 0;
          finish();
          return;
        }
        i += 1;
        next();
      });
      next();
    });
    video.src = url;
  });
}

function MeetingDetailView({ meeting }: { meeting: MeetingHistoryDetail }) {
  const readOnly = Boolean(meeting.sharedView);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [folderId, setFolderId] = useState<string | null>(meeting.folderId);
  // Video <-> transcript sync: the player's current time drives which line is
  // highlighted (read via rAF inside SyncedTranscript, so the whole page doesn't
  // re-render on every timeupdate), and clicking a line seeks the player.
  const videoRef = useRef<HTMLVideoElement>(null);
  // t=0 of the video in wall-clock ms: the recording's real start when we have
  // it, else the meeting start (a reasonable fallback for older recordings).
  const baseMs = new Date(meeting.recordingStartedAt ?? meeting.startedAt).getTime();
  // El servidor guarda las grabaciones sólo de audio con extensión .m4a/.weba
  // (ver server/src/storage.ts), que es lo único que distingue una de otra
  // desde acá.
  const audioOnlyRecording = /\.(m4a|weba)(\?|$)/i.test(meeting.recordingUrl ?? "");

  // Fotogramas para la IA, capturados UNA vez y reusados entre preguntas.
  const framesRef = useRef<AiVideoFrame[] | null>(null);
  async function askWithVideo(question: string) {
    if (meeting.recordingUrl && !audioOnlyRecording && framesRef.current === null) {
      framesRef.current = await captureVideoFrames(meeting.recordingUrl).catch(() => []);
    }
    return askMeetingAI(meeting.id, question, framesRef.current ?? []);
  }

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
    <div className="min-h-screen bg-ink-950 px-4 py-10 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center justify-between gap-3">
          <Logo />
          <Link to="/historial" className="whitespace-nowrap text-sm font-medium text-ink-300 hover:text-strong">
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

        {/* La vista de reproducción (estilo Read AI): el video y la
            transcripción sincronizada VIVEN JUNTOS, lado a lado en pantallas
            grandes. La transcripción corre en su propio panel con scroll: la
            frase que se está diciendo se ilumina y el panel la sigue solo,
            mientras el video queda fijo a la vista. */}
        {meeting.recordingUrl && (
          <div className="mt-6 items-start gap-4 lg:grid lg:grid-cols-5">
            <div className={`${cardClass} lg:sticky lg:top-4 lg:col-span-3`}>
              {/* Una grabación automática puede ser sólo audio (capturar la
                  pantalla exige un gesto del usuario que no existe al entrar).
                  Un <video> con audio suelto se ve como un rectángulo negro
                  roto, así que mostramos el reproductor que corresponde -- el
                  mismo ref sirve para los dos, y la sincronización con la
                  transcripción funciona igual porque ambos son HTMLMediaElement. */}
              {audioOnlyRecording ? (
                <audio
                  ref={videoRef as React.RefObject<HTMLVideoElement> & React.RefObject<HTMLAudioElement>}
                  controls
                  src={meeting.recordingUrl}
                  className="w-full"
                />
              ) : (
                <video
                  ref={videoRef}
                  controls
                  src={meeting.recordingUrl}
                  className="w-full rounded-lg"
                />
              )}
              <a
                href={meeting.recordingUrl}
                download
                className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand-300 transition-colors hover:text-brand-200"
              >
                <DownloadIcon className="h-4 w-4" />
                {audioOnlyRecording ? "Descargar audio" : "Descargar video"}
              </a>
            </div>

            <div className={`${cardClass} mt-6 lg:col-span-2 lg:mt-0`}>
              <h2 className="text-lg font-semibold text-strong">Palabra por palabra</h2>
              <p className="mt-1 text-xs leading-relaxed text-ink-400">
                Lo que se está diciendo se ilumina mientras el video corre. Tocá cualquier frase
                para saltar a ese momento.
              </p>
              {meeting.messages.length === 0 ? (
                <p className="mt-3 text-sm text-ink-400">No se guardó nada en esta reunión.</p>
              ) : (
                <div className="mt-3 max-h-[70vh] overflow-y-auto pr-1 lg:max-h-[34rem]">
                  <SyncedTranscript
                    messages={meeting.messages}
                    baseMs={baseMs}
                    videoRef={videoRef}
                    onSeek={seekTo}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        <ResumenTiles messages={meeting.messages} />

        <AiChatBox
          className="mt-6"
          title="Preguntale a la IA sobre esta reunión"
          description={
            meeting.recordingUrl && !audioOnlyRecording
              ? "Responde con lo que se dijo (chat y transcripción) y además MIRA el video grabado: podés preguntarle por algo que se mostró en pantalla."
              : "Responde solo con lo que se dijo en esta reunión (chat y transcripción de voz) — no inventa información."
          }
          placeholder="Ej: ¿Qué dijo Germán? ¿Qué se mostró en pantalla?"
          onAsk={askWithVideo}
        />

        <ParticipacionPanel messages={meeting.messages} />

        <SeguimientoPanel messages={meeting.messages} />

        {/* Sin grabación, la transcripción va acá abajo como lista simple.
            Con grabación NO se repite: ya vive sincronizada junto al video. */}
        {!meeting.recordingUrl && (
        <div className={`${cardClass} mt-6`}>
          <h2 className="mb-3 flex items-center justify-between gap-2 text-lg font-semibold text-strong">
            Transcripción y chat
          </h2>
          {meeting.messages.length === 0 ? (
            <p className="text-sm text-ink-400">No se guardó nada en esta reunión.</p>
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
        )}
      </div>
    </div>
  );
}

// La fila de métricas de un vistazo (estilo Read AI): duración, gente,
// palabras y ritmo, sacadas del mismo transcripto que todo lo demás.
function ResumenTiles({ messages }: { messages: MeetingHistoryMessage[] }) {
  const a = useMemo(() => analizarReunion(messages), [messages]);
  if (a.hablantes.length === 0) return null;
  const tiles = [
    { valor: a.duracionMin >= 1 ? `${Math.round(a.duracionMin)} min` : "<1 min", nombre: "Duración" },
    { valor: String(a.hablantes.length), nombre: a.hablantes.length === 1 ? "Persona habló" : "Personas hablaron" },
    { valor: a.totalPalabras.toLocaleString("es"), nombre: "Palabras" },
    { valor: a.ritmoGlobal ? `${a.ritmoGlobal}/min` : "—", nombre: "Ritmo" },
  ];
  return (
    <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.nombre} className="rounded-2xl border border-ink-700 bg-ink-800 px-4 py-3 text-center shadow-soft">
          <p className="font-display text-xl font-bold tracking-tight text-strong">{t.valor}</p>
          <p className="mt-0.5 text-xs text-ink-400">{t.nombre}</p>
        </div>
      ))}
    </div>
  );
}

function fmtOffset(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Bolds words up to (and including) the current one -- a karaoke-style fill so
// you can see which word is being said as the video plays.
// Las palabras de una línea hablada: la que se está diciendo va en negrita,
// las ya dichas quedan marcadas, y CADA palabra es clickeable -- tocarla salta
// el video al instante estimado en que se dijo (interpolación lineal dentro de
// la ventana de la línea; es un aproximado honesto, no un timestamp exacto).
function highlightWords(
  text: string,
  uptoIdx: number,
  onWord?: (wordIdx: number, wordCount: number) => void
): ReactNode[] {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  let word = -1;
  return text.split(/(\s+)/).map((tok, i) => {
    if (/^\s+$/.test(tok) || tok === "") return tok;
    word += 1;
    const idx = word;
    const cls =
      word === uptoIdx
        ? "font-bold text-strong"
        : word < uptoIdx
          ? "font-semibold text-ink-50"
          : "text-ink-300";
    return (
      <span
        key={i}
        className={`${cls}${onWord ? " cursor-pointer hover:underline decoration-brand-400/60 underline-offset-2" : ""}`}
        onClick={
          onWord
            ? (e) => {
                e.stopPropagation();
                onWord(idx, wordCount);
              }
            : undefined
        }
      >
        {tok}
      </span>
    );
  });
}

type SyncEntry = MeetingHistoryMessage & {
  offset: number;
  /** Fin estimado de la línea hablada (misma fórmula que computeAt). */
  end: number;
};

/** Momento estimado en que se dice la palabra `wordIdx` de la línea. */
function wordTime(entry: SyncEntry, wordIdx: number, wordCount: number): number {
  if (wordCount <= 0 || entry.end <= entry.offset) return entry.offset;
  return entry.offset + (wordIdx / wordCount) * (entry.end - entry.offset);
}

// One transcript/chat line. Memoized so that, as playback advances, only the
// line whose active state actually changed re-renders -- not the whole list on
// every animation frame (that full re-render was the source of the stutter).
const TranscriptLineItem = memo(function TranscriptLineItem({
  entry,
  active,
  wordIdx,
  onSeek,
  liRef,
}: {
  entry: SyncEntry;
  active: boolean;
  wordIdx: number;
  onSeek: (offsetSec: number) => void;
  liRef?: React.Ref<HTMLLIElement>;
}) {
  return (
    <li
      ref={liRef}
      className={`rounded-xl border p-3 transition-colors ${
        active ? "border-brand-400 bg-brand-500/10" : "border-ink-700 bg-ink-800/60"
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-400">
        <button
          type="button"
          onClick={() => onSeek(entry.offset)}
          title="Saltar a este momento del video"
          className="rounded bg-ink-700 px-1.5 py-0.5 font-mono text-[11px] font-medium text-brand-300 hover:bg-ink-600"
        >
          {fmtOffset(entry.offset)}
        </button>
        <span className="font-semibold text-strong">{entry.senderName}</span>
        {entry.roleName && (
          <span className="rounded-full bg-ink-700 px-2 py-0.5 text-[11px] text-ink-200">
            {entry.roleName}
          </span>
        )}
        {entry.kind === "chat" && (
          <span className="rounded-full bg-ink-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-400">
            chat
          </span>
        )}
      </div>
      <p
        onClick={() => onSeek(entry.offset)}
        title={entry.kind === "transcript" ? "Tocá una palabra para saltar a ese instante" : undefined}
        className="mt-1.5 cursor-pointer text-sm leading-relaxed text-ink-100"
      >
        {entry.kind === "transcript"
          ? highlightWords(entry.text, active ? wordIdx : -1, (w, n) => onSeek(wordTime(entry, w, n)))
          : entry.text}
      </p>
    </li>
  );
});

// Transcript that follows the recording: each line carries its offset into the
// video (from real per-line timestamps); the line being spoken at the current
// playback time is highlighted and its words fill in, and clicking any line
// (or its timestamp) seeks the video there. Chat lines are placed on the same
// timeline but aren't "spoken", so they don't get the word-fill.
//
// The playback position is read straight off the <video> via requestAnimation-
// Frame while it plays (plus the seek/pause/timeupdate events), and we only
// push new React state when the active line or word actually changes -- so the
// follow-along stays smooth instead of stuttering, and paused/seeked positions
// are tracked too.
function SyncedTranscript({
  messages,
  baseMs,
  videoRef,
  onSeek,
}: {
  messages: MeetingHistoryMessage[];
  baseMs: number;
  videoRef: React.RefObject<HTMLVideoElement>;
  onSeek: (offsetSec: number) => void;
}) {
  const entries = useMemo<SyncEntry[]>(() => {
    const base = messages.map((m) => ({
      ...m,
      offset: (new Date(m.createdAt).getTime() - baseMs) / 1000,
      end: 0,
    }));
    // La ventana estimada de cada línea hablada: mismo cálculo que computeAt,
    // así el clic por palabra y el relleno en negrita no discrepan jamás.
    const voz = base.filter((e) => e.kind === "transcript");
    for (let i = 0; i < voz.length; i++) {
      const words = voz[i].text.split(/\s+/).filter(Boolean);
      const est = Math.max(1.5, words.length * 0.45);
      voz[i].end =
        i + 1 < voz.length ? Math.min(voz[i + 1].offset, voz[i].offset + est + 3) : voz[i].offset + est;
    }
    return base;
  }, [messages, baseMs]);
  const voice = useMemo(() => entries.filter((e) => e.kind === "transcript"), [entries]);

  const [active, setActive] = useState<{ id: number | null; wordIdx: number }>({ id: null, wordIdx: -1 });
  const activeRef = useRef(active);
  activeRef.current = active;

  // Which line is being spoken at time t, and how far into its words we are.
  const computeAt = useCallback(
    (t: number): { id: number | null; wordIdx: number } => {
      for (let i = 0; i < voice.length; i++) {
        const start = voice[i].offset;
        const words = voice[i].text.split(/\s+/).filter(Boolean);
        // La ventana viene precalculada en entries (la misma que usa el clic
        // por palabra), así negrita y salto nunca discrepan.
        const end = voice[i].end;
        if (t >= start && t < end) {
          const prog = end > start ? (t - start) / (end - start) : 1;
          return { id: voice[i].id, wordIdx: Math.min(words.length - 1, Math.floor(prog * words.length)) };
        }
      }
      return { id: null, wordIdx: -1 };
    },
    [voice]
  );

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let raf = 0;
    const sync = () => {
      const next = computeAt(v.currentTime);
      const cur = activeRef.current;
      if (next.id !== cur.id || next.wordIdx !== cur.wordIdx) setActive(next);
    };
    const loop = () => {
      sync();
      raf = requestAnimationFrame(loop);
    };
    const startLoop = () => {
      if (!raf) raf = requestAnimationFrame(loop);
    };
    const stopLoop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      sync(); // settle on the exact paused/ended position
    };
    v.addEventListener("play", startLoop);
    v.addEventListener("playing", startLoop);
    v.addEventListener("pause", stopLoop);
    v.addEventListener("ended", stopLoop);
    v.addEventListener("seeked", sync);
    v.addEventListener("timeupdate", sync); // covers programmatic seeks while paused
    if (v.paused) sync();
    else startLoop();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      v.removeEventListener("play", startLoop);
      v.removeEventListener("playing", startLoop);
      v.removeEventListener("pause", stopLoop);
      v.removeEventListener("ended", stopLoop);
      v.removeEventListener("seeked", sync);
      v.removeEventListener("timeupdate", sync);
    };
  }, [computeAt, videoRef]);

  const activeLiRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    activeLiRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active.id]);

  return (
    <ul className="max-h-[26rem] space-y-2 overflow-y-auto pr-1">
      {entries.map((e) => {
        const isActive = e.kind === "transcript" && e.id === active.id;
        return (
          <TranscriptLineItem
            key={`${e.kind}-${e.id}`}
            entry={e}
            active={isActive}
            wordIdx={isActive ? active.wordIdx : -1}
            onSeek={onSeek}
            liRef={isActive ? activeLiRef : undefined}
          />
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

// El seguimiento de palabras: cuántas veces se dijeron TUS palabras clave en
// ESTA reunión, quién las dijo y en qué frases. La lista se administra en el
// Historial (tarjeta "Seguimiento de palabras"); el conteo es la función pura
// seguirPalabras sobre el transcripto ya guardado.
function SeguimientoPanel({ messages }: { messages: MeetingHistoryMessage[] }) {
  const [palabras, setPalabras] = useState<string[]>([]);
  useEffect(() => {
    fetchTrackedWords().then(setPalabras);
  }, []);
  const resultados = useMemo(() => seguirPalabras(messages, palabras), [messages, palabras]);
  if (!palabras.length) return null;

  const dichas = resultados.filter((r) => r.veces > 0);
  const noDichas = resultados.filter((r) => r.veces === 0);

  return (
    <div className={`${cardClass} mt-6`}>
      <h2 className="text-lg font-semibold text-strong">Seguimiento de palabras</h2>
      <p className="mt-1 text-sm text-ink-400">
        Tus palabras clave en esta reunión. La lista se cambia desde el Historial.
      </p>

      {dichas.length === 0 && (
        <p className="mt-3 text-sm text-ink-400">
          Ninguna de tus palabras seguidas apareció en esta reunión.
        </p>
      )}

      <div className="mt-4 space-y-4">
        {dichas.map((r) => (
          <div key={r.palabra}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="font-medium text-strong">«{r.palabra}»</span>
              <span className="shrink-0 tabular-nums text-ink-300">
                {r.veces} {r.veces === 1 ? "vez" : "veces"}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-ink-400">
              {r.porQuien.map((q) => `${q.nombre} (${q.veces})`).join(" · ")}
            </p>
            {r.ejemplos.length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {r.ejemplos.map((e, i) => (
                  <li key={i} className="rounded-lg bg-ink-800/60 px-3 py-1.5 text-xs leading-relaxed text-ink-300">
                    {e}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      {noDichas.length > 0 && dichas.length > 0 && (
        <p className="mt-4 text-xs text-ink-500">
          Sin menciones: {noDichas.map((r) => `«${r.palabra}»`).join(", ")}
        </p>
      )}
    </div>
  );
}

// Participación y coaching: quién habló cuánto, a qué ritmo, con cuántas
// muletillas. Todo calculado del transcripto (meetingAnalytics), sin IA ni
// costo. Es la analítica que Read AI cobra; acá viene de fábrica, sobre la
// misma reunión que además tuvo subtítulos traducidos en vivo.
function ParticipacionPanel({ messages }: { messages: MeetingHistoryMessage[] }) {
  const a = useMemo(() => analizarReunion(messages), [messages]);
  if (a.hablantes.length === 0) return null;

  return (
    <div className={`${cardClass} mt-6`}>
      <h2 className="text-lg font-semibold text-strong">Participación</h2>
      <p className="mt-1 text-sm text-ink-400">
        {a.hablantes.length} {a.hablantes.length === 1 ? "persona habló" : "personas hablaron"} · {a.totalPalabras.toLocaleString("es")} palabras
        {a.duracionMin >= 1 ? ` · ${Math.round(a.duracionMin)} min` : ""}
        {a.ritmoGlobal ? ` · ${a.ritmoGlobal} palabras/min` : ""}
      </p>

      <div className="mt-4 space-y-3">
        {a.hablantes.map((h) => (
          <div key={h.nombre}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate font-medium text-strong">{h.nombre}</span>
              <span className="shrink-0 tabular-nums text-ink-300">{h.porcentaje}%</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-ink-800">
              <div
                className="h-full rounded-full bg-brand-500"
                style={{ width: `${Math.max(h.porcentaje, 2)}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-ink-400">
              {h.palabras.toLocaleString("es")} palabras · {h.intervenciones} {h.intervenciones === 1 ? "intervención" : "intervenciones"}
              {h.ritmo ? ` · ${h.ritmo} palabras/min` : ""}
              {h.muletillas > 0 ? ` · ${h.muletillas} ${h.muletillas === 1 ? "muletilla" : "muletillas"}` : ""}
            </p>
          </div>
        ))}
      </div>

      {a.masHablo && a.menosHablo && a.masHablo !== a.menosHablo && (
        <p className="mt-4 rounded-lg bg-ink-800/60 px-3 py-2 text-xs leading-relaxed text-ink-300">
          <span className="font-semibold text-ink-200">{a.masHablo}</span> fue quien más habló y{" "}
          <span className="font-semibold text-ink-200">{a.menosHablo}</span> el que menos. Una reunión pareja
          suele dar mejores resultados: si buscás más participación, invitá a quienes hablaron poco a sumar.
        </p>
      )}
    </div>
  );
}
