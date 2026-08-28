import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import AiChatBox from "../components/AiChatBox";
import Button from "../components/Button";
import ChatPanel from "../components/ChatPanel";
import ControlBar from "../components/ControlBar";
import HostControlsPanel from "../components/HostControlsPanel";
import LiveCaption from "../components/LiveCaption";
import LoadingDots from "../components/LoadingDots";
import Logo from "../components/Logo";
import { ClockIcon, PeopleIcon, ScreenShareIcon } from "../components/icons";
import ParticipantsPanel from "../components/ParticipantsPanel";
import RecordAutoPrompt from "../components/RecordAutoPrompt";
import RecordingBanner from "../components/RecordingBanner";
import SaveMeetingPrompt from "../components/SaveMeetingPrompt";
import SettingsPanel from "../components/SettingsPanel";
import SidePanel from "../components/SidePanel";
import TranscriptPanel from "../components/TranscriptPanel";
import VideoGrid from "../components/VideoGrid";
import { useAuth } from "../context/AuthContext";
import { useMeeting } from "../context/MeetingContext";
import { askMeetingAI } from "../lib/api";
import { recentCaptionEntries } from "../lib/captionLines";
import { showToast } from "../lib/toasts";
import { setUnsavedMeeting } from "../lib/unsavedMeeting";
import { useActiveSpeakers } from "../hooks/useActiveSpeakers";
import { useLocalMedia } from "../hooks/useLocalMedia";
import { AUTO_LANG, ORIGINAL_LANG, useLineTranslations } from "../hooks/useLineTranslations";
import { RecTile, useCompositeRecorder } from "../hooks/useCompositeRecorder";
import { useScreenShare } from "../hooks/useScreenShare";
import { useTrackTranscription } from "../hooks/useTrackTranscription";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { MENSAJE_MIC_BLOQUEADO, usePermisoDeMicrofono } from "../hooks/usePermisoDeMicrofono";
import { useWebRTC } from "../hooks/useWebRTC";
import { getSocket } from "../lib/socket";

type Panel = "participants" | "chat" | "transcript" | "ai" | "settings" | "host";

// True from the sm breakpoint up (matches Tailwind's 640px). Two panels can be
// open side by side only on desktop; phones stick to one at a time.
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 640px)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return isDesktop;
}

// The "00:00 elapsed" pill both Zoom and Teams show while a call is live.
// Starts counting the moment we're actually connected (not from when the
// component mounted, which would also count time spent reconnecting).
function useElapsedTime(active: boolean): string {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    if (!active) return;
    if (startRef.current === null) startRef.current = Date.now();
    const id = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startRef.current!) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [active]);

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = String(Math.floor((elapsedSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(elapsedSeconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

export default function Meeting() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const {
    draft,
    connectionStatus,
    connectionError,
    connect,
    meeting,
    selfId,
    self,
    setMediaState,
    setSharingScreen,
    setHandRaised,
    setSelfLanguage,
    sendTranscriptLine,
    leaveMeeting,
  } = useMeeting();

  const media = useLocalMedia();
  const isDesktop = useIsDesktop();
  const elapsedTime = useElapsedTime(connectionStatus === "connected");

  // Mirror the current mute/camera state for the moderation handlers below
  // (registered once): they must act on the LIVE state, not a stale closure.
  const mediaRef = useRef(media);
  mediaRef.current = media;

  // Zoom-style moderation events aimed at ME. Kicked/ended send us home with
  // an explanation; force-mute obeys immediately; requests show a toast with
  // a one-tap action (the browser can't let a host remote-control someone's
  // devices -- consent by design, like Zoom's "the host asks you to unmute").
  useEffect(() => {
    const socket = getSocket();
    const goHome = (notice: string) => {
      leaveMeeting();
      navigate("/", { replace: true, state: { notice } });
    };
    const onKicked = ({ by }: { by?: string }) =>
      goHome(`${by ?? "El anfitrión"} te quitó de la reunión.`);
    const onEnded = ({ by }: { by?: string }) =>
      goHome(`${by ?? "El anfitrión"} finalizó la reunión para todos.`);
    const onForceMuted = ({ by }: { by?: string }) => {
      if (!mediaRef.current.muted) mediaRef.current.toggleMic();
      showToast({ text: `${by ?? "El anfitrión"} te silenció.`, kind: "info" });
    };
    const onRequest = ({ kind, by }: { kind: string; by?: string }) => {
      const who = by ?? "El anfitrión";
      if (kind === "unmute") {
        showToast({
          text: `${who} te pide que actives el micrófono.`,
          kind: "info",
          actionLabel: "Activar",
          onAction: () => {
            if (mediaRef.current.muted) mediaRef.current.toggleMic();
          },
        });
      } else if (kind === "camera-on") {
        showToast({
          text: `${who} te pide que prendas la cámara.`,
          kind: "info",
          actionLabel: "Prender",
          onAction: () => {
            if (mediaRef.current.cameraOff) mediaRef.current.toggleCamera();
          },
        });
      } else if (kind === "camera-off") {
        showToast({
          text: `${who} te pide que apagues la cámara.`,
          kind: "info",
          actionLabel: "Apagar",
          onAction: () => {
            if (!mediaRef.current.cameraOff) mediaRef.current.toggleCamera();
          },
        });
      }
    };
    const onShareDenied = ({ reason }: { reason?: string }) => {
      showToast({ text: reason ?? "No se pudo compartir la pantalla.", kind: "warning" });
    };
    const onShareStopped = ({ by }: { by?: string }) => {
      showToast({ text: `${by ?? "El anfitrión"} detuvo tu pantalla compartida.`, kind: "info" });
    };
    socket.on("kicked", onKicked);
    socket.on("meeting-ended", onEnded);
    socket.on("force-muted", onForceMuted);
    socket.on("moderation-request", onRequest);
    socket.on("share-denied", onShareDenied);
    socket.on("share-stopped-by-host", onShareStopped);
    return () => {
      socket.off("kicked", onKicked);
      socket.off("meeting-ended", onEnded);
      socket.off("force-muted", onForceMuted);
      socket.off("moderation-request", onRequest);
      socket.off("share-denied", onShareDenied);
      socket.off("share-stopped-by-host", onShareStopped);
    };
  }, [leaveMeeting, navigate]);

  // Report our socket round-trip every 15s so hosts see everyone's
  // connection quality (a green/yellow/red dot in the participants panel).
  useEffect(() => {
    if (connectionStatus !== "connected") return;
    const socket = getSocket();
    const report = () => {
      const start = Date.now();
      socket.timeout(5000).emit("quality-ping", (err: unknown) => {
        if (!err) socket.emit("connection-quality", { rtt: Date.now() - start });
      });
    };
    report();
    const timer = window.setInterval(report, 15_000);
    return () => window.clearInterval(timer);
  }, [connectionStatus]);
  // Open panels, oldest first. On desktop up to two can be open at once (one
  // docked left, one right -- e.g. IA on one side, chat on the other); on a
  // phone only the most recent stays open. Opening a third on desktop evicts
  // the oldest.
  const [openPanels, setOpenPanels] = useState<Panel[]>([]);
  const [chatUnread, setChatUnread] = useState(0);
  // Prendidos POR DEFECTO: los subtítulos son el corazón del producto, y
  // arrancar con ellos apagados era la primera razón del "no veo subtítulos".
  // La elección de cada quien se recuerda entre reuniones.
  const [captionsOn, setCaptionsOn] = useState(() => {
    try {
      return localStorage.getItem("unify_subtitulos") !== "0";
    } catch {
      return true;
    }
  });
  function toggleCaptions() {
    setCaptionsOn((v) => {
      const next = !v;
      try {
        localStorage.setItem("unify_subtitulos", next ? "1" : "0");
      } catch {
        /* modo privado: no se recuerda, nada más */
      }
      return next;
    });
  }

  // "Automático" (the default) always resolves to whatever language you've
  // told the app you speak, live -- so two people speaking different
  // languages understand each other with zero setup, and it keeps working
  // even if you change your spoken language mid-meeting. Picking a specific
  // language (or "Original") is a one-off override that only lasts until
  // you switch back to "Automático" -- unlike a plain "the first manual
  // pick wins forever" ref, there's always a way back to the smart default.
  const [targetLangChoice, setTargetLangChoice] = useState<string>(AUTO_LANG);
  const targetLang =
    targetLangChoice === AUTO_LANG ? self?.language ?? ORIGINAL_LANG : targetLangChoice;
  function handleTargetLangChange(lang: string) {
    setTargetLangChoice(lang);
  }

  useEffect(() => {
    if (!draft) {
      navigate("/", { replace: true });
      return;
    }
    if (connectionStatus === "idle") {
      connect();
    }
  }, [draft, connectionStatus, connect, navigate]);

  // The socket is a module-level singleton that outlives this component, so
  // navigating away (back button, closing a panel back to "/", etc.) doesn't
  // disconnect it on its own -- without this, the server never learns we
  // left and the participant lingers in the meeting forever ("ghost"
  // participant the host keeps seeing). `pagehide` covers actually closing
  // the tab; the effect cleanup covers every other way this component stops
  // being mounted.
  useEffect(() => {
    function handlePageHide() {
      leaveMeeting();
    }
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      leaveMeeting();
    };
  }, [leaveMeeting]);

  const peerIds = useMemo(
    () => (meeting ? meeting.participants.map((p) => p.id).filter((id) => id !== selfId) : []),
    [meeting, selfId]
  );

  const { remoteStreams, replaceVideoTrack, removeVideoTrack, replaceTrack } = useWebRTC({
    socket: getSocket(),
    selfId,
    peerIds,
    localStream: media.stream,
    enabled: media.ready,
  });

  // Who's currently talking, for the active-speaker highlight (like Zoom/Meet).
  const speakerStreams = useMemo(() => {
    const map: Record<string, MediaStream | null> = {};
    if (selfId && media.stream) map[selfId] = media.stream;
    for (const [id, s] of Object.entries(remoteStreams)) map[id] = s;
    return map;
  }, [selfId, media.stream, remoteStreams]);
  const activeSpeakers = useActiveSpeakers(speakerStreams);

  const screenShare = useScreenShare({
    localStream: media.stream,
    onReplaceTrack: replaceVideoTrack,
    onRemoveTrack: removeVideoTrack,
    parkCamera: media.parkCamera,
    unparkCamera: media.unparkCamera,
  });
  function toggleScreenShare() {
    if (screenShare.sharing) {
      screenShare.stop();
    } else {
      void screenShare.start();
    }
  }
  // Covers both the toolbar button and the browser's own "Stop sharing" UI
  // (which calls screenShare.stop() internally), so every path that changes
  // `sharing` ends up broadcast to everyone else exactly once.
  useEffect(() => {
    if (connectionStatus === "connected") setSharingScreen(screenShare.sharing);
  }, [screenShare.sharing, connectionStatus, setSharingScreen]);

  // A host stopped our share (or the policy changed): the server already
  // cleared our presenter slot -- stop the local capture to match.
  useEffect(() => {
    if (screenShare.sharing && self && !self.sharingScreen) {
      screenShare.stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [self?.sharingScreen]);

  useEffect(() => {
    if (connectionStatus === "connected") {
      setMediaState(media.muted, media.cameraOff);
    }
  }, [media.muted, media.cameraOff, connectionStatus, setMediaState]);

  const chatLength = meeting?.chat.length ?? 0;
  const prevChatLengthRef = useRef(chatLength);
  useEffect(() => {
    if (chatLength > prevChatLengthRef.current && !openPanels.includes("chat")) {
      setChatUnread((count) => count + (chatLength - prevChatLengthRef.current));
    }
    prevChatLengthRef.current = chatLength;
  }, [chatLength, openPanels]);

  // Shown instantly as the local speaker talks, before their utterance even
  // finishes -- purely local, never round-trips through the server, so it
  // doesn't wait on speech-recognition's own end-of-utterance pause, or on
  // cleanup/translation. Cleared once the utterance finalizes and gets sent
  // off; the "real" (cleaned + translated) caption then takes over via the
  // normal broadcast.
  const [interimCaption, setInterimCaption] = useState<string | null>(null);
  useEffect(() => {
    if (!captionsOn) setInterimCaption(null);
  }, [captionsOn]);

  // Runs continuously whenever unmuted, independent of whether the caption
  // overlay or transcript panel is even open: transcription is always-on
  // background data collection (for the meeting's saved transcript and the
  // AI features), not just a display feature. The "Subtítulos"/"Transcripción"
  // buttons only control what's shown on screen, not whether this runs.
  // Paridad con la reunión externa: reintento a mano, relanzamiento al
  // volver del segundo plano (el celular mata el reconocimiento al saltar de
  // app o bloquear la pantalla) y el permiso de micrófono mirado de frente.
  const [micAttempt, setMicAttempt] = useState(0);
  useEffect(() => {
    function alVolver() {
      if (document.visibilityState === "visible") setMicAttempt((n) => n + 1);
    }
    document.addEventListener("visibilitychange", alVolver);
    return () => document.removeEventListener("visibilitychange", alVolver);
  }, []);
  const micBloqueado = usePermisoDeMicrofono(micAttempt, () => setMicAttempt((n) => n + 1));
  const { supported: captionsSupported, error: captionsError } = useSpeechRecognition({
    key: micAttempt,
    lang: self?.language ?? "es-AR",
    active: !media.muted && connectionStatus === "connected",
    onInterim: (text) => setInterimCaption(text),
    onResult: (alternatives) => {
      setInterimCaption(null);
      sendTranscriptLine(alternatives, self?.language ?? "es-AR");
    },
  });
  const captionsProblem = micBloqueado ? MENSAJE_MIC_BLOQUEADO : captionsError;
  // El audio de la pantalla compartida (un video, una presentación con
  // sonido) también se transcribe: Chrome 139+ deja darle al reconocimiento
  // una pista en vez del micrófono. Llega al transcript como "Pantalla de
  // <nombre>", pasa por la misma IA correctora y se traduce igual que todo.
  useTrackTranscription({
    track: screenShare.audioTrack,
    lang: self?.language ?? "es-AR",
    onResult: (alternatives) => sendTranscriptLine(alternatives, self?.language ?? "es-AR", { screen: true }),
  });

  // Only worth surfacing the "why is nothing happening" hints while the
  // person is actually looking at captions or the transcript panel -- no
  // need to nag every time someone mutes for an unrelated reason.
  const watchingTranscription = captionsOn || openPanels.includes("transcript");
  const captionsMutedHint = watchingTranscription && media.muted;

  const { getTranslation } = useLineTranslations(meeting?.transcript ?? [], targetLang);

  // Composite recorder: records the whole meeting (all cameras + shared
  // screen, laid out like the room) by drawing to a canvas and mixing every
  // participant's audio -- no getDisplayMedia, so it needs no user gesture
  // and can start automatically, and it always has real frames (never an
  // empty/black file). The scene ref is refreshed below every render.
  const sceneRef = useRef<RecTile[]>([]);
  const recorder = useCompositeRecorder({ sceneRef, meetingDbId: meeting?.dbId ?? null });

  useEffect(() => {
    if (!meeting || !selfId) {
      sceneRef.current = [];
      return;
    }
    sceneRef.current = meeting.participants.map((p) => ({
      id: p.id,
      name: p.name + (p.id === selfId ? " (vos)" : ""),
      stream: p.id === selfId ? media.stream : remoteStreams[p.id] ?? null,
      cameraOff: p.cameraOff,
      sharingScreen: p.sharingScreen,
    }));
  }, [meeting, selfId, media.stream, remoteStreams]);

  // Auto-record: a discreet prompt appears once on joining; if it isn't
  // answered (or the countdown ends) recording starts on its own.
  const [showRecPrompt, setShowRecPrompt] = useState(false);
  const recPromptShownRef = useRef(false);
  useEffect(() => {
    if (connectionStatus === "connected" && !recPromptShownRef.current) {
      recPromptShownRef.current = true;
      setShowRecPrompt(true);
    }
  }, [connectionStatus]);

  function beginRecording(auto: boolean) {
    setShowRecPrompt(false);
    if (recorder.status === "recording") return;
    void recorder.start();
    showToast({
      text: auto ? "La grabación empezó automáticamente." : "Grabación iniciada.",
      kind: "info",
    });
  }
  function declineRecording() {
    setShowRecPrompt(false);
  }
  function toggleRecording() {
    setShowRecPrompt(false);
    if (recorder.status === "recording") {
      recorder.stop();
    } else if (recorder.status === "idle" || recorder.status === "error") {
      beginRecording(false);
    }
  }

  // Foto de quien habla, para los subtítulos. Por id de participante y, si ya
  // se fue, por nombre: la línea de transcripción sobrevive a quien la dijo.
  const avatarFor = (speakerId: string, speakerName: string) => {
    const people = meeting?.participants ?? [];
    const byId = people.find((p) => p.id === speakerId);
    if (byId) return byId.avatarUrl;
    return people.find((p) => p.name === speakerName)?.avatarUrl ?? null;
  };

  const maxPanels = isDesktop ? 2 : 1;
  function togglePanel(panel: Panel) {
    const willOpen = !openPanels.includes(panel);
    if (panel === "chat" && willOpen) setChatUnread(0);
    setOpenPanels((cur) => {
      if (cur.includes(panel)) return cur.filter((p) => p !== panel);
      const next = [...cur, panel];
      // Keep only the most recent `maxPanels` -- opening a third evicts the oldest.
      return next.slice(Math.max(0, next.length - maxPanels));
    });
  }
  const closePanel = (panel: Panel) => setOpenPanels((cur) => cur.filter((p) => p !== panel));

  // Guests (no account) get one chance, right as they leave, to attach this
  // meeting's transcript/chat to an account -- otherwise it stays ownerless
  // and unreachable forever (see .claude/memory/log.md). `pendingLeave` holds
  // the meeting's dbId captured before leaveMeeting() clears it.
  const [pendingLeave, setPendingLeave] = useState<string | null>(null);
  // While a recording is still being captured or uploaded, don't yank the user
  // out of the meeting -- finish saving it first, so it reliably lands in the
  // history instead of the upload being abandoned mid-flight when they leave.
  const [savingRecording, setSavingRecording] = useState(false);
  const leftRef = useRef(false);
  // La fecha límite se ancla UNA vez al pedir la salida. Antes el setTimeout
  // vivía en el efecto de abajo, y cada transición de la grabación
  // (grabando -> procesando -> subiendo -> reintento) lo reseteaba: el
  // "tope de 30s" se corría infinitamente y el spinner quedaba eterno.
  const savingDeadlineRef = useRef(0);

  function salirYa() {
    if (leftRef.current) return;
    leftRef.current = true;
    leaveMeeting();
    navigate("/", { replace: true });
  }

  function handleLeave() {
    if (!user && meeting?.dbId) {
      setPendingLeave(meeting.dbId);
      return;
    }
    const busy =
      recorder.status === "recording" ||
      recorder.status === "processing" ||
      recorder.uploadStatus === "uploading";
    if (busy) {
      if (recorder.status === "recording") recorder.stop();
      savingDeadlineRef.current = Date.now() + 30000;
      setSavingRecording(true); // an effect below leaves once the save finishes
      return;
    }
    salirYa();
  }

  // Completes the deferred leave once the recording is safely uploaded (or the
  // anchored 30s deadline passes, so a stuck upload can never trap someone).
  useEffect(() => {
    if (!savingRecording || leftRef.current) return;
    const busy =
      recorder.status === "recording" ||
      recorder.status === "processing" ||
      recorder.uploadStatus === "uploading";
    const restante = Math.max(0, savingDeadlineRef.current - Date.now());
    if (!busy || restante === 0) {
      salirYa();
      return;
    }
    const t = setTimeout(salirYa, restante);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savingRecording, recorder.status, recorder.uploadStatus]);
  function confirmSaveMeeting() {
    const dbId = pendingLeave!;
    leaveMeeting();
    navigate("/ingresar", { state: { claimMeetingId: dbId }, replace: true });
  }
  function skipSaveMeeting() {
    setUnsavedMeeting({ dbId: pendingLeave!, joinCode: meeting?.id ?? "", endedAt: Date.now() });
    leaveMeeting();
    navigate("/", { replace: true });
  }

  // El backend vive en un plan que duerme: la primera conexión del día puede
  // tardar casi un minuto. Sin decirlo, "Conectando…" parece que se colgó y la
  // gente recarga justo cuando estaba por entrar.
  const [slowConnect, setSlowConnect] = useState(false);
  useEffect(() => {
    if (connectionStatus !== "connecting" && connectionStatus !== "idle") {
      setSlowConnect(false);
      return;
    }
    const t = setTimeout(() => setSlowConnect(true), 6000);
    return () => clearTimeout(t);
  }, [connectionStatus]);

  if (!draft) return null;

  if (connectionStatus === "idle" || connectionStatus === "connecting") {
    return (
      <StatusScreen
        loading
        title="Conectando"
        description={
          slowConnect
            ? "El servidor estaba dormido y está despertando. La primera conexión del día puede tardar hasta un minuto; después entra al instante."
            : "Estamos preparando tu reunión."
        }
      />
    );
  }

  if (connectionStatus === "waiting") {
    return (
      <StatusScreen
        loading
        title="Sala de espera"
        description="El anfitrión ya sabe que estás acá. Vas a entrar en cuanto te admita."
        action={
          <Button variant="secondary" onClick={handleLeave}>
            Salir
          </Button>
        }
      />
    );
  }

  if (connectionStatus === "error" || !meeting || !selfId) {
    return (
      <StatusScreen
        title="No pudimos conectar"
        description={connectionError ?? "Ocurrió un error inesperado. Probá de nuevo."}
        action={<Button onClick={() => navigate("/", { replace: true })}>Volver al inicio</Button>}
      />
    );
  }

  // The live-caption stack: the latest line per recent speaker, so if two or
  // three people talk at once each keeps their own row instead of one caption
  // flickering as it's overwritten.
  const captionLines = captionsOn ? recentCaptionEntries(meeting.transcript, getTranslation) : [];

  // Lay the open panels out: on desktop the first goes left and the second
  // right; a single panel always sits on the right (like before). On mobile
  // only the most recent one shows, as a full overlay.
  const panelsToShow = isDesktop ? openPanels : openPanels.slice(-1);
  const leftPanel = panelsToShow.length === 2 ? panelsToShow[0] : null;
  const rightPanel = panelsToShow.length === 2 ? panelsToShow[1] : panelsToShow[0] ?? null;

  const meetingDbId = meeting.dbId;
  function renderPanel(panel: Panel, side: "left" | "right") {
    switch (panel) {
      case "participants":
        return <ParticipantsPanel key="participants" side={side} onClose={() => closePanel("participants")} />;
      case "chat":
        return <ChatPanel key="chat" side={side} onClose={() => closePanel("chat")} />;
      case "transcript":
        return (
          <TranscriptPanel
            key="transcript"
            side={side}
            onClose={() => closePanel("transcript")}
            targetLangChoice={targetLangChoice}
            resolvedTargetLang={targetLang}
            onTargetLangChange={handleTargetLangChange}
            getTranslation={getTranslation}
            spokenLang={self?.language ?? "es-AR"}
            onSpokenLangChange={setSelfLanguage}
          />
        );
      case "ai":
        return (
          <SidePanel key="ai" title="Asistente IA" side={side} onClose={() => closePanel("ai")}>
            {meetingDbId ? (
              <AiChatBox
                title="Preguntale a la IA"
                description="Tu asistente durante la reunión: responde sobre lo que se está diciendo, resume y saca conclusiones."
                placeholder='Ej: "resumime lo que se dijo hasta ahora"'
                emptyHint="La IA usa la transcripción en vivo de esta reunión."
                onAsk={(q) => askMeetingAI(meetingDbId, q)}
              />
            ) : (
              <p className="text-sm text-ink-400">Conectando la reunión…</p>
            )}
          </SidePanel>
        );
      case "host":
        return <HostControlsPanel key="host" side={side} onClose={() => closePanel("host")} />;
      case "settings":
        return (
          <SettingsPanel
            key="settings"
            side={side}
            devices={media.devices}
            activeMicId={media.activeMicId}
            activeCameraId={media.activeCameraId}
            activeSpeakerId={media.activeSpeakerId}
            onSelectMic={(id) => void media.switchMic(id, replaceTrack)}
            onSelectCamera={(id) => void media.switchCamera(id, replaceTrack)}
            onSelectSpeaker={media.setActiveSpeakerId}
            onClose={() => closePanel("settings")}
          />
        );
    }
  }

  return (
    // `h-dvh` (dynamic viewport height), not `h-screen` (100vh): mobile
    // Safari/Chrome count their address bar into 100vh, so with a fixed
    // h-screen + no outer scroll, the ControlBar at the bottom could end up
    // rendered below the visible fold with no way to scroll down to it.
    <div className="flex h-dvh flex-col bg-ink-950 pb-[env(safe-area-inset-bottom)]">
      <header className="flex items-center justify-between border-b border-ink-800 bg-ink-900/95 px-4 py-3 shadow-soft backdrop-blur-md sm:px-6">
        <div className="flex items-center gap-3">
          {/* SIEMPRE un Volver a la vista (regla de la casa). Sale por el
              camino seguro: si hay grabación en curso primero la guarda. */}
          <button
            type="button"
            onClick={handleLeave}
            aria-label="Volver al inicio (salís de la reunión)"
            className="-my-2 flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg px-3 text-sm font-medium text-ink-300 hover:bg-ink-800 hover:text-strong"
          >
            <span aria-hidden>←</span> Volver
          </button>
          <Logo />
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-1.5 rounded-full bg-ink-800 px-3 py-1.5 font-mono text-sm font-medium text-ink-200 ring-1 ring-ink-700 sm:flex">
            <ClockIcon className="h-3.5 w-3.5 text-brand-300" />
            {elapsedTime}
          </div>
          <div className="flex items-center gap-1.5 rounded-full bg-ink-800 px-3 py-1.5 ring-1 ring-ink-700">
            <PeopleIcon className="h-3.5 w-3.5 text-brand-300" />
            <span className="text-sm font-medium text-ink-200">
              {meeting.participants.length} participante{meeting.participants.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      </header>

      {/* relative so a side panel can overlay just the video area on mobile
          (see SidePanel) without covering the header or control bar. */}
      <div className="relative flex flex-1 overflow-hidden">
        {leftPanel && renderPanel(leftPanel, "left")}
        {/* min-w-0 lets this column actually shrink when a side panel opens
            (a flex item's default min-width:auto would otherwise keep it at
            its content's min width and squeeze/overlap the panel); overflow-x
            clip stops a wide video tile from spilling sideways over the panel. */}
        <main className="relative flex min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden p-4 sm:p-6">
          {media.error && (
            <div className="mb-4 rounded-xl border border-brand-500/40 bg-brand-500/10 px-4 py-2.5 text-sm text-brand-300">
              {media.error}
            </div>
          )}
          {captionsMutedHint && (
            <div className="mb-4 rounded-xl border border-brand-500/40 bg-brand-500/10 px-4 py-2.5 text-sm text-brand-300">
              Estás silenciado — activá el micrófono para que se transcriba lo que decís.
            </div>
          )}
          {watchingTranscription && !captionsMutedHint && captionsProblem && (
            <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-brand-500/40 bg-brand-500/10 px-4 py-2.5 text-sm text-brand-300">
              <span className="min-w-0 flex-1">{captionsProblem}</span>
              <button
                type="button"
                onClick={() => setMicAttempt((n) => n + 1)}
                className="shrink-0 rounded-lg border border-brand-400/50 px-2.5 py-1 text-xs font-semibold hover:bg-brand-500/20"
              >
                Reintentar
              </button>
            </div>
          )}
          {meeting.presenterId && meeting.presenterId !== selfId && (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-brand-500/40 bg-brand-500/10 px-4 py-2.5 text-sm text-brand-300">
              <ScreenShareIcon className="h-4 w-4 shrink-0" />
              {meeting.participants.find((p) => p.id === meeting.presenterId)?.name ?? "Alguien"} está
              compartiendo su pantalla.
            </div>
          )}
          {screenShare.error && (
            <div className="mb-4 rounded-xl border border-brand-500/40 bg-brand-500/10 px-4 py-2.5 text-sm text-brand-300">
              {screenShare.error}
            </div>
          )}
          <div className="min-h-0 flex-1">
          <VideoGrid
            participants={meeting.participants}
            roles={meeting.roles}
            selfId={selfId}
            localStream={media.stream}
            remoteStreams={remoteStreams}
            speakerId={media.activeSpeakerId}
            speaking={activeSpeakers}
          />
          </div>
          <LiveCaption
            lines={captionLines}
            avatarFor={avatarFor}
            localInterim={
              captionsOn && interimCaption
                ? {
                    speakerName: self?.name ?? "Vos",
                    text: interimCaption,
                    avatarUrl: self?.avatarUrl ?? null,
                  }
                : null
            }
          />
          <RecordingBanner
            status={recorder.status}
            uploadStatus={recorder.uploadStatus}
            error={recorder.error}
            resultUrl={recorder.resultUrl}
            resultType={recorder.resultType}
            onDismiss={recorder.reset}
          />
        </main>

        {rightPanel && renderPanel(rightPanel, "right")}
      </div>

      <ControlBar
        meetingCode={meeting.id}
        muted={media.muted}
        cameraOff={media.cameraOff}
        onToggleMic={media.toggleMic}
        onToggleCamera={media.toggleCamera}
        handRaised={Boolean(self?.handRaised)}
        onToggleHand={() => setHandRaised(!self?.handRaised)}
        captionsOn={captionsOn}
        captionsSupported={captionsSupported}
        onToggleCaptions={toggleCaptions}
        chatOpen={openPanels.includes("chat")}
        chatUnread={chatUnread}
        onToggleChat={() => togglePanel("chat")}
        participantsOpen={openPanels.includes("participants")}
        onToggleParticipants={() => togglePanel("participants")}
        transcriptOpen={openPanels.includes("transcript")}
        onToggleTranscript={() => togglePanel("transcript")}
        aiOpen={openPanels.includes("ai")}
        onToggleAi={() => togglePanel("ai")}
        recording={recorder.status === "recording"}
        onToggleRecording={toggleRecording}
        sharingScreen={screenShare.sharing}
        onToggleScreenShare={toggleScreenShare}
        shareBlockedBy={
          meeting.presenterId && meeting.presenterId !== selfId
            ? meeting.participants.find((p) => p.id === meeting.presenterId)?.name ?? "Alguien"
            : null
        }
        showHostControls={self?.moderationRole !== "participant"}
        hostControlsOpen={openPanels.includes("host")}
        onToggleHostControls={() => togglePanel("host")}
        settingsOpen={openPanels.includes("settings")}
        onToggleSettings={() => togglePanel("settings")}
        onLeave={handleLeave}
      />
      {showRecPrompt && recorder.status === "idle" && (
        <RecordAutoPrompt onStart={(auto) => beginRecording(auto)} onDecline={declineRecording} />
      )}
      {pendingLeave && <SaveMeetingPrompt onSave={confirmSaveMeeting} onSkip={skipSaveMeeting} />}
      {savingRecording && (
        // Colores por TOKENS de tema: la versión anterior era texto blanco
        // sobre ink-900, que en tema claro es una tarjeta casi blanca -- el
        // modal se veía VACÍO, un spinner mudo sin explicación ni salida.
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/60 backdrop-blur-sm">
          <div className="mx-6 flex max-w-sm flex-col items-center gap-4 rounded-2xl border border-ink-600 bg-ink-800 px-8 py-7 text-center shadow-2xl">
            <div className="h-9 w-9 animate-spin rounded-full border-2 border-ink-600 border-t-brand-500" />
            <div>
              <p className="text-sm font-semibold text-strong">Guardando la grabación…</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-300">
                {recorder.status === "processing"
                  ? "Preparando el archivo del video…"
                  : recorder.uploadStatus === "uploading"
                    ? "Subiendo la grabación al historial…"
                    : "Terminando de guardar…"}
              </p>
            </div>
            <button
              type="button"
              onClick={salirYa}
              className="rounded-full border border-ink-600 px-5 py-2 text-xs font-semibold text-ink-200 hover:border-brand-400 hover:text-strong"
            >
              Salir igual
            </button>
            <p className="text-[11px] leading-snug text-ink-400">
              Si salís, la subida sigue sola; y si no llega, la grabación queda guardada en este
              dispositivo y se reintenta desde el historial.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusScreen({
  title,
  description,
  action,
  loading,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-ink-950 px-6 text-center">
      <Logo />
      <h1 className="mt-4 flex items-center gap-2 text-xl font-bold text-strong">
        {title}
        {loading && <LoadingDots className="translate-y-0.5" />}
      </h1>
      <p className="max-w-sm text-sm text-ink-300">{description}</p>
      {action}
    </div>
  );
}
