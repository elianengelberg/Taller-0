import { useEffect, useRef, useState } from "react";

interface UseSpeechRecognitionOptions {
  lang: string;
  active: boolean;
  onResult: (text: string) => void;
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

export function useSpeechRecognition({ lang, active, onResult }: UseSpeechRecognitionOptions) {
  const [supported] = useState(() => Boolean(getRecognitionConstructor()));
  const [error, setError] = useState<string | null>(null);
  const onResultRef = useRef(onResult);
  const shouldRunRef = useRef(false);
  onResultRef.current = onResult;

  useEffect(() => {
    if (!supported || !active) return;

    const RecognitionCtor = getRecognitionConstructor();
    if (!RecognitionCtor) return;

    setError(null);
    shouldRunRef.current = true;
    const recognition = new RecognitionCtor();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = false;

    recognition.onresult = (event) => {
      setError(null);
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          const text = result[0]?.transcript.trim();
          if (text) onResultRef.current(text);
        }
      }
    };

    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        shouldRunRef.current = false;
      }
      // "no-speech" and "aborted" are expected/transient (e.g. silence, or the
      // effect cleaning up to restart) -- not worth alarming the user about.
      if (event.error !== "no-speech" && event.error !== "aborted") {
        setError(ERROR_MESSAGES[event.error] ?? `Error de reconocimiento de voz (${event.error}).`);
      }
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
