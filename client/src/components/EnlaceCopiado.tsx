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

  if (!oferta || quieta) return null;

  const recordar = () => {
    try { sessionStorage.setItem(`unify-vi:${oferta.url}`, "1"); } catch { /* sin storage */ }
  };

  return (
    <div className="pointer-events-auto fixed inset-x-3 top-3 z-50 mx-auto max-w-md rounded-2xl border border-brand-500/50 bg-ink-900/95 p-4 shadow-top backdrop-blur-md">
      <p className="text-sm font-semibold text-strong">
        Uy, veo que copiaste un enlace de {oferta.nombre}. ¿Entramos con Unify?
      </p>
      <div className="mt-2.5 flex gap-2">
        <Button
          className="flex-1"
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
          className="rounded-xl px-4 py-2.5 text-sm font-medium text-ink-300 hover:bg-ink-800"
        >
          Ahora no
        </button>
      </div>
    </div>
  );
}
