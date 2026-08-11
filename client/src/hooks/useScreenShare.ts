import { useCallback, useEffect, useRef, useState } from "react";
import {
  displayMediaErrorMessage,
  markScreenTrack,
  screenCaptureSupported,
  SHARE_UNSUPPORTED_MESSAGE,
} from "../lib/screenCapture";

interface UseScreenShareOptions {
  localStream: MediaStream | null;
  onReplaceTrack: (oldTrack: MediaStreamTrack | null, newTrack: MediaStreamTrack) => void;
  onRemoveTrack: (track: MediaStreamTrack) => void;
  /** Saca la cámara del stream y la conserva viva (ver useLocalMedia). */
  parkCamera: () => MediaStreamTrack | null;
  /** La devuelve al stream con el on/off vigente. */
  unparkCamera: () => MediaStreamTrack | null;
}

// Screen sharing reuses the same "video slot" used for the camera: while
// sharing, the shared screen replaces the camera track both in the local
// preview (same MediaStream object, so any bound <video> updates on its
// own) and on every WebRTC peer connection. Stopping restores the original
// camera track. If there was no camera track to begin with, the screen
// track is just added/removed as an extra track instead of swapped.
//
// La cámara NO se guarda acá: la custodia la tiene useLocalMedia, que es quien
// tiene que seguir pudiendo apagarla y cambiarla mientras la pantalla ocupa su
// lugar en el stream.
export function useScreenShare({
  localStream,
  onReplaceTrack,
  onRemoveTrack,
  parkCamera,
  unparkCamera,
}: UseScreenShareOptions) {
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);

  const stop = useCallback(() => {
    const screenTrack = screenTrackRef.current;
    if (!screenTrack) return;
    screenTrackRef.current = null;

    localStream?.removeTrack(screenTrack);
    const cameraTrack = unparkCamera();
    if (cameraTrack) {
      onReplaceTrack(screenTrack, cameraTrack);
    } else {
      onRemoveTrack(screenTrack);
    }
    screenTrack.stop();
    setSharing(false);
  }, [localStream, onReplaceTrack, onRemoveTrack, unparkCamera]);

  // El listener de "dejaste de compartir" (el botón del navegador) se registra
  // UNA vez al empezar y vive lo que dura la pista, pero `stop` se recrea en
  // cada render. Sin este puntero, el listener se quedaría llamando a una
  // versión vieja de `stop` con datos de aquel render.
  const stopRef = useRef(stop);
  stopRef.current = stop;

  const start = useCallback(async () => {
    if (!localStream) return;
    setError(null);
    if (!screenCaptureSupported) {
      setError(SHARE_UNSUPPORTED_MESSAGE);
      return;
    }
    // Dos clics seguidos en "Compartir" abrirían dos capturas y la primera
    // quedaría viva sin que nada la pueda detener.
    if (screenTrackRef.current) return;
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = displayStream.getVideoTracks()[0];
      if (!screenTrack) throw new Error("No se encontró video para compartir.");
      markScreenTrack(screenTrack);

      const cameraTrack = parkCamera();
      screenTrackRef.current = screenTrack;
      localStream.addTrack(screenTrack);
      onReplaceTrack(cameraTrack, screenTrack);

      // If the user stops sharing from the browser's own "Stop sharing" UI
      // instead of our button, treat it the same as pressing our button.
      screenTrack.addEventListener("ended", () => stopRef.current());

      setSharing(true);
    } catch (err) {
      setError(displayMediaErrorMessage(err, "compartir la pantalla"));
    }
  }, [localStream, onReplaceTrack, parkCamera]);

  useEffect(() => {
    return () => {
      screenTrackRef.current?.stop();
    };
  }, []);

  // Unlike a caption/recording error, there's no other UI in the meeting
  // that naturally clears this -- without a timeout it would sit on screen
  // for the rest of the call after a single cancelled share attempt.
  useEffect(() => {
    if (!error) return;
    const timeout = setTimeout(() => setError(null), 12000);
    return () => clearTimeout(timeout);
  }, [error]);

  return { sharing, error, start, stop };
}
