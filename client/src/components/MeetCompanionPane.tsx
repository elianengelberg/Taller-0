import { useEffect, useState } from "react";
import { useMeeting } from "../context/MeetingContext";
import { abrirVentanaReunion } from "../lib/ventanaReunion";

// La parte de la pantalla que corresponde a un Google Meet.
//
// Meet no se puede embeber (no tiene SDK y bloquea los iframes), así que la
// llamada de verdad vive en su pestaña o en su app y esto es lo que va AL
// LADO: los subtítulos con su traducción. Acá quedó una sola cosa además de
// eso -- el botón para abrir la reunión --, porque el código de la sala, el
// idioma y el estado ya viven en la cabecera de la pantalla: tenerlos también
// acá era la pila de franjas que había que atravesar para llegar a leer.
export default function MeetCompanionPane({
  meetLink,
  subtitleStage,
  compacto = false,
}: {
  meetLink: string;
  meetCode?: string;
  subtitleStage?: React.ReactNode;
  /** Pantalla chica (Split View): mandan los subtítulos, el botón se achica. */
  compacto?: boolean;
}) {
  const { meetState } = useMeeting();
  // Reloj para que "extensión conectada" se ponga viejo si dejan de llegar
  // reportes: sin esto, un estado de hace media hora parecía de ahora.
  const [ahora, setAhora] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setAhora(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, []);
  // Con la extensión conectada la persona ya está en la pestaña de Meet: el
  // botón grande de entrar no tiene a quién ayudar y sólo ocupa lugar.
  const enLaPestaña = meetState !== null && ahora - meetState.at < 30_000;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* En pantalla chica el botón se va: ahí el espacio es de los
          subtítulos, y abrir la reunión sigue estando en Ajustes. */}
      {!enLaPestaña && !compacto && (
        <div className={`px-4 ${compacto ? "pt-2" : "pt-3"}`}>
          <a
            href={meetLink}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              // Pasa por abrirVentanaReunion: si la app se lleva el enlace
              // (iPad, celular), la pestaña huérfana se cierra sola.
              e.preventDefault();
              abrirVentanaReunion(meetLink);
            }}
            className={`flex items-center justify-center gap-2 rounded-2xl border border-brand-500/60 px-4 text-sm font-semibold text-brand-200 hover:bg-brand-500/10 ${
              compacto ? "py-2" : "py-2.5"
            }`}
          >
            Abrir la reunión de Meet →
          </a>
          {!compacto && (
            <p className="mt-1.5 text-center text-[11px] leading-snug text-ink-400">
              La reunión se abre en su app o pestaña. Volvé acá para leer los subtítulos con su
              traducción.
            </p>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1">{subtitleStage}</div>
    </div>
  );
}
