import { randomUUID } from "crypto";
import { customAlphabet } from "nanoid";
import * as db from "./db";
import { ChatMessage, Meeting, Participant, Role, TranscriptLine } from "./types";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
const nanoId = customAlphabet(CODE_ALPHABET, 6);
const idAlphabet = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 12);

const meetings = new Map<string, Meeting>();

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
  };
  meetings.set(meeting.id, meeting);
  return meeting;
}

export function getMeeting(meetingId: string): Meeting | undefined {
  return meetings.get(meetingId.toUpperCase());
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
  isHost: boolean
): Participant {
  const participant: Participant = {
    id: socketId,
    name: name.trim().slice(0, 60) || "Invitado",
    isHost,
    roleId: null,
    language,
    muted: false,
    cameraOff: false,
    sharingScreen: false,
    joinedAt: Date.now(),
  };
  meeting.participants.set(socketId, participant);
  // Same object reference on purpose: later mutations (role changes, mute
  // state) apply to both maps automatically, and this entry survives even
  // after the person leaves and is removed from `participants`.
  meeting.historicalParticipants.set(socketId, participant);
  if (isHost) {
    meeting.hostId = socketId;
  }
  return participant;
}

export function removeParticipant(meeting: Meeting, socketId: string): Participant | undefined {
  const participant = meeting.participants.get(socketId);
  meeting.participants.delete(socketId);
  return participant;
}

export function promoteNextHost(meeting: Meeting): Participant | undefined {
  const remaining = Array.from(meeting.participants.values()).sort(
    (a, b) => a.joinedAt - b.joinedAt
  );
  const next = remaining[0];
  if (next) {
    next.isHost = true;
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
