// Grabación automática de reuniones externas.
//
// Lo que el navegador permite y lo que no (esto es lo que dicta el diseño):
//
//  - `getUserMedia({audio})` NO exige un gesto del usuario. Con el permiso de
//    micrófono ya concedido (que en una reunión externa siempre lo está,
//    porque los subtítulos lo usan), se puede empezar a grabar solo.
//  - `getDisplayMedia()` SÍ exige "activación transitoria": el navegador la
//    rechaza si no viene de un clic reciente. No hay forma de sortearlo, y no
//    es un bug nuestro.
//
// La salida: el clic en "Unirme acá dentro" ES un gesto válido, así que
// pedimos ahí la captura de pantalla y guardamos el stream en este módulo
// (sobrevive a la navegación del SPA, que no recarga la página). Si no hay
// stream -- entraron por URL directa, recargaron, o dijeron que no al selector
// -- la grabación arranca igual en modo solo audio. En los dos casos el
// usuario no toca nada.

const PREF_KEY = "unify_autorecord_externa";

export function autoRecordEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setAutoRecordEnabled(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0");
  } catch {
    /* modo privado: se pierde la preferencia, no la función */
  }
}

// --- Traspaso del stream entre la pantalla de unirse y la de la reunión ---

let pending: { stream: MediaStream; at: number } | null = null;
const PENDING_TTL_MS = 60_000;

export function stashDisplayStream(stream: MediaStream): void {
  discardStashedDisplayStream();
  pending = { stream, at: Date.now() };
}

// Devuelve el stream una sola vez. Si quedó viejo (el usuario se quedó en la
// pantalla anterior un minuto) o si ya se cortó, lo descarta: grabar una
// captura muerta produciría un archivo vacío.
export function takeDisplayStream(): MediaStream | null {
  if (!pending) return null;
  const { stream, at } = pending;
  pending = null;
  const live = stream.getVideoTracks().some((t) => t.readyState === "live");
  if (!live || Date.now() - at > PENDING_TTL_MS) {
    stream.getTracks().forEach((t) => t.stop());
    return null;
  }
  return stream;
}

export function discardStashedDisplayStream(): void {
  pending?.stream.getTracks().forEach((t) => t.stop());
  pending = null;
}

/**
 * Pide la captura de pantalla APROVECHANDO el gesto del usuario en curso.
 * Devuelve null (sin lanzar) si el navegador no puede o si la persona cancela:
 * la grabación automática sigue igual en modo solo audio.
 *
 * `selfBrowserSurface: "exclude"` saca a la propia pestaña de Unify del
 * selector, que es lo que evita el "túnel infinito" (grabar la pantalla donde
 * se ve la grabación, recursivamente).
 */
export async function requestDisplayStreamOnGesture(): Promise<MediaStream | null> {
  if (typeof navigator === "undefined" || typeof navigator.mediaDevices?.getDisplayMedia !== "function") {
    return null;
  }
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } },
      audio: true,
      // Tipados como opcionales: son extensiones de Chromium y los navegadores
      // que no las conocen simplemente las ignoran.
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      systemAudio: "include",
    } as DisplayMediaStreamOptions);
  } catch {
    return null;
  }
}

/**
 * ¿La captura elegida contiene a la propia pestaña de Unify? Compartir el
 * monitor entero mientras Unify está a la vista produce el efecto túnel. No se
 * puede bloquear (el usuario tiene derecho a grabar su pantalla), pero sí
 * avisar, que es lo que faltaba.
 */
export function capturesOwnScreen(stream: MediaStream | null): boolean {
  const settings = stream?.getVideoTracks()[0]?.getSettings() as
    | (MediaTrackSettings & { displaySurface?: string })
    | undefined;
  return settings?.displaySurface === "monitor";
}
