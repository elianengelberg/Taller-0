import { useEffect, useId, useMemo, useRef } from "react";
import { useMeeting } from "../context/MeetingContext";
import { AUTO_LANG, ORIGINAL_LANG } from "../hooks/useLineTranslations";
import { LANGUAGES, shortLang } from "../lib/languages";
import { groupConsecutive } from "../lib/transcriptGroups";
import { GlobeIcon } from "./icons";
import RoleBadge from "./RoleBadge";
import SidePanel from "./SidePanel";

interface Props {
  onClose: () => void;
  targetLangChoice: string;
  resolvedTargetLang: string;
  onTargetLangChange: (lang: string) => void;
  getTranslation: (line: { id: string; text: string }) => string | undefined;
  spokenLang: string;
  onSpokenLangChange: (lang: string) => void;
  side?: "left" | "right";
}

export default function TranscriptPanel({
  onClose,
  targetLangChoice,
  resolvedTargetLang,
  onTargetLangChange,
  getTranslation,
  spokenLang,
  onSpokenLangChange,
  side,
}: Props) {
  const { meeting } = useMeeting();
  const bottomRef = useRef<HTMLDivElement>(null);

  const transcript = meeting?.transcript ?? [];
  // Paragraph blocks (Otter-style): consecutive lines from the same speaker
  // read as one flowing card instead of a stack of one-liners.
  // La etiqueta apunta al select: el lector de pantalla (y las pruebas) lo
  // encuentran por su texto.
  const idHablado = useId();
  const paragraphs = useMemo(
    () =>
      groupConsecutive(transcript, (line) => ({
        speakerKey: line.speakerId,
        timestamp: line.timestamp,
      })),
    [transcript]
  );

  // Follow new entries only when the reader is already at (or near) the
  // bottom -- yanking someone to the bottom while they're scrolled up
  // reading older content loses their place. Opening the panel still lands
  // at the latest entry.
  const firstScrollRef = useRef(true);
  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const container = el.closest(".overflow-y-auto");
    const nearBottom = container
      ? container.scrollHeight - container.scrollTop - container.clientHeight < 160
      : true;
    if (firstScrollRef.current || nearBottom) {
      el.scrollIntoView({ behavior: firstScrollRef.current ? "auto" : "smooth" });
    }
    firstScrollRef.current = false;
  }, [transcript.length]);

  return (
    <SidePanel
      title="Transcripción"
      onClose={onClose}
      side={side}
      headerExtra={
        <select
          aria-label="Idioma en el que ves los subtítulos"
          className="w-full rounded-lg border border-ink-600 bg-ink-800 px-2 py-1 text-xs text-strong focus:border-brand-400 focus:outline-none"
          value={targetLangChoice}
          onChange={(e) => onTargetLangChange(e.target.value)}
        >
          <option value={AUTO_LANG}>Automático (según tu idioma)</option>
          <option value={ORIGINAL_LANG}>Original (sin traducir)</option>
          {LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code}>
              Traducir a {lang.label}
            </option>
          ))}
        </select>
      }
    >
      <div className="mb-4 rounded-xl border border-ink-700 bg-ink-800/60 p-3">
        <label htmlFor={idHablado} className="mb-1.5 block text-xs font-medium text-ink-300">
          ¿En qué idioma estás hablando vos?
        </label>
        <select
          id={idHablado}
          className="w-full rounded-lg border border-ink-600 bg-ink-800 px-2.5 py-2 text-sm text-strong focus:border-brand-400 focus:outline-none"
          value={spokenLang}
          onChange={(e) => onSpokenLangChange(e.target.value)}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.label}
            </option>
          ))}
        </select>
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-500">
          Esto es distinto del selector de arriba ("Traducir a ..."): ese controla en qué
          idioma <span className="text-ink-400">vos ves</span> los subtítulos, y este en qué
          idioma la app entiende <span className="text-ink-400">lo que vos decís</span>. Si
          cambiás de idioma al hablar, cambialo acá para que te transcriba bien.
        </p>
      </div>

      {transcript.length === 0 ? (
        <p className="text-center text-sm text-ink-400">
          Todavía no se registró nada dicho en la reunión.
        </p>
      ) : (
        <ul className="space-y-3">
          {paragraphs.map((group) => {
            const first = group[0];
            const role = meeting?.roles.find((r) => r.id === first.roleId) ?? null;
            const originalText = group.map((l) => l.text).join(" ");
            // Per-line target text: lines already spoken in the target
            // language contribute their original; the rest wait on the
            // translation cache. The paragraph flips to "translated" only
            // when every piece is ready, so mixed-language text never shows.
            const wantTranslation = resolvedTargetLang !== ORIGINAL_LANG;
            const pieces = group.map((l) =>
              shortLang(l.sourceLang) === shortLang(resolvedTargetLang)
                ? l.text
                : getTranslation(l)
            );
            const anyForeign =
              wantTranslation &&
              group.some((l) => shortLang(l.sourceLang) !== shortLang(resolvedTargetLang));
            const translated =
              wantTranslation && anyForeign && pieces.every(Boolean)
                ? pieces.join(" ")
                : null;
            const isTranslating = anyForeign && !translated;
            return (
              <li key={first.id} className="rounded-xl border border-ink-700 bg-ink-800/60 p-3">
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-400">
                  <span className="font-semibold text-strong">{first.speakerName}</span>
                  {role && <RoleBadge role={role} size="sm" />}
                  <span className="ml-auto shrink-0 text-[11px] text-ink-500">
                    {new Date(first.timestamp).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>

                {translated ? (
                  <>
                    <p className="mt-1.5 flex items-start gap-1.5 text-sm leading-relaxed text-ink-100">
                      <GlobeIcon className="mt-1 h-3.5 w-3.5 shrink-0 text-brand-300" />
                      <span>{translated}</span>
                    </p>
                    <p className="mt-1 pl-5 text-xs leading-relaxed text-ink-500">{originalText}</p>
                  </>
                ) : (
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-100">
                    {originalText}
                    {isTranslating && (
                      <span className="ml-1.5 text-xs text-ink-500">(traduciendo…)</span>
                    )}
                  </p>
                )}
              </li>
            );
          })}
          <div ref={bottomRef} />
        </ul>
      )}
    </SidePanel>
  );
}
