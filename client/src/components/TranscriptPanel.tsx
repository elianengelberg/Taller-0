import { useEffect, useRef, useState } from "react";
import { useMeeting } from "../context/MeetingContext";
import { LANGUAGES, shortLang } from "../lib/languages";
import { translate } from "../lib/translate";
import { GlobeIcon } from "./icons";
import RoleBadge from "./RoleBadge";
import SidePanel from "./SidePanel";

const ORIGINAL = "original";

export default function TranscriptPanel({ onClose }: { onClose: () => void }) {
  const { meeting } = useMeeting();
  const [targetLang, setTargetLang] = useState(ORIGINAL);
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const bottomRef = useRef<HTMLDivElement>(null);

  const transcript = meeting?.transcript ?? [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript.length]);

  useEffect(() => {
    if (targetLang === ORIGINAL) return;
    let cancelled = false;

    transcript.forEach((line) => {
      const key = `${line.id}:${targetLang}`;
      if (translations[key]) return;
      if (shortLang(line.sourceLang) === shortLang(targetLang)) return;

      translate(line.text, line.sourceLang, targetLang)
        .then((translated) => {
          if (!cancelled) setTranslations((prev) => ({ ...prev, [key]: translated }));
        })
        .catch(() => {});
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetLang, transcript]);

  return (
    <SidePanel
      title="Transcripción"
      onClose={onClose}
      headerExtra={
        <select
          className="rounded-lg border border-sand-300 bg-white px-2 py-1 text-xs text-ink-800 focus:border-brand-400 focus:outline-none"
          value={targetLang}
          onChange={(e) => setTargetLang(e.target.value)}
        >
          <option value={ORIGINAL}>Original</option>
          {LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.label}
            </option>
          ))}
        </select>
      }
    >
      {transcript.length === 0 ? (
        <p className="mt-6 text-center text-sm text-ink-500">
          Activá los subtítulos (ícono de "CC") para empezar a registrar quién dice qué.
        </p>
      ) : (
        <ul className="space-y-3">
          {transcript.map((line) => {
            const role = meeting?.roles.find((r) => r.id === line.roleId) ?? null;
            const key = `${line.id}:${targetLang}`;
            const translated = targetLang !== ORIGINAL ? translations[key] : undefined;
            return (
              <li key={line.id} className="rounded-xl border border-sand-200 p-3">
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-500">
                  <span className="font-semibold text-ink-900">{line.speakerName}</span>
                  {role && <RoleBadge role={role} size="sm" />}
                  <span className="ml-auto shrink-0 text-[11px] text-ink-400">
                    {new Date(line.timestamp).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                <p className="mt-1.5 text-sm text-ink-900">{line.text}</p>
                {translated && (
                  <p className="mt-1 flex items-start gap-1 text-sm italic text-brand-700">
                    <GlobeIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {translated}
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
