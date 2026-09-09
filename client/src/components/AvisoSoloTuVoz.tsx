import { ReactNode } from "react";
import { comoVerLosDosALaVez, detectarDispositivo } from "../lib/dispositivo";

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
export default function AvisoSoloTuVoz({
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

