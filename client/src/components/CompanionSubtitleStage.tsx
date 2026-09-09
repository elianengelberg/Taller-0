import { ReactNode, useEffect, useRef, useState } from "react";
import { comoVerLosDosALaVez, detectarDispositivo } from "../lib/dispositivo";
import Avatar from "./Avatar";
import { GlobeIcon } from "./icons";

export interface StageLine {
  id: string;
  speakerId: string;
  speakerName: string;
  text: string;
  translated?: string;
}

interface Props {
  /** De más vieja a más nueva; la última se destaca. */
  lines: StageLine[];
  roleFor?: (speakerName: string) => { label: string; color: string } | null;
  /** Foto de perfil de quien habla, para mostrarla junto al nombre. */
  avatarFor?: (speakerId: string, speakerName: string) => string | null;
  /** Lo que se está diciendo ahora mismo (aún sin cerrar la frase). */
  interim?: string | null;
  interimSpeaker?: string;
  /** Foto de quien está hablando ahora mismo (vos). */
  interimAvatarUrl?: string | null;
  /**
   * La pantalla quedó chica (Split View en el iPad, una ventana angosta al
   * lado de la reunión): los subtítulos pasan a ser lo único importante. Se
   * agranda el texto y se van los consejos, que empujaban lo que se está
   * diciendo fuera de la vista.
   */
  compacto?: boolean;
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
  avatarFor,
  interim,
  interimSpeaker,
  interimAvatarUrl,
  compacto = false,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Si la persona subió a releer algo, no la arrastramos de vuelta con cada
  // frase; en cambio aparece el botón "Volver a lo último".
  const [desanclado, setDesanclado] = useState(false);
  // La clave incluye el LARGO del texto y de la traducción de la última
  // línea: el servidor fusiona fragmentos en una misma línea (misma id, texto
  // que crece) y la traducción llega después -- ambas cosas agrandan el
  // bloque sin cambiar `lines.length`, y antes eso dejaba el final de la
  // frase fuera de la vista.
  const ultima = lines[lines.length - 1];
  const claveContenido = `${lines.length}:${ultima?.id ?? ""}:${ultima?.text.length ?? 0}:${
    ultima?.translated?.length ?? 0
  }:${interim ?? ""}`;
  useEffect(() => {
    if (desanclado) return;
    const caja = scrollRef.current;
    // Directo al fondo, sin animación: con subtítulos rápidos el scroll suave
    // se queda a mitad de camino y parece que "no sigue" la conversación.
    if (caja) caja.scrollTop = caja.scrollHeight;
  }, [claveContenido, desanclado]);
  function alDesplazar() {
    const caja = scrollRef.current;
    if (!caja) return;
    const cerca = caja.scrollHeight - caja.scrollTop - caja.clientHeight < 60;
    setDesanclado(!cerca);
  }
  function volverAlUltimo() {
    setDesanclado(false);
    const caja = scrollRef.current;
    if (caja) caja.scrollTop = caja.scrollHeight;
  }

  const empty = lines.length === 0 && !interim;
  // El aparato de quien está mirando: sus instrucciones, no las de todos.
  const aparato = detectarDispositivo();
  const verLosDos = comoVerLosDosALaVez(aparato);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={alDesplazar} className="h-full overflow-y-auto px-4 py-4">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <p className="text-base font-medium text-ink-200">Los subtítulos aparecen acá</p>
            {/* Discreción primero: nadie en la reunión ve a Unify. Escucha por
                el micrófono de este aparato, sin entrar a la llamada. */}
            <p className="max-w-sm text-sm leading-relaxed text-ink-400">
              Nadie en la reunión ve a Unify: lo que se diga aparece acá, con su traducción.
            </p>
            {/* En el teléfono, la instrucción del altavoz ES el modo de uso
                (no un consejo al pie): primero y en la caja destacada. */}
            {/* La instrucción, para el aparato que la está leyendo: en un
                teléfono el modo de uso ES el altavoz; en una compu son las dos
                ventanas lado a lado. Mostrarle a cada uno la de todos era
                obligarlo a buscar la suya. */}
            {!compacto && (
              <p className="max-w-sm rounded-xl border border-dashed border-ink-600 px-3 py-2 text-xs leading-relaxed text-ink-400">
                {verLosDos}
              </p>
            )}
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {lines.map((line, i) => {
              const role = roleFor?.(line.speakerName) ?? null;
              const isLast = i === lines.length - 1 && !interim;
              return (
                <div key={line.id} className={isLast ? "" : "opacity-60"}>
                  <p className="mb-1 flex flex-wrap items-center gap-1.5 text-xs">
                    <Avatar name={line.speakerName} src={avatarFor?.(line.speakerId, line.speakerName)} size={22} />
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
                  <p
                    className={`leading-snug text-strong ${line.translated ? "font-medium" : ""} ${
                      compacto ? "text-2xl sm:text-3xl" : "text-xl sm:text-2xl"
                    }`}
                  >
                    {line.translated || line.text}
                  </p>
                  {/* El original, de apoyo: la mitad de grande y apagado. */}
                  {line.translated && line.translated !== line.text && (
                    <p className="mt-1 text-xs italic leading-snug text-ink-500 sm:text-sm">{line.text}</p>
                  )}
                </div>
              );
            })}

            {interim && (
              <div>
                <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-brand-300">
                  <Avatar name={interimSpeaker || "Vos"} src={interimAvatarUrl} size={22} />
                  {interimSpeaker || "Vos"}
                </p>
                <p
                  className={`leading-snug text-ink-300 ${
                    compacto ? "text-2xl sm:text-3xl" : "text-xl sm:text-2xl"
                  }`}
                >
                  {interim}
                  <span className="ml-1 inline-block h-5 w-0.5 animate-pulse bg-brand-400 align-middle" />
                </p>
              </div>
            )}
          </div>
        )}
        </div>
        {desanclado && !empty && (
          <button
            type="button"
            onClick={volverAlUltimo}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-brand-500 px-4 py-2 text-sm font-semibold text-on-accent shadow-lg hover:bg-brand-600"
          >
            ↓ Volver a lo último
          </button>
        )}
      </div>
    </div>
  );
}
