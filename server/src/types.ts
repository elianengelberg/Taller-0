export interface Role {
  id: string;
  name: string;
  colorIndex: number;
}

// Moderation hierarchy (Zoom-style). Separate from the meeting's custom
// "roles" (job labels): this one gates what actions you can perform.
// Extending it later (e.g. "observer") = add a literal here + a rank below.
export type ModerationRole = "host" | "cohost" | "participant";

export const MODERATION_RANK: Record<ModerationRole, number> = {
  host: 2,
  cohost: 1,
  participant: 0,
};

export type ChatMode = "everyone" | "hosts" | "off";
export type SharePolicy = "everyone" | "hosts";

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
  // Self-reported socket round-trip tier, for the host's participant list.
  connectionQuality: "good" | "fair" | "poor" | null;
  // Foto de perfil de la cuenta, para mostrarla junto al nombre en los
  // subtítulos y en la lista de participantes. Null para invitados sin cuenta
  // o cuentas sin foto. La resuelve el SERVIDOR desde el token, nunca el
  // cliente: si no, cualquiera podría entrar con la cara de otro.
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
  // True when chatMode is "hosts": the message was delivered only to the
  // sender and the hosts, not the whole room.
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
  // Pre-computed translations into every language currently spoken by
  // someone else in the meeting (keyed by short language code), attached at
  // broadcast time so most viewers don't need a separate translate request.
  translations?: Record<string, string>;
  // La IA todavía no la corrigió: salió al instante con la lectura cruda
  // del reconocimiento y el parche llega enseguida (misma id). Falso o
  // ausente = versión definitiva.
  provisional?: boolean;
  // Última vez que el texto cambió (fusión o parche); `timestamp` es la de
  // nacimiento. Lo usa el anti-eco para saber qué líneas son "recientes".
  actualizadoEn?: number;
}

export interface MeetingSettings {
  locked: boolean;
  waitingRoomEnabled: boolean;
  chatMode: ChatMode;
  sharePolicy: SharePolicy;
}

export interface WaitingAttendee {
  id: string; // socket id of the waiting connection
  name: string;
  language: string;
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
  // Set when the host disconnects while other participants remain (so a new
  // host was auto-promoted to keep the meeting usable). If the original host
  // reconnects -- same tab, brief network blip -- within the window, they
  // get host status back instead of staying demoted forever. Cleared once
  // reclaimed or left to just expire otherwise.
  pendingHostReclaim: { participantId: string; expiresAt: number } | null;
  chat: ChatMessage[];
  transcript: TranscriptLine[];
  // --- Moderation state (Zoom-style host controls) ---
  settings: MeetingSettings;
  // The ONE participant currently sharing their screen (null = nobody).
  // Enforced server-side: a second share attempt is rejected until this
  // clears (stop, leave or host intervention).
  presenterId: string | null;
  // People held at the door while the waiting room is on.
  waiting: Map<string, WaitingAttendee>;
  // Kicked people can't immediately rejoin. Keyed by normalized display
  // name -- the only identity a guest has (see kick handler note).
  bannedNames: Set<string>;
  // Maps a connected socket id -> the account user id that authenticated it
  // (only for participants who joined while logged in). Kept OFF the broadcast
  // snapshot on purpose -- it's used server-side to let any current logged-in
  // participant of a live meeting reach that meeting's transcript/AI, not just
  // its owner, without leaking user ids to other clients.
  authedUsers: Map<string, string>;
  // True once a host explicitly ended the meeting for everyone.
  endedByHost: boolean;
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

export function toSnapshot(meeting: Meeting): MeetingSnapshot {
  return {
    id: meeting.id,
    dbId: meeting.dbId,
    hostId: meeting.hostId,
    roles: meeting.roles,
    participants: Array.from(meeting.participants.values()),
    chat: meeting.chat,
    transcript: meeting.transcript,
    settings: meeting.settings,
    presenterId: meeting.presenterId,
  };
}
