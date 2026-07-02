import { SERVER_URL } from "./socket";

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

export async function fetchMeetingsHistory(): Promise<MeetingHistorySummary[]> {
  const res = await fetchWithTimeout(`${SERVER_URL}/api/meetings`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.meetings ?? [];
}

export async function fetchMeetingDetail(id: string): Promise<MeetingHistoryDetail | null> {
  const res = await fetchWithTimeout(`${SERVER_URL}/api/meetings/${id}`);
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "No se pudo consultar a la IA." };
    return { answer: data.answer };
  } catch {
    return { error: "No pudimos conectar con el servidor. Probá de nuevo en un momento." };
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
