import { useEffect, useRef, useState } from "react";
import Avatar from "./Avatar";
import { GlobeIcon } from "./icons";

// One caption row: a speaker's most recent finalized line, optionally with a
// translation. `id` changes when they start a fresh utterance.
export interface CaptionEntry {
  id: string;
  speakerId: string;
  speakerName: string;
  text: string;
  translatedText?: string;
}

interface Props {
  // The most recent finalized line per currently-relevant speaker, oldest
  // first. When several people talk at once these stack up (newest at the
  // bottom) instead of one caption flickering as it's replaced.
  lines?: CaptionEntry[];
  // The local speaker's own in-progress utterance, shown live at the very
  // bottom before it even finishes -- always more current than any finalized
  // line, and never sent anywhere until it finalizes.
  localInterim?: { speakerName: string; text: string; avatarUrl?: string | null } | null;
  // Devuelve el rol de quien habla (etiqueta + color) para mostrarlo junto al
  // nombre. Opcional: en una reunión propia los roles ya viajan en la línea.
  roleFor?: (speakerName: string) => { label: string; color: string } | null;
  // Foto de perfil de quien habla, para mostrarla junto al nombre como en
  // Zoom. Se busca por id de participante y, si ya se fue de la reunión, por
  // nombre. Devuelve null para invitados sin cuenta: ahí van las iniciales.
  avatarFor?: (speakerId: string, speakerName: string) => string | null;
}

// How long a caption stays on screen after its speaker's last update. Matches
// the server-side MERGE_WINDOW_MS so a continuation of the same thought folds
// into the still-visible line instead of looking like it vanished.
const HOLD_MS = 6000;

export default function LiveCaption({ lines = [], localInterim, roleFor, avatarFor }: Props) {
  // Per-speaker visible captions, each with its own "last changed" time so
  // they expire independently. Kept in a ref (not state) because the pruning
  // timer and the incoming-lines effect both mutate it; a tick counter drives
  // the re-renders.
  const visibleRef = useRef<Map<string, { entry: CaptionEntry; lastSeen: number; contentKey: string }>>(
    new Map()
  );
  const [, setTick] = useState(0);
  const rerender = () => setTick((n) => (n + 1) % 1_000_000);
  // On the very first render we register whatever's already in the transcript
  // as "stale" so opening a meeting mid-conversation doesn't flash its last
  // few captions on screen -- only speech that happens after we're here shows.
  const mountedRef = useRef(false);

  const linesKey = lines
    .map((l) => `${l.speakerId}:${l.id}:${l.text}:${l.translatedText ?? ""}`)
    .join("|");

  useEffect(() => {
    const now = performance.now();
    const map = visibleRef.current;
    // Sin líneas (la persona apagó los subtítulos) no hay nada que sostener:
    // antes las burbujas seguían en pantalla hasta vencer su tiempo, y
    // «ocultar» parecía no hacer nada.
    if (lines.length === 0 && map.size > 0) map.clear();
    for (const entry of lines) {
      const contentKey = `${entry.id}|${entry.text}`;
      const existing = map.get(entry.speakerId);
      const isNewContent = !existing || existing.contentKey !== contentKey;
      // A brand-new/changed utterance refreshes the timer; a translation
      // arriving later just updates the text without extending its life.
      const lastSeen = !mountedRef.current
        ? now - HOLD_MS - 1 // pre-existing on mount -> already expired
        : isNewContent
        ? now
        : existing!.lastSeen;
      map.set(entry.speakerId, { entry, lastSeen, contentKey });
    }
    mountedRef.current = true;
    rerender();
    // Content-keyed dep so this only runs when a caption actually changes, not
    // on every parent re-render (e.g. the active-speaker sampler ticking).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey]);

  // Drop captions once they age out, even if no new lines arrive.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = performance.now();
      let changed = false;
      for (const [id, v] of visibleRef.current) {
        if (now - v.lastSeen > HOLD_MS) {
          visibleRef.current.delete(id);
          changed = true;
        }
      }
      if (changed) rerender();
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  const now = performance.now();
  const active = Array.from(visibleRef.current.values())
    .filter((v) => now - v.lastSeen <= HOLD_MS)
    .sort((a, b) => a.lastSeen - b.lastSeen) // oldest on top, newest at the bottom
    .map((v) => v.entry);

  if (active.length === 0 && !localInterim) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex flex-col items-center gap-1.5 px-4">
      {active.map((entry) => (
        <CaptionBubble
          key={entry.speakerId}
          speakerName={entry.speakerName}
          avatarUrl={avatarFor?.(entry.speakerId, entry.speakerName) ?? null}
          role={roleFor?.(entry.speakerName) ?? null}
          text={entry.text}
          translatedText={entry.translatedText}
        />
      ))}
      {localInterim && (
        <CaptionBubble
          key="__interim"
          speakerName={localInterim.speakerName}
          avatarUrl={localInterim.avatarUrl ?? null}
          role={roleFor?.(localInterim.speakerName) ?? null}
          text={localInterim.text}
        />
      )}
    </div>
  );
}

function CaptionBubble({
  speakerName,
  avatarUrl,
  role,
  text,
  translatedText,
}: {
  speakerName: string;
  avatarUrl?: string | null;
  role?: { label: string; color: string } | null;
  text: string;
  translatedText?: string;
}) {
  const showingTranslation = Boolean(translatedText);
  return (
    <div className="caption-fade max-w-2xl rounded-2xl bg-black/75 px-4 py-2.5 text-center shadow-soft backdrop-blur-md ring-1 ring-white/10">
      {/* Grande: es el texto que se lee A LA DISTANCIA mientras se mira la
          reunión, no una nota al pie. */}
      <p className="text-base leading-snug text-on-accent sm:text-lg">
        {/* La foto va inline dentro del párrafo para que el texto siga fluyendo
            alrededor cuando la frase ocupa varias líneas, igual que en Zoom. */}
        <Avatar name={speakerName} src={avatarUrl} size={20} className="mr-1.5 align-middle" ring />
        {role && (
          <span
            className="mr-1.5 rounded-md px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase tracking-wide"
            style={{ color: role.color, background: `${role.color}26`, border: `1px solid ${role.color}66` }}
          >
            {role.label}
          </span>
        )}
        <span className="font-semibold text-brand-300">{speakerName}: </span>
        {showingTranslation ? translatedText : text}
      </p>
      {/* When translated, keep the original visible underneath (muted) so
          people can follow both what was said and its translation. */}
      {showingTranslation && (
        <p className="mt-1 flex items-center justify-center gap-1.5 text-xs leading-snug text-on-accent/60">
          <GlobeIcon className="h-3 w-3 shrink-0 text-brand-300/80" />
          <span className="italic">{text}</span>
        </p>
      )}
    </div>
  );
}
