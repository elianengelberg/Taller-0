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
  // Stable identifier used for permanent storage (database rows, recordings).
  // Separate from `id` (the short join code) because join codes can be
  // reused by a later, unrelated meeting once this one is cleaned up.
  dbId: string;
  hostId: string;
  createdAt: number;
  roles: Role[];
  participants: Map<string, Participant>;
  // Same Participant objects as `participants`, but entries are never
  // removed when someone leaves -- only added/updated. Used to persist a
  // full roster (with each person's last-known role) for history, since
  // `participants` alone would lose whoever already left by the time we
  // save the final snapshot.
  historicalParticipants: Map<string, Participant>;
  chat: ChatMessage[];
  transcript: TranscriptLine[];
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

export function toSnapshot(meeting: Meeting): MeetingSnapshot {
  return {
    id: meeting.id,
    dbId: meeting.dbId,
    hostId: meeting.hostId,
    roles: meeting.roles,
    participants: Array.from(meeting.participants.values()),
    chat: meeting.chat,
    transcript: meeting.transcript,
  };
}
