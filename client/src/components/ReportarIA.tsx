import { FormEvent, useId, useState } from "react";
import { reportarContenidoIA } from "../lib/api";

// «Reportar» para todo lo que genera la IA (respuestas del asistente,
// informes). Lo exige la Microsoft Store (política 11.16) y es lo correcto:
// un modelo puede inventar o decir algo inapropiado, y quien lo ve tiene que
// poder avisar sin buscar un correo. Chico, al pie del contenido; el
// formulario aparece al tocarlo.
export default function ReportarIA({
  tipo,
  contenido,
  meetingId,
  libre = false,
  className = "",
}: {
  tipo: "respuesta" | "informe" | "otro";
  /** El texto generado que se reporta (vacío + `libre` = lo escribe la persona). */
  contenido?: string;
  meetingId?: string;
  /** Modo formulario: la persona pega el contenido (página de ayuda). */
  libre?: boolean;
  className?: string;
}) {
  const [abierto, setAbierto] = useState(libre);
  const [motivo, setMotivo] = useState("");
  const [texto, setTexto] = useState(contenido ?? "");
  const [estado, setEstado] = useState<"" | "enviando" | "listo" | "error">("");
  const [error, setError] = useState("");
  const idMotivo = useId();
  const idTexto = useId();

  async function enviar(e: FormEvent) {
    e.preventDefault();
    const cuerpo = (libre ? texto : contenido ?? "").trim();
    if (!cuerpo) {
      setError("Pegá el contenido que querés reportar.");
      return;
    }
    setEstado("enviando");
    setError("");
    const r = await reportarContenidoIA({ tipo, contenido: cuerpo, motivo: motivo.trim(), meetingId });
    if (r.ok) {
      setEstado("listo");
    } else {
      setEstado("error");
      setError(r.error ?? "No se pudo enviar el reporte.");
    }
  }

  if (estado === "listo") {
    return (
      <p role="status" className={`text-xs text-ok ${className}`}>
        Gracias, recibimos tu reporte. Lo revisamos y, si corresponde, corregimos.
      </p>
    );
  }

  if (!abierto) {
    return (
      <button
        type="button"
        onClick={() => setAbierto(true)}
        className={`text-xs font-medium text-ink-400 underline-offset-2 hover:text-brand-300 hover:underline ${className}`}
      >
        Reportar {tipo === "informe" ? "este informe" : tipo === "respuesta" ? "esta respuesta" : "contenido"}
      </button>
    );
  }

  return (
    <form onSubmit={enviar} className={`rounded-xl border border-ink-700 bg-ink-900/60 p-3 ${className}`} aria-label="Reportar contenido generado por IA">
      <p className="text-xs font-semibold text-strong">Reportar contenido generado por IA</p>
      <p className="mt-1 text-xs text-ink-400">
        Contanos qué está mal (inventado, ofensivo, confidencial, otra cosa). Lo revisa una persona.
      </p>
      {libre && (
        <>
          <label htmlFor={idTexto} className="mt-2 block text-xs text-ink-300">
            El contenido que querés reportar
          </label>
          <textarea
            id={idTexto}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            rows={3}
            maxLength={4000}
            className="mt-1 w-full rounded-lg border border-ink-600 bg-ink-900 px-3 py-2 text-sm text-strong outline-none focus:border-brand-500"
            placeholder="Pegá acá la respuesta o el informe"
          />
        </>
      )}
      <label htmlFor={idMotivo} className="mt-2 block text-xs text-ink-300">
        Motivo
      </label>
      <textarea
        id={idMotivo}
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        rows={2}
        maxLength={1000}
        className="mt-1 w-full rounded-lg border border-ink-600 bg-ink-900 px-3 py-2 text-sm text-strong outline-none focus:border-brand-500"
        placeholder="Ej: dice que aprobamos el presupuesto y nadie dijo eso"
      />
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      <div className="mt-2 flex items-center gap-3">
        <button
          type="submit"
          disabled={estado === "enviando"}
          className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-on-accent hover:bg-brand-600 disabled:opacity-60"
        >
          {estado === "enviando" ? "Enviando…" : "Enviar reporte"}
        </button>
        {!libre && (
          <button type="button" onClick={() => setAbierto(false)} className="text-xs text-ink-400 hover:text-ink-200">
            Cancelar
          </button>
        )}
      </div>
    </form>
  );
}
