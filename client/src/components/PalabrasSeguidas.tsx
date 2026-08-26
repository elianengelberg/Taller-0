import { FormEvent, useEffect, useState } from "react";
import { fetchTrackedWords, saveTrackedWords } from "../lib/api";

// El SEGUIMIENTO DE PALABRAS: la persona define sus palabras clave
// ("presupuesto", un competidor, "deadline") y cada reunión del historial le
// muestra cuántas veces se dijeron, quién y en qué frases (la sección vive en
// el detalle de la reunión; acá se administra la lista).
export default function PalabrasSeguidas() {
  const [palabras, setPalabras] = useState<string[] | null>(null);
  const [nueva, setNueva] = useState("");
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => {
    fetchTrackedWords().then(setPalabras);
  }, []);

  if (palabras === null) return null;

  async function guardar(lista: string[]) {
    setPalabras(lista);
    setAviso(null);
    const ok = await saveTrackedWords(lista);
    if (!ok) setAviso("No se pudo guardar la lista. Probá de nuevo.");
  }

  function agregar(e: FormEvent) {
    e.preventDefault();
    const p = nueva.trim();
    if (!p) return;
    setNueva("");
    if (palabras!.some((x) => x.toLowerCase() === p.toLowerCase())) return;
    void guardar([...palabras!, p].slice(0, 30));
  }

  return (
    <div className="rounded-2xl border border-ink-700 bg-ink-800/40 p-4">
      <h3 className="text-sm font-semibold text-strong">Seguimiento de palabras</h3>
      <p className="mt-1 text-xs leading-relaxed text-ink-400">
        Elegí las palabras que te importan (un producto, un competidor, «presupuesto»…) y cada
        reunión te muestra cuántas veces se dijeron, quién las dijo y en qué frases. Lo ves al
        abrir cualquier reunión del historial.
      </p>

      <form onSubmit={agregar} className="mt-3 flex gap-2">
        <input
          type="text"
          value={nueva}
          onChange={(e) => setNueva(e.target.value)}
          placeholder="Escribí una palabra y Enter"
          maxLength={40}
          className="min-w-0 flex-1 rounded-xl border border-ink-600 bg-ink-900 px-3 py-2 text-sm text-strong placeholder:text-ink-500"
        />
        <button
          type="submit"
          className="rounded-xl border border-brand-500/50 px-4 py-2 text-sm font-semibold text-brand-200 hover:bg-brand-500/10"
        >
          Agregar
        </button>
      </form>

      {palabras.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {palabras.map((p) => (
            <span
              key={p}
              className="flex items-center gap-1.5 rounded-full bg-ink-700/70 px-3 py-1 text-xs font-medium text-ink-200"
            >
              {p}
              <button
                type="button"
                aria-label={`Dejar de seguir «${p}»`}
                onClick={() => void guardar(palabras.filter((x) => x !== p))}
                className="rounded-full px-1 text-ink-400 hover:text-strong"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      {palabras.length === 0 && (
        <p className="mt-3 text-xs text-ink-500">Todavía no seguís ninguna palabra.</p>
      )}
      {aviso && <p className="mt-2 text-xs text-brand-300">{aviso}</p>}
    </div>
  );
}
