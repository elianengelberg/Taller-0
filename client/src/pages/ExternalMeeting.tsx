import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import AiChatBox from "../components/AiChatBox";
import IconButton from "../components/IconButton";
import JitsiEmbed from "../components/JitsiEmbed";
import LiveCaption from "../components/LiveCaption";
import Logo from "../components/Logo";
import RecordingBanner from "../components/RecordingBanner";
import SidePanel from "../components/SidePanel";
import TeamsEmbed from "../components/TeamsEmbed";
import TranscriptPanel from "../components/TranscriptPanel";
import ZoomEmbed from "../components/ZoomEmbed";
import {
  CaptionsIcon,
  PhoneOffIcon,
  RecordIcon,
  SparklesIcon,
  StopIcon,
  TranscriptIcon,
} from "../components/icons";
import { useMeeting } from "../context/MeetingContext";
import { AUTO_LANG, useLineTranslations } from "../hooks/useLineTranslations";
import { useRecorder } from "../hooks/useRecorder";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { askMeetingAI } from "../lib/api";
import { recentCaptionEntries } from "../lib/captionLines";
import { CompanionEmbed } from "../types";

type PanelKey = "transcript" | "ai" | null;

// Renders the actual external-meeting pane for a companion session. One branch
// per embeddable platform; adding a new platform means adding a case here.
function CompanionEmbedPane({
  embed,
  displayName,
  onLeave,
}: {
  embed: CompanionEmbed;
  displayName: string;
  onLeave: () => void;
}) {
  switch (embed.kind) {
    case "jitsi":
      return <JitsiEmbed roomName={embed.roomName} displayName={displayName} onLeave={onLeave} />;
    case "zoom":
      return (
        <ZoomEmbed
          meetingNumber={embed.meetingNumber}
          passcode={embed.passcode}
          displayName={displayName}
          onLeave={onLeave}
        />
      );
    case "teams":
      return <TeamsEmbed meetingLink={embed.meetingLink} displayName={displayName} onLeave={onLeave} />;
  }
}

// The Encuentro layer that runs ON TOP of an external meeting (Jitsi, Zoom,
// Teams...). The external platform handles audio/video (the embedded pane, with
// its own mic/camera/share controls); we add a fixed Encuentro toolbar with our
// live subtitles, transcript, translation, AI assistant and recording. The
// trick that makes this possible without reaching inside the cross-origin
// embed: our transcription listens to the user's OWN microphone (Web Speech
// API) and syncs everyone's captions through our backend keyed by the shared
// external-room key (see join-companion).
export default function ExternalMeeting() {
  const navigate = useNavigate();
  const {
    draft,
    connectionStatus,
    connectionError,
    connect,
    meeting,
    self,
    sendTranscriptLine,
    setSelfLanguage,
    leaveMeeting,
  } = useMeeting();

  const [activePanel, setActivePanel] = useState<PanelKey>(null);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [interimCaption, setInterimCaption] = useState<string | null>(null);
  const [targetLangChoice, setTargetLangChoice] = useState<string>(AUTO_LANG);

  const spokenLang = self?.language ?? (draft?.mode === "companion" ? draft.language : "es-AR");
  const targetLang = targetLangChoice === AUTO_LANG ? spokenLang : targetLangChoice;

  // No companion draft (e.g. someone refreshed this URL directly) -> there's
  // nothing to connect to; send them back to paste a link.
  useEffect(() => {
    if (!draft || draft.mode !== "companion") {
      navigate("/externa", { replace: true });
      return;
    }
    if (connectionStatus === "idle") connect();
  }, [draft, connectionStatus, connect, navigate]);

  // Same as the native meeting: leave cleanly on any navigation-away so the
  // server drops us from the companion room instead of keeping a ghost.
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

  useEffect(() => {
    if (!captionsOn) setInterimCaption(null);
  }, [captionsOn]);

  // Our own microphone, transcribed in the browser -- independent of the
  // external platform's own audio (which lives in an embed we can't touch).
  useSpeechRecognition({
    lang: spokenLang,
    active: connectionStatus === "connected",
    onInterim: (text) => setInterimCaption(text),
    onResult: (alternatives) => {
      setInterimCaption(null);
      sendTranscriptLine(alternatives, spokenLang);
    },
  });

  const { getTranslation } = useLineTranslations(meeting?.transcript ?? [], targetLang);

  // Records the whole tab (the embedded meeting + captions) with its audio.
  // No local mic stream here -- the external platform owns the mic -- but
  // getDisplayMedia with "share tab audio" captures the meeting's audio.
  const recorder = useRecorder({ micStream: null, meetingDbId: meeting?.dbId ?? null });
  function toggleRecording() {
    if (recorder.status === "recording") recorder.stop();
    else if (recorder.status === "idle" || recorder.status === "error") void recorder.start();
  }

  function togglePanel(panel: Exclude<PanelKey, null>) {
    setActivePanel((current) => (current === panel ? null : panel));
  }

  function handleLeave() {
    leaveMeeting();
    navigate("/", { replace: true });
  }

  if (!draft || draft.mode !== "companion") return null;

  const captionLines = captionsOn
    ? recentCaptionEntries(meeting?.transcript ?? [], getTranslation)
    : [];
  const participantCount = meeting?.participants.length ?? 0;
  const recording = recorder.status === "recording";

  return (
    <div className="flex h-dvh flex-col bg-ink-950">
      {/* Minimal top bar: brand + which meeting we're on + who's here. All the
          actions live in the fixed toolbar at the bottom (like Zoom / our own
          meeting), so nothing floats around. */}
      <header className="flex items-center justify-between gap-2 border-b border-ink-700 bg-ink-900 px-4 py-2.5 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Logo />
          <span className="hidden truncate text-xs text-ink-400 sm:inline">{draft.roomLabel}</span>
        </div>
        <span className="whitespace-nowrap text-xs font-medium text-ink-400">
          {participantCount} en Encuentro
        </span>
      </header>

      <div className="relative flex-1 overflow-hidden">
        {connectionStatus === "error" ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-brand-300">
            {connectionError ?? "No se pudo conectar la capa de Encuentro."}
          </div>
        ) : (
          <CompanionEmbedPane
            embed={draft.embed}
            displayName={draft.name}
            onLeave={handleLeave}
          />
        )}

        <LiveCaption
          lines={captionLines}
          localInterim={
            captionsOn && interimCaption ? { speakerName: draft.name || "Vos", text: interimCaption } : null
          }
        />

        <RecordingBanner
          status={recorder.status}
          uploadStatus={recorder.uploadStatus}
          error={recorder.error}
          resultUrl={recorder.resultUrl}
          onDismiss={recorder.reset}
        />

        {activePanel === "transcript" && (
          <div className="absolute inset-y-0 right-0 z-20 w-full sm:w-96">
            <TranscriptPanel
              onClose={() => setActivePanel(null)}
              targetLangChoice={targetLangChoice}
              resolvedTargetLang={targetLang}
              onTargetLangChange={setTargetLangChoice}
              getTranslation={getTranslation}
              spokenLang={spokenLang}
              onSpokenLangChange={setSelfLanguage}
            />
          </div>
        )}

        {activePanel === "ai" && (
          <div className="absolute inset-y-0 right-0 z-20 w-full sm:w-96">
            <SidePanel title="Asistente IA" onClose={() => setActivePanel(null)}>
              {meeting?.dbId ? (
                <AiChatBox
                  title="Preguntale a la IA"
                  description="Tu asistente durante la reunión: responde sobre lo que se está diciendo, resume y saca conclusiones."
                  placeholder='Ej: "resumime lo que se dijo hasta ahora"'
                  emptyHint="La IA usa la transcripción en vivo de esta reunión externa."
                  onAsk={(q) => askMeetingAI(meeting.dbId, q)}
                />
              ) : (
                <p className="text-sm text-ink-400">Conectando la reunión…</p>
              )}
            </SidePanel>
          </div>
        )}
      </div>

      {/* Fixed bottom toolbar -- the Encuentro layer's controls. Mic / camera /
          screen-share / participants come from the embedded platform's own
          toolbar; these are the tools we add on top. */}
      <div className="flex items-center justify-center gap-2 border-t border-ink-700 bg-ink-900 px-3 py-3 sm:gap-3 sm:px-6">
        <IconButton
          label="Mostrar u ocultar los subtítulos en vivo"
          caption="Subtítulos"
          active={captionsOn}
          onClick={() => setCaptionsOn((v) => !v)}
        >
          <CaptionsIcon className="h-5 w-5" />
        </IconButton>
        <IconButton
          label="Ver la transcripción completa y traducciones"
          caption="Transcripción"
          active={activePanel === "transcript"}
          onClick={() => togglePanel("transcript")}
        >
          <TranscriptIcon className="h-5 w-5" />
        </IconButton>
        <IconButton
          label="Abrir el asistente de IA de la reunión"
          caption="IA"
          active={activePanel === "ai"}
          onClick={() => togglePanel("ai")}
        >
          <SparklesIcon className="h-5 w-5" />
        </IconButton>
        <IconButton
          label={
            recording
              ? "Detener grabación"
              : 'Grabar la reunión (elegí "esta pestaña" y tildá compartir audio)'
          }
          caption={recording ? "Grabando" : "Grabar"}
          danger={recording}
          onClick={toggleRecording}
        >
          {recording ? <StopIcon className="h-5 w-5" /> : <RecordIcon className="h-5 w-5" />}
        </IconButton>
        <IconButton label="Salir de la reunión" caption="Salir" danger onClick={handleLeave}>
          <PhoneOffIcon className="h-5 w-5" />
        </IconButton>
      </div>
    </div>
  );
}
