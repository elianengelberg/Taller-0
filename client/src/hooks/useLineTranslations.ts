import { useEffect, useRef, useState } from "react";
import { shortLang } from "../lib/languages";
import { translate } from "../lib/translate";

export const ORIGINAL_LANG = "original";
// Resolved to the viewer's own spoken language (live -- follows it if they
// change it) by whoever owns the `targetLang` state, not by this hook.
export const AUTO_LANG = "auto";

interface TranslatableLine {
  id: string;
  text: string;
  sourceLang: string;
  // Translations the server already computed at broadcast time (see
  // TranscriptLine), keyed by short language code -- using these instead of
  // firing a request skips a whole network + translation round trip.
  translations?: Record<string, string>;
}

// Shared by the live caption overlay and the transcript panel so both read
// from (and populate) the same cache instead of firing duplicate requests.
export function useLineTranslations(lines: TranslatableLine[], targetLang: string) {
  const [translations, setTranslations] = useState<Record<string, string>>({});
  // Keys with a request already in flight: the effect below re-runs on every
  // new transcript line but reads a render-time snapshot of `translations`,
  // so without this a line whose translation hasn't resolved yet would get
  // requested again on each re-run.
  const inFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (targetLang === ORIGINAL_LANG) return;
    let cancelled = false;

    lines.forEach((line) => {
      const key = `${line.id}:${targetLang}`;
      if (translations[key] || inFlightRef.current.has(key)) return;
      if (shortLang(line.sourceLang) === shortLang(targetLang)) return;

      const bundled = line.translations?.[shortLang(targetLang)];
      if (bundled) {
        setTranslations((prev) => (prev[key] ? prev : { ...prev, [key]: bundled }));
        return;
      }

      inFlightRef.current.add(key);
      translate(line.text, line.sourceLang, targetLang)
        .then((translated) => {
          if (!cancelled) setTranslations((prev) => ({ ...prev, [key]: translated }));
        })
        .catch(() => {})
        .finally(() => inFlightRef.current.delete(key));
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetLang, lines]);

  function getTranslation(lineId: string): string | undefined {
    if (targetLang === ORIGINAL_LANG) return undefined;
    return translations[`${lineId}:${targetLang}`];
  }

  return { getTranslation };
}
