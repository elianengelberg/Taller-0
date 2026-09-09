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
  /**
   * SÓLO TU VOZ. En iPhone y iPad el sistema le da el micrófono a una sola
   * app y cancela lo que sale por el propio parlante: Unify oye a quien lo
   * tiene abierto y a nadie más. Mientras no llegue ni una frase de otra
   * persona, el escenario lo dice y ofrece la salida (el bot) TAMBIÉN cuando
   * ya hay frases propias en pantalla. Antes eso sólo se veía en la pantalla
   * vacía: la persona hablaba, veía lo suyo, y nunca supo por qué los demás
   * no aparecían ni cómo cambiarlo.
   */
  soloTuVoz?: boolean;
  /** La pantalla compartida vino SIN audio: los demás no pueden salir. */
  sinAudioCompartido?: boolean;
  /** Este navegador no sabe transcribir una pista (Chrome viejo, otro). */
  navegadorSinPista?: boolean;
  /** Es un Google Meet: la extensión de Chrome lee sus subtítulos con nombres. */
  esMeet?: boolean;
  /**
   * La pantalla quedó chica (Split View en el iPad, una ventana angosta al
   * lado de la reunión): los subtítulos pasan a ser lo único importante. Se
   * agranda el texto y se van los consejos, que empujaban lo que se está
   * diciendo fuera de la vista.
   */
  compacto?: boolean;
  /** Cuántas personas hay en la capa de Unify. */
  participantCount: number;
}

// EL AVISO DE «SÓLO TU VOZ», con la salida que corresponde a ESTE aparato.
//
// Es lo que pasó de verdad en un Meet, en la compu y en la tablet: la
// persona hablaba, veía lo suyo, y de los demás nada, sin saber por qué ni
// qué tocar. La causa es la misma en todos lados (el micrófono oye a quien
// tiene Unify abierto; lo que sale por el propio parlante lo cancela el
// navegador o el sistema), y la salida cambia según el aparato: en una compu
// compartir la pantalla CON audio (o la extensión en la pestaña de Meet); en
// un teléfono o tablet, el bot. Se muestra mientras no llegue ni una frase
// de otra persona, haya o no frases propias en pantalla.
function AvisoSoloTuVoz({
  aparato,
  accionEscucharTodos,
  accionBot,
  sinAudioCompartido,
  navegadorSinPista,
  esMeet,
}: {
  aparato: ReturnType<typeof detectarDispositivo>;
  accionEscucharTodos?: (() => void) | null;
  accionBot?: ReactNode;
  sinAudioCompartido?: boolean;
  navegadorSinPista?: boolean;
  esMeet?: boolean;
}) {
  return (
    <div
      role="note"
      aria-label="Por ahora sólo se oye tu voz"
      className="w-full max-w-md rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-left"
    >
      <p className="text-sm font-semibold text-warn">Por ahora sólo se oye tu voz</p>
      {aparato.esCompu ? (
        <>
          <p className="mt-1 text-xs leading-relaxed text-ink-300">
            {sinAudioCompartido
              ? "La pantalla que compartiste vino sin audio, así que los demás no pueden salir en los subtítulos. Volvé a compartir eligiendo «Toda la pantalla» y tildando «Compartir audio del sistema» (en Mac: la pestaña de la reunión, con su audio)."
              : navegadorSinPista
                ? "Este navegador no puede transcribir el audio de la reunión (hace falta Chrome actualizado). Con la reunión en esta misma compu, el micrófono sólo te oye a vos."
                : "Con la reunión en esta misma compu, el navegador cancela lo que sale por el parlante y el micrófono sólo te oye a vos. Para que se transcriba y traduzca a toda la reunión, compartí la pantalla con su audio:"}
          </p>
          {accionEscucharTodos && (
            <>
              <button
                type="button"
                onClick={accionEscucharTodos}
                className="mt-2.5 w-full rounded-xl bg-brand-500 px-4 py-3 text-sm font-semibold text-on-accent hover:bg-brand-600"
              >
                {sinAudioCompartido ? "Compartir de nuevo, con audio" : "Escuchar a TODA la reunión"}
              </button>
              {!sinAudioCompartido && (
                <p className="mt-1.5 text-xs leading-relaxed text-ink-400">
                  Elegí <b className="text-ink-300">Toda la pantalla</b> y tildá{" "}
                  <b className="text-ink-300">Compartir audio del sistema</b>: así transcribo a todos y la
                  reunión queda grabada en video. En Mac el audio del sistema no existe: ahí elegí la
                  pestaña de la reunión con su audio, o usá el altavoz.
                </p>
              )}
            </>
          )}
          {esMeet && (
            <p className="mt-2 text-xs leading-relaxed text-ink-400">
              En Google Meet hay otro camino, con el nombre de cada persona: la{" "}
              <a href="/instalar" target="_blank" rel="noreferrer" className="text-brand-300 underline underline-offset-2">
                extensión de Unify
              </a>{" "}
              en la pestaña de Meet lee sus subtítulos.
            </p>
          )}
        </>
      ) : (
        <p className="mt-1 text-xs leading-relaxed text-ink-300">
          En {aparato.corto}, con la reunión en este mismo aparato, el sistema sólo le deja oír tu voz
          (lo que sale por su propio parlante lo cancela), y el micrófono es de <b>una sola cosa a la
          vez</b>: por eso la grabación automática queda en pausa mientras andan los subtítulos. Si la
          reunión suena en <b>otro</b> aparato al lado (una compu, una tele), el micrófono la capta.
          Para que se transcriba, se traduzca y se grabe a todos desde acá, el bot entra por vos y
          escucha desde el servidor.
        </p>
      )}
      {accionBot}
    </div>
  );
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
  soloTuVoz = false,
  sinAudioCompartido = false,
  navegadorSinPista = false,
  esMeet = false,
  compacto = false,
  participantCount,
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
      {/* Estado: qué está pasando, en una línea */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ink-800 px-4 py-2 text-xs text-ink-300">
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
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs leading-snug text-warn">
          <span className="min-w-0 flex-1">{problem}</span>
          {accionExtra && (
            <button
              type="button"
              onClick={accionExtra.onClick}
              className="min-h-[36px] shrink-0 rounded-lg bg-amber-400 px-3.5 py-1.5 text-xs font-semibold text-ink-950 hover:bg-amber-300"
            >
              {accionExtra.texto}
            </button>
          )}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="min-h-[36px] shrink-0 rounded-lg border border-amber-400/50 px-3.5 py-1.5 text-xs font-semibold text-warn hover:bg-amber-500/20"
            >
              Reintentar
            </button>
          )}
        </div>
      )}

      {/* La nota de grabación se muestra siempre que exista: quien la manda
          decide (la página apaga la del micrófono cuando el aviso de «sólo se
          oye tu voz» ya lo explica, pero la de «lo está grabando la app de
          Unify» tiene que verse igual: nadie puede creer que no se graba). */}
      {notaGrabacion && (
        <div className="border-b border-ink-700 bg-ink-800/60 px-4 py-2 text-xs leading-snug text-ink-200">
          {notaGrabacion}
        </div>
      )}

      {translationFailed && targetLabel && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs leading-snug text-warn">
          No estamos pudiendo traducir en este momento, así que ves el texto original. Si sigue
          igual, puede faltar configurar la traducción en el servidor.
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={alDesplazar} className="h-full overflow-y-auto px-4 py-4">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <p className="text-base font-medium text-ink-200">Los subtítulos aparecen acá</p>
            {/* Discreción primero: nadie en la reunión ve a Unify. Escucha por
                el micrófono de este aparato, sin entrar a la llamada. */}
            {!soloTuVoz && (
              <p className="max-w-sm text-sm leading-relaxed text-ink-400">
                Nadie en la reunión ve a Unify: escucha por el micrófono de este aparato y te
                subtitula acá, con su traducción.
              </p>
            )}
            {/* En el teléfono, la instrucción del altavoz ES el modo de uso
                (no un consejo al pie): primero y en la caja destacada. */}
            {/* La instrucción, para el aparato que la está leyendo: en un
                teléfono el modo de uso ES el altavoz; en una compu son las dos
                ventanas lado a lado. Mostrarle a cada uno la de todos era
                obligarlo a buscar la suya. */}
            {soloTuVoz ? (
              <AvisoSoloTuVoz
                aparato={aparato}
                accionEscucharTodos={accionEscucharTodos}
                accionBot={accionBot}
                sinAudioCompartido={sinAudioCompartido}
                navegadorSinPista={navegadorSinPista}
                esMeet={esMeet}
              />
            ) : (
              // Ya se está oyendo a la reunión entera (la pista de la pantalla
              // compartida, la extensión o el bot): sólo falta que hablen.
              <p className="max-w-sm rounded-xl border border-brand-500/40 bg-brand-500/10 px-3 py-2.5 text-sm leading-relaxed text-ink-200">
                Escuchando a <b>toda la reunión</b>: apenas alguien hable, sus palabras aparecen acá,
                con su traducción.
              </p>
            )}
            {!soloTuVoz && !compacto && (
              <p className="max-w-sm rounded-xl border border-dashed border-ink-600 px-3 py-2 text-xs leading-relaxed text-ink-400">
                {verLosDos}
              </p>
            )}
            {/* LA OREJA GRANDE. El micrófono escucha lo que llega al aire;
                compartir la pantalla con el audio del sistema escucha a la
                reunión ENTERA, directo del parlante digital -- y de paso el
                video queda grabado. Es el botón que convierte "me escucha a
                mí" en "escucha a todos". */}
            {/* Sin el aviso (ya se oye a todos), el bot sigue a mano por si
                este aparato no presta el micrófono. */}
            {!soloTuVoz && accionBot && <div className="w-full max-w-sm text-left">{accionBot}</div>}
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {/* Ya hay frases, pero todas tuyas: decirlo acá, donde la persona
                está mirando, y dejar el bot a un toque. */}
            {soloTuVoz && (
              <AvisoSoloTuVoz
                aparato={aparato}
                accionEscucharTodos={accionEscucharTodos}
                accionBot={accionBot}
                sinAudioCompartido={sinAudioCompartido}
                navegadorSinPista={navegadorSinPista}
                esMeet={esMeet}
              />
            )}
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
