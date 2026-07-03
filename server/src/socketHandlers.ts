import { Server, Socket } from "socket.io";
import * as db from "./db";
import {
  addChatMessage,
  addParticipant,
  addRole,
  addTranscriptLine,
  cancelMeetingCleanup,
  createMeeting,
  getMeeting,
  promoteNextHost,
  removeParticipant,
  scheduleMeetingCleanupIfEmpty,
} from "./meetingStore";
import { cleanTranscriptFragment } from "./transcriptCleanup";
import { shortLang, translateText } from "./translate";
import { Meeting, toSnapshot } from "./types";

const MAX_NAME_LENGTH = 60;
const MAX_ROLE_NAME_LENGTH = 40;

function roomName(meetingId: string): string {
  return `meeting:${meetingId}`;
}

function requireHost(meeting: Meeting, socketId: string): boolean {
  return meeting.hostId === socketId;
}

function roleNameFor(meeting: Meeting, roleId: string | null): string | null {
  if (!roleId) return null;
  return meeting.roles.find((r) => r.id === roleId)?.name ?? null;
}

// Fire-and-forget: the DB layer swallows its own errors (see db.ts `safe()`),
// so this never throws or delays the real-time socket path it's called from.
function persistParticipants(meeting: Meeting): void {
  // Persist the full historical roster (not just who's still connected) so
  // the saved meeting keeps everyone who was ever in it, roles included,
  // even after they've left.
  void db.updateParticipantsSnapshot(
    meeting.dbId,
    Array.from(meeting.historicalParticipants.values()).map((p) => ({
      id: p.id,
      name: p.name,
      roleId: p.roleId,
      isHost: p.isHost,
    }))
  );
}

export function registerSocketHandlers(io: Server, socket: Socket): void {
  let currentMeetingId: string | null = null;

  socket.on(
    "create-meeting",
    (payload: { hostName: string; hostLanguage: string; roles: string[] }, ack) => {
      try {
        const hostName = String(payload?.hostName ?? "").slice(0, MAX_NAME_LENGTH).trim();
        const hostLanguage = String(payload?.hostLanguage ?? "es-AR");
        const roleNames = Array.isArray(payload?.roles) ? payload.roles : [];

        if (!hostName) {
          ack?.({ ok: false, error: "El nombre del anfitrión es obligatorio." });
          return;
        }

        const meeting = createMeeting();
        for (const name of roleNames) {
          if (typeof name === "string" && name.trim()) {
            addRole(meeting, name.slice(0, MAX_ROLE_NAME_LENGTH));
          }
        }
        addParticipant(meeting, socket.id, hostName, hostLanguage, true);

        currentMeetingId = meeting.id;
        socket.join(roomName(meeting.id));

        void db.createMeetingRecord({
          id: meeting.dbId,
          joinCode: meeting.id,
          hostName,
          roles: meeting.roles,
        });
        persistParticipants(meeting);

        ack?.({ ok: true, meeting: toSnapshot(meeting), selfId: socket.id });
      } catch (err) {
        ack?.({ ok: false, error: "No se pudo crear la reunión." });
      }
    }
  );

  socket.on(
    "join-meeting",
    (payload: { meetingId: string; name: string; language: string }, ack) => {
      try {
        const meetingId = String(payload?.meetingId ?? "").trim().toUpperCase();
        const name = String(payload?.name ?? "").slice(0, MAX_NAME_LENGTH).trim();
        const language = String(payload?.language ?? "es-AR");

        const meeting = getMeeting(meetingId);
        if (!meeting) {
          ack?.({ ok: false, error: "No encontramos una reunión con ese código." });
          return;
        }
        if (!name) {
          ack?.({ ok: false, error: "Ingresá tu nombre para unirte." });
          return;
        }

        cancelMeetingCleanup(meeting.id);
        // If everyone had left (meeting was just sitting in its grace
        // period) the next person in gets to be host again, otherwise
        // role assignment would be permanently stuck with no host.
        const becomesHost = meeting.participants.size === 0;
        const participant = addParticipant(meeting, socket.id, name, language, becomesHost);
        currentMeetingId = meeting.id;
        socket.join(roomName(meeting.id));
        persistParticipants(meeting);

        socket.to(roomName(meeting.id)).emit("participant-joined", { participant });

        ack?.({ ok: true, meeting: toSnapshot(meeting), selfId: socket.id });
      } catch (err) {
        ack?.({ ok: false, error: "No se pudo unir a la reunión." });
      }
    }
  );

  socket.on("signal", (payload: { to: string; data: unknown }) => {
    if (!payload?.to) return;
    io.to(payload.to).emit("signal", { from: socket.id, data: payload.data });
  });

  socket.on("add-role", (payload: { name: string }, ack) => {
    const meeting = currentMeetingId ? getMeeting(currentMeetingId) : undefined;
    if (!meeting) return ack?.({ ok: false, error: "Reunión no encontrada." });
    if (!requireHost(meeting, socket.id)) {
      return ack?.({ ok: false, error: "Solo el anfitrión puede crear roles." });
    }
    const name = String(payload?.name ?? "").trim().slice(0, MAX_ROLE_NAME_LENGTH);
    if (!name) return ack?.({ ok: false, error: "El rol necesita un nombre." });

    const role = addRole(meeting, name);
    void db.updateMeetingRoles(meeting.dbId, meeting.roles);
    io.to(roomName(meeting.id)).emit("role-added", { role });
    ack?.({ ok: true, role });
  });

  socket.on(
    "assign-role",
    (payload: { participantId: string; roleId: string | null }, ack) => {
      const meeting = currentMeetingId ? getMeeting(currentMeetingId) : undefined;
      if (!meeting) return ack?.({ ok: false, error: "Reunión no encontrada." });
      if (!requireHost(meeting, socket.id)) {
        return ack?.({ ok: false, error: "Solo el anfitrión puede asignar roles." });
      }
      const participant = meeting.participants.get(payload?.participantId);
      if (!participant) return ack?.({ ok: false, error: "Participante no encontrado." });

      const roleId = payload?.roleId ?? null;
      if (roleId && !meeting.roles.some((r) => r.id === roleId)) {
        return ack?.({ ok: false, error: "Rol no encontrado." });
      }

      participant.roleId = roleId;
      persistParticipants(meeting);
      io.to(roomName(meeting.id)).emit("role-assigned", {
        participantId: participant.id,
        roleId,
      });
      ack?.({ ok: true });
    }
  );

  socket.on("chat-message", (payload: { text: string }, ack) => {
    const meeting = currentMeetingId ? getMeeting(currentMeetingId) : undefined;
    if (!meeting) return ack?.({ ok: false, error: "Reunión no encontrada." });
    const sender = meeting.participants.get(socket.id);
    if (!sender) return ack?.({ ok: false, error: "Participante no encontrado." });
    const text = String(payload?.text ?? "").trim();
    if (!text) return ack?.({ ok: false, error: "Mensaje vacío." });

    const message = addChatMessage(meeting, sender, text);
    void db.recordMessage({
      meetingId: meeting.dbId,
      kind: "chat",
      senderName: sender.name,
      roleName: roleNameFor(meeting, sender.roleId),
      text: message.text,
      sourceLang: message.sourceLang,
    });
    io.to(roomName(meeting.id)).emit("chat-message", { message });
    ack?.({ ok: true });
  });

  socket.on("transcript-line", async (payload: { alternatives?: string[]; text?: string; lang?: string }) => {
    const meeting = currentMeetingId ? getMeeting(currentMeetingId) : undefined;
    if (!meeting) return;
    const speaker = meeting.participants.get(socket.id);
    if (!speaker) return;
    // `alternatives` is the speech recognizer's own ranked candidate
    // readings of the same utterance -- a much stronger signal for fixing a
    // mis-heard word than context alone. `text` stays as a fallback for any
    // older client still sending the single-string shape.
    const alternatives = Array.isArray(payload?.alternatives)
      ? payload.alternatives.map(String)
      : [String(payload?.text ?? "")];
    if (!alternatives.some((a) => a.trim())) return;

    // Recent lines give the model context to disambiguate a mis-heard word
    // (e.g. picking the right homophone) -- a lone fragment often can't be
    // fixed reliably on its own.
    const recentContext = meeting.transcript.slice(-4).map((l) => `${l.speakerName}: ${l.text}`);
    const text = await cleanTranscriptFragment(alternatives, recentContext);
    if (!text) return;

    // The meeting (or this participant) may have disappeared while we were
    // waiting on the cleanup call -- re-check before touching state.
    const stillPresent = currentMeetingId ? getMeeting(currentMeetingId) : undefined;
    if (!stillPresent || stillPresent !== meeting || !meeting.participants.has(socket.id)) return;

    const sourceLang = payload?.lang || speaker.language;

    // Broadcast the cleaned line right away -- viewers who share the
    // speaker's language get their caption with no extra wait. Translations
    // are fetched afterwards and pushed as a follow-up patch instead of
    // holding up everyone's caption until every language is ready.
    const line = addTranscriptLine(meeting, speaker, text, sourceLang);
    void db.recordMessage({
      meetingId: meeting.dbId,
      kind: "transcript",
      senderName: speaker.name,
      roleName: roleNameFor(meeting, speaker.roleId),
      text: line.text,
      sourceLang: line.sourceLang,
    });
    io.to(roomName(meeting.id)).emit("transcript-line", { line });

    // Translate into every language someone else in the meeting is actually
    // using, in parallel, so most viewers get an already-translated caption
    // with no extra round trip instead of each one firing its own separate
    // translate request after the fact.
    const targetLangs = new Set<string>();
    for (const p of meeting.participants.values()) {
      if (shortLang(p.language) !== shortLang(sourceLang)) targetLangs.add(p.language);
    }
    if (targetLangs.size === 0) return;

    const translations: Record<string, string> = {};
    await Promise.all(
      Array.from(targetLangs).map(async (lang) => {
        try {
          translations[shortLang(lang)] = await translateText(text, sourceLang, lang);
        } catch {
          // Best-effort -- that viewer's client falls back to /api/translate.
        }
      })
    );
    if (Object.keys(translations).length === 0) return;

    line.translations = translations;
    io.to(roomName(meeting.id)).emit("transcript-line-translations", { lineId: line.id, translations });
  });

  socket.on("media-state", (payload: { muted?: boolean; cameraOff?: boolean }) => {
    const meeting = currentMeetingId ? getMeeting(currentMeetingId) : undefined;
    if (!meeting) return;
    const participant = meeting.participants.get(socket.id);
    if (!participant) return;
    if (typeof payload?.muted === "boolean") participant.muted = payload.muted;
    if (typeof payload?.cameraOff === "boolean") participant.cameraOff = payload.cameraOff;
    io.to(roomName(meeting.id)).emit("media-state", {
      participantId: participant.id,
      muted: participant.muted,
      cameraOff: participant.cameraOff,
    });
  });

  socket.on("screen-share", (payload: { sharing?: boolean }) => {
    const meeting = currentMeetingId ? getMeeting(currentMeetingId) : undefined;
    if (!meeting) return;
    const participant = meeting.participants.get(socket.id);
    if (!participant) return;
    participant.sharingScreen = Boolean(payload?.sharing);
    io.to(roomName(meeting.id)).emit("screen-share", {
      participantId: participant.id,
      sharingScreen: participant.sharingScreen,
    });
  });

  socket.on("leave-meeting", () => {
    handleDeparture();
  });

  socket.on("disconnect", () => {
    handleDeparture();
  });

  function handleDeparture(): void {
    if (!currentMeetingId) return;
    const meeting = getMeeting(currentMeetingId);
    currentMeetingId = null;
    if (!meeting) return;

    const departed = removeParticipant(meeting, socket.id);
    if (!departed) return;

    socket.leave(roomName(meeting.id));
    io.to(roomName(meeting.id)).emit("participant-left", { participantId: departed.id });

    if (departed.isHost && meeting.participants.size > 0) {
      const promoted = promoteNextHost(meeting);
      if (promoted) {
        io.to(roomName(meeting.id)).emit("host-changed", { hostId: promoted.id });
      }
    }

    persistParticipants(meeting);
    scheduleMeetingCleanupIfEmpty(meeting.id);
  }
}
