import { useEffect, useRef } from "react";
import { useMeeting } from "../context/MeetingContext";
import { ORIGINAL_LANG } from "../hooks/useLineTranslations";
import { LANGUAGES } from "../lib/languages";
import { GlobeIcon } from "./icons";
import RoleBadge from "./RoleBadge";
import SidePanel from "./SidePanel";

interface Props {
  onClose: () => void;
  targetLang: string;
  onTargetLangChange: (lang: string) => void;
  getTranslation: (lineId: string) => string | undefined;
  spokenLang: string;
  onSpokenLangChange: (lang: string) => void;
}

export default function TranscriptPanel({
  onClose,
  targetLang,
  onTargetLangChange,
  getTranslation,
  spokenLang,
  onSpokenLangChange,
}: Props) {
  const { meeting } = useMeeting();
  const bottomRef = useRef<HTMLDivElement>(null);

  const transcript = meeting?.transcript ?? [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript.length]);

  return (
    <SidePanel
      title="Transcripción"
      onClose={onClose}
      headerExtra={
        <select
          className="rounded-lg border border-ink-600 bg-ink-800 px-2 py-1 text-xs text-white focus:border-brand-400 focus:outline-none"
          value={targetLang}
          onChange={(e) => onTargetLangChange(e.target.value)}
        >
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
        <label className="mb-1.5 block text-xs font-medium text-ink-300">
          ¿En qué idioma estás hablando vos?
        </label>
        <select
          className="w-full rounded-lg border border-ink-600 bg-ink-800 px-2.5 py-2 text-sm text-white focus:border-brand-400 focus:outline-none"
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
          {transcript.map((line) => {
            const role = meeting?.roles.find((r) => r.id === line.roleId) ?? null;
            const translated = getTranslation(line.id);
            const isTranslating = targetLang !== ORIGINAL_LANG && !translated;
            return (
              <li key={line.id} className="rounded-xl border border-ink-700 bg-ink-800/60 p-3">
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-400">
                  <span className="font-semibold text-white">{line.speakerName}</span>
                  {role && <RoleBadge role={role} size="sm" />}
                  <span className="ml-auto shrink-0 text-[11px] text-ink-500">
                    {new Date(line.timestamp).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>

                {translated ? (
                  <>
                    <p className="mt-1.5 flex items-start gap-1.5 text-sm text-ink-100">
                      <GlobeIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-300" />
                      {translated}
                    </p>
                    <p className="mt-1 pl-5 text-xs text-ink-500">{line.text}</p>
                  </>
                ) : (
                  <p className="mt-1.5 text-sm text-ink-100">
                    {line.text}
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
