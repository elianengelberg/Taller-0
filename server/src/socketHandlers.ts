import { Server, Socket } from "socket.io";
import { verifyToken } from "./auth";
import * as db from "./db";
import {
  addChatMessage,
  addParticipant,
  addRole,
  addTranscriptLine,
  cancelMeetingCleanup,
  createMeeting,
  getMeeting,
  getOrCreateCompanionMeeting,
  promoteNextHost,
  removeParticipant,
  scheduleMeetingCleanupIfEmpty,
} from "./meetingStore";
import { cleanTranscriptFragment, translateFragmentToAll } from "./transcriptCleanup";
import { shortLang, translateText } from "./translate";
import { Meeting, toSnapshot, TranscriptLine } from "./types";

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
// Native meetings run a WebRTC mesh (everyone connects to everyone), which
// degrades sharply past ~a dozen people -- each participant uploads their
// video N-1 times. Cap it with a clear message instead of letting meeting
// quality quietly collapse. Companion rooms carry no media (the external
// platform does), so their cap is only an anti-abuse sanity bound.
const MAX_PARTICIPANTS_NATIVE = 12;
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
  // Tracks the most recently finalized transcript line from THIS socket, so
  // a fast follow-up fragment can be merged into it instead of appearing as
  // its own separate, easy-to-miss caption.
  let recentUtterance: { lineId: string; dbMessageId: number | null; finalizedAt: number } | null = null;

  socket.on(
    "create-meeting",
    (payload: { hostName: string; hostLanguage: string; roles: string[]; token?: string }, ack) => {
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
        addParticipant(meeting, socket.id, hostName, hostLanguage, true);

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
    (
      payload: { meetingId: string; name: string; language: string; resumeParticipantId?: string },
      ack
    ) => {
      try {
        const meetingId = String(payload?.meetingId ?? "").trim().toUpperCase();
        const name = String(payload?.name ?? "").slice(0, MAX_NAME_LENGTH).trim();
        const language = String(payload?.language ?? "es-AR");
        const resumeParticipantId =
          typeof payload?.resumeParticipantId === "string" ? payload.resumeParticipantId : null;

        const meeting = getMeeting(meetingId);
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

        cancelMeetingCleanup(meeting.id);
        // If everyone had left (meeting was just sitting in its grace
        // period) the next person in gets to be host again, otherwise
        // role assignment would be permanently stuck with no host.
        const becomesHost = meeting.participants.size === 0;
        const participant = addParticipant(meeting, socket.id, name, language, becomesHost);
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
          if (currentHost) currentHost.isHost = false;
          participant.isHost = true;
          meeting.hostId = participant.id;
          meeting.pendingHostReclaim = null;
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

  // Join the Encuentro "companion" layer that rides on top of an external
  // meeting (Jitsi/Zoom/Meet). The external platform handles audio/video; this
  // just puts the caller into a shared room -- keyed by the external meeting --
  // where our transcript/translation/AI layer lives. From here on it's an
  // ordinary participant, so transcript-line/chat/set-language/disconnect all
  // reuse the exact same handlers as a native meeting.
  socket.on(
    "join-companion",
    (payload: { externalKey: string; name: string; language: string; token?: string }, ack) => {
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
          ack?.({ ok: false, error: "La sala de Encuentro para esta reunión está llena." });
          return;
        }
        cancelMeetingCleanup(meeting.id);
        // No host semantics here -- an external meeting has its own host on the
        // other platform; the companion layer is a flat group of note-takers.
        const participant = addParticipant(meeting, socket.id, name, language, false);
        currentMeetingId = meeting.id;
        socket.join(roomName(meeting.id));

        if (created) {
          // The first (logged-in) person to open this external meeting through
          // Encuentro owns its companion record, so it lands in their history.
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
    try {
      if (!allowTranscript()) return;
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
      const recentContext = baseTranscript.slice(-4).map((l) => `${l.speakerName}: ${l.text}`);
      const effectiveAlternatives = mergeTarget
        ? alternatives.map((a) => `${mergeTarget.text} ${a}`.trim())
        : alternatives;

      // What we *assume* the speaker is using, from their configured
      // language -- usually right, but someone can speak a different
      // language than they configured (switched languages, forgot to
      // change the setting, or is just being tested with foreign audio).
      const assumedSourceLang = payload?.lang || speaker.language;

      // Kick off the original-language cleanup AND a single combined
      // translate-to-every-*assumed*-target-language call at the same time,
      // instead of translating only after cleanup finishes -- they're
      // independent Claude calls working from the same raw alternatives, so
      // running them in parallel instead of back-to-back roughly halves the
      // time before a translated caption shows up. This is "optimistic"
      // because it's built on `assumedSourceLang`; if cleanup later detects
      // the speaker was actually using a different language, one corrective
      // call fills the gap below instead of redoing everything.
      // Deduped to short codes: someone on "en-US" and someone on "en-GB"
      // both just need "en" -- asking for the same translation twice would
      // waste a chunk of the batched call for no benefit.
      const optimisticTargetLangs = new Set<string>();
      for (const p of meeting.participants.values()) {
        if (shortLang(p.language) !== shortLang(assumedSourceLang)) optimisticTargetLangs.add(shortLang(p.language));
      }
      const cleanupPromise = cleanTranscriptFragment(effectiveAlternatives, recentContext, assumedSourceLang);
      const optimisticTranslationsPromise = translateFragmentToAll(
        effectiveAlternatives,
        recentContext,
        Array.from(optimisticTargetLangs),
        assumedSourceLang
      );

      const cleanup = await cleanupPromise;
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
        void db
          .recordMessage({
            meetingId: meeting.dbId,
            kind: "transcript",
            senderName: speaker.name,
            roleName: roleNameFor(meeting, speaker.roleId),
            text: line.text,
            sourceLang: line.sourceLang,
          })
          .then((dbMessageId) => {
            // Only update if this is still the line we think it is -- a
            // merge could have already moved recentUtterance on by the time
            // this insert resolves.
            if (recentUtterance && recentUtterance.lineId === line.id) {
              recentUtterance.dbMessageId = dbMessageId;
            }
          });
      }
      io.to(roomName(meeting.id)).emit("transcript-line", { line });

      // If the speaker turned out to be using a different language than
      // assumed, the group we skipped translating for (because we thought
      // they shared the speaker's language) actually needs a translation
      // too -- fetch that one now instead of leaving them with an untranslated
      // caption in a language they don't understand. Unlike the optimistic
      // batch above, this can translate straight from `cleanup.text` (already
      // corrected, no ASR disambiguation needed) via the plain translator,
      // which is simpler and shares its own cache with chat/REST translation.
      const correctivePromise: Promise<readonly [string, string] | null> = mismatch
        ? translateText(cleanup.text, sourceLang, assumedSourceLang)
            .then((translated) => [shortLang(assumedSourceLang), translated] as const)
            .catch(() => null)
        : Promise.resolve(null);

      const [optimisticTranslations, correctiveEntry] = await Promise.all([
        optimisticTranslationsPromise,
        correctivePromise,
      ]);

      const translations: Record<string, string> = { ...optimisticTranslations };
      if (correctiveEntry) {
        const [lang, translated] = correctiveEntry;
        if (translated) translations[lang] = translated;
      }
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

  socket.on("raise-hand", (payload: { raised?: boolean }) => {
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
