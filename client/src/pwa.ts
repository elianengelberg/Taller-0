// La capa PWA: registro del service worker y manejo de lanzamientos.
//
// Dos reglas que protegen a quien está EN una reunión:
//
//  1. La app se actualiza SOLA, pero nunca encima de la persona. Un
//     skipWaiting a destiempo intercambia los chunks bajo los pies de la
//     malla WebRTC en vivo, o borra un formulario a medio llenar: por eso la
//     versión nueva espera a un MOMENTO SEGURO (fuera de una reunión y sin
//     texto recién escrito en pantalla) y recién ahí se aplica sin preguntar.
//     La app abierta busca versiones nuevas cada hora y al volver a primer
//     plano, así los deploys de acá llegan aunque nadie recargue en días.
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

// --- Actualización automática ------------------------------------------------
// Nadie tendría que instalar versiones a mano: ni acá, ni en la app instalada
// de Windows, ni en el iPhone o el iPad. El service worker ya baja la versión
// nueva solo; lo único que hacía falta era APLICARLA sin pedir permiso.
//
// "Sin pedir permiso" no es "en cualquier momento": aplicarla recarga la
// página. Se espera a un momento en el que una recarga no cuesta nada.

/** Marca de tiempo del último tecleo REAL de la persona. */
let ultimoTecleo = 0;

/** ¿Hay texto escrito en pantalla que una recarga borraría? */
function hayTextoEnPantalla(): boolean {
  const campos = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
  for (const campo of campos) {
    const tipo = (campo as HTMLInputElement).type;
    if (tipo === "checkbox" || tipo === "radio" || tipo === "hidden" || tipo === "submit") continue;
    if (campo.value.trim() !== "") return true;
  }
  return false;
}

/**
 * Recargar ahora, ¿le cuesta algo a la persona?
 *
 * En una reunión, todo. Con un formulario a medio llenar (recién tecleado:
 * lo autocompletado por el navegador vuelve solo), también. Fuera de eso, no.
 */
function momentoSeguro(): boolean {
  if (enReunion()) return false;
  const tecleandoRecien = Date.now() - ultimoTecleo < 5 * 60_000;
  return !(tecleandoRecien && hayTextoEnPantalla());
}

// Freno anti-bucle: si una versión rota se reinstalara sin parar, la app
// quedaría recargándose para siempre. Tres intentos por sesión y después se
// ofrece el botón, que es visible y lo decide la persona.
const MAX_AUTO = 3;
const CLAVE_AUTO = "unify-auto-update";

function autoAplicadas(): number {
  try {
    return Number(sessionStorage.getItem(CLAVE_AUTO) ?? "0") || 0;
  } catch {
    return 0;
  }
}
function anotarAuto(): void {
  try {
    sessionStorage.setItem(CLAVE_AUTO, String(autoAplicadas() + 1));
  } catch {
    /* modo incógnito con storage bloqueado: el freno se pierde, no la app */
  }
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

  // Sólo cuenta lo que TECLEA la persona: el autocompletado del navegador
  // llena campos solo y volvería a llenarlos después de recargar.
  document.addEventListener(
    "input",
    (e) => {
      if (e.isTrusted) ultimoTecleo = Date.now();
    },
    true
  );

  // Hay una versión nueva bajada, esperando su momento.
  let pendiente = false;
  // Ya se mandó a activar la versión nueva en esta carga de la página.
  let aplicada = false;

  /**
   * La recarga, puesta por nosotros.
   *
   * Workbox también recarga, pero SÓLO si considera que la versión nueva es
   * "una actualización de esta pestaña". La que dejó esperando otra pestaña
   * (o la sesión anterior) le figura como externa y no recarga nunca: la app
   * quedaría con el service worker nuevo y los chunks viejos en pantalla.
   * Este listener cierra ese agujero, y recargar dos veces no hace daño.
   */
  const recargarAlTomarControl = () => {
    navigator.serviceWorker?.addEventListener(
      "controllerchange",
      () => window.location.reload(),
      { once: true }
    );
  };

  const avisarComoUltimoRecurso = () => {
    showToast(
      {
        kind: "info",
        text: "Hay una versión nueva de Unify.",
        actionLabel: "Actualizar",
        onAction: () => {
          recargarAlTomarControl();
          void updateSW(true);
        },
      },
      30_000
    );
  };

  // El botón DURANTE la reunión, una vez por versión. Antes, la versión
  // nueva esperaba en silencio a que la reunión terminara: correcto para no
  // recargar encima de nadie, pero quien QUERÍA lo nuevo ya no tenía forma
  // de aplicarlo. Ahora se avisa con el botón y la persona decide.
  let ofrecidaEnReunion = false;
  const ofrecerEnReunion = () => {
    if (ofrecidaEnReunion) return;
    ofrecidaEnReunion = true;
    showToast(
      {
        kind: "info",
        text: "Hay una versión nueva de Unify. La aplicamos solos al salir de la reunión — o tocá Actualizar ahora (recarga esta pantalla).",
        actionLabel: "Actualizar",
        onAction: () => {
          recargarAlTomarControl();
          void updateSW(true);
        },
      },
      30_000
    );
  };

  /** Aplica la versión nueva si se puede. Devuelve true si la aplicó. */
  const aplicarSiSePuede = (): boolean => {
    if (!pendiente || aplicada) return false;
    if (!momentoSeguro()) {
      if (enReunion()) ofrecerEnReunion();
      return false;
    }
    if (autoAplicadas() >= MAX_AUTO) {
      pendiente = false;
      avisarComoUltimoRecurso();
      return false;
    }
    pendiente = false;
    aplicada = true;
    anotarAuto();
    recargarAlTomarControl();
    void updateSW(true);
    return true;
  };

  const updateSW = registerSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return;

      // Paracaídas: una versión que quedó esperando de la sesión anterior.
      // Workbox normalmente la anuncia como `waiting` y eso llega abajo como
      // onNeedRefresh; si no llegó, se aplica igual desde acá.
      setTimeout(() => {
        if (aplicada || !registration.waiting) return;
        pendiente = true;
        aplicarSiSePuede();
      }, 3000);

      // La app puede quedar abierta días (sobre todo instalada): revisar
      // seguido si hay una versión nueva, en vez de esperar la próxima
      // recarga. Buscar es UN fetch del sw.js: cuesta nada.
      const buscar = () => void registration.update().catch(() => {});
      setInterval(buscar, 15 * 60 * 1000);

      // Y al volver a primer plano, casi siempre. En iPhone y iPad la app
      // instalada queda suspendida (el setInterval no corre ahí) y volver a
      // abrirla es EL momento en el que la gente espera ver lo nuevo: con el
      // freno anterior de 15 minutos, quien volvía a los cinco se quedaba
      // con la versión vieja sin aviso ninguno.
      let ultimaBusqueda = 0;
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") {
          // Irse a otra pestaña es el mejor momento posible para recargar.
          aplicarSiSePuede();
          return;
        }
        if (Date.now() - ultimaBusqueda < 60_000) return;
        ultimaBusqueda = Date.now();
        buscar();
      });
    },
    onNeedRefresh() {
      // Sin preguntar: si el momento es seguro se aplica ya, y si no queda
      // anotada para el primer momento seguro que aparezca.
      pendiente = true;
      aplicarSiSePuede();
    },
    // Sin aviso de "listo para offline": es plomería, no una noticia.
  });

  // El reintento: la reunión terminó, o la persona dejó de escribir. Un sondeo
  // barato alcanza; no hay que acoplar este módulo al router para esto.
  setInterval(() => {
    aplicarSiSePuede();
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
