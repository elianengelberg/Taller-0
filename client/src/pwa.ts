// La capa PWA: registro del service worker y manejo de lanzamientos.
//
// Dos reglas que protegen a quien está EN una reunión:
//
//  1. La actualización pide permiso, y sólo fuera de una reunión. Un
//     skipWaiting automático intercambia los chunks bajo los pies de la
//     malla WebRTC en vivo; el peor momento posible para "mejorar" la app.
//     Pero "fuera de una reunión" no es "nunca": si el aviso llegó en plena
//     llamada, queda PENDIENTE y se ofrece apenas la persona sale. Y la app
//     abierta busca versiones nuevas cada hora, así los deploys de acá
//     llegan aunque nadie recargue la pestaña en días.
//  2. launch_handler es focus-existing: abrir un enlace de Unify desde otra
//     app enfoca la ventana que ya está, y ACÁ se decide si navegar. Con una
//     reunión activa no se navega nunca solo -- se avisa y la persona decide.
import { registerSW } from "virtual:pwa-register";
import { showToast } from "./lib/toasts";

// --- Instalación con un clic -------------------------------------------------
// Chrome dispara `beforeinstallprompt` cuando la app es instalable, muchas
// veces ANTES de que la página de instalación exista siquiera. Se guarda acá
// (módulo, no React) y /instalar lo consume: si está, el botón instala de
// verdad con un clic; si no (iOS, Firefox, ya instalada), la página muestra
// los pasos manuales de cada plataforma.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
let deferredInstall: BeforeInstallPromptEvent | null = null;

export function canPromptInstall(): boolean {
  return deferredInstall !== null;
}

/** true si la persona aceptó instalar. */
export async function promptInstall(): Promise<boolean> {
  const ev = deferredInstall;
  if (!ev) return false;
  deferredInstall = null;
  await ev.prompt();
  const { outcome } = await ev.userChoice;
  return outcome === "accepted";
}

/**
 * ¿Está la extensión de Unify instalada EN ESTE navegador?
 *
 * Devuelve su versión, o null. La marca la deja el content script de la
 * extensión en <html> (ver extension/auth-sync.js): página y content script
 * no comparten variables, pero sí el DOM.
 *
 * Por qué existe: una web no puede ver las otras pestañas, así que la app no
 * se entera de que entraste a una reunión -- eso lo hace la extensión. Pero
 * puede decirte si la extensión está acá, que es justo lo que le falta saber
 * a quien la instaló en un navegador y abre las reuniones en otro.
 */
export function extensionInstalada(): string | null {
  return document.documentElement.dataset.unifyExtension ?? null;
}

/** Avisa cuando la extensión se anuncia (puede llegar después del render). */
export function onExtensionDetectada(cb: (version: string) => void): () => void {
  const handler = (e: Event) => {
    const v = (e as CustomEvent<{ version: string }>).detail?.version;
    if (v) cb(v);
  };
  window.addEventListener("unify:extension", handler);
  return () => window.removeEventListener("unify:extension", handler);
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function enReunion(): boolean {
  const p = window.location.pathname;
  return p === "/reunion" || p === "/externa/reunion";
}

/**
 * El aviso de "el servidor estaba dormido".
 *
 * El plan gratuito de Render apaga la instancia tras un rato sin visitas y la
 * primera llamada la despierta: puede tardar casi un minuto. Sin decir nada,
 * eso se siente idéntico a que la app está rota, y la gente cierra la
 * pestaña. Con una línea honesta, espera.
 */
function avisosDeServidorDormido(): void {
  window.addEventListener("unify:servidor-despertando", () => {
    showToast(
      {
        kind: "info",
        text: "El servidor estaba en reposo y se está encendiendo. Puede tardar hasta un minuto la primera vez.",
      },
      60_000
    );
  });
  window.addEventListener("unify:servidor-despierto", () => {
    showToast({ kind: "info", text: "Listo, el servidor ya está despierto." }, 4000);
  });
}

export function initPwa(): void {
  avisosDeServidorDormido();
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // sin mini-barra automática: instala /instalar
    deferredInstall = e as BeforeInstallPromptEvent;
    // Aviso a la página de instalación, si ya está montada.
    window.dispatchEvent(new Event("unify:instalable"));
  });

  // Aviso que llegó en plena reunión: no molestar ahí, pero tampoco tragarlo.
  let actualizacionPendiente = false;

  const avisar = () => {
    showToast(
      {
        kind: "info",
        text: "Hay una versión nueva de Unify.",
        actionLabel: "Actualizar",
        onAction: () => void updateSW(true),
      },
      30_000
    );
  };

  const updateSW = registerSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      // La app puede quedar abierta días (sobre todo instalada): revisar cada
      // hora si hay una versión nueva, en vez de esperar la próxima recarga.
      setInterval(() => void registration.update().catch(() => {}), 60 * 60 * 1000);
    },
    onNeedRefresh() {
      // En plena reunión ni se ofrece: queda pendiente para cuando salga.
      if (enReunion()) {
        actualizacionPendiente = true;
        return;
      }
      avisar();
    },
    // Sin aviso de "listo para offline": es plomería, no una noticia.
  });

  // El aviso pendiente espera a que la reunión termine. Un sondeo barato del
  // pathname alcanza: no hay que acoplar este módulo al router para esto.
  setInterval(() => {
    if (actualizacionPendiente && !enReunion()) {
      actualizacionPendiente = false;
      avisar();
    }
  }, 15_000);

  // Enlaces que llegan con la app ya abierta (focus-existing los entrega acá).
  interface LaunchParams { targetURL?: string }
  interface LaunchQueue { setConsumer(cb: (params: LaunchParams) => void): void }
  const queue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue;
  if (queue) {
    queue.setConsumer((params) => {
      if (!params?.targetURL) return;
      let destino: URL;
      try {
        destino = new URL(params.targetURL);
      } catch {
        return;
      }
      if (destino.origin !== window.location.origin) return;
      const aca = window.location.pathname + window.location.search;
      const alla = destino.pathname + destino.search;
      if (alla === aca) return;
      if (enReunion()) {
        // Nunca reventar una reunión en curso por un clic afuera.
        showToast({
          kind: "info",
          text: "Se abrió un enlace de Unify. Terminá la reunión y entrá desde el inicio.",
        });
        return;
      }
      // Recarga simple: fuera de una reunión no hay estado que perder, y así
      // no hace falta acoplar este módulo al router de React.
      window.location.href = destino.href;
    });
  }
}
