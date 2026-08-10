export interface Role {
  id: string;
  name: string;
  colorIndex: number;
}

// Moderation hierarchy (Zoom-style), separate from the meeting's custom
// role labels. Mirrors the server's type.
export type ModerationRole = "host" | "cohost" | "participant";

export type ChatMode = "everyone" | "hosts" | "off";
export type SharePolicy = "everyone" | "hosts";

export interface MeetingSettings {
  locked: boolean;
  waitingRoomEnabled: boolean;
  chatMode: ChatMode;
  sharePolicy: SharePolicy;
}

export interface WaitingAttendee {
  id: string;
  name: string;
}

// Live state of an external Google Meet, as reported by the Unify browser
// extension through the meet-bridge endpoint. Best-effort: fields are null
// when Meet's DOM didn't expose them.
export interface MeetBridgeState {
  meetId: string;
  inCall: boolean;
  participantCount: number | null;
  micMuted: boolean | null;
  cameraOff: boolean | null;
  presenting: boolean | null;
  activeSpeakers: string[];
  participants: string[] | null;
  at: number;
}

export interface Participant {
  id: string;
  name: string;
  isHost: boolean;
  moderationRole: ModerationRole;
  roleId: string | null;
  language: string;
  muted: boolean;
  cameraOff: boolean;
  sharingScreen: boolean;
  handRaised: boolean;
  joinedAt: number;
  connectionQuality: "good" | "fair" | "poor" | null;
  // Foto de perfil de la cuenta (la de Google al iniciar sesión, o una propia).
  // Null para invitados sin cuenta: ahí se muestra la inicial.
  avatarUrl: string | null;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  roleId: string | null;
  text: string;
  sourceLang: string;
  timestamp: number;
  // True when the host limited chat to "hosts": this message was only
  // delivered to the sender and the hosts.
  toHostsOnly?: boolean;
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
  settings: MeetingSettings;
  presenterId: string | null;
}

// What the embedded pane actually renders for a companion session, per
// platform. Adding a new embeddable platform later (e.g. Teams) = one more
// variant here + one branch in ExternalMeeting; nothing else changes.
export type CompanionEmbed =
  | { kind: "jitsi"; roomName: string }
  | { kind: "zoom"; meetingNumber: string; passcode?: string }
  | { kind: "teams"; meetingLink: string }
  // Google Meet can't be embedded (no SDK, frame-blocked): the real call
  // opens in its own tab and the Unify extension feeds live state back
  // through the meet-bridge (see MeetBridgeState).
  | { kind: "meet"; meetCode: string; meetLink: string }
  // Cualquier otra plataforma que reconocemos pero no podemos embeber (Teams
  // personal, Webex, Skype, Discord, o un enlace suelto): la llamada vive en
  // su propia pestaña y Unify corre al lado con subtítulos, traducción, IA y
  // grabación. No necesita credenciales de nadie.
  | { kind: "external"; label: string; joinLink: string };

export type MeetingDraft =
  | { mode: "host"; name: string; language: string; roleNames: string[] }
  | { mode: "join"; name: string; language: string; meetingCode: string }
  // The Unify transcript/AI layer riding on top of an external meeting
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

// "waiting" = held in the meeting's waiting room until a host admits us.
export type ConnectionStatus = "idle" | "connecting" | "waiting" | "connected" | "error";
