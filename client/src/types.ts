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
  sharingScreen: boolean;
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
  translations?: Record<string, string>;
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

// What the embedded pane actually renders for a companion session, per
// platform. Adding a new embeddable platform later (e.g. Teams) = one more
// variant here + one branch in ExternalMeeting; nothing else changes.
export type CompanionEmbed =
  | { kind: "jitsi"; roomName: string }
  | { kind: "zoom"; meetingNumber: string; passcode?: string }
  | { kind: "teams"; meetingLink: string };

export type MeetingDraft =
  | { mode: "host"; name: string; language: string; roleNames: string[] }
  | { mode: "join"; name: string; language: string; meetingCode: string }
  // The Encuentro transcript/AI layer riding on top of an external meeting
  // (Jitsi/Zoom/...). `externalKey` is the shared room key on our backend that
  // everyone opening the same link lands in; `embed` describes which platform
  // pane to render and how; `roomLabel` is what we show the user.
  | {
      mode: "companion";
      name: string;
      language: string;
      externalKey: string;
      roomLabel: string;
      embed: CompanionEmbed;
    };

export type ConnectionStatus = "idle" | "connecting" | "connected" | "error";
