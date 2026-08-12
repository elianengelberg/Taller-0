import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { getAuthToken } from "../lib/authToken";
import { explainError } from "../lib/explainError";
import { getSocket, SERVER_URL } from "../lib/socket";
import {
  ChatMessage,
  CompanionEmbed,
  ConnectionStatus,
  MeetBridgeState,
  MeetingDraft,
  MeetingSettings,
  MeetingSnapshot,
  ModerationRole,
  Participant,
  Role,
  TranscriptLine,
  WaitingAttendee,
} from "../types";

type MeetingAction =
  | { type: "SNAPSHOT_LOADED"; meeting: MeetingSnapshot }
  | { type: "PARTICIPANT_JOINED"; participant: Participant }
  | { type: "PARTICIPANT_LEFT"; participantId: string }
  | { type: "ROLE_ADDED"; role: Role }
  | { type: "ROLE_ASSIGNED"; participantId: string; roleId: string | null }
  | { type: "CHAT_MESSAGE"; message: ChatMessage }
  | { type: "TRANSCRIPT_LINE"; line: TranscriptLine }
  | { type: "TRANSCRIPT_LINE_TRANSLATIONS"; lineId: string; translations: Record<string, string> }
  | { type: "MEDIA_STATE"; participantId: string; muted: boolean; cameraOff: boolean }
  | { type: "SCREEN_SHARE"; participantId: string; sharingScreen: boolean }
  | { type: "HAND_RAISED"; participantId: string; raised: boolean }
  | { type: "LANGUAGE_CHANGED"; participantId: string; language: string }
  | { type: "HOST_CHANGED"; hostId: string }
  | { type: "SETTINGS_CHANGED"; settings: MeetingSettings }
  | { type: "MODERATION_ROLE"; participantId: string; role: ModerationRole }
  | { type: "PRESENTER_CHANGED"; presenterId: string | null }
  | { type: "CONNECTION_QUALITY"; participantId: string; quality: "good" | "fair" | "poor" }
  | { type: "RESET" };

function meetingReducer(state: MeetingSnapshot | null, action: MeetingAction): MeetingSnapshot | null {
  if (action.type === "SNAPSHOT_LOADED") return action.meeting;
  if (action.type === "RESET") return null;
  if (!state) return state;

  switch (action.type) {
    case "PARTICIPANT_JOINED":
      if (state.participants.some((p) => p.id === action.participant.id)) return state;
      return { ...state, participants: [...state.participants, action.participant] };
    case "PARTICIPANT_LEFT":
      return {
        ...state,
        participants: state.participants.filter((p) => p.id !== action.participantId),
      };
    case "ROLE_ADDED":
      return { ...state, roles: [...state.roles, action.role] };
    case "ROLE_ASSIGNED":
      return {
        ...state,
        participants: state.participants.map((p) =>
          p.id === action.participantId ? { ...p, roleId: action.roleId } : p
        ),
      };
    case "CHAT_MESSAGE":
      return { ...state, chat: [...state.chat, action.message] };
    case "TRANSCRIPT_LINE": {
      // The server folds a fast follow-up fragment into the previous line
      // (same id) instead of appending a choppy new one when someone's
      // speech gets split into several "final" results in quick succession
      // -- replace it in place rather than showing both.
      const existingIndex = state.transcript.findIndex((l) => l.id === action.line.id);
      if (existingIndex === -1) {
        return { ...state, transcript: [...state.transcript, action.line] };
      }
      const transcript = state.transcript.slice();
      transcript[existingIndex] = action.line;
      return { ...state, transcript };
    }
    case "TRANSCRIPT_LINE_TRANSLATIONS":
      return {
        ...state,
        transcript: state.transcript.map((l) =>
          l.id === action.lineId
            ? { ...l, translations: { ...l.translations, ...action.translations } }
            : l
        ),
      };
    case "MEDIA_STATE":
      return {
        ...state,
        participants: state.participants.map((p) =>
          p.id === action.participantId
            ? { ...p, muted: action.muted, cameraOff: action.cameraOff }
            : p
        ),
      };
    case "SCREEN_SHARE":
      return {
        ...state,
        participants: state.participants.map((p) =>
          p.id === action.participantId ? { ...p, sharingScreen: action.sharingScreen } : p
        ),
      };
    case "HAND_RAISED":
      return {
        ...state,
        participants: state.participants.map((p) =>
          p.id === action.participantId ? { ...p, handRaised: action.raised } : p
        ),
      };
    case "LANGUAGE_CHANGED":
      return {
        ...state,
        participants: state.participants.map((p) =>
          p.id === action.participantId ? { ...p, language: action.language } : p
        ),
      };
    case "HOST_CHANGED":
      return {
        ...state,
        hostId: action.hostId,
        participants: state.participants.map((p) => ({
          ...p,
          isHost: p.id === action.hostId,
        })),
      };
    case "SETTINGS_CHANGED":
      return { ...state, settings: action.settings };
    case "MODERATION_ROLE":
      return {
        ...state,
        participants: state.participants.map((p) =>
          p.id === action.participantId
            ? { ...p, moderationRole: action.role, isHost: action.role === "host" }
            : p
        ),
      };
    case "PRESENTER_CHANGED":
      return { ...state, presenterId: action.presenterId };
    case "CONNECTION_QUALITY":
      return {
        ...state,
        participants: state.participants.map((p) =>
          p.id === action.participantId ? { ...p, connectionQuality: action.quality } : p
        ),
      };
    default:
      return state;
  }
}

interface MeetingContextValue {
  draft: MeetingDraft | null;
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  selfId: string | null;
  meeting: MeetingSnapshot | null;
  self: Participant | null;
  isHost: boolean;
  hostParticipant: Participant | null;
  startHostDraft: (info: { name: string; language: string; roleNames: string[] }) => void;
  startJoinDraft: (info: { name: string; language: string; meetingCode: string }) => void;
  startCompanionDraft: (info: {
    name: string;
    language: string;
    externalKey: string;
    roomLabel: string;
    embed: CompanionEmbed;
  }) => void;
  clearDraft: () => void;
  // Wakes the backend (Render can cold-start ~tens of seconds) and opens the
  // socket ahead of time, while the user is still filling in the join/create
  // form, so actually entering the meeting is near-instant.
  prewarm: () => void;
  connect: () => void;
  sendChatMessage: (text: string) => void;
  assignRole: (participantId: string, roleId: string | null) => void;
  addRole: (name: string) => Promise<Role | null>;
  sendTranscriptLine: (alternatives: string[], lang: string) => void;
  setMediaState: (muted: boolean, cameraOff: boolean) => void;
  setSharingScreen: (sharing: boolean) => void;
  setHandRaised: (raised: boolean) => void;
  setSelfLanguage: (language: string) => void;
  leaveMeeting: () => void;
  // People held in the waiting room (host/co-host view only).
  waitingList: WaitingAttendee[];
  // Live state of the linked external Google Meet (companion sessions with
  // the Unify extension installed); null until the first report arrives.
  meetState: MeetBridgeState | null;
  // Runs a Zoom-style host action, authorized server-side. Resolves with the
  // server's verdict so the UI can surface a denial.
  moderate: (
    action: string,
    targetId?: string,
    value?: unknown
  ) => Promise<{ ok: boolean; error?: string }>;
}

const MeetingContext = createContext<MeetingContextValue | null>(null);

export function MeetingProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<MeetingDraft | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [meeting, dispatch] = useReducer(meetingReducer, null);
  const [waitingList, setWaitingList] = useState<WaitingAttendee[]>([]);
  const [meetState, setMeetState] = useState<MeetBridgeState | null>(null);
  const socketRef = useRef(getSocket());

  // Mirrors of the latest state for the "connect" handler below, which is
  // registered once ([] deps) and would otherwise only ever see the values
  // from the very first render.
  const selfIdRef = useRef(selfId);
  selfIdRef.current = selfId;
  const meetingRef = useRef(meeting);
  meetingRef.current = meeting;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Lo que se dijo mientras la conexión estaba caída, esperando a que el
  // servidor vuelva a tenernos DENTRO de la reunión.
  //
  // Por qué hace falta: socket.io ya guarda solo lo que se emite desconectado y
  // lo manda al reconectar, pero lo manda ANTES de que corra nuestro listener
  // de "connect" -- o sea, antes del join-companion que nos vuelve a meter en
  // la sala. El servidor recibe esas líneas de un socket que todavía no está
  // en ninguna reunión y las descarta (socketHandlers: `if (!meeting) return`).
  // Resultado: cada corte de red se comía lo que se dijo justo ahí. Con esta
  // cola, las líneas esperan al ack del rejoin y recién entonces salen.
  // La cola guarda EVENTOS (lo que se dijo, lo que se escribió): cada uno es un
  // hecho que tiene que llegar, y en orden.
  const outboxRef = useRef<{ event: string; payload: unknown }[]>([]);
  const joinedRef = useRef(false);

  // El ESTADO es otra cosa y necesita otro trato. Al reconectar, el servidor
  // vuelve a crear al participante con los valores de fábrica
  // (`muted: false`, `handRaised: false`...), y el cliente nunca se los volvía
  // a mandar: quien se cayó estando silenciado volvía y todos lo veían con el
  // micrófono abierto. Encolar cada cambio no sirve -- diez toques de mute no
  // son diez hechos, es un solo estado -- así que se guarda el último y se
  // reenvía entero después del rejoin.
  const localStateRef = useRef({
    muted: false,
    cameraOff: false,
    sharingScreen: false,
    handRaised: false,
    language: "",
  });

  const flushOutbox = useCallback(() => {
    const socket = socketRef.current;
    if (!joinedRef.current || !socket.connected) return;

    // Primero el estado, para que lo que salga de la cola aparezca junto a la
    // presencia correcta y no un instante después.
    const st = localStateRef.current;
    socket.emit("media-state", { muted: st.muted, cameraOff: st.cameraOff });
    if (st.handRaised) socket.emit("raise-hand", { raised: true });
    if (st.sharingScreen) socket.emit("screen-share", { sharing: true });
    if (st.language) socket.emit("set-language", { language: st.language });

    const pending = outboxRef.current;
    outboxRef.current = [];
    for (const item of pending) socket.emit(item.event, item.payload);
  }, []);

  // Encola cuando no estamos adentro de la sala; si no, sale al instante.
  const emitOrQueue = useCallback((event: string, payload: unknown) => {
    const socket = socketRef.current;
    if (!joinedRef.current || !socket.connected) {
      outboxRef.current.push({ event, payload });
      // Tope para que una desconexión larga no crezca sin límite en memoria;
      // se conserva lo más reciente, que es lo que se sigue hablando.
      if (outboxRef.current.length > 200) outboxRef.current.shift();
      return;
    }
    socket.emit(event, payload);
  }, []);

  // Wake the backend as soon as the app loads (Render's free tier sleeps and
  // can take tens of seconds to come back). Doing it here -- not when the user
  // finally clicks "join" -- means the server is usually already awake by then.
  useEffect(() => {
    fetch(`${SERVER_URL}/health`).catch(() => {});
  }, []);

  useEffect(() => {
    const socket = socketRef.current;

    // The socket is configured to auto-reconnect after a dropped connection
    // (flaky wifi, backgrounded tab, network switch). Each reconnect gets a
    // brand new socket id server-side, so our old participant record there
    // is gone -- without this, the UI still says "connected" but silently
    // stops receiving anything (chat, transcript, everyone else's state)
    // because we're no longer in the meeting's room. `selfIdRef` being set
    // is what tells us this "connect" is a *re*connect, not the first one
    // (the very first connect always happens before selfId is set).
    socket.on("connect", () => {
      const draft = draftRef.current;
      if (!selfIdRef.current || !meetingRef.current || !draft) return;
      const onRejoin = (res: { ok: boolean; meeting?: MeetingSnapshot; selfId?: string; error?: string }) => {
        if (res.ok && res.meeting && res.selfId) {
          setSelfId(res.selfId);
          dispatch({ type: "SNAPSHOT_LOADED", meeting: res.meeting });
          setConnectionStatus("connected");
          // Recién ahora el servidor nos tiene otra vez adentro de la sala:
          // lo que se dijo durante el corte puede salir sin que lo descarte.
          joinedRef.current = true;
          flushOutbox();
        } else {
          setConnectionStatus("error");
          setConnectionError(res.error ?? "Se perdió la conexión con la reunión.");
        }
      };
      // A companion session rejoins by its external-room key; a native meeting
      // rejoins by its code (and reclaims host if it had it).
      if (draft.mode === "companion") {
        socket.emit(
          "join-companion",
          { externalKey: draft.externalKey, name: draft.name, language: draft.language, token: getAuthToken() },
          onRejoin
        );
        return;
      }
      socket.emit(
        "join-meeting",
        // `resumeParticipantId` is our old socket id (from before the drop) --
        // it tells the server this is the same person resuming, so it can
        // hand host status back if we were host when we got disconnected. The
        // token (if logged in) lets us reach the meeting's transcript/AI.
        { meetingId: meetingRef.current.id, name: draft.name, language: draft.language, resumeParticipantId: selfIdRef.current, token: getAuthToken() },
        onRejoin
      );
    });

    socket.on("participant-joined", ({ participant }: { participant: Participant }) => {
      dispatch({ type: "PARTICIPANT_JOINED", participant });
    });
    socket.on("participant-left", ({ participantId }: { participantId: string }) => {
      dispatch({ type: "PARTICIPANT_LEFT", participantId });
    });
    socket.on("role-added", ({ role }: { role: Role }) => {
      dispatch({ type: "ROLE_ADDED", role });
    });
    socket.on(
      "role-assigned",
      ({ participantId, roleId }: { participantId: string; roleId: string | null }) => {
        dispatch({ type: "ROLE_ASSIGNED", participantId, roleId });
      }
    );
    socket.on("chat-message", ({ message }: { message: ChatMessage }) => {
      dispatch({ type: "CHAT_MESSAGE", message });
    });
    socket.on("transcript-line", ({ line }: { line: TranscriptLine }) => {
      dispatch({ type: "TRANSCRIPT_LINE", line });
    });
    socket.on(
      "transcript-line-translations",
      (payload: { lineId: string; translations: Record<string, string> }) => {
        dispatch({ type: "TRANSCRIPT_LINE_TRANSLATIONS", ...payload });
      }
    );
    socket.on(
      "media-state",
      (payload: { participantId: string; muted: boolean; cameraOff: boolean }) => {
        dispatch({ type: "MEDIA_STATE", ...payload });
      }
    );
    socket.on(
      "screen-share",
      (payload: { participantId: string; sharingScreen: boolean }) => {
        dispatch({ type: "SCREEN_SHARE", ...payload });
      }
    );
    socket.on(
      "hand-raised",
      (payload: { participantId: string; raised: boolean }) => {
        dispatch({ type: "HAND_RAISED", ...payload });
      }
    );
    socket.on(
      "language-changed",
      (payload: { participantId: string; language: string }) => {
        dispatch({ type: "LANGUAGE_CHANGED", ...payload });
      }
    );
    socket.on("host-changed", ({ hostId }: { hostId: string }) => {
      dispatch({ type: "HOST_CHANGED", hostId });
    });
    socket.on("meeting-settings", ({ settings }: { settings: MeetingSettings }) => {
      dispatch({ type: "SETTINGS_CHANGED", settings });
    });
    socket.on(
      "moderation-role",
      ({ participantId, role }: { participantId: string; role: ModerationRole }) => {
        dispatch({ type: "MODERATION_ROLE", participantId, role });
      }
    );
    socket.on(
      "presenter-changed",
      ({ presenterId }: { presenterId: string | null }) => {
        dispatch({ type: "PRESENTER_CHANGED", presenterId });
      }
    );
    socket.on(
      "connection-quality",
      (payload: { participantId: string; quality: "good" | "fair" | "poor" }) => {
        dispatch({ type: "CONNECTION_QUALITY", ...payload });
      }
    );
    socket.on("waiting-updated", ({ waiting }: { waiting: WaitingAttendee[] }) => {
      setWaitingList(waiting ?? []);
    });
    // Waiting-room resolution for OUR pending join.
    socket.on("admitted", (payload: { meeting: MeetingSnapshot; selfId: string }) => {
      setSelfId(payload.selfId);
      dispatch({ type: "SNAPSHOT_LOADED", meeting: payload.meeting });
      setConnectionStatus("connected");
      joinedRef.current = true;
      flushOutbox();
    });
    socket.on("join-rejected", ({ reason }: { reason?: string }) => {
      setConnectionStatus("error");
      setConnectionError(reason ?? "El anfitrión no te admitió en la reunión.");
    });
    socket.on("meet-state", (state: MeetBridgeState) => {
      setMeetState(state);
    });
    // Mientras estemos afuera, lo que se hable se encola en vez de perderse.
    socket.on("disconnect", () => {
      joinedRef.current = false;
    });

    socket.on("connect_error", (err: Error) => {
      // Don't get stuck on "error" mid-reconnect after we already had a
      // working session -- the socket keeps retrying on its own and the
      // "connect" handler above rejoins automatically once it succeeds.
      if (selfIdRef.current) return;
      setConnectionStatus("error");
      const fallback = "No se pudo conectar con el servidor de reuniones.";
      setConnectionError(fallback);
      const raw = err?.message;
      if (raw) {
        void explainError(raw, "Fallo al conectar por WebSocket con el servidor de la reunión.").then(
          (explanation) => setConnectionError(explanation)
        );
      }
    });

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("participant-joined");
      socket.off("participant-left");
      socket.off("role-added");
      socket.off("role-assigned");
      socket.off("chat-message");
      socket.off("transcript-line");
      socket.off("transcript-line-translations");
      socket.off("media-state");
      socket.off("screen-share");
      socket.off("hand-raised");
      socket.off("language-changed");
      socket.off("host-changed");
      socket.off("meeting-settings");
      socket.off("moderation-role");
      socket.off("presenter-changed");
      socket.off("connection-quality");
      socket.off("waiting-updated");
      socket.off("admitted");
      socket.off("join-rejected");
      socket.off("meet-state");
      socket.off("connect_error");
    };
  }, []);

  const startHostDraft = useCallback(
    (info: { name: string; language: string; roleNames: string[] }) => {
      setDraft({ mode: "host", ...info });
    },
    []
  );

  const startJoinDraft = useCallback(
    (info: { name: string; language: string; meetingCode: string }) => {
      setDraft({ mode: "join", ...info });
    },
    []
  );

  const startCompanionDraft = useCallback(
    (info: {
      name: string;
      language: string;
      externalKey: string;
      roomLabel: string;
      embed: CompanionEmbed;
    }) => {
      setDraft({ mode: "companion", ...info });
    },
    []
  );

  const clearDraft = useCallback(() => setDraft(null), []);

  const prewarm = useCallback(() => {
    // Wake a possibly-sleeping backend right away (fire-and-forget) and start
    // the socket handshake now, so it's already connected by the time the
    // user submits the form -- no cold-start wait on the "Conectando" screen.
    fetch(`${SERVER_URL}/health`).catch(() => {});
    const socket = socketRef.current;
    if (!socket.connected) socket.connect();
  }, []);

  const connect = useCallback(() => {
    if (!draft) return;
    const socket = socketRef.current;
    setConnectionStatus("connecting");
    setConnectionError(null);
    if (!socket.connected) socket.connect();

    const onResult = (fallbackError: string) =>
      (res: { ok: boolean; waiting?: boolean; meeting?: MeetingSnapshot; selfId?: string; error?: string }) => {
        if (res.ok && res.waiting) {
          // Held at the waiting room -- resolution arrives later as an
          // "admitted" or "join-rejected" event.
          setConnectionStatus("waiting");
          return;
        }
        if (res.ok && res.meeting && res.selfId) {
          setSelfId(res.selfId);
          dispatch({ type: "SNAPSHOT_LOADED", meeting: res.meeting });
          setConnectionStatus("connected");
          joinedRef.current = true;
          flushOutbox();
        } else {
          setConnectionStatus("error");
          setConnectionError(res.error ?? fallbackError);
        }
      };

    if (draft.mode === "host") {
      socket.emit(
        "create-meeting",
        // token (if logged in) ties this meeting to the account so it shows up
        // in that person's private history.
        { hostName: draft.name, hostLanguage: draft.language, roles: draft.roleNames, token: getAuthToken() },
        onResult("No se pudo crear la reunión.")
      );
    } else if (draft.mode === "companion") {
      socket.emit(
        "join-companion",
        { externalKey: draft.externalKey, name: draft.name, language: draft.language, token: getAuthToken() },
        onResult("No se pudo unir a la reunión externa.")
      );
    } else {
      socket.emit(
        "join-meeting",
        { meetingId: draft.meetingCode, name: draft.name, language: draft.language, token: getAuthToken() },
        onResult("No se pudo unir a la reunión.")
      );
    }
  }, [draft, flushOutbox]);

  const sendChatMessage = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      // Igual que la transcripción: durante una reconexión el servidor
      // responde "Reunión no encontrada" y el mensaje se perdía en silencio.
      emitOrQueue("chat-message", { text });
    },
    [emitOrQueue]
  );

  const assignRole = useCallback((participantId: string, roleId: string | null) => {
    socketRef.current.emit("assign-role", { participantId, roleId });
  }, []);

  const addRole = useCallback((name: string): Promise<Role | null> => {
    return new Promise((resolve) => {
      socketRef.current.emit(
        "add-role",
        { name },
        (res: { ok: boolean; role?: Role; error?: string }) => {
          resolve(res.ok && res.role ? res.role : null);
        }
      );
    });
  }, []);

  const sendTranscriptLine = useCallback(
    (alternatives: string[], lang: string) => {
      const cleaned = alternatives.filter((a) => a.trim());
      if (cleaned.length === 0) return;
      emitOrQueue("transcript-line", { alternatives: cleaned, lang });
    },
    [emitOrQueue]
  );

  // Estos cuatro guardan el último valor además de emitirlo: al reconectar, el
  // servidor recrea al participante con los valores de fábrica y flushOutbox lo
  // vuelve a poner como estaba. Sin esto, quien se caía silenciado volvía y
  // todos lo veían con el micrófono abierto.
  const setMediaState = useCallback((muted: boolean, cameraOff: boolean) => {
    localStateRef.current.muted = muted;
    localStateRef.current.cameraOff = cameraOff;
    if (joinedRef.current) socketRef.current.emit("media-state", { muted, cameraOff });
  }, []);

  const setSharingScreen = useCallback((sharing: boolean) => {
    localStateRef.current.sharingScreen = sharing;
    if (joinedRef.current) socketRef.current.emit("screen-share", { sharing });
  }, []);

  const setHandRaised = useCallback((raised: boolean) => {
    localStateRef.current.handRaised = raised;
    if (joinedRef.current) socketRef.current.emit("raise-hand", { raised });
  }, []);

  const setSelfLanguage = useCallback((language: string) => {
    localStateRef.current.language = language;
    if (joinedRef.current) socketRef.current.emit("set-language", { language });
  }, []);

  const moderate = useCallback(
    (action: string, targetId?: string, value?: unknown): Promise<{ ok: boolean; error?: string }> => {
      return new Promise((resolve) => {
        socketRef.current.emit(
          "moderate",
          { action, targetId, value },
          (res: { ok: boolean; error?: string } | undefined) => {
            resolve(res ?? { ok: false, error: "Sin respuesta del servidor." });
          }
        );
      });
    },
    []
  );

  const leaveMeeting = useCallback(() => {
    const socket = socketRef.current;
    joinedRef.current = false;
    outboxRef.current = [];
    localStateRef.current = {
      muted: false,
      cameraOff: false,
      sharingScreen: false,
      handRaised: false,
      language: "",
    };
    socket.emit("leave-meeting");
    socket.disconnect();
    dispatch({ type: "RESET" });
    setSelfId(null);
    setConnectionStatus("idle");
    setConnectionError(null);
    setDraft(null);
    setWaitingList([]);
    setMeetState(null);
  }, []);

  const self = useMemo(
    () => meeting?.participants.find((p) => p.id === selfId) ?? null,
    [meeting, selfId]
  );
  const isHost = !!self?.isHost;
  const hostParticipant = useMemo(
    () => meeting?.participants.find((p) => p.id === meeting.hostId) ?? null,
    [meeting]
  );

  const value: MeetingContextValue = {
    draft,
    connectionStatus,
    connectionError,
    selfId,
    meeting,
    self,
    isHost,
    hostParticipant,
    startHostDraft,
    startJoinDraft,
    startCompanionDraft,
    clearDraft,
    prewarm,
    connect,
    sendChatMessage,
    assignRole,
    addRole,
    sendTranscriptLine,
    setMediaState,
    setSharingScreen,
    setHandRaised,
    setSelfLanguage,
    leaveMeeting,
    waitingList,
    meetState,
    moderate,
  };

  return <MeetingContext.Provider value={value}>{children}</MeetingContext.Provider>;
}

export function useMeeting(): MeetingContextValue {
  const ctx = useContext(MeetingContext);
  if (!ctx) throw new Error("useMeeting debe usarse dentro de MeetingProvider");
  return ctx;
}
