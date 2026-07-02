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

export async function fetchMeetingsHistory(): Promise<MeetingHistorySummary[]> {
  const res = await fetch(`${SERVER_URL}/api/meetings`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.meetings ?? [];
}

export async function fetchMeetingDetail(id: string): Promise<MeetingHistoryDetail | null> {
  const res = await fetch(`${SERVER_URL}/api/meetings/${id}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.meeting ?? null;
}

export async function askMeetingAI(
  id: string,
  question: string
): Promise<{ answer?: string; error?: string }> {
  const res = await fetch(`${SERVER_URL}/api/meetings/${id}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.error ?? "No se pudo consultar a la IA." };
  return { answer: data.answer };
}

export async function requestRecordingUploadUrl(
  meetingDbId: string,
  contentType: string
): Promise<{ uploadUrl: string; publicUrl: string } | null> {
  const res = await fetch(`${SERVER_URL}/api/meetings/${meetingDbId}/recording-upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contentType }),
  });
  if (!res.ok) return null;
  return res.json();
}

export async function confirmRecordingComplete(
  meetingDbId: string,
  publicUrl: string
): Promise<void> {
  await fetch(`${SERVER_URL}/api/meetings/${meetingDbId}/recording-complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicUrl }),
  });
}
