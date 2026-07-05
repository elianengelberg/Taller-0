// Loads Zoom's official Meeting SDK for web (Component View) on demand, the
// same way lib/jitsi.ts loads Jitsi's external_api. We use the CDN bundle
// (not the npm package) on purpose:
//   - it ships its own React internally, so it doesn't clash with our app's
//     React (the npm package pins react@18.2.0 exactly, which conflicts);
//   - it keeps the ~MBs of SDK out of our main Vite bundle -- only fetched
//     when someone actually joins a Zoom meeting;
//   - it mirrors the proven, credential-free Jitsi loader pattern.
// The bundle resolves its own audio/video worker + wasm assets from
// `https://source.zoom.us/{version}/lib/av` automatically, so nothing else
// needs configuring. Bump ZOOM_SDK_VERSION to upgrade.

export const ZOOM_SDK_VERSION = "6.2.0";
const SCRIPT_URL = `https://source.zoom.us/${ZOOM_SDK_VERSION}/zoom-meeting-embedded-${ZOOM_SDK_VERSION}.min.js`;

let scriptPromise: Promise<void> | null = null;

export function loadZoomSdk(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("El SDK de Zoom solo puede cargarse en el navegador."));
  }
  if (window.ZoomMtgEmbedded) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      // Reset so a later attempt can retry instead of being stuck with a
      // permanently-rejected cached promise (e.g. a transient network blip).
      scriptPromise = null;
      reject(new Error("No se pudo cargar el SDK de Zoom. Revisá tu conexión e intentá de nuevo."));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}
