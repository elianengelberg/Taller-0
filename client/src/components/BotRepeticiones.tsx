import { useEffect, useState } from "react";
import {
  borrarRepeticion,
  crearRepeticion,
  fetchRepeticiones,
  RepeticionBot,
} from "../lib/api";

const DIAS = [
  { n: 1, letra: "L", nombre: "lunes" },
  { n: 2, letra: "M", nombre: "martes" },
  { n: 3, letra: "M", nombre: "miércoles" },
  { n: 4, letra: "J", nombre: "jueves" },
  { n: 5, letra: "V", nombre: "viernes" },
  { n: 6, letra: "S", nombre: "sábado" },
  { n: 0, letra: "D", nombre: "domingo" },
];

function comoSeLee(dias: number[]): string {
  const orden = DIAS.filter((d) => dias.includes(d.n));
  if (orden.length === 7) return "todos los días";
  if (orden.length === 5 && !dias.includes(0) && !dias.includes(6)) return "de lunes a viernes";
  return orden.map((d) => d.nombre).join(", ");
}

// "Mi reunión de todos los días a las 10": el link de siempre, los días y la
// hora. El bot entra solo, sin calendario de por medio.
//
// Existe porque conectar Google Calendar exige la "dirección secreta en
// formato iCal", que NO se puede copiar desde la app del celular ni del iPad
// (sólo desde la web de escritorio) -- y porque muchas reuniones de todos los
// días ni siquiera están anotadas en un calendario.
export default function BotRepeticiones({ botEnabled }: { botEnabled: boolean }) {
  const [lista, setLista] = useState<RepeticionBot[] | null>(null);
  const [abierto, setAbierto] = useState(false);
  const [titulo, setTitulo] = useState("");
  const [url, setUrl] = useState("");
  const [dias, setDias] = useState<number[]>([1, 2, 3, 4, 5]);
  const [hora, setHora] = useState("10:00");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchRepeticiones().then(setLista);
  }, []);

  async function agregar() {
    setGuardando(true);
    setError(null);
    const r = await crearRepeticion({ titulo, url: url.trim(), dias, hora });
    setGuardando(false);
    if (!r.ok) {
      setError(r.error ?? "No se pudo guardar.");
      return;
    }
    setLista(await fetchRepeticiones());
    setUrl("");
    setTitulo("");
    setAbierto(false);
  }

  async function quitar(id: string) {
    if (await borrarRepeticion(id)) setLista((l) => (l ?? []).filter((r) => r.id !== id));
  }

  if (lista === null) return null;

  return (
    <div className="mt-4 border-t border-ink-700 pt-4">
      <h4 className="text-xs font-semibold text-ink-200">Una reunión que se repite</h4>
      <p className="mt-1 text-xs leading-relaxed text-ink-400">
        ¿Tenés el link de siempre? Pegalo con sus días y su hora, y el bot entra solo. No hace
        falta conectar ningún calendario.
      </p>

      {lista.length > 0 && (
        <ul className="mt-3 space-y-2">
          {lista.map((r) => (
            <li
              key={r.id}
              className="flex items-start justify-between gap-3 rounded-xl border border-ink-700 bg-ink-900/50 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-strong">{r.titulo}</p>
                <p className="mt-0.5 text-[11px] text-ink-400">
                  {comoSeLee(r.dias)} a las {r.hora}
                </p>
                <p className="truncate text-[11px] text-ink-500">{r.url}</p>
              </div>
              <button
                type="button"
                onClick={() => void quitar(r.id)}
                className="shrink-0 rounded-lg border border-ink-600 px-2.5 py-1 text-[11px] font-semibold text-ink-300 hover:bg-ink-800"
              >
                Quitar
              </button>
            </li>
          ))}
        </ul>
      )}

      {!abierto ? (
        <button
          type="button"
          onClick={() => setAbierto(true)}
          disabled={!botEnabled}
          className="mt-3 w-full rounded-xl border border-brand-500/50 px-4 py-2.5 text-sm font-semibold text-brand-200 hover:bg-brand-500/10 disabled:opacity-50"
        >
          + Agregar una reunión de siempre
        </button>
      ) : (
        <div className="mt-3 space-y-3 rounded-xl border border-ink-700 bg-ink-900/50 p-3">
          <div>
            <label className="text-[11px] font-medium text-ink-300" htmlFor="rep-titulo">
              ¿Cómo la llamamos?
            </label>
            <input
              id="rep-titulo"
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
              placeholder="Ej: Clase de Fundamentos"
              className="mt-1 w-full rounded-xl border border-ink-600 bg-ink-900 px-3 py-2 text-sm text-strong placeholder:text-ink-500"
            />
          </div>
          <div>
            <label className="text-[11px] font-medium text-ink-300" htmlFor="rep-url">
              El link de la reunión
            </label>
            <input
              id="rep-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://meet.google.com/abc-defg-hij"
              className="mt-1 w-full rounded-xl border border-ink-600 bg-ink-900 px-3 py-2 text-sm text-strong placeholder:text-ink-500"
            />
          </div>
          <div>
            <p className="text-[11px] font-medium text-ink-300">¿Qué días?</p>
            <div className="mt-1.5 flex gap-1.5">
              {DIAS.map((d) => {
                const puesto = dias.includes(d.n);
                return (
                  <button
                    key={d.n}
                    type="button"
                    aria-pressed={puesto}
                    aria-label={d.nombre}
                    onClick={() =>
                      setDias((ds) => (puesto ? ds.filter((x) => x !== d.n) : [...ds, d.n]))
                    }
                    className={`h-9 w-9 rounded-full text-xs font-bold transition ${
                      puesto
                        ? "bg-brand-500 text-on-accent"
                        : "border border-ink-600 text-ink-400 hover:bg-ink-800"
                    }`}
                  >
                    {d.letra}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className="text-[11px] font-medium text-ink-300" htmlFor="rep-hora">
              ¿A qué hora empieza?
            </label>
            <input
              id="rep-hora"
              type="time"
              value={hora}
              onChange={(e) => setHora(e.target.value)}
              className="mt-1 w-full rounded-xl border border-ink-600 bg-ink-900 px-3 py-2 text-sm text-strong sm:w-40"
            />
            <p className="mt-1 text-[11px] text-ink-500">
              En la hora de este aparato. El bot llega puntual y espera hasta 30 minutos.
            </p>
          </div>
          {error && (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void agregar()}
              disabled={guardando || !url.trim() || dias.length === 0}
              className="flex-1 rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-on-accent hover:bg-brand-600 disabled:opacity-50"
            >
              {guardando ? "Guardando…" : "Guardar"}
            </button>
            <button
              type="button"
              onClick={() => { setAbierto(false); setError(null); }}
              className="rounded-xl border border-ink-600 px-4 py-2.5 text-sm font-semibold text-ink-300 hover:bg-ink-800"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
