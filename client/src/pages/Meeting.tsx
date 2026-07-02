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
import { ORIGINAL_LANG, useLineTranslations } from "../hooks/useLineTranslations";
import { useRecorder } from "../hooks/useRecorder";
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
    sendTranscriptLine,
    leaveMeeting,
  } = useMeeting();

  const media = useLocalMedia();
  const [activePanel, setActivePanel] = useState<PanelKey>(null);
  const [chatUnread, setChatUnread] = useState(0);
  const [captionsOn, setCaptionsOn] = useState(false);

  // Defaults to "translate everything into my own language" so two people
  // speaking different languages understand each other without having to
  // touch any settings; picking a language manually turns off the auto-sync.
  const [targetLang, setTargetLang] = useState<string>(ORIGINAL_LANG);
  const userPickedLangRef = useRef(false);
  useEffect(() => {
    if (!userPickedLangRef.current && self?.language) {
      setTargetLang(self.language);
    }
  }, [self?.language]);
  function handleTargetLangChange(lang: string) {
    userPickedLangRef.current = true;
    setTargetLang(lang);
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

  const peerIds = useMemo(
    () => (meeting ? meeting.participants.map((p) => p.id).filter((id) => id !== selfId) : []),
    [meeting, selfId]
  );

  const { remoteStreams } = useWebRTC({
    socket: getSocket(),
    selfId,
    peerIds,
    localStream: media.stream,
    enabled: media.ready,
  });

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

  const { supported: captionsSupported } = useSpeechRecognition({
    lang: self?.language ?? "es-AR",
    active: captionsOn && !media.muted && connectionStatus === "connected",
    onResult: (text) => sendTranscriptLine(text, self?.language ?? "es-AR"),
  });

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
    <div className="flex h-screen flex-col bg-ink-950">
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
            targetLang={targetLang}
            onTargetLangChange={handleTargetLangChange}
            getTranslation={getTranslation}
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
