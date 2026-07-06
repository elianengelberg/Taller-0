import IconButton from "./IconButton";
import ShareMenu from "./ShareMenu";
import {
  CameraIcon,
  CameraOffIcon,
  CaptionsIcon,
  ChatIcon,
  MicIcon,
  MicOffIcon,
  PeopleIcon,
  PhoneOffIcon,
  RecordIcon,
  ScreenShareIcon,
  SparklesIcon,
  StopIcon,
  TranscriptIcon,
} from "./icons";

interface ControlBarProps {
  meetingCode: string;
  muted: boolean;
  cameraOff: boolean;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  captionsOn: boolean;
  captionsSupported: boolean;
  onToggleCaptions: () => void;
  chatOpen: boolean;
  chatUnread: number;
  onToggleChat: () => void;
  participantsOpen: boolean;
  onToggleParticipants: () => void;
  transcriptOpen: boolean;
  onToggleTranscript: () => void;
  aiOpen: boolean;
  onToggleAi: () => void;
  recording: boolean;
  onToggleRecording: () => void;
  sharingScreen: boolean;
  onToggleScreenShare: () => void;
  onLeave: () => void;
}

export default function ControlBar({
  meetingCode,
  muted,
  cameraOff,
  onToggleMic,
  onToggleCamera,
  captionsOn,
  captionsSupported,
  onToggleCaptions,
  chatOpen,
  chatUnread,
  onToggleChat,
  participantsOpen,
  onToggleParticipants,
  transcriptOpen,
  onToggleTranscript,
  aiOpen,
  onToggleAi,
  recording,
  onToggleRecording,
  sharingScreen,
  onToggleScreenShare,
  onLeave,
}: ControlBarProps) {
  const leaveButton = (
    <IconButton label="Salir de la reunión" caption="Salir" danger onClick={onLeave}>
      <PhoneOffIcon className="h-5 w-5" />
    </IconButton>
  );

  return (
    <div className="flex flex-col gap-3 border-t border-ink-700 bg-ink-900 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
      {/* On phones the "salir" button rides along the same row as the meeting
          code (its own row on desktop, at the far right) so it's never
          competing for space with the icon grid below. */}
      <div className="flex items-center justify-between gap-3">
        <ShareMenu meetingCode={meetingCode} />
        <div className="sm:hidden">{leaveButton}</div>
      </div>

      {/* A 3-column grid keeps every control visible in tidy rows on a
          phone-width screen instead of overflowing off the right edge of a
          single row -- 9 controls become 3 even rows of 3, and it collapses
          back to a single centered row once there's enough width for it. */}
      <div className="grid grid-cols-3 gap-x-2 gap-y-3 justify-items-center sm:flex sm:flex-1 sm:items-center sm:justify-center sm:gap-3">
        <IconButton
          label={muted ? "Activar micrófono" : "Silenciar micrófono"}
          caption={muted ? "Silenciado" : "Micrófono"}
          danger={muted}
          onClick={onToggleMic}
        >
          {muted ? <MicOffIcon className="h-5 w-5" /> : <MicIcon className="h-5 w-5" />}
        </IconButton>
        <IconButton
          label={cameraOff ? "Activar cámara" : "Apagar cámara"}
          caption={cameraOff ? "Cámara apagada" : "Cámara"}
          danger={cameraOff}
          onClick={onToggleCamera}
        >
          {cameraOff ? <CameraOffIcon className="h-5 w-5" /> : <CameraIcon className="h-5 w-5" />}
        </IconButton>
        <IconButton
          label={captionsSupported ? "Subtítulos en vivo" : "Subtítulos no disponibles en este navegador"}
          caption="Subtítulos"
          active={captionsOn}
          onClick={captionsSupported ? onToggleCaptions : undefined}
        >
          <CaptionsIcon className="h-5 w-5" />
        </IconButton>
        <IconButton
          label="Ver transcripción completa"
          caption="Transcripción"
          active={transcriptOpen}
          onClick={onToggleTranscript}
        >
          <TranscriptIcon className="h-5 w-5" />
        </IconButton>
        <IconButton
          label={sharingScreen ? "Dejar de compartir pantalla" : "Compartir pantalla"}
          caption={sharingScreen ? "Compartiendo" : "Compartir"}
          active={sharingScreen}
          onClick={onToggleScreenShare}
        >
          <ScreenShareIcon className="h-5 w-5" />
        </IconButton>
        <IconButton
          label="Ver participantes y asignar roles"
          caption="Participantes"
          active={participantsOpen}
          onClick={onToggleParticipants}
        >
          <PeopleIcon className="h-5 w-5" />
        </IconButton>
        <IconButton label="Chat" caption="Chat" active={chatOpen} badge={chatUnread} onClick={onToggleChat}>
          <ChatIcon className="h-5 w-5" />
        </IconButton>
        <IconButton
          label="Abrir el asistente de IA de la reunión"
          caption="IA"
          active={aiOpen}
          onClick={onToggleAi}
        >
          <SparklesIcon className="h-5 w-5" />
        </IconButton>
        <IconButton
          label={
            recording
              ? "Detener grabación"
              : 'Grabar la reunión (elegí "esta pestaña" y tildá compartir audio para grabar también lo que dicen los demás)'
          }
          caption={recording ? "Grabando" : "Grabar"}
          danger={recording}
          onClick={onToggleRecording}
        >
          {recording ? <StopIcon className="h-5 w-5" /> : <RecordIcon className="h-5 w-5" />}
        </IconButton>
      </div>

      <div className="hidden sm:block">{leaveButton}</div>
    </div>
  );
}
