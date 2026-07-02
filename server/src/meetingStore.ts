import { customAlphabet } from "nanoid";
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
    hostId: "",
    createdAt: Date.now(),
    roles: [],
    participants: new Map(),
    chat: [],
    transcript: [],
  };
  meetings.set(meeting.id, meeting);
  return meeting;
}

export function getMeeting(meetingId: string): Meeting | undefined {
  return meetings.get(meetingId.toUpperCase());
}

export function deleteMeetingIfEmpty(meetingId: string): void {
  const meeting = meetings.get(meetingId);
  if (meeting && meeting.participants.size === 0) {
    meetings.delete(meetingId);
  }
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
    joinedAt: Date.now(),
  };
  meeting.participants.set(socketId, participant);
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
  sourceLang: string
): TranscriptLine {
  const line: TranscriptLine = {
    id: idAlphabet(),
    speakerId: speaker.id,
    speakerName: speaker.name,
    roleId: speaker.roleId,
    text: text.slice(0, 2000),
    sourceLang,
    timestamp: Date.now(),
  };
  meeting.transcript.push(line);
  if (meeting.transcript.length > 2000) {
    meeting.transcript.shift();
  }
  return line;
}
