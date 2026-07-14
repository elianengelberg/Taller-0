import IconButton from "./IconButton";
import ShareMenu from "./ShareMenu";
import { showToast } from "../lib/toasts";
import {
  screenCaptureSupported,
  RECORDING_UNSUPPORTED_MESSAGE,
  SHARE_UNSUPPORTED_MESSAGE,
} from "../lib/screenCapture";
import {
  CameraIcon,
  CameraOffIcon,
  CaptionsIcon,
  ChatIcon,
  HandIcon,
  MicIcon,
  MicOffIcon,
  PeopleIcon,
  PhoneOffIcon,
  RecordIcon,
  ScreenShareIcon,
  SettingsIcon,
  ShieldIcon,
  SparklesIcon,
  StopIcon,
  TranscriptIcon,
} from "./icons";

// A thin vertical rule between control clusters (personal AV / meeting
// features / host tools) -- Teams groups its toolbar the same way, instead of
// Zoom's single undifferentiated row. Hidden on mobile, where the grid wraps
// controls into rows and a rule would just float mid-row.
function Divider() {
  return <div aria-hidden className="hidden h-8 w-px shrink-0 bg-ink-700 sm:block" />;
}

interface ControlBarProps {
  meetingCode: string;
  muted: boolean;
  cameraOff: boolean;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  handRaised: boolean;
  onToggleHand: () => void;
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
  // Someone ELSE is presenting (name given): the share button explains
  // instead of starting a second share -- only one presenter at a time.
  shareBlockedBy?: string | null;
  // Host/co-host only: the moderation panel toggle. Hidden for participants.
  showHostControls?: boolean;
  hostControlsOpen?: boolean;
  onToggleHostControls?: () => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  onLeave: () => void;
}

export default function ControlBar({
  meetingCode,
  muted,
  cameraOff,
  onToggleMic,
  onToggleCamera,
  handRaised,
  onToggleHand,
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
  shareBlockedBy,
  showHostControls,
  hostControlsOpen,
  onToggleHostControls,
  settingsOpen,
  onToggleSettings,
  onLeave,
}: ControlBarProps) {
  // Deliberately not just another IconButton: Teams' "Salir" is a wide,
  // labeled red pill that stands apart from the rest of the toolbar, so
  // leaving reads as a distinct, weightier action rather than one icon among
  // equals -- and it's never confusable with the account menu's own
  // "Cerrar sesión" (that one signs you out of Unify; this one just
  // leaves the call).
  const leaveButton = (
    <button
      type="button"
      onClick={onLeave}
      aria-label="Salir de la reunión"
      title="Salir de la reunión"
      className="flex items-center gap-2 rounded-full bg-gradient-to-b from-red-500 to-red-600 px-4 py-3 text-sm font-semibold text-on-accent shadow-[0_4px_16px_-4px_rgba(220,38,38,0.5)] transition-all duration-150 hover:scale-105 hover:from-red-500 hover:to-red-700 active:scale-95"
    >
      <PhoneOffIcon className="h-5 w-5" />
      Salir
    </button>
  );

  return (
    <div className="flex flex-col gap-3 border-t border-ink-800 bg-ink-900/95 px-3 py-3 shadow-top backdrop-blur-md sm:flex-row sm:items-center sm:justify-between sm:px-6">
      {/* On phones the "salir" button rides along the same row as the meeting
          code (its own row on desktop, at the far right) so it's never
          competing for space with the icon grid below. */}
      <div className="flex items-center justify-between gap-3">
        <ShareMenu meetingCode={meetingCode} />
        <div className="sm:hidden">{leaveButton}</div>
      </div>

      {/* A 5-column grid keeps every control visible in tidy rows on a
          phone-width screen instead of overflowing off the right edge of a
          single row -- 11 controls become clean rows of 5, and it collapses
          back to a single centered row (grouped by Divider, Teams-style)
          once there's enough width for it. */}
      <div className="grid grid-cols-5 gap-x-1 gap-y-3 justify-items-center sm:flex sm:flex-1 sm:items-center sm:justify-center sm:gap-2">
        {/* Personal AV -- the controls over your own mic/camera/hand. */}
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
          label={handRaised ? "Bajar la mano" : "Levantar la mano"}
          caption="Mano"
          active={handRaised}
          onClick={onToggleHand}
        >
          <HandIcon className="h-5 w-5" />
        </IconButton>

        <Divider />

        {/* Meeting features -- shared with everyone in the call. */}
        <IconButton
          label={
            sharingScreen
              ? "Dejar de compartir pantalla"
              : !screenCaptureSupported
                ? "Compartir pantalla no está disponible en este navegador"
                : shareBlockedBy
                  ? `${shareBlockedBy} ya está compartiendo su pantalla`
                  : "Compartir pantalla"
          }
          caption={sharingScreen ? "Compartiendo" : shareBlockedBy ? "En uso" : "Compartir"}
          active={sharingScreen}
          onClick={
            !screenCaptureSupported && !sharingScreen
              ? () => showToast({ text: SHARE_UNSUPPORTED_MESSAGE, kind: "info" })
              : shareBlockedBy && !sharingScreen
                ? () =>
                    showToast({
                      text: `${shareBlockedBy} ya está compartiendo su pantalla. Cuando termine, vas a poder compartir la tuya.`,
                      kind: "info",
                    })
                : onToggleScreenShare
          }
        >
          <ScreenShareIcon className="h-5 w-5" />
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

        <Divider />

        {/* Host / recording tools. */}
        <IconButton
          label={
            recording
              ? "Detener grabación"
              : !screenCaptureSupported
                ? "La grabación no está disponible en este navegador"
                : 'Grabar la reunión (elegí "esta pestaña" y tildá compartir audio para grabar también lo que dicen los demás)'
          }
          caption={recording ? "Grabando" : "Grabar"}
          danger={recording}
          onClick={
            !screenCaptureSupported && !recording
              ? () => showToast({ text: RECORDING_UNSUPPORTED_MESSAGE, kind: "info" })
              : onToggleRecording
          }
        >
          {recording ? <StopIcon className="h-5 w-5" /> : <RecordIcon className="h-5 w-5" />}
        </IconButton>
        {showHostControls && (
          <IconButton
            label="Controles del anfitrión: permisos, sala de espera y seguridad"
            caption="Anfitrión"
            active={hostControlsOpen}
            onClick={onToggleHostControls}
          >
            <ShieldIcon className="h-5 w-5" />
          </IconButton>
        )}
        <IconButton
          label="Opciones: elegir micrófono, cámara y parlante"
          caption="Opciones"
          active={settingsOpen}
          onClick={onToggleSettings}
        >
          <SettingsIcon className="h-5 w-5" />
        </IconButton>
      </div>

      <div className="hidden sm:block">{leaveButton}</div>
    </div>
  );
}
