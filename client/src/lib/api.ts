import { getAuthToken } from "./authToken";
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
}

// Render's free tier can take ~50s to wake up a sleeping instance, so this
// has to be generous -- but requests still shouldn't hang forever if
// something is genuinely broken (bad CORS config, wrong URL, etc.).
const TIMEOUT_MS = 55_000;

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// --- Auth ------------------------------------------------------------------

export async function authRegister(
  email: string,
  password: string,
  name: string
): Promise<{ token?: string; user?: AuthUser; error?: string }> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "No se pudo crear la cuenta." };
    return { token: data.token, user: data.user };
  } catch {
    return { error: "No pudimos conectar con el servidor. Probá de nuevo en un momento." };
  }
}

export async function authLogin(
  email: string,
  password: string
): Promise<{ token?: string; user?: AuthUser; error?: string }> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "No se pudo iniciar sesión." };
    return { token: data.token, user: data.user };
  } catch {
    return { error: "No pudimos conectar con el servidor. Probá de nuevo en un momento." };
  }
}

// Validates the stored token and returns the current user, or null if the
// token is missing/expired (caller should then treat the user as logged out).
export async function authMe(): Promise<AuthUser | null> {
  if (!getAuthToken()) return null;
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/auth/me`, { headers: authHeaders() });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return data.user ?? null;
  } catch {
    return null;
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

export async function askMeetingAI(
  id: string,
  question: string
): Promise<{ answer?: string; error?: string }> {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/meetings/${id}/ask`, {
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

export async function confirmRecordingComplete(
  meetingDbId: string,
  publicUrl: string
): Promise<void> {
  try {
    await fetchWithTimeout(`${SERVER_URL}/api/meetings/${meetingDbId}/recording-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicUrl }),
    });
  } catch {
    // best-effort -- the recording is still on the user's device either way
  }
}
