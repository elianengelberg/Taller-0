import { useEffect, useRef, useState } from "react";

// Reconocimiento de voz sobre una PISTA de audio (no el micrófono): el audio
// de la reunión que entra por la captura de pantalla/pestaña. Es lo que hace
// que los DEMÁS -- que hablan por Zoom, Meet o la app que sea, sin Unify --
// aparezcan en los subtítulos y la transcripción, y no sólo quien tiene Unify
// abierto (que se transcribe aparte, por su micrófono).
//
// Necesita el Web Speech de Chrome 139+ (start(pista) llegó junto con
// SpeechRecognition.available). En un Chrome más viejo start(pista) IGNORA el
// argumento y escucharía el micrófono DOS veces: ahí directamente no se
// arranca, y `soportado` queda en false para que la UI lo cuente.
//
// Sólo resultados finales: lo interino del audio ajeno ensuciaría el globo de
// subtítulos de la propia voz (hay un solo carril interino en pantalla).

type Ctor = typeof window.SpeechRecognition & {
  available?: (opts: { langs: string[] }) => Promise<string>;
};

export function useReconocimientoDePista({
  track,
  lang,
  onFinal,
}: {
  track: MediaStreamTrack | null;
  lang: string;
  onFinal: (alternatives: string[]) => void;
}) {
  const [soportado, setSoportado] = useState(true);
  // El callback vive en un ref: cambiarlo no tiene que reiniciar la escucha.
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => {
    if (!track) return;
    const Reconocedor = (window.SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: Ctor }).webkitSpeechRecognition) as
      | Ctor
      | undefined;
    if (!Reconocedor || typeof Reconocedor.available !== "function") {
      setSoportado(false);
      return;
    }
    setSoportado(true);

    let activa = true;
    let fallasSeguidas = 0;
    const rec = new Reconocedor();
    rec.lang = lang;
    rec.continuous = true;
    // Los interinos se piden pero NO se muestran (el globo interino en
    // pantalla es de la propia voz): sirven para el RESCATE de abajo. Sin
    // ellos, cuando la sesión moría a mitad de una frase, esas palabras del
    // audio de la reunión desaparecían sin dejar rastro.
    rec.interimResults = true;
    // 5 lecturas candidatas, igual que el micrófono: más hipótesis para que
    // la IA correctora del servidor reconstruya la palabra que se dijo.
    rec.maxAlternatives = 5;
    let interinoPendiente = "";
    const rescatarInterino = () => {
      const texto = interinoPendiente.trim();
      interinoPendiente = "";
      if (texto) onFinalRef.current([texto]);
    };
    rec.onresult = (ev: SpeechRecognitionEvent) => {
      fallasSeguidas = 0;
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (!res.isFinal) {
          interinoPendiente = res[0]?.transcript?.trim() ?? interinoPendiente;
          continue;
        }
        const alternativas: string[] = [];
        for (let j = 0; j < res.length && j < 5; j++) {
          const texto = res[j]?.transcript?.trim();
          if (texto && !alternativas.includes(texto)) alternativas.push(texto);
        }
        interinoPendiente = "";
        if (alternativas.length > 0) onFinalRef.current(alternativas);
      }
    };
    rec.onerror = (ev: SpeechRecognitionErrorEvent) => {
      if (ev.error !== "no-speech" && ev.error !== "aborted") fallasSeguidas += 1;
    };
    rec.onend = () => {
      // Antes de relevantar, lo interino sin confirmar se rescata: la sesión
      // que murió no lo va a confirmar nunca.
      rescatarInterino();
      // Se corta solo tras un silencio; relevantarlo es lo que lo hace
      // continuo. NUNCA se rinde del todo (antes, ocho fallas seguidas lo
      // apagaban PARA SIEMPRE y la reunión quedaba muda hasta recargar):
      // espacia los reintentos y sigue -- cuando la red vuelve, vuelve.
      if (!activa || track.readyState === "ended") return;
      setTimeout(() => {
        if (!activa) return;
        try {
          (rec as unknown as { start: (t: MediaStreamTrack) => void }).start(track);
        } catch {
          // Ya estaba arrancando: inofensivo.
        }
      }, Math.min(fallasSeguidas, 7) * 700);
    };
    try {
      (rec as unknown as { start: (t: MediaStreamTrack) => void }).start(track);
    } catch {
      setSoportado(false);
      return;
    }
    return () => {
      activa = false;
      rescatarInterino();
      try {
        rec.stop();
      } catch {
        // Ya estaba parado.
      }
    };
  }, [track, lang]);

  return { soportado };
}
