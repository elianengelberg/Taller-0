import { useEffect, useState } from "react";
import { alCambiarTextoGrande, fijarTextoGrande, textoGrandeActivo } from "../lib/textoGrande";

interface Props {
  /** "enlace": como los enlaces del encabezado; "pastilla": botón con borde. */
  variante?: "enlace" | "pastilla";
  className?: string;
}

// El interruptor de TEXTO GRANDE (ver lib/textoGrande). Mismo texto en todas
// partes para que se reconozca: «Aa Texto grande» apaga/prende.
export default function TextoGrandeToggle({ variante = "pastilla", className = "" }: Props) {
  const [activo, setActivo] = useState(textoGrandeActivo);
  useEffect(() => alCambiarTextoGrande(() => setActivo(textoGrandeActivo())), []);
  const etiqueta = activo ? "Texto normal" : "Texto grande";
  const base =
    variante === "enlace"
      ? "whitespace-nowrap text-[15px] font-semibold text-ink-100 underline-offset-4 transition-colors hover:text-brand-300 hover:underline"
      : `flex min-h-[40px] items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-semibold transition-colors ${
          activo
            ? "border-brand-400/60 bg-brand-500/15 text-brand-200"
            : "border-ink-600 text-ink-100 hover:bg-white/10"
        }`;
  return (
    <button
      type="button"
      onClick={() => fijarTextoGrande(!activo)}
      aria-pressed={activo}
      title="Agranda la letra de toda la app (se recuerda)"
      className={`${base} ${className}`}
    >
      <span aria-hidden className="font-display text-base font-extrabold leading-none">
        Aa
      </span>{" "}
      {etiqueta}
    </button>
  );
}
