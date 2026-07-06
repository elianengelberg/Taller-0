import { useCallback, useEffect, useRef, useState } from "react";

export interface MediaDevices {
  mics: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
}

type ReplaceTrack = (oldTrack: MediaStreamTrack | null, newTrack: MediaStreamTrack) => void;

export interface LocalMediaState {
  stream: MediaStream | null;
  ready: boolean;
  muted: boolean;
  cameraOff: boolean;
  error: string | null;
  toggleMic: () => void;
  toggleCamera: () => void;
  devices: MediaDevices;
  activeMicId: string | null;
  activeCameraId: string | null;
  activeSpeakerId: string | null;
  // Switch the active mic/camera live: re-acquires the track and swaps it into
  // the existing stream + every peer connection (via `onReplace`), so no
  // reconnect is needed. Speaker selection is applied to the audio output
  // elements by the caller (see setActiveSpeakerId).
  switchMic: (deviceId: string, onReplace?: ReplaceTrack) => Promise<void>;
  switchCamera: (deviceId: string, onReplace?: ReplaceTrack) => Promise<void>;
  setActiveSpeakerId: (deviceId: string) => void;
}

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  sampleRate: { ideal: 48000 },
  channelCount: { ideal: 1 },
};

const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
};

export function useLocalMedia(): LocalMediaState {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDevices>({ mics: [], cameras: [], speakers: [] });
  const [activeMicId, setActiveMicId] = useState<string | null>(null);
  const [activeCameraId, setActiveCameraId] = useState<string | null>(null);
  const [activeSpeakerId, setActiveSpeakerId] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  // Read current toggle state inside async switch handlers without stale closures.
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const cameraOffRef = useRef(cameraOff);
  cameraOffRef.current = cameraOff;

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices({
        mics: list.filter((d) => d.kind === "audioinput"),
        cameras: list.filter((d) => d.kind === "videoinput"),
        speakers: list.filter((d) => d.kind === "audiooutput"),
      });
    } catch {
      // enumeration can fail on some browsers -- selectors just stay empty.
    }
  }, []);

  const adoptStream = useCallback(
    (mediaStream: MediaStream) => {
      streamRef.current = mediaStream;
      setStream(mediaStream);
      setActiveMicId(mediaStream.getAudioTracks()[0]?.getSettings().deviceId ?? null);
      setActiveCameraId(mediaStream.getVideoTracks()[0]?.getSettings().deviceId ?? null);
      setReady(true);
      void refreshDevices();
    },
    [refreshDevices]
  );

  useEffect(() => {
    let cancelled = false;

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Este navegador no permite acceder a la cámara o al micrófono.");
      setReady(true);
      return;
    }

    navigator.mediaDevices
      .getUserMedia({ video: VIDEO_CONSTRAINTS, audio: AUDIO_CONSTRAINTS })
      .then((mediaStream) => {
        if (cancelled) {
          mediaStream.getTracks().forEach((t) => t.stop());
          return;
        }
        adoptStream(mediaStream);
      })
      .catch(() => {
        if (cancelled) return;
        // getUserMedia rejects the WHOLE request if either track can't be
        // satisfied -- fall back to audio-only so someone with no camera still
        // gets in (camera-off already shows an avatar placeholder).
        navigator.mediaDevices
          .getUserMedia({ audio: AUDIO_CONSTRAINTS })
          .then((audioOnly) => {
            if (cancelled) {
              audioOnly.getTracks().forEach((t) => t.stop());
              return;
            }
            adoptStream(audioOnly);
            setCameraOff(true);
            setError("No encontramos una cámara (o el permiso fue denegado) — te uniste solo con audio.");
          })
          .catch(() => {
            if (cancelled) return;
            setError("No pudimos acceder a tu cámara o micrófono. Revisá los permisos del navegador.");
            setReady(true);
          });
      });

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [adoptStream]);

  // Re-list devices when the user plugs/unplugs one, so the pickers stay current.
  useEffect(() => {
    if (!navigator.mediaDevices) return;
    const handler = () => void refreshDevices();
    navigator.mediaDevices.addEventListener?.("devicechange", handler);
    return () => navigator.mediaDevices.removeEventListener?.("devicechange", handler);
  }, [refreshDevices]);

  const toggleMic = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
      return next;
    });
  }, []);

  const toggleCamera = useCallback(() => {
    setCameraOff((prev) => {
      const next = !prev;
      streamRef.current?.getVideoTracks().forEach((t) => (t.enabled = !next));
      return next;
    });
  }, []);

  const switchTrack = useCallback(
    async (kind: "audio" | "video", deviceId: string, onReplace?: ReplaceTrack) => {
      const stream = streamRef.current;
      if (!stream) return;
      try {
        const constraints =
          kind === "audio"
            ? { audio: { ...AUDIO_CONSTRAINTS, deviceId: { exact: deviceId } } }
            : { video: { ...VIDEO_CONSTRAINTS, deviceId: { exact: deviceId } } };
        const tmp = await navigator.mediaDevices.getUserMedia(constraints);
        const newTrack = (kind === "audio" ? tmp.getAudioTracks() : tmp.getVideoTracks())[0];
        if (!newTrack) return;

        const oldTrack =
          (kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks())[0] ?? null;
        // Respect the current on/off toggle so switching doesn't unexpectedly
        // un-mute / turn the camera back on.
        newTrack.enabled = kind === "audio" ? !mutedRef.current : !cameraOffRef.current;

        if (oldTrack) stream.removeTrack(oldTrack);
        stream.addTrack(newTrack);
        // Swap it into every peer connection, then stop the old device.
        onReplace?.(oldTrack, newTrack);
        oldTrack?.stop();

        if (kind === "audio") setActiveMicId(deviceId);
        else setActiveCameraId(deviceId);
        void refreshDevices();
      } catch {
        // Device busy / unplugged mid-switch -- keep the current one.
      }
    },
    [refreshDevices]
  );

  const switchMic = useCallback(
    (deviceId: string, onReplace?: ReplaceTrack) => switchTrack("audio", deviceId, onReplace),
    [switchTrack]
  );
  const switchCamera = useCallback(
    (deviceId: string, onReplace?: ReplaceTrack) => switchTrack("video", deviceId, onReplace),
    [switchTrack]
  );

  return {
    stream,
    ready,
    muted,
    cameraOff,
    error,
    toggleMic,
    toggleCamera,
    devices,
    activeMicId,
    activeCameraId,
    activeSpeakerId,
    switchMic,
    switchCamera,
    setActiveSpeakerId,
  };
}
