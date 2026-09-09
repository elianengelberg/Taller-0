import { ReactNode } from "react";
import { abrirVentanaReunion } from "../lib/ventanaReunion";

// La parte de la pantalla para una reunión que vive en OTRA app (Zoom, Teams,
// o cualquier enlace que no se pueda embeber). Igual que con Meet: acá va el
// botón para abrirla y, debajo, los subtítulos. De qué reunión se trata y en
// qué idioma se lee ya lo dice la cabecera.
export default function ExternalCompanionPane({
  label,
  joinLink,
  nota,
  subtitleStage,
  compacto = false,
}: {
  label: string;
  joinLink: string;
  /** Por qué la llamada va afuera y no adentro (si hubo un intento fallido). */
  nota?: string;
  subtitleStage?: ReactNode;
  compacto?: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`px-4 ${compacto ? "pt-2" : "pt-3"}`}>
        <a
          href={joinLink}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            e.preventDefault();
            abrirVentanaReunion(joinLink);
          }}
          className={`flex items-center justify-center gap-2 rounded-2xl border border-brand-500/60 px-4 text-sm font-semibold text-brand-200 hover:bg-brand-500/10 ${
            compacto ? "py-2" : "py-2.5"
          }`}
        >
          Abrir la reunión en {label} →
        </a>
        {nota && (
          <p role="note" className="mt-1.5 text-center text-[11px] leading-relaxed text-warn">
            {nota}
          </p>
        )}
        {!compacto && !nota && (
          <p className="mt-1.5 text-center text-[11px] leading-snug text-ink-400">
            La llamada se abre en {label}. Volvé acá para leer los subtítulos con su traducción.
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1">{subtitleStage}</div>
    </div>
  );
}
