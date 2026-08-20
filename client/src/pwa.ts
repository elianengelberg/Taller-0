// La capa PWA: registro del service worker y manejo de lanzamientos.
//
// Dos reglas que protegen a quien está EN una reunión:
//
//  1. La actualización pide permiso, y sólo fuera de una reunión. Un
//     skipWaiting automático intercambia los chunks bajo los pies de la
//     malla WebRTC en vivo; el peor momento posible para "mejorar" la app.
//  2. launch_handler es focus-existing: abrir un enlace de Unify desde otra
//     app enfoca la ventana que ya está, y ACÁ se decide si navegar. Con una
//     reunión activa no se navega nunca solo -- se avisa y la persona decide.
import { registerSW } from "virtual:pwa-register";
import { showToast } from "./lib/toasts";

function enReunion(): boolean {
  const p = window.location.pathname;
  return p === "/reunion" || p === "/externa/reunion";
}

export function initPwa(): void {
  const updateSW = registerSW({
    onNeedRefresh() {
      // En plena reunión ni se ofrece: el aviso saldrá en la próxima carga.
      if (enReunion()) return;
      showToast(
        {
          kind: "info",
          text: "Hay una versión nueva de Unify.",
          actionLabel: "Actualizar",
          onAction: () => void updateSW(true),
        },
        30_000
      );
    },
    // Sin aviso de "listo para offline": es plomería, no una noticia.
  });

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
