import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import AiChatBox from "../components/AiChatBox";
import IconButton from "../components/IconButton";
import JitsiEmbed from "../components/JitsiEmbed";
import LiveCaption from "../components/LiveCaption";
import Logo from "../components/Logo";
import SidePanel from "../components/SidePanel";
import TranscriptPanel from "../components/TranscriptPanel";
import ZoomEmbed from "../components/ZoomEmbed";
import { CaptionsIcon, PhoneOffIcon, SparklesIcon, TranscriptIcon } from "../components/icons";
import { useMeeting } from "../context/MeetingContext";
import { AUTO_LANG, useLineTranslations } from "../hooks/useLineTranslations";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { askMeetingAI } from "../lib/api";
import { CompanionEmbed } from "../types";

type PanelKey = "transcript" | "ai" | null;

// Renders the actual external-meeting pane for a companion session. One branch
// per embeddable platform; adding Teams later means adding a case here.
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
  }
}

// The Encuentro layer that runs ON TOP of an external meeting (Jitsi, Zoom...).
// The external platform handles audio/video (the embedded pane); we add our
// live subtitles, transcript, translation and AI. The trick that makes this
// possible without reaching inside the cross-origin embed: our transcription
// listens to the user's OWN microphone (Web Speech API), exactly like the
// native app, and syncs everyone's captions through our backend keyed by the
// shared external-room key (see join-companion). So two people who both open
// the same link through Encuentro see each other's translated captions.
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

  if (!draft || draft.mode !== "companion") return null;

  const lastLine = meeting?.transcript[meeting.transcript.length - 1] ?? null;

  return (
    <div className="flex h-dvh flex-col bg-ink-950">
      <header className="flex items-center justify-between gap-2 border-b border-ink-700 bg-ink-900 px-3 py-2 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Logo />
          <span className="hidden truncate text-xs text-ink-400 sm:inline">{draft.roomLabel}</span>
        </div>
        <div className="flex items-center gap-1 sm:gap-2">
          <IconButton
            label="Mostrar u ocultar los subtítulos en vivo"
            caption="Subtítulos"
            active={captionsOn}
            onClick={() => setCaptionsOn((v) => !v)}
          >
            <CaptionsIcon className="h-5 w-5" />
          </IconButton>
          <IconButton
            label="Ver la transcripción completa"
            caption="Transcripción"
            active={activePanel === "transcript"}
            onClick={() => setActivePanel((p) => (p === "transcript" ? null : "transcript"))}
          >
            <TranscriptIcon className="h-5 w-5" />
          </IconButton>
          <IconButton
            label="Preguntarle a la IA sobre esta reunión"
            caption="IA"
            active={activePanel === "ai"}
            onClick={() => setActivePanel((p) => (p === "ai" ? null : "ai"))}
          >
            <SparklesIcon className="h-5 w-5" />
          </IconButton>
          <IconButton
            label="Salir de la reunión"
            caption="Salir"
            danger
            onClick={() => {
              leaveMeeting();
              navigate("/", { replace: true });
            }}
          >
            <PhoneOffIcon className="h-5 w-5" />
          </IconButton>
        </div>
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
            onLeave={() => {
              leaveMeeting();
              navigate("/", { replace: true });
            }}
          />
        )}

        <LiveCaption
          line={captionsOn ? lastLine : null}
          translatedText={captionsOn && lastLine ? getTranslation(lastLine.id) : undefined}
          localInterim={
            captionsOn && interimCaption ? { speakerName: draft.name || "Vos", text: interimCaption } : null
          }
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
            <SidePanel title="IA de la reunión" onClose={() => setActivePanel(null)}>
              {meeting?.dbId ? (
                <AiChatBox
                  title="Preguntale a la IA"
                  description="Responde en base a lo que se transcribió de esta reunión."
                  placeholder='Ej: "¿qué se dijo hasta ahora?"'
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
    </div>
  );
}
