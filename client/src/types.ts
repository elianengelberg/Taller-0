export interface Role {
  id: string;
  name: string;
  colorIndex: number;
}

export interface Participant {
  id: string;
  name: string;
  isHost: boolean;
  roleId: string | null;
  language: string;
  muted: boolean;
  cameraOff: boolean;
  joinedAt: number;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  roleId: string | null;
  text: string;
  sourceLang: string;
  timestamp: number;
}

export interface TranscriptLine {
  id: string;
  speakerId: string;
  speakerName: string;
  roleId: string | null;
  text: string;
  sourceLang: string;
  timestamp: number;
}

export interface MeetingSnapshot {
  id: string;
  dbId: string;
  hostId: string;
  roles: Role[];
  participants: Participant[];
  chat: ChatMessage[];
  transcript: TranscriptLine[];
}

export type MeetingDraft =
  | { mode: "host"; name: string; language: string; roleNames: string[] }
  | { mode: "join"; name: string; language: string; meetingCode: string };

export type ConnectionStatus = "idle" | "connecting" | "connected" | "error";
