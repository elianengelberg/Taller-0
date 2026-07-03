import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Button from "../components/Button";
import ChatPanel from "../components/ChatPanel";
import ControlBar from "../components/ControlBar";
import LiveCaption from "../components/LiveCaption";
import Logo from "../components/Logo";
import ParticipantsPanel from "../components/ParticipantsPanel";
import RecordingBanner from "../components/RecordingBanner";
import TranscriptPanel from "../components/TranscriptPanel";
import VideoGrid from "../components/VideoGrid";
import { useMeeting } from "../context/MeetingContext";
import { useLocalMedia } from "../hooks/useLocalMedia";
import { AUTO_LANG, ORIGINAL_LANG, useLineTranslations } from "../hooks/useLineTranslations";
import { useRecorder } from "../hooks/useRecorder";
import { useScreenShare } from "../hooks/useScreenShare";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { useWebRTC } from "../hooks/useWebRTC";
import { getSocket } from "../lib/socket";

type PanelKey = "participants" | "chat" | "transcript" | null;

export default function Meeting() {
  const navigate = useNavigate();
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
    setSelfLanguage,
    sendTranscriptLine,
    leaveMeeting,
  } = useMeeting();

  const media = useLocalMedia();
  const [activePanel, setActivePanel] = useState<PanelKey>(null);
  const [chatUnread, setChatUnread] = useState(0);
  const [captionsOn, setCaptionsOn] = useState(false);

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

  const { remoteStreams, replaceVideoTrack, removeVideoTrack } = useWebRTC({
    socket: getSocket(),
    selfId,
    peerIds,
    localStream: media.stream,
    enabled: media.ready,
  });

  const screenShare = useScreenShare({
    localStream: media.stream,
    onReplaceTrack: replaceVideoTrack,
    onRemoveTrack: removeVideoTrack,
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

  useEffect(() => {
    if (connectionStatus === "connected") {
      setMediaState(media.muted, media.cameraOff);
    }
  }, [media.muted, media.cameraOff, connectionStatus, setMediaState]);

  const chatLength = meeting?.chat.length ?? 0;
  const prevChatLengthRef = useRef(chatLength);
  useEffect(() => {
    if (chatLength > prevChatLengthRef.current && activePanel !== "chat") {
      setChatUnread((count) => count + (chatLength - prevChatLengthRef.current));
    }
    prevChatLengthRef.current = chatLength;
  }, [chatLength, activePanel]);

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
  const { supported: captionsSupported, error: captionsError } = useSpeechRecognition({
    lang: self?.language ?? "es-AR",
    active: !media.muted && connectionStatus === "connected",
    onInterim: (text) => setInterimCaption(text),
    onResult: (alternatives) => {
      setInterimCaption(null);
      sendTranscriptLine(alternatives, self?.language ?? "es-AR");
    },
  });
  // Only worth surfacing the "why is nothing happening" hints while the
  // person is actually looking at captions or the transcript panel -- no
  // need to nag every time someone mutes for an unrelated reason.
  const watchingTranscription = captionsOn || activePanel === "transcript";
  const captionsMutedHint = watchingTranscription && media.muted;

  const { getTranslation } = useLineTranslations(meeting?.transcript ?? [], targetLang);

  const recorder = useRecorder({ micStream: media.stream, meetingDbId: meeting?.dbId ?? null });
  function toggleRecording() {
    if (recorder.status === "recording") {
      recorder.stop();
    } else if (recorder.status === "idle" || recorder.status === "error") {
      void recorder.start();
    }
  }

  function togglePanel(panel: PanelKey) {
    setActivePanel((current) => (current === panel ? null : panel));
    if (panel === "chat") setChatUnread(0);
  }

  function handleLeave() {
    leaveMeeting();
    navigate("/", { replace: true });
  }

  if (!draft) return null;

  if (connectionStatus === "idle" || connectionStatus === "connecting") {
    return <StatusScreen title="Conectando…" description="Estamos preparando tu reunión." />;
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

  const lastTranscriptLine = meeting.transcript[meeting.transcript.length - 1] ?? null;

  return (
    // `h-dvh` (dynamic viewport height), not `h-screen` (100vh): mobile
    // Safari/Chrome count their address bar into 100vh, so with a fixed
    // h-screen + no outer scroll, the ControlBar at the bottom could end up
    // rendered below the visible fold with no way to scroll down to it.
    <div className="flex h-dvh flex-col bg-ink-950">
      <header className="flex items-center justify-between border-b border-ink-700 bg-ink-900 px-4 py-3 sm:px-6">
        <Logo />
        <span className="text-sm font-medium text-ink-300">
          {meeting.participants.length} participante{meeting.participants.length === 1 ? "" : "s"}
        </span>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <main className="relative flex-1 overflow-y-auto p-4 sm:p-6">
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
          {watchingTranscription && !captionsMutedHint && captionsError && (
            <div className="mb-4 rounded-xl border border-brand-500/40 bg-brand-500/10 px-4 py-2.5 text-sm text-brand-300">
              {captionsError}
            </div>
          )}
          {screenShare.error && (
            <div className="mb-4 rounded-xl border border-brand-500/40 bg-brand-500/10 px-4 py-2.5 text-sm text-brand-300">
              {screenShare.error}
            </div>
          )}
          <VideoGrid
            participants={meeting.participants}
            roles={meeting.roles}
            selfId={selfId}
            localStream={media.stream}
            remoteStreams={remoteStreams}
          />
          <LiveCaption
            line={captionsOn ? lastTranscriptLine : null}
            translatedText={
              captionsOn && lastTranscriptLine ? getTranslation(lastTranscriptLine.id) : undefined
            }
            localInterim={
              captionsOn && interimCaption ? { speakerName: self?.name ?? "Vos", text: interimCaption } : null
            }
          />
          <RecordingBanner
            status={recorder.status}
            uploadStatus={recorder.uploadStatus}
            error={recorder.error}
            resultUrl={recorder.resultUrl}
            onDismiss={recorder.reset}
          />
        </main>

        {activePanel === "participants" && <ParticipantsPanel onClose={() => setActivePanel(null)} />}
        {activePanel === "chat" && <ChatPanel onClose={() => setActivePanel(null)} />}
        {activePanel === "transcript" && (
          <TranscriptPanel
            onClose={() => setActivePanel(null)}
            targetLangChoice={targetLangChoice}
            resolvedTargetLang={targetLang}
            onTargetLangChange={handleTargetLangChange}
            getTranslation={getTranslation}
            spokenLang={self?.language ?? "es-AR"}
            onSpokenLangChange={setSelfLanguage}
          />
        )}
      </div>

      <ControlBar
        meetingCode={meeting.id}
        muted={media.muted}
        cameraOff={media.cameraOff}
        onToggleMic={media.toggleMic}
        onToggleCamera={media.toggleCamera}
        captionsOn={captionsOn}
        captionsSupported={captionsSupported}
        onToggleCaptions={() => setCaptionsOn((v) => !v)}
        chatOpen={activePanel === "chat"}
        chatUnread={chatUnread}
        onToggleChat={() => togglePanel("chat")}
        participantsOpen={activePanel === "participants"}
        onToggleParticipants={() => togglePanel("participants")}
        transcriptOpen={activePanel === "transcript"}
        onToggleTranscript={() => togglePanel("transcript")}
        recording={recorder.status === "recording"}
        onToggleRecording={toggleRecording}
        sharingScreen={screenShare.sharing}
        onToggleScreenShare={toggleScreenShare}
        onLeave={handleLeave}
      />
    </div>
  );
}

function StatusScreen({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-ink-950 px-6 text-center">
      <Logo />
      <h1 className="mt-4 text-xl font-bold text-white">{title}</h1>
      <p className="max-w-sm text-sm text-ink-300">{description}</p>
      {action}
    </div>
  );
}
