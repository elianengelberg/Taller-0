import { useEffect, useRef } from "react";
import { GlobeIcon } from "./icons";

export interface StageLine {
  id: string;
  speakerName: string;
  text: string;
  translated?: string;
}

interface Props {
  /** De más vieja a más nueva; la última se destaca. */
  lines: StageLine[];
  roleFor?: (speakerName: string) => { label: string; color: string } | null;
  /** Lo que se está diciendo ahora mismo (aún sin cerrar la frase). */
  interim?: string | null;
  interimSpeaker?: string;
  /** Nombre del idioma al que se traduce, o null si no se traduce. */
  targetLabel: string | null;
  /** El traductor del servidor no está respondiendo. */
  translationFailed?: boolean;
  /** El reconocimiento de voz está escuchando. */
  listening: boolean;
  /** Cuántas personas hay en la capa de Unify. */
  participantCount: number;
}

// Pantalla de subtítulos para usar AL LADO de la reunión.
//
// En una reunión externa la llamada vive en otra app o pestaña (Meet no se
// puede embeber), así que un cartelito que aparece y se va en seis segundos no
// sirve: cuando mirás Meet, no lo ves. Esto es lo contrario: texto grande, las
// últimas frases siempre presentes, pensado para tener Unify en media pantalla
// (o en otro dispositivo) y leer sin perderse nada.
export default function CompanionSubtitleStage({
  lines,
  roleFor,
  interim,
  interimSpeaker,
  targetLabel,
  translationFailed,
  listening,
  participantCount,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [lines.length, interim]);

  const empty = lines.length === 0 && !interim;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Estado: qué está pasando, en una línea */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ink-800 px-4 py-2 text-[11px] text-ink-400">
        <span className="flex items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 rounded-full ${listening ? "animate-pulse bg-accent-green" : "bg-ink-500"}`}
            aria-hidden
          />
          {listening ? "Escuchando tu micrófono" : "Micrófono en pausa"}
        </span>
        <span className="flex items-center gap-1.5">
          <GlobeIcon className="h-3 w-3" />
          {targetLabel ? `Traduciendo a ${targetLabel}` : "Sin traducir"}
        </span>
        {participantCount > 1 && <span>{participantCount} en Unify</span>}
      </div>

      {translationFailed && targetLabel && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[11px] leading-snug text-amber-200">
          No estamos pudiendo traducir en este momento, así que ves el texto original. Si sigue
          igual, puede faltar configurar la traducción en el servidor.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <p className="text-base font-medium text-ink-200">Los subtítulos aparecen acá</p>
            <p className="max-w-sm text-sm leading-relaxed text-ink-400">
              Hablá y vas a ver lo que decís, con su traducción. Para que también se transcriba a
              los demás, tienen que abrir Unify con este mismo enlace.
            </p>
            <p className="max-w-sm rounded-xl border border-dashed border-ink-600 px-3 py-2 text-xs leading-relaxed text-ink-400">
              En celular o tablet, dejá la reunión en <b className="text-ink-200">altavoz</b> y sin
              auriculares: así el micrófono llega a captar también lo que dicen los demás.
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {lines.map((line, i) => {
              const role = roleFor?.(line.speakerName) ?? null;
              const isLast = i === lines.length - 1 && !interim;
              return (
                <div key={line.id} className={isLast ? "" : "opacity-60"}>
                  <p className="mb-1 flex flex-wrap items-center gap-1.5 text-xs">
                    {role && (
                      <span
                        className="rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                        style={{
                          color: role.color,
                          background: `${role.color}26`,
                          border: `1px solid ${role.color}66`,
                        }}
                      >
                        {role.label}
                      </span>
                    )}
                    <span className="font-semibold text-brand-300">{line.speakerName}</span>
                  </p>
                  {/* Cuando hay traducción, ESA es la lectura principal (a eso
                      vino el usuario) y el original queda debajo, más chico. */}
                  <p className="text-xl leading-snug text-strong sm:text-2xl">
                    {line.translated || line.text}
                  </p>
                  {line.translated && line.translated !== line.text && (
                    <p className="mt-1 text-sm italic leading-snug text-ink-400">{line.text}</p>
                  )}
                </div>
              );
            })}

            {interim && (
              <div>
                <p className="mb-1 text-xs font-semibold text-brand-300">{interimSpeaker || "Vos"}</p>
                <p className="text-xl leading-snug text-ink-300 sm:text-2xl">
                  {interim}
                  <span className="ml-1 inline-block h-5 w-0.5 animate-pulse bg-brand-400 align-middle" />
                </p>
              </div>
            )}
            <div ref={endRef} />
          </div>
        )}
      </div>
    </div>
  );
}
