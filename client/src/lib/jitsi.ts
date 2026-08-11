// Loads Jitsi's official embed API (external_api.js) on demand. This is the
// supported, credential-free way to run a real Jitsi meeting inside our own
// page -- no account, key, or server signature needed, unlike Zoom. The
// script is fetched once and cached (a shared promise) so navigating in and
// out of a meeting doesn't re-inject it.

export const JITSI_MEET_DOMAIN = "meet.jit.si";

// Una promesa por servidor: además del meet.jit.si público existen 8x8.vc
// (Jitsi as a Service) y las instalaciones propias, y cada una sirve su propio
// external_api. Cachear una sola haría que la segunda sala se conectara al
// servidor equivocado.
const scriptPromises = new Map<string, Promise<void>>();

// Sólo un dominio con forma de dominio: este valor sale de la URL que pegó el
// usuario y termina en el src de un <script>, así que no puede llevar nada
// raro.
function safeDomain(domain: string): string | null {
  return /^[a-z0-9.-]+$/i.test(domain) && domain.includes(".") ? domain : null;
}

export function loadJitsiApi(domain: string = JITSI_MEET_DOMAIN): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Jitsi solo puede cargarse en el navegador."));
  }
  const server = safeDomain(domain);
  if (!server) return Promise.reject(new Error("El servidor de Jitsi del enlace no es válido."));
  // Ya cargado: el external_api sólo puede existir una vez por página, así que
  // si otro servidor lo dejó puesto, se reutiliza (el dominio real de la sala
  // se pasa igual al construir la API).
  if (window.JitsiMeetExternalAPI) return Promise.resolve();
  const cached = scriptPromises.get(server);
  if (cached) return cached;

  const scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://${server}/external_api.js`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      // Let a later attempt retry from scratch instead of being stuck with a
      // permanently-rejected cached promise (e.g. a transient network blip).
      scriptPromises.delete(server);
      reject(new Error("No se pudo cargar Jitsi. Revisá tu conexión e intentá de nuevo."));
    };
    document.head.appendChild(script);
  });
  scriptPromises.set(server, scriptPromise);
  return scriptPromise;
}
