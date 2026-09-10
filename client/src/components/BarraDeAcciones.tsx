import { ReactNode } from "react";

/**
 * LA BARRA DE ABAJO DE UNA REUNIÓN.
 *
 * Antes eran cinco o siete círculos grises idénticos, uno al lado del otro:
 * el que pausa los subtítulos se veía igual que el que abre un panel y que el
 * que CORTA la reunión. Con todo igual de importante, nada lo es -- hay que
 * leer las cinco etiquetas para encontrar la que se busca, y el botón rojo de
 * cortar queda a un toque de distancia del de abrir la transcripción.
 *
 * Acá cada cosa tiene la FORMA de lo que es, y esa forma se aprende una vez:
 *
 *   · Un INTERRUPTOR (píldora que se prende) es algo que queda encendido o
 *     apagado: los subtítulos en vivo, la ventanita flotante. Se ve de un
 *     vistazo en cuál de los dos estados está.
 *   · Un SELECTOR (los tres juntos, en una sola cápsula) es «elegí uno»:
 *     transcripción, IA o ajustes. Sólo uno puede estar abierto, y la cápsula
 *     lo muestra sin que haya que abrirlos para saberlo.
 *   · Una ACCIÓN (suelta, del otro lado de una línea) toca la reunión de
 *     verdad: silenciar tu micrófono, cortar. Van separadas a propósito:
 *     cortar no puede vivir pegado a «ver la transcripción».
 *
 * Los nombres se ven SIEMPRE, en los tres casos. Un ícono solo no le dice
 * nada a nadie, y en esta app hubo que arreglarlo más de una vez.
 */

export function Interruptor({
  label,
  nombre,
  encendido,
  onClick,
  children,
}: {
  /** Lo que hace TOCARLO, para el lector de pantalla y el tooltip. */
  label: string;
  /** El nombre visible. Arranca igual que `label` para que sean la misma cosa. */
  nombre: string;
  encendido: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={encendido}
      title={label}
      className={`flex min-h-[44px] items-center gap-2 rounded-full px-3 py-2 text-xs font-semibold transition-colors sm:px-3.5 ${
        encendido
          ? "bg-brand-500 text-on-accent ring-1 ring-brand-400/40"
          : "bg-ink-800 text-ink-200 ring-1 ring-ink-700 hover:ring-brand-400"
      }`}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">{children}</span>
      <span className="whitespace-nowrap">{nombre}</span>
      {/* El puntito es la diferencia entre «está prendido» y «se ve azul
          porque lo estoy tocando»: sin él, en una foto no se distingue. */}
      <span
        aria-hidden
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${encendido ? "bg-on-accent/90" : "bg-ink-600"}`}
      />
    </button>
  );
}

export function Selector({
  opciones,
}: {
  opciones: Array<{
    clave: string;
    label: string;
    nombre: string;
    abierto: boolean;
    onClick: () => void;
    icono: ReactNode;
  }>;
}) {
  return (
    <div
      role="group"
      aria-label="Paneles de la reunión"
      className="flex items-center gap-0.5 rounded-full bg-ink-800 p-1 ring-1 ring-ink-700"
    >
      {opciones.map((o) => (
        <button
          key={o.clave}
          type="button"
          onClick={o.onClick}
          aria-label={o.label}
          aria-pressed={o.abierto}
          title={o.label}
          className={`flex min-h-[38px] items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-semibold transition-colors sm:px-3 ${
            o.abierto ? "bg-brand-500 text-on-accent" : "text-ink-200 hover:bg-ink-700"
          }`}
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center">{o.icono}</span>
          <span className="whitespace-nowrap">{o.nombre}</span>
        </button>
      ))}
    </div>
  );
}

export function Accion({
  label,
  nombre,
  peligro,
  onClick,
  children,
}: {
  label: string;
  nombre: string;
  peligro?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex min-h-[44px] items-center gap-2 rounded-full px-3 py-2 text-xs font-semibold transition-colors sm:px-3.5 ${
        peligro
          ? "bg-red-600 text-on-accent ring-1 ring-red-400/40 hover:bg-red-500"
          : "bg-ink-800 text-strong ring-1 ring-ink-700 hover:ring-brand-400"
      }`}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">{children}</span>
      <span className="whitespace-nowrap">{nombre}</span>
    </button>
  );
}

/** La línea que separa «mirar» de «tocar la reunión». */
export function Separador() {
  return <span aria-hidden className="mx-0.5 h-7 w-px shrink-0 bg-ink-700 sm:mx-1.5" />;
}

export function Barra({ children }: { children: ReactNode }) {
  return (
    // Se puede desplazar de costado: en un teléfono angosto, con la extensión
    // conectada, entran siete controles. Antes se apretaban hasta quedar
    // ilegibles; ahora se corren, que es lo que la gente ya sabe hacer.
    <div className="border-t border-ink-800 bg-ink-900/95 shadow-top backdrop-blur-md">
      <div className="flex items-center justify-start gap-1.5 overflow-x-auto px-3 py-2.5 sm:justify-center sm:gap-2 sm:px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {children}
      </div>
    </div>
  );
}
