import { useCallback, useEffect, useRef, useState } from "react";
import { isScreenTrack } from "../lib/screenCapture";

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
  /**
   * Saca la cámara del stream y la guarda viva, para que compartir pantalla
   * pueda ocupar su lugar. Devuelve la pista guardada (o null si no había).
   *
   * La custodia vive acá y no en useScreenShare a propósito: apagar la cámara
   * y cambiar de cámara son acciones de ESTE hook, y tienen que seguir
   * funcionando sobre la cámara real mientras la pantalla ocupa el stream.
   */
  parkCamera: () => MediaStreamTrack | null;
  /** La devuelve al stream, respetando el on/off vigente. */
  unparkCamera: () => MediaStreamTrack | null;
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
  // La cámara mientras está fuera del stream (compartiendo pantalla).
  const parkedCameraRef = useRef<MediaStreamTrack | null>(null);

  // La pista de cámara de verdad, esté en el stream o guardada aparte.
  const cameraTrack = useCallback((): MediaStreamTrack | null => {
    if (parkedCameraRef.current) return parkedCameraRef.current;
    return streamRef.current?.getVideoTracks().find((t) => !isScreenTrack(t)) ?? null;
  }, []);

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
      // La cámara guardada no está en el stream, así que hay que cerrarla
      // aparte o queda la luz prendida después de salir de la reunión.
      parkedCameraRef.current?.stop();
      parkedCameraRef.current = null;
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
      // Sólo la cámara, nunca la pantalla compartida: antes esto apagaba la
      // pista de video que hubiera en el stream, así que apretar "apagar
      // cámara" mientras compartías dejaba a todos viendo negro.
      const camera = cameraTrack();
      if (camera) camera.enabled = !next;
      return next;
    });
  }, [cameraTrack]);

  const parkCamera = useCallback(() => {
    const stream = streamRef.current;
    const camera = stream?.getVideoTracks().find((t) => !isScreenTrack(t)) ?? null;
    if (camera && stream) stream.removeTrack(camera);
    parkedCameraRef.current = camera;
    return camera;
  }, []);

  const unparkCamera = useCallback(() => {
    const camera = parkedCameraRef.current;
    parkedCameraRef.current = null;
    // Puede haber muerto mientras tanto (cámara desenchufada, pestaña
    // suspendida): devolver una pista terminada dejaría un cuadro congelado.
    if (!camera || camera.readyState !== "live") return null;
    camera.enabled = !cameraOffRef.current;
    streamRef.current?.addTrack(camera);
    return camera;
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

        // Respect the current on/off toggle so switching doesn't unexpectedly
        // un-mute / turn the camera back on.
        newTrack.enabled = kind === "audio" ? !mutedRef.current : !cameraOffRef.current;

        // Cambiar de cámara mientras se comparte pantalla: la cámara nueva
        // reemplaza a la GUARDADA y entra al stream recién cuando termine el
        // share. Antes se metía en el stream pisando la pantalla compartida,
        // que además quedaba detenida con el estado en "compartiendo" para
        // siempre -- nadie más podía compartir.
        if (kind === "video" && parkedCameraRef.current) {
          const parked = parkedCameraRef.current;
          parkedCameraRef.current = newTrack;
          parked.stop();
          setActiveCameraId(deviceId);
          void refreshDevices();
          return;
        }

        const oldTrack =
          (kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks())[0] ?? null;

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
    parkCamera,
    unparkCamera,
  };
}
