import { Server, Socket } from "socket.io";
import {
  addChatMessage,
  addParticipant,
  addRole,
  addTranscriptLine,
  createMeeting,
  deleteMeetingIfEmpty,
  getMeeting,
  promoteNextHost,
  removeParticipant,
} from "./meetingStore";
import { Meeting, toSnapshot } from "./types";

const MAX_NAME_LENGTH = 60;
const MAX_ROLE_NAME_LENGTH = 40;

function roomName(meetingId: string): string {
  return `meeting:${meetingId}`;
}

function requireHost(meeting: Meeting, socketId: string): boolean {
  return meeting.hostId === socketId;
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

        const participant = addParticipant(meeting, socket.id, name, language, false);
        currentMeetingId = meeting.id;
        socket.join(roomName(meeting.id));

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
    io.to(roomName(meeting.id)).emit("chat-message", { message });
    ack?.({ ok: true });
  });

  socket.on("transcript-line", (payload: { text: string; lang?: string }) => {
    const meeting = currentMeetingId ? getMeeting(currentMeetingId) : undefined;
    if (!meeting) return;
    const speaker = meeting.participants.get(socket.id);
    if (!speaker) return;
    const text = String(payload?.text ?? "").trim();
    if (!text) return;

    const line = addTranscriptLine(meeting, speaker, text, payload?.lang || speaker.language);
    io.to(roomName(meeting.id)).emit("transcript-line", { line });
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

    deleteMeetingIfEmpty(meeting.id);
  }
}
