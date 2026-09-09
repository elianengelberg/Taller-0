import { ReactNode } from "react";

// QUIÉN ESTÁ ESCUCHANDO ESTA REUNIÓN. Es la única pregunta que importa en una
// reunión externa, y era la que la pantalla no contestaba: había tres franjas
// de texto largo apiladas (un aviso amarillo, una nota gris, un consejo) que
// entre todas no decían lo esencial -- si en este momento se está
// transcribiendo algo, y si no, qué tocar.
//
// Acá vive esa respuesta, en UNA sola pieza:
//   - escuchando: un renglón corto y tranquilo, para no robarle lugar a los
//     subtítulos (que son a lo que la persona vino);
//   - sin escuchar: una tarjeta con las DOS salidas reales, la que no depende
//     de este aparato primero.
export type ModoDeEscucha = "conectando" | "servidor" | "puente" | "microfono" | "nadie";

export default function EstadoDeEscucha({
  modo,
  problema,
  detalleServidor,
  onEncenderMicrofono,
  micDisponible,
  accionServidor,
  nota,
  compacto = false,
}: {
  modo: ModoDeEscucha;
  /** Algo anda mal y hay que decirlo (micrófono bloqueado, silencio largo…). */
  problema?: string | null;
  /** Cómo viene la grabación del servidor, cuando está escuchando. */
  detalleServidor?: string | null;
  /** Prender el micrófono de ESTE aparato (pide el permiso en el toque). */
  onEncenderMicrofono?: (() => void) | null;
  /** Este navegador puede transcribir por micrófono. */
  micDisponible: boolean;
  /** El botón que hace escuchar al servidor (el bot), tal cual, sin adornos. */
  accionServidor?: ReactNode;
  /**
   * Un aviso con su propia explicación y sus botones (hoy: «por ahora sólo se
   * oye tu voz», que cambia según el aparato). Va acá y no en los subtítulos:
   * el estado de la escucha se lee en un solo lugar.
   */
  nota?: ReactNode;
  compacto?: boolean;
}) {
  // La nota («por ahora sólo se oye tu voz» y su salida) no depende del
  // socket: habla del micrófono de ESTE aparato. Se muestra desde el primer
  // instante, también mientras conecta -- si esperara a la conexión, el
  // consejo aparecería tarde, justo cuando la persona ya se preguntó por qué
  // no se escucha a nadie.
  const conNota = nota ? <div className="border-b border-ink-800 bg-ink-900/60 px-4 py-2">{nota}</div> : null;

  if (modo === "conectando") {
    return (
      <div>
        {conNota}
        <Renglon tono="neutro" compacto={compacto}>
          <Punto tono="neutro" latiendo />
          Conectando con la reunión…
        </Renglon>
      </div>
    );
  }

  if (modo === "servidor" || modo === "puente" || modo === "microfono") {
    const propio = modo === "microfono";
    return (
      <div>
        {conNota}
        <Renglon tono={propio ? "info" : "ok"} compacto={compacto}>
          <Punto tono={propio ? "info" : "ok"} latiendo />
          <span className="font-semibold">
            {modo === "servidor"
              ? "Unify escucha toda la reunión"
              : modo === "puente"
                ? "Se está transcribiendo la reunión"
                : "Escuchando por el micrófono de este aparato"}
          </span>
          <span className="text-ink-400">
            {modo === "servidor"
              ? (detalleServidor ?? "Transcribe y graba desde el servidor, sin depender de este aparato.")
              : modo === "puente"
                ? "Lo que se dice llega desde la reunión (la extensión, o quien tenga Unify abierto)."
                : "Sólo mientras Unify esté abierto y adelante."}
          </span>
        </Renglon>
        {problema && (
          <Renglon tono="aviso" compacto={compacto}>
            {problema}
          </Renglon>
        )}
      </div>
    );
  }

  // NADIE ESCUCHA. La tarjeta con las dos salidas, la más importante primero:
  // la que sigue funcionando aunque esta pantalla se cierre.
  return (
    <div className="border-b border-ink-800 bg-ink-900/60 px-4 py-3">
      <div className="mx-auto flex max-w-2xl flex-col gap-2.5">
        <p className="flex items-center gap-2 text-sm font-semibold text-strong">
          <Punto tono="aviso" />
          Sin transcribir: todavía nadie escucha esta reunión
        </p>
        {problema ? (
          <p className="text-xs leading-relaxed text-warn">{problema}</p>
        ) : (
          <p className="text-xs leading-relaxed text-ink-300">
            Elegí cómo querés que Unify escuche esta reunión.
          </p>
        )}
        {accionServidor}
        {nota}
        {onEncenderMicrofono && micDisponible && (
          <div>
            <button
              type="button"
              onClick={onEncenderMicrofono}
              className="w-full rounded-xl border border-ink-600 px-4 py-2.5 text-sm font-semibold text-ink-100 hover:border-brand-400 hover:text-strong"
            >
              Usar el micrófono de este aparato
            </button>
            {/* Dicho de frente, porque es la causa del «si cierro la app deja
                de escuchar»: el navegador sólo oye con la pantalla adelante. */}
            <p className="mt-1 text-[11px] leading-snug text-ink-500">
              Transcribe lo que entre por este micrófono, y sólo mientras Unify esté abierto adelante.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Renglon({
  tono,
  compacto,
  children,
}: {
  tono: "ok" | "info" | "aviso" | "neutro";
  compacto?: boolean;
  children: ReactNode;
}) {
  const color =
    tono === "ok"
      ? "text-ok"
      : tono === "aviso"
        ? "text-warn"
        : tono === "info"
          ? "text-brand-200"
          : "text-ink-300";
  return (
    <div
      role="status"
      className={`flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 border-b border-ink-800 bg-ink-900/60 px-4 text-center text-xs leading-snug ${color} ${
        compacto ? "py-1" : "py-1.5"
      }`}
    >
      {children}
    </div>
  );
}

function Punto({ tono, latiendo }: { tono: "ok" | "info" | "aviso" | "neutro"; latiendo?: boolean }) {
  const fondo =
    tono === "ok"
      ? "bg-accent-green"
      : tono === "aviso"
        ? "bg-warn"
        : tono === "info"
          ? "bg-brand-400"
          : "bg-ink-500";
  return (
    <span
      aria-hidden
      className={`h-2 w-2 shrink-0 rounded-full ${fondo} ${latiendo ? "animate-pulse" : ""}`}
    />
  );
}
