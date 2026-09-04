import { useId } from "react";
import { MediaDevices } from "../hooks/useLocalMedia";
import { CameraIcon, MicIcon, SpeakerIcon } from "./icons";
import SidePanel from "./SidePanel";
import TextoGrandeToggle from "./TextoGrandeToggle";

interface Props {
  devices: MediaDevices;
  activeMicId: string | null;
  activeCameraId: string | null;
  activeSpeakerId: string | null;
  onSelectMic: (deviceId: string) => void;
  onSelectCamera: (deviceId: string) => void;
  onSelectSpeaker: (deviceId: string) => void;
  onClose: () => void;
  side?: "left" | "right";
}

// The in-meeting "Opciones" panel: pick which microphone, camera and speaker
// to use (like Zoom), so people with several devices — or one that isn't
// working — can switch without leaving the call.
export default function SettingsPanel({
  devices,
  activeMicId,
  activeCameraId,
  activeSpeakerId,
  onSelectMic,
  onSelectCamera,
  onSelectSpeaker,
  onClose,
  side,
}: Props) {
  // Some browsers (Firefox) can't route audio output per element, so only
  // offer the speaker picker where it actually works.
  const speakerSupported =
    typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

  return (
    <SidePanel title="Opciones" onClose={onClose} side={side}>
      <div className="space-y-5">
        <DeviceSelect
          icon={<MicIcon className="h-4 w-4" />}
          label="Micrófono"
          devices={devices.mics}
          value={activeMicId}
          onChange={onSelectMic}
          fallback="Micrófono"
        />
        <DeviceSelect
          icon={<CameraIcon className="h-4 w-4" />}
          label="Cámara"
          devices={devices.cameras}
          value={activeCameraId}
          onChange={onSelectCamera}
          fallback="Cámara"
        />
        {speakerSupported && devices.speakers.length > 0 && (
          <DeviceSelect
            icon={<SpeakerIcon className="h-4 w-4" />}
            label="Parlante"
            devices={devices.speakers}
            value={activeSpeakerId}
            onChange={onSelectSpeaker}
            fallback="Parlante"
          />
        )}
        <div className="border-t border-ink-700 pt-4">
          <p className="mb-2 text-sm font-semibold text-strong">Tamaño de la letra</p>
          <TextoGrandeToggle />
          <p className="mt-2 text-xs text-ink-500">
            Agranda los subtítulos, el chat y todos los textos de Unify, en todas las pantallas. Se
            recuerda para la próxima.
          </p>
        </div>
        <p className="text-xs text-ink-500">
          Si conectás o desconectás un dispositivo, la lista se actualiza sola. El cambio se aplica al
          instante, sin salir de la reunión.
        </p>
      </div>
    </SidePanel>
  );
}

function DeviceSelect({
  icon,
  label,
  devices,
  value,
  onChange,
  fallback,
}: {
  icon: React.ReactNode;
  label: string;
  devices: MediaDeviceInfo[];
  value: string | null;
  onChange: (deviceId: string) => void;
  fallback: string;
}) {
  const empty = devices.length === 0;
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 flex items-center gap-2 text-sm font-medium text-ink-200">
        <span className="text-brand-300">{icon}</span>
        {label}
      </label>
      <select
        id={id}
        className="w-full rounded-xl border border-ink-600 bg-ink-800 px-3 py-2.5 text-sm text-ink-50 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:opacity-50"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={empty}
      >
        {empty && <option value="">No se detectaron dispositivos</option>}
        {devices.map((d, i) => (
          <option key={d.deviceId || i} value={d.deviceId}>
            {d.label || `${fallback} ${i + 1}`}
          </option>
        ))}
      </select>
    </div>
  );
}
