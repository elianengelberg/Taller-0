import { ReactNode } from "react";

// Panel companion genérico: para las plataformas que reconocemos pero que NO
// se pueden embeber (Teams personal, Webex, Skype, Discord, o un enlace suelto
// de videollamada). La llamada vive en su propia pestaña y Unify corre al
// lado: subtítulos, traducción, transcripción, IA y grabación.
//
// Es exactamente el mismo trato que Google Meet, que tampoco se puede embeber.
// Antes estos enlaces terminaban en "la conexión embebida todavía no está
// disponible" y el usuario se quedaba sin nada; ahora se queda con todo lo que
// Unify realmente puede darle sin depender de la otra plataforma.
export default function ExternalCompanionPane({
  label,
  joinLink,
  subtitleStage,
}: {
  label: string;
  joinLink: string;
  subtitleStage?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink-800 px-4 py-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-brand-300">{label}</p>
          <p className="truncate text-sm text-strong">La llamada se abre en {label}</p>
        </div>
        <a
          href={joinLink}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto shrink-0 rounded-xl bg-brand-500 px-3.5 py-2 text-xs font-semibold text-on-accent hover:bg-brand-600"
        >
          Abrir en {label}
        </a>
        <span className="w-full text-[11px] text-ink-500">
          Dejá esta pantalla al lado de {label} para leer los subtítulos mientras hablan.
        </span>
      </div>

      <div className="min-h-0 flex-1">{subtitleStage}</div>
    </div>
  );
}
