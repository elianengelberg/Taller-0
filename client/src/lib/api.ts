import { getAuthToken, setAuthToken } from "./authToken";
import { SERVER_URL } from "./socket";

// Attaches the session token (if any) so the private history/AI endpoints
// accept the request. Spread into a fetch's headers.
function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  /** Foto de perfil, o null si no tiene. */
  avatarUrl: string | null;
  /**
   * Está probado que el email es de esta persona: entró por Google, o abrió el
   * enlace que le mandamos. Las cuentas anteriores a la verificación llegan en
   * false hasta que la confirmen.
   */
  emailVerified: boolean;
}

export interface HistoryParticipant {
  id: string;
  name: string;
  roleId: string | null;
  isHost: boolean;
}

export interface HistoryRole {
  id: string;
  name: string;
  colorIndex: number;
}

export interface MeetingHistorySummary {
  id: string;
  joinCode: string;
  hostName: string;
  participants: HistoryParticipant[];
  recordingUrl: string | null;
  startedAt: string;
  endedAt: string | null;
  messageCount: number;
  folderId: string | null;
  hasReport: boolean;
}

export interface FolderSummary {
  id: string;
  name: string;
  createdAt: string;
  meetingCount: number;
  ownerName?: string;
  sharedWithCount?: number;
}

export interface FolderShareRecipient {
  userId: string;
  name: string;
  email: string;
  /** Esa cuenta probó ser dueña de su email. Ver el aviso al compartir. */
  emailVerified: boolean;
}

export interface CalendarEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  organizer: string | null;
  joinUrl: string | null;
  platform: "google-meet" | "microsoft-teams" | "zoom" | "other" | null;
}

export interface MeetingHistoryMessage {
  id: number;
  kind: "chat" | "transcript";
  senderName: string;
  roleName: string | null;
  text: string;
  sourceLang: string | null;
  createdAt: string;
}

export interface MeetingHistoryDetail extends MeetingHistorySummary {
  roles: HistoryRole[];
  messages: MeetingHistoryMessage[];
  report: string | null;
  reportGeneratedAt: string | null;
  // When the recording started (ISO, server clock) -- t=0 of the video, used
  // to line the transcript up with playback.
  recordingStartedAt: string | null;
  sharedView?: boolean;
}

// Render's free tier can take ~50s to wake up a sleeping instance, so this
// has to be generous -- but requests still shouldn't hang forever if
// something is genuinely broken (bad CORS config, wrong URL, etc.).
const TIMEOUT_MS = 55_000;

// El servidor duerme, y eso se AVISA.
//
// El plan gratuito de Render apaga la instancia tras un rato sin visitas, y
// la primera llamada la despierta: puede tardar casi un minuto. La app no se
// cayó -- está esperando -- pero en silencio se siente exactamente igual que
// si estuviera rota. Pasados unos segundos se avisa una sola vez, y cuando
// vuelve la primera respuesta se avisa que ya está.
const AVISO_LENTO_MS = 4_000;
let avisadoDormido = false;

function avisarDespertando(): void {
  if (avisadoDormido) return;
  avisadoDormido = true;
  window.dispatchEvent(new CustomEvent("unify:servidor-despertando"));
}
function avisarDespierto(): void {
  if (!avisadoDormido) return;
  avisadoDormido = false;
  window.dispatchEvent(new CustomEvent("unify:servidor-despierto"));
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const lento = setTimeout(avisarDespertando, AVISO_LENTO_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    avisarDespierto();
    return res;
  } finally {
    clearTimeout(timeout);
    clearTimeout(lento);
  }
}

/**
 * Golpea /api/health apenas abre la app, sin esperar la respuesta.
 *
 * Si el servidor estaba dormido, empieza a despertarse MIENTRAS la persona
 * mira la pantalla de inicio, en vez de hacerlo cuando ya apuró un botón. Es
 * la diferencia entre "tardó un poco" y "no anda". No toca la base de datos
 * ni la cuenta: es el endpoint más barato que hay.
 */
export function despertarServidor(): void {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 60_000);
  void fetch(`${SERVER_URL}/api/health`, { signal: ctl.signal, cache: "no-store" }).catch(() => {});
}

// --- Auth ------------------------------------------------------------------

export async function authRegister(
  email: string,
  password: string,
  name: string
): Promise<{ token?: string; user?: AuthUser; error?: string; verificationSent?: boolean }> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "No se pudo crear la cuenta." };
    return { token: data.token, user: data.user, verificationSent: data.verificationSent === true };
  } catch {
    return { error: "No pudimos conectar con el servidor. Probá de nuevo en un momento." };
  }
}

export async function authLogin(
  email: string,
  password: string
): Promise<{
  token?: string;
  user?: AuthUser;
  error?: string;
  /** La contraseña era correcta, pero falta abrir el enlace del correo. */
  needsVerification?: boolean;
}> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        error: data.error ?? "No se pudo iniciar sesión.",
        needsVerification: data.needsVerification === true,
      };
    }
    return { token: data.token, user: data.user };
  } catch {
    return { error: "No pudimos conectar con el servidor. Probá de nuevo en un momento." };
  }
}

// --- Verificación de email y recuperación de contraseña ---------------------

/**
 * Pide (o vuelve a pedir) el enlace de verificación. Con sesión abierta va al
 * email de la cuenta; sin ella hay que pasar la dirección, que es el caso de
 * quien no puede entrar justamente porque no verificó.
 *
 * Responde siempre lo mismo exista o no la cuenta: el servidor no delata
 * quién está registrado, y el cliente no puede fingir que sabe más.
 */
export async function requestEmailVerification(email?: string): Promise<{ ok?: boolean; error?: string }> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/auth/verify-email/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(email ? { email } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "No se pudo enviar el correo." };
    return { ok: true };
  } catch {
    return { error: "No pudimos conectar con el servidor. Probá de nuevo en un momento." };
  }
}

export async function confirmEmailVerification(
  token: string
): Promise<{ user?: AuthUser; alreadyVerified?: boolean; error?: string }> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/auth/verify-email/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "No se pudo confirmar el email." };
    // Confirmar el enlace ya probó que el buzón es tuyo, así que el servidor
    // devuelve sesión y quedás adentro sin volver a escribir la contraseña.
    if (typeof data.token === "string") setAuthToken(data.token);
    return { user: data.user, alreadyVerified: data.alreadyVerified === true };
  } catch {
    return { error: "No pudimos conectar con el servidor. Probá de nuevo en un momento." };
  }
}

/**
 * Canje por los 6 dígitos del correo. Es el mismo canje que el enlace (deja
 * sesión iniciada), pero sirve cuando el mail llegó al teléfono y Unify está
 * abierto en la computadora.
 */
export async function confirmEmailWithCode(
  email: string,
  code: string
): Promise<{ user?: AuthUser; error?: string }> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/auth/verify-email/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "No se pudo confirmar el código." };
    if (typeof data.token === "string") setAuthToken(data.token);
    return { user: data.user };
  } catch {
    return { error: "No pudimos conectar con el servidor. Probá de nuevo en un momento." };
  }
}

export async function requestPasswordReset(email: string): Promise<{ ok?: boolean; error?: string }> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/auth/password-reset/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "No se pudo enviar el correo." };
    return { ok: true };
  } catch {
    return { error: "No pudimos conectar con el servidor. Probá de nuevo en un momento." };
  }
}

export async function confirmPasswordReset(
  token: string,
  password: string
): Promise<{ user?: AuthUser; error?: string }> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/auth/password-reset/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "No se pudo cambiar la contraseña." };
    if (typeof data.token === "string") setAuthToken(data.token);
    return { user: data.user };
  } catch {
    return { error: "No pudimos conectar con el servidor. Probá de nuevo en un momento." };
  }
}

// Validates the stored token and returns the current user. `unauthorized` is
// only true when the server explicitly rejected the token (401) -- a network
// failure (free-tier server cold-starting, CORS hiccup, flaky wifi) must NOT
// count, because the caller deletes the stored token on that signal and a
// transient outage would then permanently log the person out.
export async function authMe(): Promise<{ user: AuthUser | null; unauthorized?: boolean }> {
  if (!getAuthToken()) return { user: null };
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/auth/me`, { headers: authHeaders() });
    if (res.status === 401) return { user: null, unauthorized: true };
    if (!res.ok) return { user: null };
    const data = await res.json().catch(() => ({}));
    return { user: data.user ?? null };
  } catch {
    return { user: null };
  }
}

export interface AuthConfig {
  /** El servidor tiene credenciales de Google OAuth de verdad. */
  googleEnabled: boolean;
  /** Puede mandar el enlace de verificación (hay correo configurado). */
  emailVerification: boolean;
  /** Puede mandar el enlace para recuperar la contraseña. */
  passwordReset: boolean;
}

// Qué sabe hacer de verdad este servidor, para que la pantalla de ingreso no
// ofrezca botones que no funcionan: sin credenciales de Google no se muestra
// "Continuar con Google", y sin correo configurado no se muestra "Olvidé mi
// contraseña" (mandaría a una pantalla que nunca va a recibir el enlace).
export async function fetchAuthConfig(): Promise<AuthConfig> {
  const fallback: AuthConfig = { googleEnabled: false, emailVerification: false, passwordReset: false };
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/auth/config`);
    if (!res.ok) return fallback;
    return { ...fallback, ...(await res.json()) };
  } catch {
    return fallback;
  }
}

export interface PlatformConfig {
  zoom: boolean;
  teams: boolean;
  jitsi: boolean;
  "google-meet": boolean;
  /** El servidor puede guardar grabaciones (almacenamiento configurado). */
  recording: boolean;
  /** El servidor puede guardar fotos de perfil subidas por el usuario. */
  avatars: boolean;
}

// Which external-meeting integrations the server actually has configured, so
// the join UI can be honest up front (offer the in-app join only when it will
// really work, else point the user to open the meeting on its own platform).
// Defaults to "available" on failure so a slow/cold server never blocks a join
// that might actually work.
export async function fetchPlatformConfig(): Promise<PlatformConfig> {
  const fallback: PlatformConfig = {
    zoom: true,
    teams: true,
    jitsi: true,
    "google-meet": true,
    recording: true,
    avatars: true,
  };
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/platforms`);
    if (!res.ok) return fallback;
    return { ...fallback, ...(await res.json()) };
  } catch {
    return fallback;
  }
}

// Full-page navigation (not fetch) -- OAuth needs an actual browser redirect
// to Google's own consent screen.
export function startGoogleLogin(): void {
  window.location.href = `${SERVER_URL}/api/auth/google`;
}

// `avatarUrl: null` saca la foto; omitirlo la deja como está (guardar el
// nombre no tiene por qué borrar la foto).
export async function updateProfile(
  name: string,
  options: { avatarUrl?: string | null } = {}
): Promise<{ user?: AuthUser; error?: string }> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/auth/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ name, ...("avatarUrl" in options ? { avatarUrl: options.avatarUrl } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "No se pudo actualizar el perfil." };
    return { user: data.user };
  } catch {
    return { error: "No pudimos conectar con el servidor. Probá de nuevo en un momento." };
  }
}

// Sube la foto de perfil ya recortada y comprimida por el navegador (ver
// lib/avatar.ts). Se manda la imagen cruda como cuerpo, sin multipart: es un
// solo archivo chico y así el servidor la puede pasar derecho al bucket.
export async function uploadAvatar(blob: Blob): Promise<{ user?: AuthUser; error?: string }> {
  try {
    const res = await fetch(`${SERVER_URL}/api/auth/me/avatar`, {
      method: "POST",
      headers: { "Content-Type": blob.type || "image/jpeg", ...authHeaders() },
      body: blob,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "No se pudo guardar la foto." };
    return { user: data.user };
  } catch {
    return { error: "No pudimos conectar con el servidor. Probá de nuevo en un momento." };
  }
}

export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<{ ok?: boolean; error?: string }> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "No se pudo cambiar la contraseña." };
    // Cambiar la contraseña cierra TODAS las sesiones abiertas -- incluida
    // esta. El servidor devuelve un token nuevo para que quien la cambió no
    // se quede afuera de rebote.
    if (typeof data.token === "string") setAuthToken(data.token);
    return { ok: true };
  } catch {
    return { error: "No pudimos conectar con el servidor. Probá de nuevo en un momento." };
  }
}

// Cierra la sesión en todos los dispositivos y renueva la de este. Para usar
// cuando sospechás que alguien más entró a tu cuenta.
export async function logoutEverywhere(): Promise<{ ok?: boolean; error?: string }> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/auth/logout-everywhere`, {
      method: "POST",
      headers: authHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "No se pudo cerrar las sesiones." };
    if (typeof data.token === "string") setAuthToken(data.token);
    return { ok: true };
  } catch {
    return { error: "No pudimos conectar con el servidor. Probá de nuevo en un momento." };
  }
}

// --- Meeting history (private per account) ---------------------------------

export async function fetchMeetingsHistory(): Promise<MeetingHistorySummary[]> {
  const res = await fetchWithTimeout(`${SERVER_URL}/api/meetings`, { headers: authHeaders() });
  if (!res.ok) return [];
  const data = await res.json();
  return data.meetings ?? [];
}

export async function fetchMeetingDetail(id: string): Promise<MeetingHistoryDetail | null> {
  const res = await fetchWithTimeout(`${SERVER_URL}/api/meetings/${id}`, { headers: authHeaders() });
  if (!res.ok) return null;
  const data = await res.json();
  return data.meeting ?? null;
}

/** Fotograma del video grabado que acompaña una pregunta a la IA. */
export interface AiVideoFrame {
  /** Segundo del video del que salió. */
  atSec: number;
  /** JPEG en base64 (sin el prefijo data:). */
  data: string;
}

export async function askMeetingAI(
  id: string,
  question: string,
  // Con fotogramas, la IA no sólo lee la transcripción: MIRA el video grabado
  // (los captura el navegador desde el reproductor -- ver MeetingDetail).
  frames: AiVideoFrame[] = []
): Promise<{ answer?: string; error?: string }> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/meetings/${id}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(frames.length > 0 ? { question, frames } : { question }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "No se pudo consultar a la IA." };
    return { answer: data.answer };
  } catch {
    return { error: "No pudimos conectar con el servidor. Probá de nuevo en un momento." };
  }
}

export async function askAllMeetingsAI(question: string): Promise<{ answer?: string; error?: string }> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/meetings/ask-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ question }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "No se pudo consultar a la IA." };
    return { answer: data.answer };
  } catch {
    return { error: "No pudimos conectar con el servidor. Probá de nuevo en un momento." };
  }
}

// Asks our backend for a Zoom Meeting SDK signature (a short-lived JWT). The
// signing secret never leaves the server -- we only ever get back the finished
// token. `role` is 0 (attendee) for the meetings we join. Returns an `error`
// string (e.g. Zoom isn't configured) instead of throwing, so the embed can
// show it inline.
export async function fetchZoomSignature(
  meetingNumber: string,
  role: 0 | 1 = 0
): Promise<{ signature?: string; error?: string }> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/zoom/signature`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meetingNumber, role }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "No se pudo autorizar el ingreso a Zoom." };
    return { signature: data.signature };
  } catch {
    return { error: "No pudimos conectar con el servidor para autorizar Zoom." };
  }
}

// Asks our backend for a short-lived Azure Communication Services access token
// so the browser can join a Microsoft Teams meeting (Teams interop). The ACS
// connection string never leaves the server. Returns an `error` string instead
// of throwing so the embed can show it inline.
export async function fetchTeamsToken(): Promise<{
  token?: string;
  userId?: string;
  error?: string;
}> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/teams/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "No se pudo autorizar el ingreso a Teams." };
    return { token: data.token, userId: data.userId };
  } catch {
    return { error: "No pudimos conectar con el servidor para autorizar Teams." };
  }
}

export async function requestRecordingUploadUrl(
  meetingDbId: string,
  contentType: string
): Promise<{ uploadUrl: string; publicUrl: string } | null> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/meetings/${meetingDbId}/recording-upload-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// Pinged the instant recording begins so the server anchors the video's t=0 to
// a real timestamp -- keeps the history transcript lined up with the video
// without the drift that back-computing from the upload would introduce.
export async function markRecordingStarted(meetingDbId: string): Promise<void> {
  try {
    await fetchWithTimeout(`${SERVER_URL}/api/meetings/${meetingDbId}/recording-started`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch {
    // best-effort -- attachRecording still back-computes a start from duration
  }
}

export async function confirmRecordingComplete(
  meetingDbId: string,
  publicUrl: string,
  durationMs?: number
): Promise<void> {
  try {
    await fetchWithTimeout(`${SERVER_URL}/api/meetings/${meetingDbId}/recording-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicUrl, durationMs }),
    });
  } catch {
    // best-effort -- the recording is still on the user's device either way
  }
}

// Fallback for when the direct browser->R2 PUT fails (most often the bucket's
// CORS not allowing PUT from the app origin). Re-sends the whole video through
// our server, which has R2 credentials and isn't subject to browser CORS, and
// attaches it to the meeting itself. Plain fetch (no timeout) so a large upload
// over a slow connection isn't aborted mid-way. Returns whether it landed.
export async function uploadRecordingViaServer(
  meetingDbId: string,
  blob: Blob,
  contentType: string,
  durationMs: number
): Promise<boolean> {
  try {
    const res = await fetch(
      `${SERVER_URL}/api/meetings/${meetingDbId}/recording-upload?durationMs=${Math.round(durationMs)}`,
      { method: "POST", headers: { "Content-Type": contentType }, body: blob }
    );
    return res.ok;
  } catch {
    return false;
  }
}

// Attaches an ownerless meeting (created/joined as a guest) to the just
// logged-in/registered account so it shows up in their history.
export async function claimMeeting(meetingDbId: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/meetings/${meetingDbId}/claim`, {
      method: "POST",
      headers: authHeaders(),
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({}));
    return Boolean(data.ok);
  } catch {
    return false;
  }
}

// --- Folders ---------------------------------------------------------------

export async function fetchFolders(): Promise<{ folders: FolderSummary[]; shared: FolderSummary[] }> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/folders`, { headers: authHeaders() });
    if (!res.ok) return { folders: [], shared: [] };
    const data = await res.json();
    return { folders: data.folders ?? [], shared: data.shared ?? [] };
  } catch {
    return { folders: [], shared: [] };
  }
}

export async function createFolderApi(name: string): Promise<{ folder?: FolderSummary; error?: string }> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "No se pudo crear la carpeta." };
    return { folder: data.folder };
  } catch {
    return { error: "No pudimos conectar con el servidor." };
  }
}

export async function renameFolderApi(id: string, name: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/folders/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ name }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteFolderApi(id: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/folders/${id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchFolderMeetings(id: string): Promise<MeetingHistorySummary[]> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/folders/${id}/meetings`, {
      headers: authHeaders(),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.meetings ?? [];
  } catch {
    return [];
  }
}

export async function fetchFolderShares(id: string): Promise<FolderShareRecipient[]> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/folders/${id}/shares`, {
      headers: authHeaders(),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.recipients ?? [];
  } catch {
    return [];
  }
}

export async function shareFolderApi(id: string, email: string): Promise<{ ok?: boolean; error?: string }> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/folders/${id}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "No se pudo compartir la carpeta." };
    return { ok: true };
  } catch {
    return { error: "No pudimos conectar con el servidor." };
  }
}

export async function unshareFolderApi(id: string, userId: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/folders/${id}/share/${userId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function moveMeetingToFolderApi(
  meetingId: string,
  folderId: string | null
): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/meetings/${meetingId}/folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ folderId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteMeetingApi(meetingId: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/meetings/${meetingId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// --- AI report -------------------------------------------------------------

export async function generateMeetingReport(
  meetingId: string,
  regenerate = false
): Promise<{ report?: string; error?: string }> {
  try {
    const url = `${SERVER_URL}/api/meetings/${meetingId}/report${regenerate ? "?regenerate=1" : ""}`;
    const res = await fetchWithTimeout(url, { method: "POST", headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "No se pudo generar el informe." };
    return { report: data.report };
  } catch {
    return { error: "No pudimos conectar con el servidor. Probá de nuevo en un momento." };
  }
}

// --- Outlook / Microsoft calendar ------------------------------------------

export async function fetchCalendarStatus(): Promise<{ configured: boolean; connected: boolean }> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/calendar/status`, { headers: authHeaders() });
    if (!res.ok) return { configured: false, connected: false };
    return await res.json();
  } catch {
    return { configured: false, connected: false };
  }
}

// Full-page navigation to Microsoft's consent screen. We first fetch the URL
// (authenticated) so the session token never rides in a query string.
export async function startCalendarConnect(): Promise<{ error?: string }> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/calendar/connect-url`, {
      headers: authHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) return { error: data.error ?? "No se pudo conectar con Outlook." };
    window.location.href = data.url;
    return {};
  } catch {
    return { error: "No pudimos conectar con el servidor." };
  }
}

export async function disconnectCalendar(): Promise<void> {
  try {
    await fetchWithTimeout(`${SERVER_URL}/api/calendar/disconnect`, {
      method: "POST",
      headers: authHeaders(),
    });
  } catch {
    /* best-effort */
  }
}

export async function fetchUpcomingMeetings(): Promise<{
  configured: boolean;
  connected: boolean;
  events: CalendarEvent[];
  error?: string;
}> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/calendar/upcoming`, {
      headers: authHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    return {
      configured: Boolean(data.configured),
      connected: Boolean(data.connected),
      events: data.events ?? [],
      error: data.error,
    };
  } catch {
    return { configured: false, connected: false, events: [] };
  }
}
