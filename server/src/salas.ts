// LA CLAVE DE UNA SALA EXTERNA, en un solo lugar.
//
// Es la identidad de una reunión que vive en otra app ("zoom:89123456789",
// "google-meet:abc-defg-hij"): la usan el puente de la extensión, el bot, y
// ahora también una reunión de Unify que tiene su otra puerta en Zoom, Meet o
// Teams. Vivía adentro de index.ts, que socketHandlers no puede importar (se
// importan al revés), así que se mudó acá tal cual.
export const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

export const BRIDGE_PLATFORMS = new Set([
  "google-meet", "zoom", "teams", "jitsi", "webex", "whereby", "element",
  "chime", "goto", "bluejeans", "ringcentral", "dialpad", "livestorm", "zoho",
  "skype", "discord", "slack", "whatsapp", "gather", "generica",
  // Cualquier web: la clave que la web y la extensión derivan de un enlace
  // que no reconocen por nombre (origen + path). Ver externalFallbackKey.
  "externa",
  // La reunión detectada por la APP DE WINDOWS (la app de Zoom o de Teams,
  // no una web): la barra companion y el grabador silencioso comparten esta
  // sala. La cola dice cuál app fue ("zoom-...", "teams-...").
  "escritorio",
]);

/**
 * Normaliza el id que llega por la URL a una clave de sala, o null si no es
 * válido. Un código de Meet pelado ("abc-defg-hij") sigue andando tal cual --
 * es lo que manda la extensión v3 instalada -- y se mapea a la misma clave
 * "google-meet:código" de siempre, así que nadie pierde su sala.
 */
export function claveDeSalaValida(raw: string): string | null {
  const value = String(raw ?? "").trim().toLowerCase().slice(0, 240);
  if (MEET_CODE_RE.test(value)) return `google-meet:${value}`;
  const sep = value.indexOf(":");
  if (sep <= 0) return null;
  const platform = value.slice(0, sep);
  const tail = value.slice(sep + 1);
  if (!BRIDGE_PLATFORMS.has(platform)) return null;
  // El resto de la clave sale de hosts, paths y ids de reunión: letras,
  // números y la puntuación que esos formatos usan de verdad (Teams mete
  // "19:meeting_...@thread.v2", Jitsi "dominio/sala"). Nada de espacios ni
  // caracteres de control.
  if (!/^[a-z0-9][a-z0-9\-._~:/@%+=]{0,200}$/.test(tail)) return null;
  return `${platform}:${tail}`;
}
