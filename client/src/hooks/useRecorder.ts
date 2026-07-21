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

// MP4 (H.264 + AAC) first: it's the only format that also plays on
// iPhone/iPad Safari, which can't decode WebM files -- recordings used to
// "look empty" there while playing fine on desktop. WebM stays as the
// fallback for browsers whose MediaRecorder can't mux MP4 yet.
function pickSupportedMimeType(): string | undefined {
  const candidates = [
    "video/mp4;codecs=avc1.640028,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(type)) {
      return type;
    }
  }
  return undefined;
}

// MediaRecorder's default video bitrate (~2.5 Mbps) makes 1080p+ screen
// content look smeared. Scale the target with the actually-captured size --
// asking for 12 Mbps at 720p just wastes upload, and 2.5 Mbps at 4K is mush.
function videoBitrateFor(track: MediaStreamTrack): number {
  const { width = 1920, height = 1080 } = track.getSettings();
  const pixels = width * height;
  if (pixels >= 3200 * 1700) return 12_000_000; // 4K / retina fullscreen
  if (pixels >= 1900 * 1000) return 8_000_000; // 1080p-1440p
  if (pixels >= 1200 * 650) return 5_000_000; // 720p-900p
  return 3_500_000;
}

// Records the shared screen/tab + its audio, mixed with the local
// microphone (via Web Audio), so the file captures the whole conversation --
// not just what the recording user hears.
export function useRecorder({ micStream, meetingDbId }: UseRecorderOptions) {
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  // Actual container of the finished file ("video/mp4" or "video/webm"), so
  // the download button can name the file with the right extension.
  const [resultType, setResultType] = useState<string>("video/webm");
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
        // Without explicit ideals Chrome sometimes hands back a downscaled
        // capture; asking high keeps the surface at its native resolution.
        video: { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } },
        audio: true,
      });
      displayStreamRef.current = displayStream;
      // Screen content is mostly text/UI: "detail" tells the encoder to spend
      // its bits on sharpness instead of smooth motion.
      const captureTrack = displayStream.getVideoTracks()[0];
      if (captureTrack) captureTrack.contentHint = "detail";

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
      const recorder = new MediaRecorder(combined, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: captureTrack ? videoBitrateFor(captureTrack) : 8_000_000,
        audioBitsPerSecond: 192_000,
      });
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        const contentType = (mimeType || "video/webm").split(";")[0];
        const blob = new Blob(chunksRef.current, { type: contentType });
        cleanupStreams();
        // A "successful" recording with (almost) no data means the capture
        // never produced frames -- typically a minimized window, a closed
        // source, or stopping immediately. Saying so beats handing the user
        // an empty file that "doesn't play".
        if (blob.size < 20_000) {
          setError(
            "La grabación quedó vacía. Suele pasar si la ventana elegida estaba minimizada, si la fuente se cerró o si se detuvo al instante. Elegí una pestaña o pantalla visible y probá de nuevo."
          );
          setStatus("error");
          return;
        }
        setResultType(contentType);
        setResultUrl(URL.createObjectURL(blob));
        setStatus("done");
        void uploadRecording(blob, contentType);
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

  return { status, uploadStatus, error, resultUrl, resultType, start, stop, reset };
}
