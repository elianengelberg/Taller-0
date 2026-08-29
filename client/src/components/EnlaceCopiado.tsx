import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Button from "./Button";
import { detectMeetingPlatform, PLATFORM_REGISTRY } from "../lib/meetingPlatforms";

// El cartel de "te estás uniendo a una reunión", versión APP (la PC sin
// extensión, el iPad, Android). Una app instalada no puede ver otras
// pestañas ni otras apps -- eso sólo lo puede la extensión de PC, y es regla
// de los navegadores y de Apple/Google --, pero SÍ puede mirar su propio
// portapapeles. Con el permiso dado UNA vez (lo pide el botón "Pegar el
// enlace" del inicio), esta pieza vive en TODA la app: al abrirla, al volver
// a ella, y mientras está a la vista (Split View del iPad, media pantalla en
// Windows) un sondeo barato hace que copiar un enlace de reunión haga saltar
// el cartel al instante, sin tocar nada. "Entrar" dispara el circuito
// completo: subtítulos, traducción, transcripción, grabación e IA.
//
// Donde el navegador exige un gesto para leer (iPhone/iPad), esto calla y
// queda el botón de un toque del inicio: nunca un permiso a escondidas.

// En plena reunión (o ya en la pantalla de detección) el cartel no aparece:
// nada de interrumpir una llamada por un enlace suelto.
const RUTAS_QUIETAS = ["/reunion", "/externa"];

export default function EnlaceCopiado() {
  const navigate = useNavigate();
  const location = useLocation();
  const [oferta, setOferta] = useState<{ url: string; nombre: string } | null>(null);
  // La cuenta regresiva del cartel: 15 segundos a la vista y se CIERRA solo.
  // A diferencia de los carteles de reunión (que al vencer arrancan solos),
  // acá copiar un enlace no prueba que quieras entrar YA -- podés estar por
  // mandárselo a alguien --, así que vencerse significa correrse del medio,
  // nunca navegarte la app sin permiso.
  const [restante, setRestante] = useState(15);
  // Lo ya ofrecido en esta carga: el sondeo no debe re-disparar lo mismo.
  const vistoRef = useRef<string>("");

  const quieta = RUTAS_QUIETAS.some(
    (r) => location.pathname === r || location.pathname.startsWith(`${r}/`)
  );

  useEffect(() => {
    if (quieta) return;
    let vivo = true;
    async function mirar(): Promise<void> {
      try {
        const permiso = await navigator.permissions?.query?.({
          name: "clipboard-read" as PermissionName,
        });
        if (permiso?.state !== "granted") return; // sin permiso previo: ni intentarlo
        if (document.visibilityState !== "visible") return;
        const texto = (await navigator.clipboard.readText()).trim();
        if (!vivo || !texto || texto.length > 800) return;
        const det = detectMeetingPlatform(texto, { selfHosts: [window.location.hostname] });
        if (det.platform === "unknown" || det.platform === "encuentro" || !det.url) return;
        if (det.url === vistoRef.current) return;
        try {
          if (sessionStorage.getItem(`unify-vi:${det.url}`)) return; // ya dijo "ahora no"
        } catch { /* sin storage */ }
        vistoRef.current = det.url;
        setOferta({ url: det.url, nombre: PLATFORM_REGISTRY[det.platform].label });
      } catch {
        /* iPhone/iPad (exigen gesto), permiso revocado o sin foco: silencio */
      }
    }
    void mirar();
    const alVolver = () => {
      if (document.visibilityState === "visible") void mirar();
    };
    document.addEventListener("visibilitychange", alVolver);
    window.addEventListener("focus", alVolver);
    const timer = setInterval(() => void mirar(), 3000);
    return () => {
      vivo = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", alVolver);
      window.removeEventListener("focus", alVolver);
    };
  }, [quieta]);

  useEffect(() => {
    if (!oferta) return;
    setRestante(15);
    const reloj = setInterval(() => {
      setRestante((r) => {
        if (r <= 1) {
          clearInterval(reloj);
          setOferta(null); // se corre solo; el mismo enlace no re-insiste en esta carga
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(reloj);
  }, [oferta]);

  if (!oferta || quieta) return null;

  const recordar = () => {
    try { sessionStorage.setItem(`unify-vi:${oferta.url}`, "1"); } catch { /* sin storage */ }
  };

  return (
    // AL MEDIO y grande, como todos los carteles de "¿usamos Unify?": en el
    // borde de arriba se perdía. El contenedor no roba clics (la app sigue
    // usable atrás); sólo la tarjeta los recibe.
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-4">
      <div
        data-cartel-enlace
        role="dialog"
        aria-label="Aviso de Unify"
        className="pointer-events-auto w-full max-w-lg rounded-3xl border border-brand-500/50 bg-ink-900/95 p-6 shadow-top backdrop-blur-md"
      >
        <p className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-widest text-brand-300">
          <span className="h-2.5 w-2.5 rounded-full bg-brand-400 shadow-[0_0_8px_rgba(96,165,250,0.8)]" aria-hidden />
          Unify
        </p>
        <p className="mt-3 text-lg font-semibold leading-snug text-strong">
          Uy, veo que copiaste un enlace de {oferta.nombre}. ¿Entramos con Unify?
        </p>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-400">
          Subtítulos en vivo con traducción, transcripción, grabación y resumen con IA.
        </p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <Button
            className="flex-1 py-3 text-base"
            onClick={() => {
              recordar();
              const url = oferta.url;
              setOferta(null);
              navigate(`/externa?url=${encodeURIComponent(url)}`);
            }}
          >
            Entrar con subtítulos y grabación
          </Button>
          <button
            type="button"
            onClick={() => {
              recordar();
              setOferta(null);
            }}
            className="rounded-xl border border-ink-600 px-5 py-3 text-sm font-semibold text-ink-300 hover:bg-ink-800"
          >
            Ahora no
          </button>
        </div>
        <p className="mt-3 text-xs text-ink-500">
          Este aviso se corre solo en {restante} segundo{restante === 1 ? "" : "s"} (no entra a ningún lado sin que toques).
        </p>
      </div>
    </div>
  );
}
