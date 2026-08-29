import { ReactNode, useEffect, useRef } from "react";
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
  /** Nombre del idioma al que se traduce, o null si no se traduce. */
  targetLabel: string | null;
  /** El traductor del servidor no está respondiendo. */
  translationFailed?: boolean;
  /** El reconocimiento de voz está escuchando. */
  listening: boolean;
  /**
   * Por qué NO se está transcribiendo, si es el caso: navegador sin soporte,
   * micrófono denegado, servicio caído. Sin esto, la pantalla decía
   * "Escuchando tu micrófono" para siempre sin una sola línea -- que es lo que
   * se ve como "no andan los subtítulos".
   */
  problem?: string | null;
  /** Vuelve a intentar el reconocimiento de voz (tras dar permiso, por ej.). */
  onRetry?: () => void;
  /**
   * El arreglo de UN TOQUE cuando el problema tiene solución directa (por
   * ejemplo: se detectó que hablás en otro idioma -> "Escuchar en inglés").
   */
  accionExtra?: { texto: string; onClick: () => void } | null;
  /**
   * El botón que hace que el micrófono deje de ser la única oreja: compartir
   * la pantalla CON audio del sistema mete las voces de toda la reunión al
   * reconocimiento (y de paso queda el video grabado). Sólo tiene sentido
   * donde la reunión vive AFUERA (Meet, la app de Zoom) y el navegador puede
   * capturar pantalla.
   */
  accionEscucharTodos?: (() => void) | null;
  /**
   * Aclaración sobre la grabación, cuando no está corriendo por una razón que
   * la persona merece saber (en iPhone/iPad el micrófono es de una sola cosa
   * a la vez, así que grabar apagaría los subtítulos).
   */
  notaGrabacion?: string | null;
  /**
   * La salida cuando este aparato no puede escuchar (el sistema le dio el
   * micrófono a la app de la llamada): mandar al bot, que graba y transcribe
   * desde el servidor. Se ofrece mientras no haya ni una frase.
   */
  accionBot?: ReactNode;
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
  avatarFor,
  interim,
  interimSpeaker,
  interimAvatarUrl,
  targetLabel,
  translationFailed,
  listening,
  problem,
  onRetry,
  accionExtra,
  accionEscucharTodos,
  notaGrabacion,
  accionBot,
  participantCount,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [lines.length, interim]);

  const empty = lines.length === 0 && !interim;
  // El aparato de quien está mirando: sus instrucciones, no las de todos.
  const aparato = detectarDispositivo();
  const verLosDos = comoVerLosDosALaVez(aparato);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Estado: qué está pasando, en una línea */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ink-800 px-4 py-2 text-[11px] text-ink-400">
        <span className="flex items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              problem ? "bg-amber-400" : listening ? "animate-pulse bg-accent-green" : "bg-ink-500"
            }`}
            aria-hidden
          />
          {problem ? "Sin transcribir" : listening ? "Escuchando tu micrófono" : "Micrófono en pausa"}
        </span>
        <span className="flex items-center gap-1.5">
          <GlobeIcon className="h-3 w-3" />
          {targetLabel ? `Traduciendo a ${targetLabel}` : "Sin traducir"}
        </span>
        {participantCount > 1 && <span>{participantCount} en Unify</span>}
      </div>

      {problem && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[11px] leading-snug text-amber-200">
          <span className="min-w-0 flex-1">{problem}</span>
          {accionExtra && (
            <button
              type="button"
              onClick={accionExtra.onClick}
              className="shrink-0 rounded-lg bg-amber-400 px-2.5 py-1 font-semibold text-ink-950 hover:bg-amber-300"
            >
              {accionExtra.texto}
            </button>
          )}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="shrink-0 rounded-lg border border-amber-400/50 px-2.5 py-1 font-semibold text-amber-100 hover:bg-amber-500/20"
            >
              Reintentar
            </button>
          )}
        </div>
      )}

      {notaGrabacion && (
        <div className="border-b border-ink-700 bg-ink-800/60 px-4 py-2 text-[11px] leading-snug text-ink-300">
          {notaGrabacion}
        </div>
      )}

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
            {/* Discreción primero: nadie en la reunión ve a Unify. Escucha por
                el micrófono de este aparato, sin entrar a la llamada. */}
            <p className="max-w-sm text-sm leading-relaxed text-ink-400">
              Nadie en la reunión ve a Unify: escucha por el micrófono de este aparato y te
              subtitula acá, con su traducción.
            </p>
            {/* En el teléfono, la instrucción del altavoz ES el modo de uso
                (no un consejo al pie): primero y en la caja destacada. */}
            {/* La instrucción, para el aparato que la está leyendo: en un
                teléfono el modo de uso ES el altavoz; en una compu son las dos
                ventanas lado a lado. Mostrarle a cada uno la de todos era
                obligarlo a buscar la suya. */}
            <p className="max-w-sm rounded-xl border border-brand-500/40 bg-brand-500/10 px-3 py-2.5 text-sm leading-relaxed text-ink-200">
              {aparato.esCompu ? (
                <>
                  Con la reunión sonando en <b>altavoz</b> (en esta compu o en un aparato al lado),
                  el micrófono capta todas las voces solo.
                </>
              ) : (
                <>
                  Poné la reunión en <b>altavoz</b>, sin auriculares, y dejá esta pantalla al frente:
                  el micrófono capta a todos y los subtítulos corren acá, con su traducción.
                </>
              )}
            </p>
            <p className="max-w-sm rounded-xl border border-dashed border-ink-600 px-3 py-2 text-xs leading-relaxed text-ink-400">
              {verLosDos}
            </p>
            {/* LA OREJA GRANDE. El micrófono escucha lo que llega al aire;
                compartir la pantalla con el audio del sistema escucha a la
                reunión ENTERA, directo del parlante digital -- y de paso el
                video queda grabado. Es el botón que convierte "me escucha a
                mí" en "escucha a todos". */}
            {accionEscucharTodos && (
              <div className="w-full max-w-sm">
                <button
                  type="button"
                  onClick={accionEscucharTodos}
                  className="w-full rounded-xl bg-brand-500 px-4 py-3 text-sm font-semibold text-on-accent hover:bg-brand-600"
                >
                  Escuchar a TODA la reunión
                </button>
                <p className="mt-1.5 text-[11px] leading-relaxed text-ink-500">
                  Elegí <b className="text-ink-300">Toda la pantalla</b> y tildá{" "}
                  <b className="text-ink-300">Compartir audio del sistema</b>: así transcribo a
                  todos (no sólo tu voz) y la reunión queda grabada en video. En Mac el audio del
                  sistema no existe: ahí elegí la pestaña de la reunión, o usá el altavoz.
                </p>
              </div>
            )}
            {/* Si el aparato no presta el micrófono (la app de la llamada se
                lo queda, que es lo que hace iOS), esta es la salida que SÍ
                funciona: el bot escucha y graba desde el servidor. */}
            {accionBot && <div className="w-full max-w-sm text-left">{accionBot}</div>}
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
                <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-brand-300">
                  <Avatar name={interimSpeaker || "Vos"} src={interimAvatarUrl} size={22} />
                  {interimSpeaker || "Vos"}
                </p>
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
