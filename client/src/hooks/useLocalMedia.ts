import { useCallback, useEffect, useRef, useState } from "react";

export interface LocalMediaState {
  stream: MediaStream | null;
  ready: boolean;
  muted: boolean;
  cameraOff: boolean;
  error: string | null;
  toggleMic: () => void;
  toggleCamera: () => void;
}

export function useLocalMedia(): LocalMediaState {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Este navegador no permite acceder a la cámara o al micrófono.");
      setReady(true);
      return;
    }

    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      // Match Opus's native rate so the browser doesn't resample and
      // lose quality before it ever reaches the encoder.
      sampleRate: { ideal: 48000 },
      channelCount: { ideal: 1 },
    };

    navigator.mediaDevices
      .getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
        audio: audioConstraints,
      })
      .then((mediaStream) => {
        if (cancelled) {
          mediaStream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = mediaStream;
        setStream(mediaStream);
        setReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        // getUserMedia rejects the WHOLE request if either track can't be
        // satisfied -- someone with no camera (or camera permission denied
        // while the mic is fine) would otherwise be completely locked out of
        // joining instead of just missing video, which the rest of the UI
        // already handles fine (camera-off shows an avatar placeholder).
        navigator.mediaDevices
          .getUserMedia({ audio: audioConstraints })
          .then((audioOnlyStream) => {
            if (cancelled) {
              audioOnlyStream.getTracks().forEach((track) => track.stop());
              return;
            }
            streamRef.current = audioOnlyStream;
            setStream(audioOnlyStream);
            setCameraOff(true);
            setError(
              "No encontramos una cámara (o el permiso fue denegado) -- te uniste solo con audio."
            );
            setReady(true);
          })
          .catch(() => {
            if (cancelled) return;
            setError("No pudimos acceder a tu cámara o micrófono. Revisá los permisos del navegador.");
            setReady(true);
          });
      });

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  const toggleMic = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      streamRef.current?.getAudioTracks().forEach((track) => {
        track.enabled = !next;
      });
      return next;
    });
  }, []);

  const toggleCamera = useCallback(() => {
    setCameraOff((prev) => {
      const next = !prev;
      streamRef.current?.getVideoTracks().forEach((track) => {
        track.enabled = !next;
      });
      return next;
    });
  }, []);

  return { stream, ready, muted, cameraOff, error, toggleMic, toggleCamera };
}
