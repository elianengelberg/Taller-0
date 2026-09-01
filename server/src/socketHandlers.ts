import { Server, Socket } from "socket.io";
import { verifyToken } from "./auth";
import * as db from "./db";
import {
  addChatMessage,
  addParticipant,
  addRole,
  addNamedTranscriptLine,
  addTranscriptLine,
  cancelMeetingCleanup,
  createMeeting,
  getMeeting,
  getOrCreateCompanionMeeting,
  promoteNextHost,
  removeParticipant,
  reviveMeeting,
  scheduleMeetingCleanupIfEmpty,
} from "./meetingStore";
import { cleanTranscriptFragment, translateFragmentToAll } from "./transcriptCleanup";
import { shortLang } from "./translate";
import { ChatMode, Meeting, MODERATION_RANK, ModerationRole, Participant, SharePolicy, toSnapshot, TranscriptLine } from "./types";

const MAX_NAME_LENGTH = 60;
const MAX_ROLE_NAME_LENGTH = 40;
// Speech recognizers emit at most a handful of short candidate readings per
// utterance; anything beyond these caps is a hostile client trying to stuff
// megabytes into the Claude-backed cleanup/translation calls.
const MAX_ALTERNATIVES = 5;
const MAX_ALTERNATIVE_CHARS = 600;
// A meeting realistically needs a dozen roles at most; an unbounded list
// bloats every snapshot broadcast to everyone.
const MAX_ROLES_PER_MEETING = 50;
// Companion keys are "zoom:<num>" / "teams:<threadId>" / a fallback URL --
// never anywhere near this long legitimately.
const MAX_EXTERNAL_KEY_CHARS = 512;
// Native meetings run a WebRTC mesh (everyone connects to everyone): with N
// participants each browser uploads its video N-1 times, so video quality on
// weak connections degrades well before this cap -- participants can always
// turn cameras off (audio + captions stay light). The hard cap exists so the
// room stays functional instead of quietly collapsing. Companion rooms carry
// no media of ours, so their cap is only an anti-abuse sanity bound.
const MAX_PARTICIPANTS_NATIVE = 30;
const MAX_PARTICIPANTS_COMPANION = 100;

// Deliberately generous per-socket rate caps -- far above anything a real
// client produces (the recognizer finalizes at most ~1 utterance/second and
// nobody types 2 chat messages a second sustained), so legitimate use never
// trips them, but a hostile loop can't flood the room or the Claude calls.
function makeRateLimiter(maxPerWindow: number, windowMs: number): () => boolean {
  let windowStart = 0;
  let count = 0;
  return () => {
    const now = Date.now();
    if (now - windowStart > windowMs) {
      windowStart = now;
      count = 0;
    }
    count += 1;
    return count <= maxPerWindow;
  };
}

function roomName(meetingId: string): string {
  return `meeting:${meetingId}`;
}

function requireHost(meeting: Meeting, socketId: string): boolean {
  return meeting.hostId === socketId;
}

function moderationRoleOf(meeting: Meeting, socketId: string): ModerationRole | null {
  return meeting.participants.get(socketId)?.moderationRole ?? null;
}

// Can `actor` act on `target`? Equal or higher rank is protected: a co-host
// can moderate participants but never another co-host or the host.
function canModerate(meeting: Meeting, actorId: string, targetId: string): boolean {
  const actor = moderationRoleOf(meeting, actorId);
  const target = moderationRoleOf(meeting, targetId);
  if (!actor || !target) return false;
  return MODERATION_RANK[actor] > MODERATION_RANK[target];
}

function normalizedName(name: string): string {
  return name.trim().toLowerCase();
}

function broadcastSettings(io: Server, meeting: Meeting): void {
  io.to(roomName(meeting.id)).emit("meeting-settings", { settings: meeting.settings });
}

function broadcastWaitingToHosts(io: Server, meeting: Meeting): void {
  const waiting = Array.from(meeting.waiting.values()).map((w) => ({ id: w.id, name: w.name }));
  for (const p of meeting.participants.values()) {
    if (p.moderationRole !== "participant") {
      io.to(p.id).emit("waiting-updated", { waiting });
    }
  }
}

function clearPresenterIf(io: Server, meeting: Meeting, participantId: string): void {
  if (meeting.presenterId !== participantId) return;
  meeting.presenterId = null;
  io.to(roomName(meeting.id)).emit("presenter-changed", { presenterId: null, presenterName: null });
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

// Continuous, fluent speech can get chopped into several separate "final"
// results by the browser's speech recognizer (its own pause/end-of-utterance
// detection, not something this app controls), which otherwise shows up as
// a run of disconnected half-sentences instead of one coherent line. If the
// next fragment from the same speaker arrives within this window and nobody
// else has spoken in between, fold it into the previous line instead of
// starting a new one.
//
// 2.5s used to be enough for fluent native speech, but someone speaking
// deliberately -- reading a phrase carefully, pausing between words to get
// pronunciation right in a language they're less comfortable in -- can
// easily leave a longer gap than that between two halves of the SAME
// thought. When that happens the second half starts a new, unmerged line,
// and because the on-screen caption bubble only ever shows the single most
// recent line (see LiveCaption's 6s auto-hide below), it looks like
// everything before it just vanished, even though it's still sitting in the
// Transcripción panel as a separate line. Matching this to LiveCaption's own
// 6s visibility window keeps both in sync: as long as the previous caption
// would still be on screen, a new fragment from the same speaker is treated
// as a continuation of it rather than a fresh thought.
const MERGE_WINDOW_MS = 6000;
// Stop folding fragments into an ever-growing single line -- both to keep
// the correction call's input sane and because a gap this long is more
// likely a new thought than a continuation anyway.
const MAX_MERGED_LINE_CHARS = 800;

// How long a departed host has to reconnect (same tab auto-reconnecting
// after a network blip) and automatically get host status back before the
// promotion to whoever replaced them is considered permanent.
const HOST_RECLAIM_WINDOW_MS = 3 * 60 * 1000;

export function registerSocketHandlers(io: Server, socket: Socket): void {
  let currentMeetingId: string | null = null;
  const allowTranscript = makeRateLimiter(30, 10_000);
  const allowChat = makeRateLimiter(20, 10_000);
  // WebRTC setup for a large mesh is genuinely chatty (offer/answer + trickle
  // ICE candidates per peer, plus renegotiation on track swaps), so this cap is
  // high enough never to trip legitimate signalling while still stopping a
  // socket from being used as a relay-flood amplifier.
  const allowSignal = makeRateLimiter(1500, 10_000);
  // Presence/state events (mute, camera, hand, language, quality, share) each
  // BROADCAST to the whole room, so a flood is amplified by the participant
  // count. Real clients emit these a handful of times per minute; this shared
  // cap is far above that yet stops a hostile loop from hammering everyone.
  const allowStateChange = makeRateLimiter(60, 10_000);
  const allowModerate = makeRateLimiter(60, 10_000);

  // Foto de perfil de quien se une. Se resuelve en el SERVIDOR a partir del
  // token: si la mandara el cliente, cualquiera podría entrar a una reunión
  // con la cara de otra persona. Los invitados sin cuenta no tienen, y eso
  // está bien -- la inicial alcanza.
  async function avatarForUser(userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const user = await db.getUserById(userId);
    return user?.avatarUrl ?? null;
  }
  // Tracks the most recently finalized transcript line from THIS socket, so
  // a fast follow-up fragment can be merged into it instead of appearing as
  // its own separate, easy-to-miss caption.
  let recentUtterance: { lineId: string; dbMessageId: number | null; finalizedAt: number } | null = null;

  socket.on(
    "create-meeting",
    async (payload: { hostName: string; hostLanguage: string; roles: string[]; token?: string }, ack) => {
      try {
        const hostName = String(payload?.hostName ?? "").slice(0, MAX_NAME_LENGTH).trim();
        const hostLanguage = String(payload?.hostLanguage ?? "es-AR");
        const roleNames = Array.isArray(payload?.roles) ? payload.roles : [];
        // If the creator is logged in, tie the meeting to their account so it
        // shows up in their (private) history -- guests create ownerless ones.
        const ownerId = verifyToken(payload?.token);

        if (!hostName) {
          ack?.({ ok: false, error: "El nombre del anfitrión es obligatorio." });
          return;
        }

        const meeting = createMeeting();
        for (const name of roleNames.slice(0, MAX_ROLES_PER_MEETING)) {
          if (typeof name === "string" && name.trim()) {
            addRole(meeting, name.slice(0, MAX_ROLE_NAME_LENGTH));
          }
        }
        addParticipant(meeting, socket.id, hostName, hostLanguage, true, ownerId, await avatarForUser(ownerId));

        currentMeetingId = meeting.id;
        socket.join(roomName(meeting.id));

        void db.createMeetingRecord({
          id: meeting.dbId,
          joinCode: meeting.id,
          hostName,
          roles: meeting.roles,
          ownerId,
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
    async (
      payload: { meetingId: string; name: string; language: string; resumeParticipantId?: string; token?: string },
      ack
    ) => {
      try {
        const meetingId = String(payload?.meetingId ?? "").trim().toUpperCase();
        const name = String(payload?.name ?? "").slice(0, MAX_NAME_LENGTH).trim();
        const language = String(payload?.language ?? "es-AR");
        // Logged-in? Lets this participant reach the live meeting's transcript/AI
        // (via REST) even if they're not its owner. Guests stay anonymous.
        const userId = verifyToken(payload?.token);
        const resumeParticipantId =
          typeof payload?.resumeParticipantId === "string" ? payload.resumeParticipantId : null;

        let meeting = getMeeting(meetingId);
        if (!meeting) {
          // El servidor pudo reiniciarse en plena reunión (un deploy, el plan
          // gratuito que recicla la instancia): las reuniones viven en
          // memoria y el reinicio las borra, pero su registro queda en la
          // base. Si el código es de una reunión RECIENTE, se resucita con el
          // MISMO dbId: cada participante re-entra solo apenas su socket
          // reconecta -- nadie va a parar al inicio -- y el historial sigue
          // siendo uno solo. El primero en volver queda de anfitrión (regla
          // de la sala vacía, más abajo).
          const registro = await db.findRecentMeetingByJoinCode(meetingId);
          if (registro) meeting = reviveMeeting(meetingId, registro.id, registro.roles);
        }
        if (!meeting) {
          ack?.({ ok: false, error: "No encontramos una reunión con ese código." });
          return;
        }
        if (!name) {
          ack?.({ ok: false, error: "Ingresá tu nombre para unirte." });
          return;
        }
        if (meeting.participants.size >= MAX_PARTICIPANTS_NATIVE) {
          ack?.({
            ok: false,
            error: `La reunión está llena (máximo ${MAX_PARTICIPANTS_NATIVE} participantes).`,
          });
          return;
        }
        if (meeting.bannedNames.has(normalizedName(name))) {
          ack?.({ ok: false, error: "El anfitrión te quitó de esta reunión." });
          return;
        }
        // A returning host (resume) never gets stopped at the door by their
        // own lock/waiting room.
        const isReturningHost =
          meeting.pendingHostReclaim &&
          resumeParticipantId &&
          meeting.pendingHostReclaim.participantId === resumeParticipantId &&
          Date.now() < meeting.pendingHostReclaim.expiresAt;
        if (meeting.settings.locked && !isReturningHost) {
          ack?.({ ok: false, error: "La reunión está bloqueada por el anfitrión." });
          return;
        }
        if (meeting.settings.waitingRoomEnabled && !isReturningHost && meeting.participants.size > 0) {
          meeting.waiting.set(socket.id, { id: socket.id, name, language });
          currentMeetingId = meeting.id;
          broadcastWaitingToHosts(io, meeting);
          ack?.({ ok: true, waiting: true });
          return;
        }

        cancelMeetingCleanup(meeting.id);
        // If everyone had left (meeting was just sitting in its grace
        // period) the next person in gets to be host again, otherwise
        // role assignment would be permanently stuck with no host.
        const becomesHost = meeting.participants.size === 0;
        const participant = addParticipant(
          meeting,
          socket.id,
          name,
          language,
          becomesHost,
          userId,
          await avatarForUser(userId)
        );
        currentMeetingId = meeting.id;
        socket.join(roomName(meeting.id));

        // This is a client-side socket reconnect (network blip, backgrounded
        // tab) resuming as the same person who was previously the host --
        // give host status back instead of leaving them permanently demoted
        // to whoever got auto-promoted while they were briefly disconnected.
        const reclaim = meeting.pendingHostReclaim;
        if (
          reclaim &&
          resumeParticipantId &&
          reclaim.participantId === resumeParticipantId &&
          Date.now() < reclaim.expiresAt
        ) {
          const currentHost = meeting.participants.get(meeting.hostId);
          if (currentHost) {
            currentHost.isHost = false;
            // The stand-in keeps co-host powers instead of dropping to
            // participant -- they were trusted enough to run the room.
            currentHost.moderationRole = "cohost";
            io.to(roomName(meeting.id)).emit("moderation-role", { participantId: currentHost.id, role: "cohost" });
          }
          participant.isHost = true;
          participant.moderationRole = "host";
          meeting.hostId = participant.id;
          meeting.pendingHostReclaim = null;
          io.to(roomName(meeting.id)).emit("moderation-role", { participantId: participant.id, role: "host" });
          io.to(roomName(meeting.id)).emit("host-changed", { hostId: participant.id });
        }

        persistParticipants(meeting);

        socket.to(roomName(meeting.id)).emit("participant-joined", { participant });

        ack?.({ ok: true, meeting: toSnapshot(meeting), selfId: socket.id });
      } catch (err) {
        ack?.({ ok: false, error: "No se pudo unir a la reunión." });
      }
    }
  );

  // Join the Unify "companion" layer that rides on top of an external
  // meeting (Jitsi/Zoom/Meet). The external platform handles audio/video; this
  // just puts the caller into a shared room -- keyed by the external meeting --
  // where our transcript/translation/AI layer lives. From here on it's an
  // ordinary participant, so transcript-line/chat/set-language/disconnect all
  // reuse the exact same handlers as a native meeting.
  socket.on(
    "join-companion",
    async (payload: { externalKey: string; name: string; language: string; token?: string }, ack) => {
      try {
        const externalKey = String(payload?.externalKey ?? "").trim().slice(0, MAX_EXTERNAL_KEY_CHARS);
        const name = String(payload?.name ?? "").slice(0, MAX_NAME_LENGTH).trim();
        const language = String(payload?.language ?? "es-AR");
        const ownerId = verifyToken(payload?.token);

        if (!externalKey) {
          ack?.({ ok: false, error: "Falta la referencia de la reunión externa." });
          return;
        }
        if (!name) {
          ack?.({ ok: false, error: "Ingresá tu nombre para unirte." });
          return;
        }

        const { meeting, created } = getOrCreateCompanionMeeting(externalKey);
        if (meeting.participants.size >= MAX_PARTICIPANTS_COMPANION) {
          ack?.({ ok: false, error: "La sala de Unify para esta reunión está llena." });
          return;
        }
        cancelMeetingCleanup(meeting.id);
        // No host semantics here -- an external meeting has its own host on the
        // other platform; the companion layer is a flat group of note-takers.
        const participant = addParticipant(
          meeting,
          socket.id,
          name,
          language,
          false,
          ownerId,
          await avatarForUser(ownerId)
        );
        currentMeetingId = meeting.id;
        socket.join(roomName(meeting.id));

        if (created) {
          // The first (logged-in) person to open this external meeting through
          // Unify owns its companion record, so it lands in their history.
          void db.createMeetingRecord({
            id: meeting.dbId,
            joinCode: meeting.id,
            hostName: name,
            roles: [],
            ownerId,
          });
        }
        persistParticipants(meeting);

        socket.to(roomName(meeting.id)).emit("participant-joined", { participant });
        ack?.({ ok: true, meeting: toSnapshot(meeting), selfId: socket.id });
      } catch (err) {
        ack?.({ ok: false, error: "No se pudo unir a la reunión externa." });
      }
    }
  );

  socket.on("signal", (payload: { to: string; data: unknown }) => {
    if (!allowSignal()) return;
    const to = typeof payload?.to === "string" ? payload.to : "";
    if (!to) return;
    // Only relay WebRTC signalling between two participants of the SAME
    // meeting. Without this, any socket could fan signalling data out to
    // arbitrary sockets (including ones in other meetings), which is both a
    // cross-meeting isolation leak and a way to poke unrelated peers.
    const meeting = currentMeetingId ? getMeeting(currentMeetingId) : undefined;
    if (!meeting || !meeting.participants.has(socket.id) || !meeting.participants.has(to)) return;
    io.to(to).emit("signal", { from: socket.id, data: payload.data });
  });

  socket.on("add-role", (payload: { name: string }, ack) => {
    const meeting = currentMeetingId ? getMeeting(currentMeetingId) : undefined;
    if (!meeting) return ack?.({ ok: false, error: "Reunión no encontrada." });
    if (!requireHost(meeting, socket.id)) {
      return ack?.({ ok: false, error: "Solo el anfitrión puede crear roles." });
    }
    const name = String(payload?.name ?? "").trim().slice(0, MAX_ROLE_NAME_LENGTH);
    if (!name) return ack?.({ ok: false, error: "El rol necesita un nombre." });
    if (meeting.roles.length >= MAX_ROLES_PER_MEETING) {
      return ack?.({ ok: false, error: "La reunión ya tiene el máximo de roles posibles." });
    }

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
    if (!allowChat()) return ack?.({ ok: false, error: "Estás enviando mensajes demasiado rápido." });
    const meeting = currentMeetingId ? getMeeting(currentMeetingId) : undefined;
    if (!meeting) return ack?.({ ok: false, error: "Reunión no encontrada." });
    const sender = meeting.participants.get(socket.id);
    if (!sender) return ack?.({ ok: false, error: "Participante no encontrado." });
    const text = String(payload?.text ?? "").trim();
    if (!text) return ack?.({ ok: false, error: "Mensaje vacío." });

    const isModerator = sender.moderationRole !== "participant";
    if (meeting.settings.chatMode === "off" && !isModerator) {
      return ack?.({ ok: false, error: "El anfitrión desactivó el chat." });
    }

    const message = addChatMessage(meeting, sender, text);
    if (meeting.settings.chatMode === "hosts" && !isModerator) {
      // Deliver only to the hosts (and echo to the sender) -- Zoom's
      // "chat with host only" mode.
      message.toHostsOnly = true;
      for (const p of meeting.participants.values()) {
        if (p.moderationRole !== "participant" || p.id === sender.id) {
          io.to(p.id).emit("chat-message", { message });
        }
      }
    } else {
      io.to(roomName(meeting.id)).emit("chat-message", { message });
    }
    void db.recordMessage({
      meetingId: meeting.dbId,
      kind: "chat",
      senderName: sender.name,
      roleName: roleNameFor(meeting, sender.roleId),
      text: message.text,
      sourceLang: message.sourceLang,
    });
    ack?.({ ok: true });
  });

  socket.on("transcript-line", async (payload: { alternatives?: string[]; text?: string; lang?: string; screen?: boolean; origen?: string }) => {
    try {
      if (!allowTranscript()) return;
      // Stamp the utterance NOW, before the cleanup/translation awaits below --
      // this is when it was spoken (server clock), which is what the history
      // player uses to line the transcript up with the video. Using the insert
      // time instead would fold in several seconds of pipeline latency.
      const spokenAt = new Date();
      const meeting = currentMeetingId ? getMeeting(currentMeetingId) : undefined;
      if (!meeting) return;
      const speaker = meeting.participants.get(socket.id);
      if (!speaker) return;
      // `alternatives` is the speech recognizer's own ranked candidate
      // readings of the same utterance -- a much stronger signal for fixing a
      // mis-heard word than context alone. `text` stays as a fallback for any
      // older client still sending the single-string shape. Capped in count
      // and length: real recognizer output is short, and these strings feed
      // straight into Claude calls billed to us.
      const alternatives = (Array.isArray(payload?.alternatives)
        ? payload.alternatives.map(String)
        : [String(payload?.text ?? "")]
      )
        .slice(0, MAX_ALTERNATIVES)
        .map((a) => a.slice(0, MAX_ALTERNATIVE_CHARS));
      if (!alternatives.some((a) => a.trim())) return;

      // Una línea de PANTALLA: el audio de lo que el participante comparte
      // (un video, una presentación con sonido), no su voz. Va con nombre
      // propio ("Pantalla de X"), sin fusionarse con lo que la persona dice,
      // y pasa por la misma IA correctora. El idioma del video es incierto,
      // así que se traduce al idioma de TODOS los presentes (el de la persona
      // que comparte incluido) y la interfaz oculta las idénticas.
      if (payload?.screen === true) {
        const recentContext = meeting.transcript.slice(-6).map((l) => `${l.speakerName}: ${l.text}`);
        const assumedLang = payload?.lang || speaker.language;
        const targets = new Set<string>();
        for (const p of meeting.participants.values()) targets.add(shortLang(p.language));
        // Corregir primero, traducir lo corregido: traducir las lecturas
        // crudas era traducir los errores del reconocimiento.
        const cleanup = await cleanTranscriptFragment(alternatives, recentContext, assumedLang);
        if (!cleanup.text) return;
        const translationsPromise = translateFragmentToAll(
          [cleanup.text], recentContext, Array.from(targets), assumedLang
        );
        const still = currentMeetingId ? getMeeting(currentMeetingId) : undefined;
        if (!still || still !== meeting || !meeting.participants.has(socket.id)) return;
        const mismatch = cleanup.detectedLang !== null && cleanup.detectedLang !== shortLang(assumedLang);
        const sourceLang = mismatch ? cleanup.detectedLang! : assumedLang;
        // `origen: "reunion"`: el audio capturado ES la reunión externa (las
        // voces de quienes entran por Zoom/Meet/la app que sea, sin Unify) --
        // companion transcribiendo la pestaña/pantalla compartida. La etiqueta
        // lo dice; "Pantalla de X" queda para el sonido de una pantalla
        // compartida en una reunión nativa.
        const nombre = payload?.origen === "reunion" ? "La reunión" : `Pantalla de ${speaker.name}`;
        const line = addNamedTranscriptLine(meeting, nombre, cleanup.text, sourceLang);
        io.to(roomName(meeting.id)).emit("transcript-line", { line });
        void db.recordMessage({
          meetingId: meeting.dbId,
          kind: "transcript",
          senderName: nombre,
          roleName: null,
          text: line.text,
          sourceLang: line.sourceLang,
          spokenAt,
        });
        void translationsPromise.then((translations) => {
          if (Object.keys(translations).length === 0) return;
          line.translations = translations;
          io.to(roomName(meeting.id)).emit("transcript-line-translations", { lineId: line.id, translations });
        });
        return;
      }

      // Is this a fast follow-up to the utterance we just finished for this
      // same speaker? If so, fold it into that line instead of starting a
      // choppy new one -- see MERGE_WINDOW_MS comment above.
      const mergeCandidate =
        recentUtterance && Date.now() - recentUtterance.finalizedAt < MERGE_WINDOW_MS
          ? meeting.transcript.find((l) => l.id === recentUtterance!.lineId)
          : undefined;
      const isStillLatest =
        mergeCandidate && meeting.transcript[meeting.transcript.length - 1]?.id === mergeCandidate.id;
      const mergeTarget =
        isStillLatest && mergeCandidate && mergeCandidate.text.length < MAX_MERGED_LINE_CHARS
          ? mergeCandidate
          : undefined;

      // Recent lines give the model context to disambiguate a mis-heard word
      // (e.g. picking the right homophone) -- a lone fragment often can't be
      // fixed reliably on its own. When merging, the line being merged into
      // is folded directly into the alternatives themselves (below) instead
      // of staying in "context", so it isn't duplicated in the prompt.
      const baseTranscript = mergeTarget ? meeting.transcript.slice(0, -1) : meeting.transcript;
      // Seis líneas de contexto (eran cuatro): con más conversación previa el
      // modelo desambigua mejor una palabra mal oída -- de qué se viene
      // hablando es la mejor pista para "¿dijo 'banda' o 'venda'?".
      const recentContext = baseTranscript.slice(-6).map((l) => `${l.speakerName}: ${l.text}`);
      const effectiveAlternatives = mergeTarget
        ? alternatives.map((a) => `${mergeTarget.text} ${a}`.trim())
        : alternatives;

      // What we *assume* the speaker is using, from their configured
      // language -- usually right, but someone can speak a different
      // language than they configured (switched languages, forgot to
      // change the setting, or is just being tested with foreign audio).
      const assumedSourceLang = payload?.lang || speaker.language;

      // PRIMERO se corrige, DESPUÉS se traduce. Antes las dos llamadas
      // corrían en paralelo sobre las lecturas CRUDAS del reconocimiento
      // (ganaba ~1 segundo), pero eso significaba traducir los errores:
      // "commanders" traducido con toda seriedad en vez de "cómo andás".
      // La traducción llega igual como parche posterior sobre la línea, así
      // que ese segundo no le costaba nada a nadie -- y la calidad, todo.
      const cleanup = await cleanTranscriptFragment(effectiveAlternatives, recentContext, assumedSourceLang);
      if (!cleanup.text) return;

      // The meeting (or this participant) may have disappeared while we were
      // waiting on the cleanup call -- re-check before touching state.
      const stillPresent = currentMeetingId ? getMeeting(currentMeetingId) : undefined;
      if (!stillPresent || stillPresent !== meeting || !meeting.participants.has(socket.id)) return;

      // Trust what was actually detected over what we assumed, but only
      // override when detection confidently disagrees -- otherwise keep the
      // richer configured code (e.g. "es-AR" instead of collapsing to "es").
      const mismatch = cleanup.detectedLang !== null && cleanup.detectedLang !== shortLang(assumedSourceLang);
      const sourceLang = mismatch ? cleanup.detectedLang! : assumedSourceLang;

      // Broadcast the cleaned line right away -- viewers who share the
      // speaker's language get their caption with no extra wait. Translations
      // (already in flight since before the cleanup call even resolved) are
      // pushed as a follow-up patch instead of holding up everyone's caption
      // until every language is ready.
      let line: TranscriptLine;
      if (mergeTarget) {
        mergeTarget.text = cleanup.text;
        mergeTarget.sourceLang = sourceLang;
        mergeTarget.translations = undefined; // stale -- they were for the shorter, now-superseded text
        line = mergeTarget;
        const dbMessageId = recentUtterance?.dbMessageId ?? null;
        if (dbMessageId != null) {
          void db.updateMessageText(dbMessageId, line.text);
        }
        recentUtterance = { lineId: line.id, dbMessageId, finalizedAt: Date.now() };
      } else {
        line = addTranscriptLine(meeting, speaker, cleanup.text, sourceLang);
        // Not carrying over the previous line's dbMessageId here -- a
        // fragment merging into this new line before the insert below
        // resolves must NOT write into an older, unrelated row.
        recentUtterance = { lineId: line.id, dbMessageId: null, finalizedAt: Date.now() };
        const lineaNueva = line;
        const textoInsertado = line.text;
        void db
          .recordMessage({
            meetingId: meeting.dbId,
            kind: "transcript",
            senderName: speaker.name,
            roleName: roleNameFor(meeting, speaker.roleId),
            text: line.text,
            sourceLang: line.sourceLang,
            spokenAt,
          })
          .then((dbMessageId) => {
            // Only update if this is still the line we think it is -- a
            // merge could have already moved recentUtterance on by the time
            // this insert resolves.
            if (recentUtterance && recentUtterance.lineId === lineaNueva.id) {
              recentUtterance.dbMessageId = dbMessageId;
            }
            // Si un fragmento se FUSIONÓ en esta línea mientras el insert
            // viajaba (con el reintento por clave foránea, casi un segundo),
            // la fila quedaba con el primer pedazo solo. Se la pone al día.
            if (dbMessageId != null && lineaNueva.text !== textoInsertado) {
              void db.updateMessageText(dbMessageId, lineaNueva.text);
            }
          });
      }
      io.to(roomName(meeting.id)).emit("transcript-line", { line });

      // Los destinos se calculan con el idioma DETECTADO (no el supuesto):
      // si la persona habló en otro idioma que el configurado, el grupo que
      // se creía "del mismo idioma" también recibe su traducción -- sin
      // llamada correctiva aparte, porque acá ya se sabe la verdad.
      const targetLangs = new Set<string>();
      for (const p of meeting.participants.values()) {
        if (shortLang(p.language) !== shortLang(sourceLang)) targetLangs.add(shortLang(p.language));
      }
      const translations = await translateFragmentToAll(
        [cleanup.text],
        recentContext,
        Array.from(targetLangs),
        sourceLang
      );
      if (Object.keys(translations).length === 0) return;

      const stillThere = currentMeetingId ? getMeeting(currentMeetingId) : undefined;
      if (!stillThere || stillThere !== meeting) return;
      // A later fragment may have merged into (and replaced the text of)
      // this same line while translation was in flight -- don't let a
      // slower, now-stale translation overwrite the newer merged content.
      if (recentUtterance?.lineId !== line.id || line.text !== cleanup.text) return;

      line.translations = translations;
      io.to(roomName(meeting.id)).emit("transcript-line-translations", { lineId: line.id, translations });
    } catch (err) {
      // A bug here shouldn't be able to silently blackhole captions for the
      // rest of the meeting -- log it so it shows up in Render's logs
      // instead of just vanishing.
      console.error("Error procesando transcript-line:", err);
    }
  });

  socket.on("set-language", (payload: { language?: string }) => {
    if (!allowStateChange()) return;
    const meeting = currentMeetingId ? getMeeting(currentMeetingId) : undefined;
    if (!meeting) return;
    const participant = meeting.participants.get(socket.id);
    if (!participant) return;
    const language = String(payload?.language ?? "").trim();
    if (!language) return;
    participant.language = language;
    io.to(roomName(meeting.id)).emit("language-changed", {
      participantId: participant.id,
      language,
    });
  });

  socket.on("media-state", (payload: { muted?: boolean; cameraOff?: boolean }) => {
    if (!allowStateChange()) return;
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

  socket.on("screen-share", (payload: { sharing?: boolean }, ack) => {
    if (!allowStateChange()) return ack?.({ ok: false });
    const meeting = currentMeetingId ? getMeeting(currentMeetingId) : undefined;
    if (!meeting) return ack?.({ ok: false });
    const participant = meeting.participants.get(socket.id);
    if (!participant) return ack?.({ ok: false });
    const wantsToShare = Boolean(payload?.sharing);

    if (wantsToShare) {
      // Zoom rule: exactly ONE active presenter, enforced here (the client
      // disables its button too, but the server is the authority).
      if (meeting.presenterId && meeting.presenterId !== participant.id) {
        const current = meeting.participants.get(meeting.presenterId);
        socket.emit("share-denied", {
          reason: `${current?.name ?? "Otra persona"} ya está compartiendo su pantalla.`,
        });
        return ack?.({ ok: false, error: "Ya hay una pantalla compartida." });
      }
      if (meeting.settings.sharePolicy === "hosts" && participant.moderationRole === "participant") {
        socket.emit("share-denied", {
          reason: "El anfitrión limitó el compartir pantalla a los anfitriones.",
        });
        return ack?.({ ok: false, error: "Compartir pantalla está restringido." });
      }
      meeting.presenterId = participant.id;
      participant.sharingScreen = true;
      io.to(roomName(meeting.id)).emit("presenter-changed", {
        presenterId: participant.id,
        presenterName: participant.name,
      });
    } else if (participant.sharingScreen) {
      participant.sharingScreen = false;
      clearPresenterIf(io, meeting, participant.id);
    }

    io.to(roomName(meeting.id)).emit("screen-share", {
      participantId: participant.id,
      sharingScreen: participant.sharingScreen,
    });
    ack?.({ ok: true });
  });

  // Instant echo so the client can measure its own socket round trip.
  socket.on("quality-ping", (ack?: () => void) => {
    if (typeof ack === "function") ack();
  });

  // Self-reported socket round trip, mapped to a coarse tier shown in the
  // participants panel. Only broadcast when the tier actually changes.
  socket.on("connection-quality", (payload: { rtt?: number }) => {
    if (!allowStateChange()) return;
    const meeting = currentMeetingId ? getMeeting(currentMeetingId) : undefined;
    if (!meeting) return;
    const participant = meeting.participants.get(socket.id);
    if (!participant) return;
    const rtt = Number(payload?.rtt);
    if (!Number.isFinite(rtt) || rtt < 0) return;
    const quality = rtt < 150 ? "good" : rtt < 400 ? "fair" : "poor";
    if (participant.connectionQuality === quality) return;
    participant.connectionQuality = quality;
    io.to(roomName(meeting.id)).emit("connection-quality", {
      participantId: participant.id,
      quality,
    });
  });

  socket.on("raise-hand", (payload: { raised?: boolean }) => {
    if (!allowStateChange()) return;
    const meeting = currentMeetingId ? getMeeting(currentMeetingId) : undefined;
    if (!meeting) return;
    const participant = meeting.participants.get(socket.id);
    if (!participant) return;
    participant.handRaised = Boolean(payload?.raised);
    io.to(roomName(meeting.id)).emit("hand-raised", {
      participantId: participant.id,
      raised: participant.handRaised,
    });
  });


  // =========================================================================
  // Moderation: every Zoom-style host action arrives through this one event
  // and is authorized SERVER-SIDE. The client hiding a button is cosmetic --
  // a hand-crafted socket message from a participant gets rejected here.
  //
  //   host-only:            make-cohost, remove-cohost, transfer-host,
  //                         end-meeting
  //   host or co-host:      everything else (never against an equal or
  //                         higher rank -- see canModerate)
  // =========================================================================
  type ModerateAction =
    | "mute"
    | "mute-all"
    | "request-unmute"
    | "request-camera-on"
    | "request-camera-off"
    | "lower-hand"
    | "stop-share"
    | "kick"
    | "make-cohost"
    | "remove-cohost"
    | "transfer-host"
    | "end-meeting"
    | "admit"
    | "reject"
    | "set-lock"
    | "set-waiting-room"
    | "set-chat-mode"
    | "set-share-policy";

  const HOST_ONLY: ReadonlySet<ModerateAction> = new Set([
    "make-cohost",
    "remove-cohost",
    "transfer-host",
    "end-meeting",
  ]);

  socket.on(
    "moderate",
    (payload: { action?: ModerateAction; targetId?: string; value?: unknown }, ack) => {
      if (!allowModerate()) return ack?.({ ok: false, error: "Demasiadas acciones seguidas." });
      const meeting = currentMeetingId ? getMeeting(currentMeetingId) : undefined;
      if (!meeting) return ack?.({ ok: false, error: "Reunión no encontrada." });
      const actor = meeting.participants.get(socket.id);
      const action = payload?.action;
      if (!actor || !action) return ack?.({ ok: false, error: "Acción inválida." });

      if (actor.moderationRole === "participant") {
        return ack?.({ ok: false, error: "Solo el anfitrión puede hacer eso." });
      }
      if (HOST_ONLY.has(action) && actor.moderationRole !== "host") {
        return ack?.({ ok: false, error: "Solo el anfitrión principal puede hacer eso." });
      }

      const room = roomName(meeting.id);
      const targetId = typeof payload?.targetId === "string" ? payload.targetId : "";
      const target = meeting.participants.get(targetId);

      // Per-person actions need a valid target the actor outranks.
      const perPerson: ModerateAction[] = [
        "mute", "request-unmute", "request-camera-on", "request-camera-off",
        "lower-hand", "stop-share", "kick", "make-cohost", "remove-cohost", "transfer-host",
      ];
      if (perPerson.includes(action)) {
        if (!target) return ack?.({ ok: false, error: "Participante no encontrado." });
        // transfer/make-cohost target any participant below host rank; the
        // rest require strict rank superiority too (same check).
        if (!canModerate(meeting, actor.id, target.id)) {
          return ack?.({ ok: false, error: "No podés moderar a otro anfitrión." });
        }
      }

      switch (action) {
        case "mute": {
          target!.muted = true;
          io.to(room).emit("media-state", {
            participantId: target!.id,
            muted: true,
            cameraOff: target!.cameraOff,
          });
          io.to(target!.id).emit("force-muted", { by: actor.name });
          return ack?.({ ok: true });
        }
        case "mute-all": {
          for (const p of meeting.participants.values()) {
            if (p.moderationRole !== "participant" || p.muted) continue;
            p.muted = true;
            io.to(room).emit("media-state", { participantId: p.id, muted: true, cameraOff: p.cameraOff });
            io.to(p.id).emit("force-muted", { by: actor.name });
          }
          return ack?.({ ok: true });
        }
        case "request-unmute":
        case "request-camera-on":
        case "request-camera-off": {
          // The browser can't remote-control someone's devices (by design):
          // these send a polite prompt the person accepts or ignores.
          const kind = action.replace("request-", "") as "unmute" | "camera-on" | "camera-off";
          io.to(target!.id).emit("moderation-request", { kind, by: actor.name });
          return ack?.({ ok: true });
        }
        case "lower-hand": {
          target!.handRaised = false;
          io.to(room).emit("hand-raised", { participantId: target!.id, raised: false });
          return ack?.({ ok: true });
        }
        case "stop-share": {
          if (meeting.presenterId !== target!.id) return ack?.({ ok: false, error: "No está compartiendo." });
          target!.sharingScreen = false;
          clearPresenterIf(io, meeting, target!.id);
          io.to(room).emit("screen-share", { participantId: target!.id, sharingScreen: false });
          io.to(target!.id).emit("share-stopped-by-host", { by: actor.name });
          return ack?.({ ok: true });
        }
        case "kick": {
          // Guests have no durable identity, so the ban is by display name:
          // it stops the immediate "rejoin with the same name" case, which
          // is the realistic abuse here. (A determined person can rename --
          // a real account-level ban needs authenticated-only meetings.)
          meeting.bannedNames.add(normalizedName(target!.name));
          io.to(target!.id).emit("kicked", { by: actor.name });
          const departed = removeParticipant(meeting, target!.id);
          io.sockets.sockets.get(target!.id)?.leave(room);
          if (departed) {
            io.to(room).emit("participant-left", { participantId: departed.id });
            clearPresenterIf(io, meeting, departed.id);
            persistParticipants(meeting);
          }
          scheduleMeetingCleanupIfEmpty(meeting.id);
          return ack?.({ ok: true });
        }
        case "make-cohost": {
          target!.moderationRole = "cohost";
          io.to(room).emit("moderation-role", { participantId: target!.id, role: "cohost" });
          broadcastWaitingToHosts(io, meeting);
          return ack?.({ ok: true });
        }
        case "remove-cohost": {
          if (target!.moderationRole !== "cohost") return ack?.({ ok: false, error: "No es co-anfitrión." });
          target!.moderationRole = "participant";
          io.to(room).emit("moderation-role", { participantId: target!.id, role: "participant" });
          return ack?.({ ok: true });
        }
        case "transfer-host": {
          actor.isHost = false;
          actor.moderationRole = "cohost";
          target!.isHost = true;
          target!.moderationRole = "host";
          meeting.hostId = target!.id;
          meeting.pendingHostReclaim = null;
          io.to(room).emit("moderation-role", { participantId: actor.id, role: "cohost" });
          io.to(room).emit("moderation-role", { participantId: target!.id, role: "host" });
          io.to(room).emit("host-changed", { hostId: target!.id });
          persistParticipants(meeting);
          return ack?.({ ok: true });
        }
        case "end-meeting": {
          meeting.endedByHost = true;
          io.to(room).emit("meeting-ended", { by: actor.name });
          for (const p of meeting.participants.values()) {
            io.sockets.sockets.get(p.id)?.leave(room);
          }
          meeting.participants.clear();
          for (const w of meeting.waiting.values()) {
            io.to(w.id).emit("join-rejected", { reason: "La reunión terminó." });
          }
          meeting.waiting.clear();
          persistParticipants(meeting);
          scheduleMeetingCleanupIfEmpty(meeting.id);
          return ack?.({ ok: true });
        }
        case "admit": {
          const attendee = meeting.waiting.get(targetId);
          if (!attendee) return ack?.({ ok: false, error: "Ya no está esperando." });
          meeting.waiting.delete(targetId);
          const attendeeSocket = io.sockets.sockets.get(attendee.id);
          if (!attendeeSocket) {
            broadcastWaitingToHosts(io, meeting);
            return ack?.({ ok: false, error: "Esa persona ya se fue." });
          }
          const participant = addParticipant(meeting, attendee.id, attendee.name, attendee.language, false);
          attendeeSocket.join(room);
          attendeeSocket.to(room).emit("participant-joined", { participant });
          io.to(attendee.id).emit("admitted", { meeting: toSnapshot(meeting), selfId: attendee.id });
          persistParticipants(meeting);
          broadcastWaitingToHosts(io, meeting);
          return ack?.({ ok: true });
        }
        case "reject": {
          const attendee = meeting.waiting.get(targetId);
          if (!attendee) return ack?.({ ok: false, error: "Ya no está esperando." });
          meeting.waiting.delete(targetId);
          io.to(attendee.id).emit("join-rejected", { reason: "El anfitrión no te admitió en la reunión." });
          broadcastWaitingToHosts(io, meeting);
          return ack?.({ ok: true });
        }
        case "set-lock": {
          meeting.settings.locked = Boolean(payload?.value);
          broadcastSettings(io, meeting);
          return ack?.({ ok: true });
        }
        case "set-waiting-room": {
          meeting.settings.waitingRoomEnabled = Boolean(payload?.value);
          if (!meeting.settings.waitingRoomEnabled) {
            // Turning it off lets everyone currently waiting straight in.
            for (const attendee of Array.from(meeting.waiting.values())) {
              meeting.waiting.delete(attendee.id);
              const attendeeSocket = io.sockets.sockets.get(attendee.id);
              if (!attendeeSocket) continue;
              const participant = addParticipant(meeting, attendee.id, attendee.name, attendee.language, false);
              attendeeSocket.join(room);
              attendeeSocket.to(room).emit("participant-joined", { participant });
              io.to(attendee.id).emit("admitted", { meeting: toSnapshot(meeting), selfId: attendee.id });
            }
            persistParticipants(meeting);
          }
          broadcastSettings(io, meeting);
          broadcastWaitingToHosts(io, meeting);
          return ack?.({ ok: true });
        }
        case "set-chat-mode": {
          const value = payload?.value;
          if (value !== "everyone" && value !== "hosts" && value !== "off") {
            return ack?.({ ok: false, error: "Modo de chat inválido." });
          }
          meeting.settings.chatMode = value as ChatMode;
          broadcastSettings(io, meeting);
          return ack?.({ ok: true });
        }
        case "set-share-policy": {
          const value = payload?.value;
          if (value !== "everyone" && value !== "hosts") {
            return ack?.({ ok: false, error: "Política inválida." });
          }
          meeting.settings.sharePolicy = value as SharePolicy;
          // If a participant is presenting and sharing becomes hosts-only,
          // their share ends now (Zoom does the same).
          if (value === "hosts" && meeting.presenterId) {
            const presenter = meeting.participants.get(meeting.presenterId);
            if (presenter && presenter.moderationRole === "participant") {
              presenter.sharingScreen = false;
              clearPresenterIf(io, meeting, presenter.id);
              io.to(room).emit("screen-share", { participantId: presenter.id, sharingScreen: false });
              io.to(presenter.id).emit("share-stopped-by-host", { by: actor.name });
            }
          }
          broadcastSettings(io, meeting);
          return ack?.({ ok: true });
        }
        default:
          return ack?.({ ok: false, error: "Acción desconocida." });
      }
    }
  );

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

    // Someone who was still in the waiting room just left/gave up.
    if (meeting.waiting.delete(socket.id)) {
      broadcastWaitingToHosts(io, meeting);
    }

    const departed = removeParticipant(meeting, socket.id);
    if (!departed) return;
    clearPresenterIf(io, meeting, departed.id);

    socket.leave(roomName(meeting.id));
    io.to(roomName(meeting.id)).emit("participant-left", { participantId: departed.id });

    if (departed.isHost && meeting.participants.size > 0) {
      // Same object reference lives on in `historicalParticipants` -- clear
      // this explicitly so a departed host doesn't keep showing as host
      // (alongside whoever gets promoted next) in the persisted roster.
      departed.isHost = false;
      meeting.pendingHostReclaim = {
        participantId: departed.id,
        expiresAt: Date.now() + HOST_RECLAIM_WINDOW_MS,
      };
      const promoted = promoteNextHost(meeting);
      if (promoted) {
        io.to(roomName(meeting.id)).emit("host-changed", { hostId: promoted.id });
      }
    }

    persistParticipants(meeting);
    scheduleMeetingCleanupIfEmpty(meeting.id);
  }
}
