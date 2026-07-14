import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import AiChatBox from "../components/AiChatBox";
import IconButton from "../components/IconButton";
import JitsiEmbed from "../components/JitsiEmbed";
import LiveCaption from "../components/LiveCaption";
import MeetCompanionPane from "../components/MeetCompanionPane";
import Logo from "../components/Logo";
import RecordingBanner from "../components/RecordingBanner";
import SaveMeetingPrompt from "../components/SaveMeetingPrompt";
import SidePanel from "../components/SidePanel";
import TeamsEmbed from "../components/TeamsEmbed";
import TranscriptPanel from "../components/TranscriptPanel";
import ZoomEmbed from "../components/ZoomEmbed";
import {
  CaptionsIcon,
  PeopleIcon,
  PhoneOffIcon,
  RecordIcon,
  SparklesIcon,
  StopIcon,
  TranscriptIcon,
} from "../components/icons";
import { useAuth } from "../context/AuthContext";
import { useMeeting } from "../context/MeetingContext";
import { AUTO_LANG, useLineTranslations } from "../hooks/useLineTranslations";
import { useRecorder } from "../hooks/useRecorder";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { askMeetingAI } from "../lib/api";
import { recentCaptionEntries } from "../lib/captionLines";
import { screenCaptureSupported } from "../lib/screenCapture";
import { setUnsavedMeeting } from "../lib/unsavedMeeting";
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
    case "meet":
      return <MeetCompanionPane meetLink={embed.meetLink} meetCode={embed.meetCode} />;
  }
}

// The Unify layer that runs ON TOP of an external meeting (Jitsi, Zoom,
// Teams...). The external platform handles audio/video (the embedded pane, with
// its own mic/camera/share controls); we add a fixed Unify toolbar with our
// live subtitles, transcript, translation, AI assistant and recording. The
// trick that makes this possible without reaching inside the cross-origin
// embed: our transcription listens to the user's OWN microphone (Web Speech
// API) and syncs everyone's captions through our backend keyed by the shared
// external-room key (see join-companion).
export default function ExternalMeeting() {
  const navigate = useNavigate();
  const { user } = useAuth();
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

  // Same guest-save prompt as the native meeting -- see Meeting.tsx.
  const [pendingLeave, setPendingLeave] = useState<string | null>(null);
  function handleLeave() {
    if (!user && meeting?.dbId) {
      setPendingLeave(meeting.dbId);
      return;
    }
    leaveMeeting();
    navigate("/", { replace: true });
  }
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
      <header className="flex items-center justify-between gap-2 border-b border-ink-800 bg-ink-900/95 px-4 py-2.5 shadow-soft backdrop-blur-md sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Logo />
          <span className="hidden truncate text-xs text-ink-400 sm:inline">{draft.roomLabel}</span>
        </div>
        <div className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-ink-800 px-3 py-1.5 ring-1 ring-ink-700">
          <PeopleIcon className="h-3.5 w-3.5 text-brand-300" />
          <span className="text-xs font-medium text-ink-200">{participantCount} en Unify</span>
        </div>
      </header>

      {/* flex (not just relative) so the transcript/AI panel becomes a real
          column beside the embed on desktop -- SidePanel switches to
          `sm:static sm:w-96 sm:shrink-0` there, which only lines up correctly
          inside an actual flex row. */}
      <div className="relative flex flex-1 overflow-hidden">
        <div className="relative min-w-0 flex-1 overflow-hidden">
          {connectionStatus === "error" ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-brand-300">
              {connectionError ?? "No se pudo conectar la capa de Unify."}
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
        </div>

        {/* SidePanel positions itself (overlay on mobile, static column on
            desktop beside the embed div above). */}
        {activePanel === "transcript" && (
          <TranscriptPanel
            onClose={() => setActivePanel(null)}
            targetLangChoice={targetLangChoice}
            resolvedTargetLang={targetLang}
            onTargetLangChange={setTargetLangChoice}
            getTranslation={getTranslation}
            spokenLang={spokenLang}
            onSpokenLangChange={setSelfLanguage}
          />
        )}

        {activePanel === "ai" && (
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
        )}
      </div>

      {/* Fixed bottom toolbar -- the Unify layer's controls. Mic / camera /
          screen-share / participants come from the embedded platform's own
          toolbar; these are the tools we add on top. */}
      <div className="flex items-center justify-center gap-2 border-t border-ink-800 bg-ink-900/95 px-3 py-3 shadow-top backdrop-blur-md sm:gap-3 sm:px-6">
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
              : !screenCaptureSupported
                ? "La grabación no está disponible en este navegador"
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
      {pendingLeave && <SaveMeetingPrompt onSave={confirmSaveMeeting} onSkip={skipSaveMeeting} />}
    </div>
  );
}
