// Loads Jitsi's official embed API (external_api.js) on demand. This is the
// supported, credential-free way to run a real Jitsi meeting inside our own
// page -- no account, key, or server signature needed, unlike Zoom. The
// script is fetched once and cached (a shared promise) so navigating in and
// out of a meeting doesn't re-inject it.

export const JITSI_MEET_DOMAIN = "meet.jit.si";
const SCRIPT_URL = `https://${JITSI_MEET_DOMAIN}/external_api.js`;

let scriptPromise: Promise<void> | null = null;

export function loadJitsiApi(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Jitsi solo puede cargarse en el navegador."));
  }
  if (window.JitsiMeetExternalAPI) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      // Let a later attempt retry from scratch instead of being stuck with a
      // permanently-rejected cached promise (e.g. a transient network blip).
      scriptPromise = null;
      reject(new Error("No se pudo cargar Jitsi. Revisá tu conexión e intentá de nuevo."));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}
