import { useState } from "react";
import IconButton from "./IconButton";
import {
  CameraIcon,
  CameraOffIcon,
  CaptionsIcon,
  ChatIcon,
  CopyIcon,
  MicIcon,
  MicOffIcon,
  PeopleIcon,
  PhoneOffIcon,
  RecordIcon,
  ScreenShareIcon,
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
  recording,
  onToggleRecording,
  sharingScreen,
  onToggleScreenShare,
  onLeave,
}: ControlBarProps) {
  const [copied, setCopied] = useState(false);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(meetingCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-700 bg-ink-900 px-4 py-3 sm:px-6">
      <button
        type="button"
        onClick={copyCode}
        className="flex items-center gap-2 rounded-xl border border-ink-600 px-3 py-2 text-sm font-medium text-ink-200 hover:border-brand-400"
        title="Copiar código de la reunión"
      >
        <CopyIcon className="h-4 w-4" />
        {copied ? "¡Copiado!" : meetingCode}
      </button>

      <div className="flex items-center gap-2 sm:gap-3">
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

      <IconButton label="Salir de la reunión" caption="Salir" danger onClick={onLeave}>
        <PhoneOffIcon className="h-5 w-5" />
      </IconButton>
    </div>
  );
}
