import { useCallback, useEffect, useRef, useState } from "react";
import {
  confirmRecordingComplete,
  fetchPlatformConfig,
  markRecordingStarted,
  requestRecordingUploadUrl,
  uploadRecordingViaServer,
} from "../lib/api";
import {
  displayMediaErrorMessage,
  screenCaptureSupported,
  RECORDING_UNSUPPORTED_MESSAGE,
} from "../lib/screenCapture";
import { capturesOwnScreen } from "../lib/autoRecord";
import { dropRecording, listPendingRecordings, markAttempt, stashRecording } from "../lib/recordingVault";

export type RecordingStatus = "idle" | "recording" | "processing" | "done" | "error";
export type UploadStatus = "idle" | "uploading" | "uploaded" | "unavailable" | "failed";
/** Qué se está grabando: la pantalla con su audio, o sólo el micrófono. */
export type RecordingKind = "screen" | "audio";

interface UseRecorderOptions {
  micStream: MediaStream | null;
  meetingDbId: string | null;
}

export interface StartOptions {
  /**
   * Captura ya obtenida durante un gesto del usuario (ver lib/autoRecord).
   * Se usa tal cual en vez de volver a pedir permiso -- que es justamente lo
   * que el navegador no permitiría fuera del gesto.
   */
  stream?: MediaStream | null;
  /**
   * Grabar sólo el micrófono, sin pedir la pantalla. Es el modo con el que
   * arranca la grabación automática cuando no hay gesto disponible.
   */
  audioOnly?: boolean;
}

// Sólo audio: el mismo criterio que arriba (MP4 primero por iPhone/iPad).
function pickAudioMimeType(): string | undefined {
  const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return undefined;
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

  // Qué se está grabando ahora mismo, y si la captura incluye a esta misma
  // pantalla (efecto túnel) -- la UI lo avisa en vez de dejar que sorprenda.
  const [kind, setKind] = useState<RecordingKind>("screen");
  const [selfCapture, setSelfCapture] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const ownAudioStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  // Reloj real de la grabación: la duración que mandamos al servidor ancla el
  // t=0 del video contra la transcripción en el historial.
  const startedAtRef = useRef(0);

  const cleanupStreams = useCallback(() => {
    displayStreamRef.current?.getTracks().forEach((track) => track.stop());
    displayStreamRef.current = null;
    // Sólo cerramos el micrófono que abrimos nosotros; el que llega por
    // `micStream` es de quien nos lo pasó y sigue en uso en la reunión.
    ownAudioStreamRef.current?.getTracks().forEach((track) => track.stop());
    ownAudioStreamRef.current = null;
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

  // Sube una grabación y devuelve si llegó. Sin estado de React adentro, así
  // sirve tanto para la grabación recién hecha como para reintentar las que
  // quedaron guardadas en la bóveda de una sesión anterior.
  const pushRecording = useCallback(
    async (dbId: string, blob: Blob, contentType: string, durationMs: number): Promise<boolean> => {
      const target = await requestRecordingUploadUrl(dbId, contentType);
      if (target) {
        // Camino rápido: PUT directo del navegador a R2. Un PUT bloqueado por
        // CORS rechaza el fetch en vez de devolver !ok, así que las dos formas
        // de fallar caen igual en el respaldo por servidor.
        let directOk = false;
        try {
          const putResponse = await fetch(target.uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": contentType },
            body: blob,
          });
          directOk = putResponse.ok;
        } catch {
          directOk = false;
        }
        if (directOk) {
          await confirmRecordingComplete(dbId, target.publicUrl, durationMs);
          return true;
        }
      }
      // Respaldo: el video pasa por nuestro servidor (sin CORS de navegador),
      // que lo sube a R2 y lo engancha a la reunión.
      return uploadRecordingViaServer(dbId, blob, contentType, durationMs);
    },
    []
  );

  const uploadRecording = useCallback(
    async (blob: Blob, contentType: string, durationMs: number) => {
      if (!meetingDbId) {
        setUploadStatus("unavailable");
        return;
      }
      setUploadStatus("uploading");
      // Si el servidor no tiene almacenamiento configurado, la subida no puede
      // funcionar por más que se reintente: no se guarda nada en el navegador
      // (sería llenarle el disco al usuario para nada) y se lo decimos.
      if ((await fetchPlatformConfig()).recording === false) {
        setUploadStatus("unavailable");
        return;
      }
      // Al disco ANTES de intentar subir: si se cierra la pestaña, se corta la
      // red o el servidor está dormido, la grabación sigue existiendo y se
      // reintenta sola la próxima vez que se abra Unify.
      const vaultId = await stashRecording({
        meetingDbId,
        blob,
        contentType,
        durationMs,
      });
      const ok = await pushRecording(meetingDbId, blob, contentType, durationMs);
      if (ok && vaultId) await dropRecording(vaultId);
      setUploadStatus(ok ? "uploaded" : vaultId ? "failed" : "unavailable");
    },
    [meetingDbId, pushRecording]
  );

  // Reintento de rescate: al montar, se sube lo que haya quedado colgado de
  // una sesión anterior (pestaña cerrada a mitad de subida, red caída,
  // servidor dormido). En segundo plano y en silencio -- no es lo que la
  // persona vino a hacer ahora.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const pending = await listPendingRecordings();
      if (pending.length === 0) return;
      // Mismo criterio que arriba: sin almacenamiento no hay a dónde subirlas.
      if ((await fetchPlatformConfig()).recording === false) return;
      for (const rec of pending) {
        if (cancelled) return;
        // Tres intentos y se deja quieta hasta que venza: reintentar sin
        // límite una grabación de una reunión borrada sería gastar datos del
        // usuario para siempre.
        if (rec.attempts >= 3) continue;
        await markAttempt(rec.id);
        const ok = await pushRecording(rec.meetingDbId, rec.blob, rec.contentType, rec.durationMs);
        if (ok) await dropRecording(rec.id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pushRecording]);

  // Grabación sólo de micrófono. Es la que puede arrancar SOLA: getUserMedia no
  // exige un gesto del usuario (getDisplayMedia sí), así que con el permiso de
  // micrófono ya dado -- que en una reunión externa siempre está, porque los
  // subtítulos lo usan -- la reunión queda grabada sin que nadie apriete nada.
  const startAudioOnly = useCallback(async () => {
    try {
      const source =
        micStream && micStream.getAudioTracks().some((t) => t.readyState === "live")
          ? micStream
          : await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
            });
      // Sólo cerramos al final el micrófono que abrimos nosotros.
      if (source !== micStream) ownAudioStreamRef.current = source;

      const mimeType = pickAudioMimeType();
      const recorder = new MediaRecorder(source, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 128_000,
      });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const contentType = (mimeType || "audio/webm").split(";")[0];
        const blob = new Blob(chunksRef.current, { type: contentType });
        const durationMs = startedAtRef.current ? Date.now() - startedAtRef.current : 0;
        cleanupStreams();
        // Umbral mucho más bajo que el de video: un minuto de audio pesa
        // ~1 MB, y un audio corto igual es una grabación válida.
        if (blob.size < 2_000) {
          setError("La grabación de audio quedó vacía: no llegó sonido del micrófono.");
          setStatus("error");
          return;
        }
        setResultType(contentType);
        setResultUrl(URL.createObjectURL(blob));
        setStatus("done");
        void uploadRecording(blob, contentType, durationMs);
      };
      recorder.onerror = () => {
        setError("Hubo un error grabando el audio de la reunión.");
        setStatus("error");
        cleanupStreams();
      };
      mediaRecorderRef.current = recorder;
      recorder.start(1000);
      startedAtRef.current = Date.now();
      setStatus("recording");
      if (meetingDbId) void markRecordingStarted(meetingDbId);
    } catch (err) {
      const denied = err instanceof DOMException && err.name === "NotAllowedError";
      setError(
        denied
          ? "No pudimos grabar: el navegador tiene bloqueado el micrófono para este sitio. Habilitalo y volvé a intentar."
          : "No pudimos acceder al micrófono para grabar la reunión."
      );
      setStatus("error");
      cleanupStreams();
    }
  }, [micStream, cleanupStreams, uploadRecording, meetingDbId]);

  const start = useCallback(
    async (options: StartOptions = {}) => {
    setError(null);
    setResultUrl(null);
    setUploadStatus("idle");
    setSelfCapture(false);
    const audioOnly = Boolean(options.audioOnly);
    setKind(audioOnly ? "audio" : "screen");
    if (!audioOnly && !options.stream && !screenCaptureSupported) {
      setError(RECORDING_UNSUPPORTED_MESSAGE);
      setStatus("error");
      return;
    }
    if (audioOnly) {
      await startAudioOnly();
      return;
    }
    try {
      const displayStream =
        options.stream ??
        (await navigator.mediaDevices.getDisplayMedia({
          // Without explicit ideals Chrome sometimes hands back a downscaled
          // capture; asking high keeps the surface at its native resolution.
          video: { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } },
          audio: true,
          // Saca esta misma pestaña del selector: es lo que evita el "túnel
          // infinito" de grabar la pantalla donde se ve la grabación.
          selfBrowserSurface: "exclude",
        } as DisplayMediaStreamOptions));
      displayStreamRef.current = displayStream;
      // Compartir el monitor entero con Unify a la vista sí produce el túnel,
      // y eso no se puede impedir -- pero sí avisarlo.
      setSelfCapture(capturesOwnScreen(displayStream));
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
        const durationMs = startedAtRef.current ? Date.now() - startedAtRef.current : 0;
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
        void uploadRecording(blob, contentType, durationMs);
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
      startedAtRef.current = Date.now();
      setStatus("recording");
      // Anchor the video's t=0 on the server so the saved transcript lines up.
      if (meetingDbId) void markRecordingStarted(meetingDbId);
    } catch (err) {
      // El stream cedido puede haber muerto entre el gesto y acá; no dejamos
      // sus pistas abiertas por el error.
      options.stream?.getTracks().forEach((t) => t.stop());
      setError(displayMediaErrorMessage(err, "iniciar la grabación"));
      setStatus("error");
      cleanupStreams();
    }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [micStream, cleanupStreams, stop, uploadRecording, meetingDbId, startAudioOnly]
  );

  // Cerrar la pestaña mientras se graba o mientras el video está subiendo
  // abandonaba el archivo a mitad de camino. Ahora el navegador pregunta antes
  // ("¿seguro que querés salir?") y, si igual se va, la grabación ya quedó en
  // la bóveda (IndexedDB) y se reintenta sola al volver a abrir Unify.
  useEffect(() => {
    const busy = status === "recording" || status === "processing" || uploadStatus === "uploading";
    if (!busy) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Los navegadores modernos muestran su propio texto; devolver algo es lo
      // que dispara el diálogo.
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [status, uploadStatus]);

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

  return { status, uploadStatus, error, resultUrl, resultType, kind, selfCapture, start, stop, reset };
}
