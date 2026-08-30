import { useEffect, useRef, useState } from "react";
import { explainError } from "../lib/explainError";

interface UseSpeechRecognitionOptions {
  lang: string;
  active: boolean;
  /**
   * Cambiar este valor fuerza una sesión de reconocimiento nueva. Hace falta
   * porque un "not-allowed" (micrófono denegado) apaga el reintento
   * automático a propósito -- si no, el navegador quedaría en un bucle
   * infinito de errores. Con esto, un botón "Reintentar" puede volver a
   * encenderlo sin recargar la página.
   */
  key?: number;
  // Called once an utterance is finalized, with every candidate reading the
  // recognizer considered (ranked best-first) -- more signal than a single
  // guess for fixing a mis-heard word server-side.
  onResult: (alternatives: string[]) => void;
  // Called repeatedly while an utterance is still being recognized, so the
  // speaker sees their own caption update live instead of waiting for a
  // pause in speech. Purely local -- never sent anywhere.
  onInterim?: (text: string) => void;
}

function getRecognitionConstructor(): SpeechRecognitionConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  return window.SpeechRecognition || window.webkitSpeechRecognition;
}

const ERROR_MESSAGES: Record<string, string> = {
  "not-allowed": "El navegador bloqueó el acceso al micrófono para los subtítulos. Revisá los permisos del sitio.",
  "service-not-allowed": "El navegador bloqueó el acceso al micrófono para los subtítulos. Revisá los permisos del sitio.",
  network: "No se pudo conectar con el servicio de reconocimiento de voz (puede ser un bloqueador de red o extensión).",
  "audio-capture": "No encontramos un micrófono para captar los subtítulos.",
};

export function useSpeechRecognition({
  lang,
  active,
  key = 0,
  onResult,
  onInterim,
}: UseSpeechRecognitionOptions) {
  const [supported] = useState(() => Boolean(getRecognitionConstructor()));
  const [error, setError] = useState<string | null>(null);
  const onResultRef = useRef(onResult);
  const onInterimRef = useRef(onInterim);
  const shouldRunRef = useRef(false);
  onResultRef.current = onResult;
  onInterimRef.current = onInterim;

  useEffect(() => {
    if (!supported || !active) return;

    const RecognitionCtor = getRecognitionConstructor();
    if (!RecognitionCtor) return;

    let cancelled = false;
    // Fallas rápidas seguidas (la red del servicio de voz caída, un bloqueo):
    // NO apagan el reconocimiento -- antes cinco seguidas lo mataban PARA
    // SIEMPRE y los subtítulos quedaban "trabados" sin aviso hasta recargar.
    // Espacian los reintentos (hasta ~5 s) y se sigue insistiendo: cuando la
    // causa pasa, la voz vuelve sola. Sólo el permiso denegado corta.
    let consecutiveErrors = 0;
    let lastErrorAt = 0;
    let restartTimeout: ReturnType<typeof setTimeout> | undefined;
    setError(null);
    shouldRunRef.current = true;
    const recognition = new RecognitionCtor();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 5;

    // Lo interino que la sesión nunca confirmó. Cuando la sesión muere
    // (silencio, red, un stop), el navegador lo descarta: eran palabras
    // DICHAS que desaparecían de la transcripción. Se rescatan como final.
    let pendingInterim = "";
    const rescueInterim = () => {
      const texto = pendingInterim.trim();
      pendingInterim = "";
      if (texto) onResultRef.current([texto]);
    };

    recognition.onresult = (event) => {
      setError(null);
      consecutiveErrors = 0;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          const alternatives: string[] = [];
          for (let j = 0; j < result.length; j++) {
            const alt = result[j]?.transcript?.trim();
            if (alt) alternatives.push(alt);
          }
          pendingInterim = "";
          if (alternatives.length) onResultRef.current(alternatives);
        } else {
          const interim = result[0]?.transcript?.trim();
          if (interim) {
            pendingInterim = interim;
            onInterimRef.current?.(interim);
          }
        }
      }
    };

    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        rescueInterim();
        shouldRunRef.current = false;
      }
      // "no-speech" and "aborted" are expected/transient (e.g. silence, or the
      // effect cleaning up to restart) -- not worth alarming the user about,
      // and don't count toward the failure backoff below.
      if (event.error === "no-speech" || event.error === "aborted") return;

      const now = Date.now();
      consecutiveErrors = now - lastErrorAt < 3000 ? consecutiveErrors + 1 : 1;
      lastErrorAt = now;

      const known = ERROR_MESSAGES[event.error];
      if (known) {
        setError(known);
        return;
      }
      // Unrecognized error code: show it right away as a placeholder, then
      // swap in a plain-language explanation once it's ready (or leave the
      // raw code if that's not available) instead of showing nothing.
      setError(`Error de reconocimiento de voz (${event.error}).`);
      void explainError(event.error, "Error del reconocimiento de voz para subtítulos en un navegador.").then(
        (explanation) => {
          if (!cancelled) setError(explanation);
        }
      );
    };

    // The API stops itself after a pause in speech; restart it while captions
    // are still toggled on so it behaves like a continuous live transcript.
    // Con fallas recientes, el reintento se espacia (backoff) en vez de
    // martillar -- pero NUNCA deja de intentar mientras siga activo.
    recognition.onend = () => {
      rescueInterim();
      if (!shouldRunRef.current) return;
      const espera = consecutiveErrors > 0 ? Math.min(consecutiveErrors, 7) * 700 : 0;
      clearTimeout(restartTimeout);
      restartTimeout = setTimeout(() => {
        if (!shouldRunRef.current || cancelled) return;
        try {
          recognition.start();
        } catch {
          // start() can throw if called while already starting; safe to ignore.
        }
      }, espera);
    };

    try {
      recognition.start();
    } catch {
      // ignore
    }

    let reactivateTimeout: ReturnType<typeof setTimeout> | undefined;
    // Backgrounding a tab (locking the phone, switching apps) can make some
    // mobile browsers -- iOS Safari especially -- silently suspend the mic
    // without ever firing onerror or onend, so captions would just stop
    // forever with no signal that anything went wrong. Force a fresh
    // recognition session on return instead of leaving that zombie state,
    // and say so briefly so a stretch of silence right after doesn't look
    // like a bug.
    function handleVisibilityChange() {
      if (document.visibilityState !== "visible" || !shouldRunRef.current) return;
      try {
        recognition.stop();
      } catch {
        // Already stopped -- onend won't fire to restart it, so start it
        // directly instead.
        try {
          recognition.start();
        } catch {
          // ignore
        }
      }
      setError("Reactivando los subtítulos después de volver a esta pestaña…");
      clearTimeout(reactivateTimeout);
      reactivateTimeout = setTimeout(() => {
        if (!cancelled) setError(null);
      }, 6000);
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      shouldRunRef.current = false;
      // El desmontaje también rescata lo interino: onend ya no va a correr
      // (se anula abajo) y esas palabras estaban dichas.
      rescueInterim();
      clearTimeout(reactivateTimeout);
      clearTimeout(restartTimeout);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.stop();
    };
  }, [supported, active, lang, key]);

  useEffect(() => {
    if (!active) setError(null);
  }, [active]);

  return { supported, error };
}
