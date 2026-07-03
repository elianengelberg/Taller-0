import { useEffect, useRef, useState } from "react";
import { explainError } from "../lib/explainError";

interface UseSpeechRecognitionOptions {
  lang: string;
  active: boolean;
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

export function useSpeechRecognition({ lang, active, onResult, onInterim }: UseSpeechRecognitionOptions) {
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
    // If every restart immediately errors again (e.g. a persistent network
    // block), onend -> start() -> onerror -> onend would otherwise loop
    // forever, hammering the API and draining battery for no benefit. Give
    // up after a handful of rapid failures instead of retrying forever.
    let consecutiveErrors = 0;
    let lastErrorAt = 0;
    setError(null);
    shouldRunRef.current = true;
    const recognition = new RecognitionCtor();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 5;

    recognition.onresult = (event) => {
      setError(null);
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          const alternatives: string[] = [];
          for (let j = 0; j < result.length; j++) {
            const alt = result[j]?.transcript?.trim();
            if (alt) alternatives.push(alt);
          }
          if (alternatives.length) onResultRef.current(alternatives);
        } else {
          const interim = result[0]?.transcript?.trim();
          if (interim) onInterimRef.current?.(interim);
        }
      }
    };

    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        shouldRunRef.current = false;
      }
      // "no-speech" and "aborted" are expected/transient (e.g. silence, or the
      // effect cleaning up to restart) -- not worth alarming the user about,
      // and don't count toward the failure backoff below.
      if (event.error === "no-speech" || event.error === "aborted") return;

      const now = Date.now();
      consecutiveErrors = now - lastErrorAt < 3000 ? consecutiveErrors + 1 : 1;
      lastErrorAt = now;
      if (consecutiveErrors >= 5) {
        // Stop the onend handler from restarting -- something is
        // persistently broken, not a one-off blip.
        shouldRunRef.current = false;
      }

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
    recognition.onend = () => {
      if (shouldRunRef.current) {
        try {
          recognition.start();
        } catch {
          // start() can throw if called while already starting; safe to ignore.
        }
      }
    };

    try {
      recognition.start();
    } catch {
      // ignore
    }

    return () => {
      cancelled = true;
      shouldRunRef.current = false;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.stop();
    };
  }, [supported, active, lang]);

  useEffect(() => {
    if (!active) setError(null);
  }, [active]);

  return { supported, error };
}
