import { randomUUID } from "crypto";
import { customAlphabet } from "nanoid";
import * as db from "./db";
import { ChatMessage, Meeting, Participant, Role, TranscriptLine } from "./types";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
const nanoId = customAlphabet(CODE_ALPHABET, 6);
const idAlphabet = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 12);

const meetings = new Map<string, Meeting>();

// Upper bound on the per-meeting historical roster (see addParticipant): high
// enough that no legitimate meeting reaches it, low enough that churn can't
// leak unbounded memory.
const MAX_HISTORICAL_PARTICIPANTS = 250;

function generateMeetingCode(): string {
  let code = nanoId();
  while (meetings.has(code)) {
    code = nanoId();
  }
  return code;
}

export function createMeeting(): Meeting {
  const meeting: Meeting = {
    id: generateMeetingCode(),
    dbId: randomUUID(),
    hostId: "",
    createdAt: Date.now(),
    roles: [],
    participants: new Map(),
    historicalParticipants: new Map(),
    pendingHostReclaim: null,
    chat: [],
    transcript: [],
    settings: { locked: false, waitingRoomEnabled: false, chatMode: "everyone", sharePolicy: "everyone" },
    presenterId: null,
    waiting: new Map(),
    bannedNames: new Set(),
    authedUsers: new Map(),
    endedByHost: false,
  };
  meetings.set(meeting.id, meeting);
  return meeting;
}

export function getMeeting(meetingId: string): Meeting | undefined {
  return meetings.get(meetingId.toUpperCase());
}

// A "companion" meeting rides alongside a call hosted on ANOTHER platform
// (Jitsi/Zoom/Meet). Instead of a random join code, its id is derived
// deterministically from the external room, so everyone who opens the same
// external link through Unify lands in the SAME companion room and shares
// one live transcript/AI layer -- even though the actual audio/video is
// handled by the other platform. Reuses the exact same Meeting object as
// native meetings, so every downstream handler (transcript-line, chat,
// persistence, cleanup) works unchanged.
export function getOrCreateCompanionMeeting(externalKey: string): {
  meeting: Meeting;
  created: boolean;
} {
  const id = externalKey.toUpperCase();
  const existing = meetings.get(id);
  if (existing) return { meeting: existing, created: false };

  const meeting: Meeting = {
    id,
    dbId: randomUUID(),
    hostId: "",
    createdAt: Date.now(),
    roles: [],
    participants: new Map(),
    historicalParticipants: new Map(),
    pendingHostReclaim: null,
    chat: [],
    transcript: [],
    settings: { locked: false, waitingRoomEnabled: false, chatMode: "everyone", sharePolicy: "everyone" },
    presenterId: null,
    waiting: new Map(),
    bannedNames: new Set(),
    authedUsers: new Map(),
    endedByHost: false,
  };
  meetings.set(id, meeting);
  return { meeting, created: true };
}

// A meeting doesn't get deleted the instant it empties out: a flaky wifi
// connection or a backgrounded tab can disconnect everyone for a few
// seconds and we don't want the meeting code to go stale (and become
// impossible for late joiners to use) just because of that. We only
// actually delete it if it's *still* empty after this grace period.
const CLEANUP_GRACE_MS = 3 * 60 * 1000;
const pendingCleanups = new Map<string, NodeJS.Timeout>();

export function cancelMeetingCleanup(meetingId: string): void {
  const timer = pendingCleanups.get(meetingId);
  if (timer) {
    clearTimeout(timer);
    pendingCleanups.delete(meetingId);
  }
}

export function scheduleMeetingCleanupIfEmpty(meetingId: string): void {
  const meeting = meetings.get(meetingId);
  if (!meeting || meeting.participants.size > 0) return;

  cancelMeetingCleanup(meetingId);
  const timer = setTimeout(() => {
    pendingCleanups.delete(meetingId);
    const current = meetings.get(meetingId);
    if (current && current.participants.size === 0) {
      void db.finalizeMeeting(current.dbId);
      meetings.delete(meetingId);
    }
  }, CLEANUP_GRACE_MS);
  pendingCleanups.set(meetingId, timer);
}

export function addRole(meeting: Meeting, name: string): Role {
  const role: Role = {
    id: idAlphabet(),
    name: name.trim().slice(0, 40),
    colorIndex: meeting.roles.length,
  };
  meeting.roles.push(role);
  return role;
}

export function addParticipant(
  meeting: Meeting,
  socketId: string,
  name: string,
  language: string,
  isHost: boolean,
  userId?: string | null
): Participant {
  const participant: Participant = {
    id: socketId,
    name: name.trim().slice(0, 60) || "Invitado",
    isHost,
    moderationRole: isHost ? "host" : "participant",
    roleId: null,
    language,
    muted: false,
    cameraOff: false,
    sharingScreen: false,
    handRaised: false,
    joinedAt: Date.now(),
    connectionQuality: null,
  };
  meeting.participants.set(socketId, participant);
  // Same object reference on purpose: later mutations (role changes, mute
  // state) apply to both maps automatically, and this entry survives even
  // after the person leaves and is removed from `participants`.
  meeting.historicalParticipants.set(socketId, participant);
  // Bound the historical roster: constant join/leave churn (flaky wifi, a tab
  // reconnecting over and over -- each time a NEW socket id) would otherwise
  // grow this map without limit for the meeting's whole life. Evict the oldest
  // DEPARTED entries first; anyone still connected is always kept. A real
  // meeting never has this many distinct people, so it never triggers normally.
  if (meeting.historicalParticipants.size > MAX_HISTORICAL_PARTICIPANTS) {
    for (const id of meeting.historicalParticipants.keys()) {
      if (meeting.historicalParticipants.size <= MAX_HISTORICAL_PARTICIPANTS) break;
      if (!meeting.participants.has(id)) meeting.historicalParticipants.delete(id);
    }
  }
  if (isHost) {
    meeting.hostId = socketId;
  }
  // Remember which account (if any) this socket authenticated as, so a
  // logged-in participant of a live meeting can reach its transcript/AI even
  // when they're not the meeting's owner (see isLiveParticipant).
  if (userId) meeting.authedUsers.set(socketId, userId);
  return participant;
}

export function removeParticipant(meeting: Meeting, socketId: string): Participant | undefined {
  const participant = meeting.participants.get(socketId);
  meeting.participants.delete(socketId);
  meeting.authedUsers.delete(socketId);
  return participant;
}

// True if `userId` is currently connected as a participant of the LIVE meeting
// with this dbId. Lets the REST layer grant a logged-in participant read access
// to that meeting's transcript/AI while they're in it, not only its owner.
export function isLiveParticipant(dbId: string, userId: string): boolean {
  for (const meeting of meetings.values()) {
    if (meeting.dbId !== dbId) continue;
    for (const uid of meeting.authedUsers.values()) {
      if (uid === userId) return true;
    }
    return false;
  }
  return false;
}

export function promoteNextHost(meeting: Meeting): Participant | undefined {
  // Prefer a co-host (that's what they're for); otherwise whoever has been
  // in the meeting longest.
  const remaining = Array.from(meeting.participants.values()).sort((a, b) => {
    if (a.moderationRole !== b.moderationRole) {
      return a.moderationRole === "cohost" ? -1 : 1;
    }
    return a.joinedAt - b.joinedAt;
  });
  const next = remaining[0];
  if (next) {
    next.isHost = true;
    next.moderationRole = "host";
    meeting.hostId = next.id;
  }
  return next;
}

export function addChatMessage(
  meeting: Meeting,
  sender: Participant,
  text: string
): ChatMessage {
  const message: ChatMessage = {
    id: idAlphabet(),
    senderId: sender.id,
    senderName: sender.name,
    roleId: sender.roleId,
    text: text.slice(0, 2000),
    sourceLang: sender.language,
    timestamp: Date.now(),
  };
  meeting.chat.push(message);
  if (meeting.chat.length > 500) {
    meeting.chat.shift();
  }
  return message;
}

export function addTranscriptLine(
  meeting: Meeting,
  speaker: Participant,
  text: string,
  sourceLang: string,
  translations?: Record<string, string>
): TranscriptLine {
  const line: TranscriptLine = {
    id: idAlphabet(),
    speakerId: speaker.id,
    speakerName: speaker.name,
    roleId: speaker.roleId,
    text: text.slice(0, 2000),
    sourceLang,
    timestamp: Date.now(),
    translations,
  };
  meeting.transcript.push(line);
  if (meeting.transcript.length > 2000) {
    meeting.transcript.shift();
  }
  return line;
}
