import { CaptionsIcon, SparklesIcon } from "./icons";

// Un "mockup" del producto al estilo de las páginas de descarga (Discord):
// un marco de dispositivo con un blob de color detrás y una representación
// de la pantalla de Unify (video + subtítulo en vivo + transcripción). Se
// dibuja con HTML/CSS -- no es una captura real, es una maqueta fiel, y así
// no depende de ningún archivo de imagen (el CSP sólo permite lo propio).

// Filas de transcripción de ejemplo para llenar la maqueta.
const LINEAS = [
  { quien: "Ana", color: "#6366f1", texto: "Arrancamos con el presupuesto del trimestre." },
  { quien: "Bruno", color: "#0ea5e9", texto: "La curva de ventas viene mejor de lo que esperábamos." },
  { quien: "Caro", color: "#10b981", texto: "Perfecto, cerramos los números el jueves." },
];

// Variante ESCRITORIO: marco ancho apaisado, blob verde/celeste.
export function AppMockupDesktop({ className = "" }: { className?: string }) {
  return (
    <div className={`relative ${className}`}>
      <div className="absolute -inset-6 -z-10 rounded-[2.5rem] bg-gradient-to-br from-emerald-400/40 via-sky-400/30 to-indigo-500/30 blur-2xl" />
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-900 shadow-2xl ring-1 ring-black/5">
        <div className="flex items-center gap-1.5 bg-slate-800 px-3 py-2">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
          <span className="ml-2 text-[10px] text-slate-400">unify-meet.com · reunión</span>
        </div>
        <div className="grid grid-cols-3 gap-2 p-3">
          <div className="col-span-2">
            <div className="relative aspect-video overflow-hidden rounded-lg bg-gradient-to-br from-slate-700 to-slate-800">
              <div className="absolute inset-0 grid grid-cols-2 gap-1 p-1.5">
                <div className="rounded bg-slate-600/60" />
                <div className="rounded bg-slate-600/40" />
                <div className="rounded bg-slate-600/50" />
                <div className="rounded bg-slate-600/60" />
              </div>
              <div className="absolute inset-x-2 bottom-2 flex justify-center">
                <span className="rounded-lg bg-black/70 px-2.5 py-1 text-[10px] font-medium text-white backdrop-blur-sm">
                  <span className="text-sky-300">Bruno:</span> la curva de ventas viene mejor…
                </span>
              </div>
            </div>
          </div>
          <div className="rounded-lg bg-slate-800 p-2">
            <div className="flex items-center gap-1 text-[9px] font-semibold text-sky-300">
              <CaptionsIcon className="h-3 w-3" /> Transcripción
            </div>
            <div className="mt-1.5 space-y-1.5">
              {LINEAS.map((l) => (
                <div key={l.quien} className="rounded bg-slate-700/60 p-1.5">
                  <span className="text-[8px] font-bold" style={{ color: l.color }}>{l.quien}</span>
                  <p className="text-[8px] leading-tight text-slate-300">{l.texto}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Variante CELULAR: marco de teléfono vertical, blob violeta/rosa.
export function AppMockupPhone({ className = "" }: { className?: string }) {
  return (
    <div className={`relative ${className}`}>
      <div className="absolute -inset-6 -z-10 rounded-[3rem] bg-gradient-to-br from-indigo-500/40 via-fuchsia-500/25 to-pink-400/30 blur-2xl" />
      <div className="mx-auto w-52 overflow-hidden rounded-[2rem] border-4 border-slate-800 bg-slate-900 shadow-2xl">
        <div className="flex justify-center bg-slate-800 py-1.5">
          <span className="h-1 w-14 rounded-full bg-slate-600" />
        </div>
        <div className="p-2.5">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold text-strong text-white">
            <SparklesIcon className="h-3.5 w-3.5 text-sky-300" /> Reunión de equipo
          </div>
          <div className="relative mt-2 aspect-[3/4] overflow-hidden rounded-xl bg-gradient-to-br from-slate-700 to-slate-800">
            <div className="absolute inset-x-1.5 bottom-1.5 space-y-1">
              {LINEAS.slice(0, 2).map((l) => (
                <div key={l.quien} className="rounded-lg bg-black/60 px-1.5 py-1 backdrop-blur-sm">
                  <span className="text-[8px] font-bold" style={{ color: l.color }}>{l.quien}</span>
                  <p className="text-[8px] leading-tight text-white">{l.texto}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-2 rounded-lg bg-brand-500 py-1.5 text-center text-[9px] font-semibold text-white">
            Grabar y transcribir
          </div>
        </div>
      </div>
    </div>
  );
}
