import { useEffect, useRef, useState } from "react";

interface Props {
  /** Nombre de la plataforma, para los mensajes. */
  label: string;
  /** URL que va como src del iframe. */
  embedUrl: string;
  /** URL para abrir la llamada en su propio sitio si el iframe no sirve. */
  joinLink: string;
  /** Seguir con Unify al lado en vez de dentro (ver ExternalMeeting). */
  onFailure?: () => void;
}

// Cuánto esperamos antes de ofrecer la salida. Una sala de video tarda en
// levantar (permisos, media, servidores), así que apurarse sería peor que
// esperar: el cartel aparece sólo si a esta altura todavía no arrancó.
const SLOW_MS = 9000;

// Embed genérico por iframe, para las plataformas que SÍ permiten correr
// dentro de otra página (Whereby, Element Call).
//
// La parte importante es la salida de emergencia. Un iframe bloqueado por
// X-Frame-Options igual dispara `load` (carga la página de error del
// navegador), así que no hay forma confiable de detectar el bloqueo desde
// acá. En vez de adivinar, se ofrece siempre la salida: "¿No se ve? Abrila en
// su sitio y seguí con Unify al lado". Nunca queda un rectángulo en blanco sin
// explicación.
export default function IframeEmbed({ label, embedUrl, joinLink, onFailure }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const onFailureRef = useRef(onFailure);
  onFailureRef.current = onFailure;

  useEffect(() => {
    setLoaded(false);
    setSlow(false);
    const t = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => window.clearTimeout(t);
  }, [embedUrl]);

  return (
    <div className="relative h-full w-full bg-ink-950">
      <iframe
        title={`Reunión de ${label}`}
        src={embedUrl}
        onLoad={() => setLoaded(true)}
        className="h-full w-full border-0"
        // Sin esto la sala no puede pedir cámara ni micrófono desde adentro
        // del iframe, y la llamada entra muda y a oscuras.
        allow="camera; microphone; fullscreen; speaker; display-capture; autoplay; clipboard-write"
        allowFullScreen
      />

      {!loaded && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-sm text-ink-300">Abriendo la reunión de {label}…</p>
        </div>
      )}

      {slow && (
        <div className="absolute inset-x-0 bottom-0 border-t border-ink-700 bg-ink-900/95 px-4 py-3 backdrop-blur-md">
          <p className="text-xs leading-relaxed text-ink-300">
            ¿No se ve la reunión acá dentro? Algunas salas no permiten abrirse dentro de otra web.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <a
              href={joinLink}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => onFailureRef.current?.()}
              className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-on-accent hover:bg-brand-600"
            >
              Abrir en {label} y seguir con Unify al lado
            </a>
            <button
              type="button"
              onClick={() => setSlow(false)}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-ink-400 hover:bg-ink-800 hover:text-ink-100"
            >
              Se ve bien, gracias
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
