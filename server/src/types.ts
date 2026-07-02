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

export interface Meeting {
  id: string;
  hostId: string;
  createdAt: number;
  roles: Role[];
  participants: Map<string, Participant>;
  chat: ChatMessage[];
  transcript: TranscriptLine[];
}

export interface MeetingSnapshot {
  id: string;
  hostId: string;
  roles: Role[];
  participants: Participant[];
  chat: ChatMessage[];
  transcript: TranscriptLine[];
}

export function toSnapshot(meeting: Meeting): MeetingSnapshot {
  return {
    id: meeting.id,
    hostId: meeting.hostId,
    roles: meeting.roles,
    participants: Array.from(meeting.participants.values()),
    chat: meeting.chat,
    transcript: meeting.transcript,
  };
}
