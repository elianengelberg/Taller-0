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
  // Última traducción RESUELTA por línea+idioma, con el largo del texto que
  // tradujo. Cuando el servidor fusiona fragmentos el texto crece, la clave
  // exacta deja de existir por un momento y el subtítulo VOLVÍA al idioma
  // original hasta que llegara la traducción nueva: un parpadeo de idioma en
  // cada fusión. Esto hace de puente mientras tanto.
  const latestRef = useRef<Map<string, { len: number; value: string }>>(new Map());
  // Si el traductor del servidor no responde (no está configurado, o se cayó),
  // antes se descartaba el error en silencio: el usuario veía el texto original
  // y creía que la traducción estaba rota sin ninguna explicación. Ahora el
  // estado sale del hook para poder decirlo.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (targetLang === ORIGINAL_LANG) return;
    let cancelled = false;

    lines.forEach((line) => {
      // El largo del texto viaja en la clave: el servidor FUSIONA fragmentos
      // seguidos en una misma línea (misma id, texto que crece), y una
      // traducción hecha para el texto corto no vale para el largo. Con la
      // clave vieja (id solo), la línea fusionada quedaba traducida a medias
      // PARA SIEMPRE -- y el parche del servidor que llegaba después caía en
      // una clave ya ocupada y se ignoraba.
      const key = `${line.id}:${targetLang}:${line.text.length}`;
      // `in` y no truthiness: una traducción vacía legítima no debe
      // re-pedirse en loop para siempre.
      if (key in translations || inFlightRef.current.has(key)) return;
      if (shortLang(line.sourceLang) === shortLang(targetLang)) return;

      const len = line.text.length;
      const anotarUltima = (value: string) => {
        const shortKey = `${line.id}:${targetLang}`;
        const prev = latestRef.current.get(shortKey);
        if (!prev || prev.len <= len) latestRef.current.set(shortKey, { len, value });
      };

      const bundled = line.translations?.[shortLang(targetLang)];
      if (bundled) {
        anotarUltima(bundled);
        setTranslations((prev) => (key in prev ? prev : { ...prev, [key]: bundled }));
        return;
      }

      inFlightRef.current.add(key);
      translate(line.text, line.sourceLang, targetLang)
        .then((translated) => {
          anotarUltima(translated);
          if (!cancelled) setTranslations((prev) => ({ ...prev, [key]: translated }));
        })
        .then(() => {
          if (!cancelled) setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        })
        .finally(() => inFlightRef.current.delete(key));
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetLang, lines]);

  function getTranslation(line: { id: string; text: string }): string | undefined {
    if (targetLang === ORIGINAL_LANG) return undefined;
    const exacta = translations[`${line.id}:${targetLang}:${line.text.length}`];
    if (exacta !== undefined) return exacta;
    // Puente: el texto creció (fusión) y la traducción nueva todavía viaja.
    // Mostrar la anterior -- que es de un PREFIJO de este texto -- en vez de
    // saltar al idioma original y volver. Sólo si el texto actual es más
    // largo: una traducción de un texto MÁS largo diría cosas que ya no están.
    const puente = latestRef.current.get(`${line.id}:${targetLang}`);
    if (puente && puente.len < line.text.length) return puente.value;
    return undefined;
  }

  return { getTranslation, translationFailed: failed };
}
