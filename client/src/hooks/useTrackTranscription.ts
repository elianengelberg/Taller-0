import { useEffect, useRef, useState } from "react";

interface UseTrackTranscriptionOptions {
  /** La pista de audio a transcribir (el audio de la pantalla compartida). */
  track: MediaStreamTrack | null;
  lang: string;
  onResult: (alternatives: string[]) => void;
}

// Transcribe una pista de audio ARBITRARIA -- el audio de la pantalla
// compartida: un video, una presentación con sonido -- usando la entrada de
// MediaStreamTrack del Web Speech API (Chrome 139+). El micrófono no tiene
// nada que ver acá: esa transcripción la lleva useSpeechRecognition.
//
// La detección de soporte importa de verdad: en un Chrome viejo,
// recognition.start(pista) IGNORA el argumento en silencio y escucharía el
// micrófono -- duplicando cada línea de voz como si fuera de la pantalla.
// start(pista) llegó en la misma tanda que el método estático available()
// (Chrome 139), así que available() es la marca de que el argumento se
// respeta. Sin ella, este hook no arranca nada.
export function useTrackTranscription({ track, lang, onResult }: UseTrackTranscriptionOptions) {
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const [supported] = useState(() => {
    if (typeof window === "undefined") return false;
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    return Boolean(Ctor && typeof (Ctor as unknown as { available?: unknown }).available === "function");
  });

  useEffect(() => {
    if (!supported || !track || track.readyState !== "live") return;
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) return;

    let activo = true;
    // Las fallas en cadena (sin red hacia el servicio de voz) ESPACIAN los
    // reintentos, pero no lo apagan: antes cinco seguidas lo dejaban mudo
    // PARA SIEMPRE sin aviso. Cuando la causa pasa, la escucha vuelve sola.
    let fallas = 0;
    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = true;
    // Interinos sólo para el RESCATE: si la sesión muere a mitad de una
    // frase, esas palabras estaban dichas y se emiten igual. No se muestran.
    rec.interimResults = true;
    rec.maxAlternatives = 5;
    let interinoPendiente = "";
    const rescatarInterino = () => {
      const texto = interinoPendiente.trim();
      interinoPendiente = "";
      if (texto) onResultRef.current([texto]);
    };
    const prender = () => {
      try {
        (rec.start as unknown as (t?: MediaStreamTrack) => void)(track);
      } catch {
        /* ya estaba arrancando */
      }
    };

    rec.onresult = (event) => {
      fallas = 0;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result.isFinal) {
          interinoPendiente = result[0]?.transcript?.trim() ?? interinoPendiente;
          continue;
        }
        const alternatives: string[] = [];
        for (let j = 0; j < result.length; j++) {
          const alt = result[j]?.transcript?.trim();
          if (alt) alternatives.push(alt);
        }
        interinoPendiente = "";
        if (alternatives.length) onResultRef.current(alternatives);
      }
    };
    rec.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      fallas += 1;
    };
    rec.onend = () => {
      rescatarInterino();
      if (!activo || track.readyState !== "live") return;
      setTimeout(() => {
        if (activo) prender();
      }, Math.min(fallas, 7) * 700);
    };

    const alTerminar = () => {
      activo = false;
      rescatarInterino();
      try { rec.stop(); } catch { /* ya parado */ }
    };
    track.addEventListener("ended", alTerminar);
    prender();

    return () => {
      activo = false;
      track.removeEventListener("ended", alTerminar);
      rescatarInterino();
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try { rec.stop(); } catch { /* ya parado */ }
    };
  }, [supported, track, lang]);

  return { supported };
}
