import { useCallback, useEffect, useRef, useState } from "react";
import { confirmRecordingComplete, requestRecordingUploadUrl } from "../lib/api";
import {
  displayMediaErrorMessage,
  screenCaptureSupported,
  RECORDING_UNSUPPORTED_MESSAGE,
} from "../lib/screenCapture";

export type RecordingStatus = "idle" | "recording" | "processing" | "done" | "error";
export type UploadStatus = "idle" | "uploading" | "uploaded" | "unavailable" | "failed";

interface UseRecorderOptions {
  micStream: MediaStream | null;
  meetingDbId: string | null;
}

function pickSupportedMimeType(): string | undefined {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(type)) {
      return type;
    }
  }
  return undefined;
}

// Records the shared screen/tab + its audio, mixed with the local
// microphone (via Web Audio), so the file captures the whole conversation --
// not just what the recording user hears.
export function useRecorder({ micStream, meetingDbId }: UseRecorderOptions) {
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  // Mirror for the unmount cleanup below -- leaving the page without
  // dismissing the "Grabación lista" card would otherwise leak the blob URL
  // (and the recording's memory) for the rest of the session.
  const resultUrlRef = useRef<string | null>(null);
  resultUrlRef.current = resultUrl;

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  const cleanupStreams = useCallback(() => {
    displayStreamRef.current?.getTracks().forEach((track) => track.stop());
    displayStreamRef.current = null;
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
  }, []);

  const stop = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      setStatus("processing");
      recorder.stop();
    }
  }, []);

  const uploadRecording = useCallback(
    async (blob: Blob, contentType: string) => {
      if (!meetingDbId) {
        setUploadStatus("unavailable");
        return;
      }
      setUploadStatus("uploading");
      const target = await requestRecordingUploadUrl(meetingDbId, contentType);
      if (!target) {
        setUploadStatus("unavailable");
        return;
      }
      try {
        const putResponse = await fetch(target.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": contentType },
          body: blob,
        });
        if (!putResponse.ok) throw new Error("upload failed");
        await confirmRecordingComplete(meetingDbId, target.publicUrl);
        setUploadStatus("uploaded");
      } catch {
        setUploadStatus("failed");
      }
    },
    [meetingDbId]
  );

  const start = useCallback(async () => {
    setError(null);
    setResultUrl(null);
    setUploadStatus("idle");
    if (!screenCaptureSupported) {
      setError(RECORDING_UNSUPPORTED_MESSAGE);
      setStatus("error");
      return;
    }
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      displayStreamRef.current = displayStream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      // Chrome can create this suspended when there's an async gap (like the
      // getDisplayMedia permission prompt) between the click that started
      // recording and this point -- if we don't resume it explicitly, the
      // mixed audio track silently produces no sound at all, even though the
      // video track (which doesn't go through the AudioContext) works fine.
      if (audioContext.state === "suspended") {
        await audioContext.resume().catch(() => {});
      }
      const destination = audioContext.createMediaStreamDestination();

      if (displayStream.getAudioTracks().length > 0) {
        audioContext
          .createMediaStreamSource(new MediaStream(displayStream.getAudioTracks()))
          .connect(destination);
      }
      if (micStream && micStream.getAudioTracks().length > 0) {
        audioContext
          .createMediaStreamSource(new MediaStream(micStream.getAudioTracks()))
          .connect(destination);
      }

      const combined = new MediaStream([
        ...displayStream.getVideoTracks(),
        ...destination.stream.getAudioTracks(),
      ]);

      const mimeType = pickSupportedMimeType();
      const recorder = new MediaRecorder(combined, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType || "video/webm" });
        setResultUrl(URL.createObjectURL(blob));
        setStatus("done");
        cleanupStreams();
        void uploadRecording(blob, mimeType || "video/webm");
      };

      recorder.onerror = () => {
        setError("Hubo un error grabando la reunión.");
        setStatus("error");
        cleanupStreams();
      };

      // If the user stops sharing from the browser's own "Stop sharing" UI,
      // treat it the same as pressing our stop button.
      displayStream.getVideoTracks()[0]?.addEventListener("ended", stop);

      mediaRecorderRef.current = recorder;
      recorder.start(1000);
      setStatus("recording");
    } catch (err) {
      setError(displayMediaErrorMessage(err, "iniciar la grabación"));
      setStatus("error");
      cleanupStreams();
    }
  }, [micStream, cleanupStreams, stop, uploadRecording]);

  const reset = useCallback(() => {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setResultUrl(null);
    setStatus("idle");
    setUploadStatus("idle");
    setError(null);
  }, [resultUrl]);

  // Without this, leaving the meeting mid-recording (navigating away,
  // closing the tab) left the getDisplayMedia stream and AudioContext
  // running forever -- the browser's "you are sharing your screen" bar
  // would stay up with nothing left to stop it. `stop()` still lets
  // onstop's upload-to-history logic run normally; it just also makes sure
  // we're not leaking a live screen-capture stream in the background.
  useEffect(() => {
    return () => {
      stop();
      if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
    };
  }, [stop]);

  return { status, uploadStatus, error, resultUrl, start, stop, reset };
}
