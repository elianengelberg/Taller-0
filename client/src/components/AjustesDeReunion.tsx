import { useState } from "react";
import TextoGrandeToggle from "./TextoGrandeToggle";

// LO QUE NO SE USA TODO EL TIEMPO, JUNTO Y CON NOMBRE. La barra de abajo tenía
// seis botones en fila -- roles, grabar, salir, y en algunas reuniones dos que
// no hacían nada -- y ninguno decía para qué servía hasta tocarlo. Lo que se
// usa cada tanto vive acá, en un panel donde cada cosa tiene su renglón, su
// explicación y un solo botón.
export default function AjustesDeReunion({
  invitarUrl,
  onRoles,
  grabando,
  onGrabar,
  puedeGrabar,
  notaGrabar,
  abrir,
}: {
  /** Enlace para que los demás abran ESTA reunión en Unify. */
  invitarUrl: string;
  onRoles: () => void;
  grabando: boolean;
  onGrabar: () => void;
  puedeGrabar: boolean;
  /** Por qué grabar acá tiene su costo (iPhone/iPad: se pausan los subtítulos). */
  notaGrabar?: string | null;
  /** Abrir la reunión de verdad, en su app. */
  abrir?: { etiqueta: string; alAbrir: () => void } | null;
}) {
  const [copiado, setCopiado] = useState(false);

  async function compartir() {
    const texto = `Sumate a la capa de Unify de esta reunión para que se transcriba también tu voz: ${invitarUrl}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Unify", text: texto, url: invitarUrl });
        return;
      } catch {
        /* cancelado: seguimos con el copiado */
      }
    }
    try {
      await navigator.clipboard.writeText(invitarUrl);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1800);
    } catch {
      /* sin portapapeles: el enlace está a la vista para copiarlo a mano */
    }
  }

  return (
    <div className="space-y-4">
      {abrir && (
        <Fila
          titulo={`Abrir la reunión en ${abrir.etiqueta}`}
          detalle="La llamada vive en su app. Esta pantalla es la de los subtítulos."
        >
          <Boton onClick={abrir.alAbrir} principal>
            Abrir {abrir.etiqueta}
          </Boton>
        </Fila>
      )}

      <Fila
        titulo="Sumar las voces de los demás"
        detalle="Cada navegador sólo escucha su propio micrófono. Si tus compañeros abren este enlace, sus voces entran a la misma transcripción."
      >
        <p className="mb-2 truncate rounded-lg bg-ink-800 px-2.5 py-1.5 font-mono text-[11px] text-ink-300">
          {invitarUrl}
        </p>
        <Boton onClick={() => void compartir()}>{copiado ? "¡Enlace copiado!" : "Compartir el enlace"}</Boton>
      </Fila>

      <Fila titulo="Texto grande" detalle="Agranda los subtítulos y el resto de la app, para leer de lejos.">
        <TextoGrandeToggle />
      </Fila>

      <Fila
        titulo="Roles"
        detalle="Poné una etiqueta a cada persona (cliente, equipo, invitado) y se ve al lado de lo que dice."
      >
        <Boton onClick={onRoles}>Abrir roles</Boton>
      </Fila>

      {puedeGrabar && (
        <Fila
          titulo={grabando ? "Estás grabando" : "Grabar esta reunión"}
          detalle={
            notaGrabar ??
            "Guarda el audio (o la pantalla, si elegís compartirla) y queda en tu historial al terminar."
          }
        >
          <Boton onClick={onGrabar} peligro={grabando}>
            {grabando ? "Detener la grabación" : "Empezar a grabar"}
          </Boton>
        </Fila>
      )}
    </div>
  );
}

function Fila({
  titulo,
  detalle,
  children,
}: {
  titulo: string;
  detalle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-ink-700 bg-ink-800/40 p-3">
      <p className="text-sm font-semibold text-strong">{titulo}</p>
      <p className="mb-2.5 mt-1 text-xs leading-relaxed text-ink-400">{detalle}</p>
      {children}
    </div>
  );
}

function Boton({
  onClick,
  principal,
  peligro,
  children,
}: {
  onClick: () => void;
  principal?: boolean;
  peligro?: boolean;
  children: React.ReactNode;
}) {
  const estilo = peligro
    ? "border border-red-500/50 text-danger hover:bg-red-500/10"
    : principal
      ? "bg-brand-500 text-on-accent hover:bg-brand-600"
      : "border border-ink-600 text-ink-100 hover:border-brand-400 hover:text-strong";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-[40px] w-full rounded-xl px-4 py-2 text-sm font-semibold ${estilo}`}
    >
      {children}
    </button>
  );
}
