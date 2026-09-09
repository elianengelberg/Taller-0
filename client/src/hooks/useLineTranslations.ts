import { useEffect, useRef, useState } from "react";
import { shortLang } from "../lib/languages";
import { idiomaEfectivo } from "../lib/idioma";
import { translate } from "../lib/translate";

export const ORIGINAL_LANG = "original";
// Resolved to the viewer's own spoken language (live -- follows it if they
// change it) by whoever owns the `targetLang` state, not by this hook.
export const AUTO_LANG = "auto";

interface TranslatableLine {
  id: string;
  text: string;
  sourceLang: string;
  speakerName?: string;
  provisional?: boolean;
  // Translations the server already computed at broadcast time (see
  // TranscriptLine), keyed by short language code -- using these instead of
  // firing a request skips a whole network + translation round trip.
  translations?: Record<string, string>;
}

// Huella corta del texto. La clave llevaba sólo el LARGO: una corrección de
// la IA que cambia una palabra por otra del mismo largo ("banda" -> "venda")
// caía en la misma clave y la traducción vieja quedaba pegada para siempre.
function huella(texto: string): string {
  let h = 5381;
  for (let i = 0; i < texto.length; i++) h = ((h << 5) + h + texto.charCodeAt(i)) | 0;
  return `${texto.length}.${(h >>> 0).toString(36)}`;
}
function claveDe(line: { id: string; text: string }, targetLang: string): string {
  return `${line.id}:${targetLang}:${huella(line.text)}`;
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
  // Cuántas traducciones se piden A LA VEZ. En una reunión en vivo las líneas
  // llegan de a una y esto no se nota, pero una reunión GUARDADA son
  // trescientas líneas de golpe: pedirlas todas juntas es una avalancha que
  // el servidor corta por su propio límite y la mitad queda sin traducir.
  // Salen de a tandas: cuando una vuelve, arranca la siguiente.
  const A_LA_VEZ = 6;
  // Se mueve cada vez que una traducción vuelve (con o sin suerte) para que
  // el efecto se vuelva a correr y salga la tanda siguiente.
  const [vuelta, setVuelta] = useState(0);

  useEffect(() => {
    if (targetLang === ORIGINAL_LANG) return;
    let cancelled = false;
    let enVuelo = inFlightRef.current.size;

    // DE LA ÚLTIMA HACIA ATRÁS. Con el cupo de arriba, el orden importa: lo
    // que se está leyendo AHORA es el final de la lista. Yendo de la primera
    // a la última, una reunión larga que recién se manda a traducir dejaría
    // el subtítulo del momento para el final -- justo al revés de lo que hace
    // falta. Las de arriba llegan igual, en las tandas siguientes.
    const enOrdenDeLectura = lines.map((line, i) => ({ line, i })).reverse();

    enOrdenDeLectura.forEach(({ line, i }) => {
      // El largo del texto viaja en la clave: el servidor FUSIONA fragmentos
      // seguidos en una misma línea (misma id, texto que crece), y una
      // traducción hecha para el texto corto no vale para el largo. Con la
      // clave vieja (id solo), la línea fusionada quedaba traducida a medias
      // PARA SIEMPRE -- y el parche del servidor que llegaba después caía en
      // una clave ya ocupada y se ignoraba.
      // Mientras la IA no corrigió la línea (salió al instante, cruda), no
      // se traduce: en un segundo llega la versión buena y se traduce ESA.
      // Pero sólo se espera por las ÚLTIMAS: si una línea quedó atrás y
      // sigue provisional, esa corrección ya no va a llegar (se cortó la
      // conexión, se reinició el servidor, quien hablaba se fue) y antes
      // esa frase se quedaba sin traducir PARA SIEMPRE. Traducir la cruda
      // es mucho mejor que dejarla en un idioma que no se entiende.
      if (line.provisional && i >= lines.length - 2) return;
      const key = claveDe(line, targetLang);
      // `in` y no truthiness: una traducción vacía legítima no debe
      // re-pedirse en loop para siempre.
      if (key in translations || inFlightRef.current.has(key)) return;
      // La etiqueta es el idioma CONFIGURADO, no el de la frase: si te
      // hablan en inglés con el oído en español, la línea llega "es-AR" y
      // se quedaba en inglés. Se decide por lo que dice el texto.
      const fuente = idiomaEfectivo(line.text, line.sourceLang);
      if (fuente === shortLang(targetLang)) return;

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

      // Esta tanda ya está llena: el resto sale cuando vuelva alguna.
      if (enVuelo >= A_LA_VEZ) return;
      enVuelo++;
      inFlightRef.current.add(key);
      // Las líneas anteriores viajan de contexto: "no lo veo" se traduce
      // distinto según de qué venían hablando.
      const contexto = lines
        .slice(0, Math.max(0, i))
        .slice(-3)
        .map((l) => `${l.speakerName ?? ""}: ${l.text}`.slice(0, 240));
      translate(line.text, fuente, targetLang, contexto)
        .then((translated) => {
          anotarUltima(translated);
          // Sin mirar `cancelled`: la clave lleva el id Y la huella del texto,
          // así que esta traducción es de ESTA frase y vale igual aunque
          // mientras tanto haya entrado otra línea (que es lo normal en una
          // reunión). Antes se descartaba y había que volver a pedirla.
          setTranslations((prev) => (key in prev ? prev : { ...prev, [key]: translated }));
          if (!cancelled) setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        })
        .finally(() => {
          inFlightRef.current.delete(key);
          setVuelta((v) => v + 1);
        });
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetLang, lines, vuelta]);

  function getTranslation(line: { id: string; text: string }): string | undefined {
    if (targetLang === ORIGINAL_LANG) return undefined;
    const exacta = translations[claveDe(line, targetLang)];
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
