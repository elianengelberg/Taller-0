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
import { getSocket } from "../lib/socket";
import {
  ChatMessage,
  ConnectionStatus,
  MeetingDraft,
  MeetingSnapshot,
  Participant,
  Role,
  TranscriptLine,
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
  | { type: "HOST_CHANGED"; hostId: string }
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
    case "TRANSCRIPT_LINE":
      return { ...state, transcript: [...state.transcript, action.line] };
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
    case "HOST_CHANGED":
      return {
        ...state,
        hostId: action.hostId,
        participants: state.participants.map((p) => ({
          ...p,
          isHost: p.id === action.hostId,
        })),
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
  clearDraft: () => void;
  connect: () => void;
  sendChatMessage: (text: string) => void;
  assignRole: (participantId: string, roleId: string | null) => void;
  addRole: (name: string) => Promise<Role | null>;
  sendTranscriptLine: (alternatives: string[], lang: string) => void;
  setMediaState: (muted: boolean, cameraOff: boolean) => void;
  setSharingScreen: (sharing: boolean) => void;
  leaveMeeting: () => void;
}

const MeetingContext = createContext<MeetingContextValue | null>(null);

export function MeetingProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<MeetingDraft | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [meeting, dispatch] = useReducer(meetingReducer, null);
  const socketRef = useRef(getSocket());

  useEffect(() => {
    const socket = socketRef.current;

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
    socket.on("host-changed", ({ hostId }: { hostId: string }) => {
      dispatch({ type: "HOST_CHANGED", hostId });
    });
    socket.on("connect_error", () => {
      setConnectionStatus("error");
      setConnectionError("No se pudo conectar con el servidor de reuniones.");
    });

    return () => {
      socket.off("participant-joined");
      socket.off("participant-left");
      socket.off("role-added");
      socket.off("role-assigned");
      socket.off("chat-message");
      socket.off("transcript-line");
      socket.off("transcript-line-translations");
      socket.off("media-state");
      socket.off("screen-share");
      socket.off("host-changed");
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

  const clearDraft = useCallback(() => setDraft(null), []);

  const connect = useCallback(() => {
    if (!draft) return;
    const socket = socketRef.current;
    setConnectionStatus("connecting");
    setConnectionError(null);
    if (!socket.connected) socket.connect();

    if (draft.mode === "host") {
      socket.emit(
        "create-meeting",
        { hostName: draft.name, hostLanguage: draft.language, roles: draft.roleNames },
        (res: { ok: boolean; meeting?: MeetingSnapshot; selfId?: string; error?: string }) => {
          if (res.ok && res.meeting && res.selfId) {
            setSelfId(res.selfId);
            dispatch({ type: "SNAPSHOT_LOADED", meeting: res.meeting });
            setConnectionStatus("connected");
          } else {
            setConnectionStatus("error");
            setConnectionError(res.error ?? "No se pudo crear la reunión.");
          }
        }
      );
    } else {
      socket.emit(
        "join-meeting",
        { meetingId: draft.meetingCode, name: draft.name, language: draft.language },
        (res: { ok: boolean; meeting?: MeetingSnapshot; selfId?: string; error?: string }) => {
          if (res.ok && res.meeting && res.selfId) {
            setSelfId(res.selfId);
            dispatch({ type: "SNAPSHOT_LOADED", meeting: res.meeting });
            setConnectionStatus("connected");
          } else {
            setConnectionStatus("error");
            setConnectionError(res.error ?? "No se pudo unir a la reunión.");
          }
        }
      );
    }
  }, [draft]);

  const sendChatMessage = useCallback((text: string) => {
    if (!text.trim()) return;
    socketRef.current.emit("chat-message", { text });
  }, []);

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

  const sendTranscriptLine = useCallback((alternatives: string[], lang: string) => {
    const cleaned = alternatives.filter((a) => a.trim());
    if (cleaned.length === 0) return;
    socketRef.current.emit("transcript-line", { alternatives: cleaned, lang });
  }, []);

  const setMediaState = useCallback((muted: boolean, cameraOff: boolean) => {
    socketRef.current.emit("media-state", { muted, cameraOff });
  }, []);

  const setSharingScreen = useCallback((sharing: boolean) => {
    socketRef.current.emit("screen-share", { sharing });
  }, []);

  const leaveMeeting = useCallback(() => {
    const socket = socketRef.current;
    socket.emit("leave-meeting");
    socket.disconnect();
    dispatch({ type: "RESET" });
    setSelfId(null);
    setConnectionStatus("idle");
    setConnectionError(null);
    setDraft(null);
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
    clearDraft,
    connect,
    sendChatMessage,
    assignRole,
    addRole,
    sendTranscriptLine,
    setMediaState,
    setSharingScreen,
    leaveMeeting,
  };

  return <MeetingContext.Provider value={value}>{children}</MeetingContext.Provider>;
}

export function useMeeting(): MeetingContextValue {
  const ctx = useContext(MeetingContext);
  if (!ctx) throw new Error("useMeeting debe usarse dentro de MeetingProvider");
  return ctx;
}
