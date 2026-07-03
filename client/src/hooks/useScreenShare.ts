import { useCallback, useEffect, useRef, useState } from "react";

interface UseScreenShareOptions {
  localStream: MediaStream | null;
  onReplaceTrack: (oldTrack: MediaStreamTrack | null, newTrack: MediaStreamTrack) => void;
  onRemoveTrack: (track: MediaStreamTrack) => void;
}

// Screen sharing reuses the same "video slot" used for the camera: while
// sharing, the shared screen replaces the camera track both in the local
// preview (same MediaStream object, so any bound <video> updates on its
// own) and on every WebRTC peer connection. Stopping restores the original
// camera track. If there was no camera track to begin with, the screen
// track is just added/removed as an extra track instead of swapped.
export function useScreenShare({ localStream, onReplaceTrack, onRemoveTrack }: UseScreenShareOptions) {
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);

  const stop = useCallback(() => {
    const stream = localStream;
    const screenTrack = screenTrackRef.current;
    const cameraTrack = cameraTrackRef.current;
    if (!screenTrack) return;

    if (stream) {
      stream.removeTrack(screenTrack);
      if (cameraTrack) stream.addTrack(cameraTrack);
    }
    if (cameraTrack) {
      onReplaceTrack(screenTrack, cameraTrack);
    } else {
      onRemoveTrack(screenTrack);
    }
    screenTrack.stop();

    screenTrackRef.current = null;
    cameraTrackRef.current = null;
    setSharing(false);
  }, [localStream, onReplaceTrack, onRemoveTrack]);

  const start = useCallback(async () => {
    if (!localStream) return;
    setError(null);
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = displayStream.getVideoTracks()[0];
      if (!screenTrack) throw new Error("No se encontró video para compartir.");

      const cameraTrack = localStream.getVideoTracks()[0] ?? null;
      screenTrackRef.current = screenTrack;
      cameraTrackRef.current = cameraTrack;

      if (cameraTrack) localStream.removeTrack(cameraTrack);
      localStream.addTrack(screenTrack);
      onReplaceTrack(cameraTrack, screenTrack);

      // If the user stops sharing from the browser's own "Stop sharing" UI
      // instead of our button, treat it the same as pressing our button.
      screenTrack.addEventListener("ended", stop);

      setSharing(true);
    } catch {
      setError("No se pudo compartir la pantalla (¿cancelaste el permiso?).");
    }
  }, [localStream, onReplaceTrack, stop]);

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
    const timeout = setTimeout(() => setError(null), 8000);
    return () => clearTimeout(timeout);
  }, [error]);

  return { sharing, error, start, stop };
}
