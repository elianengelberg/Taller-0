// Screen sharing and recording both ride on getDisplayMedia, and that API
// simply doesn't exist in iOS/iPadOS WebKit -- every browser on iPhone/iPad
// is WebKit underneath, so capturing the screen from a web page there is
// impossible, not merely unpermitted. Feature-detect it once so the UI can
// say that honestly instead of blaming a cancelled permission prompt.
export const screenCaptureSupported =
  typeof navigator !== "undefined" &&
  typeof navigator.mediaDevices?.getDisplayMedia === "function";

export const SHARE_UNSUPPORTED_MESSAGE =
  "Este navegador no puede capturar la pantalla: en iPhone y iPad ningún navegador lo permite. Para compartir pantalla, entrá a la reunión desde una computadora.";

export const RECORDING_UNSUPPORTED_MESSAGE =
  "La grabación captura la pantalla de la reunión y este navegador no lo permite: en iPhone y iPad ningún navegador puede. Para grabar, entrá desde una computadora.";

// NotAllowedError covers both the user pressing "Cancelar" in the picker and
// an OS-level block (macOS's screen-recording privacy setting) -- the spec
// doesn't let pages tell those apart, so the message covers both.
export function displayMediaErrorMessage(err: unknown, action: string): string {
  if (!screenCaptureSupported) return SHARE_UNSUPPORTED_MESSAGE;
  if (err instanceof DOMException && err.name === "NotAllowedError") {
    return `No se pudo ${action}: cancelaste el permiso, o el sistema lo tiene bloqueado (en Mac: Ajustes del Sistema → Privacidad y seguridad → Grabación de pantalla, habilitá tu navegador).`;
  }
  const detail = err instanceof DOMException ? ` (${err.name})` : "";
  return `No se pudo ${action}${detail}. Probá de nuevo.`;
}

// Qué pistas de video vienen de la pantalla y no de una cámara.
//
// Hace falta porque compartir pantalla mete la pista de la pantalla en el
// MISMO stream local donde vivía la cámara. Sin poder distinguirlas, cualquier
// acción que busque "la pista de video" agarraba la pantalla: apagar la cámara
// dejaba a todos viendo negro, y cambiar de cámara mataba la pantalla
// compartida dejando el estado colgado.
//
// Un WeakSet y no `getSettings().displaySurface`: ese campo no existe en todos
// los navegadores, y acá no hace falta adivinar nada -- nosotros mismos
// pedimos esa pista, así que la marcamos.
const screenTracks = new WeakSet<MediaStreamTrack>();

export function markScreenTrack(track: MediaStreamTrack): void {
  screenTracks.add(track);
}

export function isScreenTrack(track: MediaStreamTrack | null | undefined): boolean {
  return Boolean(track) && screenTracks.has(track!);
}
