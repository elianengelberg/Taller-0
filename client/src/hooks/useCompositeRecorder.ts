import { useCallback, useEffect, useRef, useState } from "react";
import {
  confirmRecordingComplete,
  markRecordingStarted,
  requestRecordingUploadUrl,
  uploadRecordingViaServer,
} from "../lib/api";
import type { RecordingStatus, UploadStatus } from "./useRecorder";

// Records a NATIVE Unify meeting by compositing every participant's video onto
// a canvas and mixing all their audio, then capturing that canvas + audio with
// MediaRecorder. Two reasons this beats getDisplayMedia for our own meetings:
//
//  1. No user gesture is required (canvas.captureStream + MediaStreamDestination
//     don't need one), so recording can start AUTOMATICALLY -- e.g. the 10s
//     auto-start prompt -- which getDisplayMedia can never do.
//  2. It records the actual meeting (all cameras + the shared screen when
//     someone presents, laid out just like the room), not "whatever tab you
//     picked", and it always produces real frames -- so the file is never the
//     empty/black video screen-capture could yield.

export interface RecTile {
  id: string;
  name: string;
  stream: MediaStream | null;
  cameraOff: boolean;
  sharingScreen: boolean;
}

interface Options {
  // Ref, read fresh every animation frame, so joins/leaves/camera toggles and
  // a share starting/stopping all reflow the recording live.
  sceneRef: React.MutableRefObject<RecTile[]>;
  meetingDbId: string | null;
}

const W = 1280;
const H = 720;
const FPS = 30;

function pickMimeType(): string | undefined {
  const c = [
    "video/mp4;codecs=avc1.640028,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const t of c) if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(t)) return t;
  return undefined;
}

function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase() || "?";
}

// Grid columns for N camera tiles (matches the on-screen grid feel).
function gridDims(n: number): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n <= 2) return { cols: 2, rows: 1 };
  if (n <= 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  if (n <= 9) return { cols: 3, rows: 3 };
  return { cols: 4, rows: Math.ceil(n / 4) };
}

export function useCompositeRecorder({ sceneRef, meetingDbId }: Options) {
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultType, setResultType] = useState<string>("video/webm");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const destRef = useRef<MediaStreamDestination | null>(null);
  // Everyone's audio is summed into a limiter, then the limiter feeds the
  // recording. Summing raw would clip once a few people talk at once (the
  // "saturación" the user heard); the limiter tames peaks so it stays clean.
  const busRef = useRef<AudioNode | null>(null);
  const connectedAudioRef = useRef<Set<string>>(new Set());
  // One-time gesture handlers that resume a still-suspended AudioContext, so a
  // fully hands-off auto-record still gets sound the instant anything is
  // touched (and usually right away, since joining the call already counts as
  // a user gesture for the page).
  const resumeKickRef = useRef<(() => void) | null>(null);
  // Hidden <video> element per participant stream, kept playing so the canvas
  // has live frames to draw.
  const videosRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const startedAtRef = useRef<number>(0);
  // The meeting id captured when recording starts, so a later upload attaches
  // to the right meeting even if the meeting state was cleared on leave.
  const dbIdRef = useRef<string | null>(meetingDbId);
  const resultUrlRef = useRef<string | null>(null);
  resultUrlRef.current = resultUrl;

  const videoFor = useCallback((tile: RecTile): HTMLVideoElement | null => {
    if (!tile.stream) return null;
    const key = tile.id;
    let el = videosRef.current.get(key);
    if (!el) {
      el = document.createElement("video");
      el.muted = true; // audio is mixed separately; muted lets it autoplay
      el.autoplay = true;
      el.playsInline = true;
      el.srcObject = tile.stream;
      el.play().catch(() => {});
      videosRef.current.set(key, el);
    } else if (el.srcObject !== tile.stream) {
      el.srcObject = tile.stream;
      el.play().catch(() => {});
    }
    return el;
  }, []);

  const ensureAudio = useCallback((tiles: RecTile[]) => {
    const ctx = audioCtxRef.current;
    const bus = busRef.current;
    if (!ctx || !bus) return;
    for (const t of tiles) {
      if (!t.stream || connectedAudioRef.current.has(t.id)) continue;
      const audioTracks = t.stream.getAudioTracks();
      if (audioTracks.length === 0) continue; // not marked, so we retry later
      try {
        ctx.createMediaStreamSource(new MediaStream(audioTracks)).connect(bus);
        connectedAudioRef.current.add(t.id);
      } catch {
        /* a track already tied to another context -- skip */
      }
    }
  }, []);

  const drawTile = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      tile: RecTile,
      x: number,
      y: number,
      w: number,
      h: number,
      screen: boolean
    ) => {
      ctx.save();
      ctx.fillStyle = "#0b1220";
      roundRect(ctx, x, y, w, h, 12);
      ctx.fill();
      ctx.clip();

      const el = videoFor(tile);
      const showVideo = el && el.readyState >= 2 && (!tile.cameraOff || tile.sharingScreen);
      if (showVideo && el) {
        const vw = el.videoWidth || 16;
        const vh = el.videoHeight || 9;
        if (screen || tile.sharingScreen) {
          // contain (letterbox) so a shared doc is never cropped
          const scale = Math.min(w / vw, h / vh);
          const dw = vw * scale;
          const dh = vh * scale;
          ctx.drawImage(el, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
        } else {
          // cover (fill) for cameras
          const scale = Math.max(w / vw, h / vh);
          const dw = vw * scale;
          const dh = vh * scale;
          ctx.drawImage(el, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
        }
      } else {
        // Avatar with initials
        const cx = x + w / 2;
        const cy = y + h / 2;
        const r = Math.min(w, h) * 0.22;
        ctx.fillStyle = "#2563EB";
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = `bold ${Math.round(r)}px Inter, Arial, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(initials(tile.name), cx, cy);
      }

      // Name label
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      const label = tile.name.slice(0, 30);
      ctx.font = "600 16px Inter, Arial, sans-serif";
      const tw = ctx.measureText(label).width + 16;
      roundRect(ctx, x + 8, y + h - 32, tw, 24, 8);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, x + 16, y + h - 20);
      ctx.restore();
    },
    [videoFor]
  );

  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const tiles = sceneRef.current;
    ensureAudio(tiles);

    ctx.fillStyle = "#020617";
    ctx.fillRect(0, 0, W, H);

    const presenter = tiles.find((t) => t.sharingScreen) ?? null;
    const pad = 12;
    if (presenter) {
      const others = tiles.filter((t) => t.id !== presenter.id);
      // Screen on top ~74%, a centered camera strip below.
      const stripH = others.length > 0 ? 150 : 0;
      drawTile(ctx, presenter, pad, pad, W - pad * 2, H - stripH - pad * 2, true);
      if (others.length > 0) {
        const n = Math.min(others.length, 6);
        const tileW = Math.min((W - pad * 2 - (n - 1) * pad) / n, 200);
        const tileH = stripH - pad;
        const totalW = n * tileW + (n - 1) * pad;
        let sx = (W - totalW) / 2;
        for (let i = 0; i < n; i++) {
          drawTile(ctx, others[i], sx, H - stripH, tileW, tileH, false);
          sx += tileW + pad;
        }
      }
    } else {
      const { cols, rows } = gridDims(tiles.length);
      const cw = (W - pad * (cols + 1)) / cols;
      const chh = (H - pad * (rows + 1)) / rows;
      tiles.forEach((t, i) => {
        const c = i % cols;
        const r = Math.floor(i / cols);
        drawTile(ctx, t, pad + c * (cw + pad), pad + r * (chh + pad), cw, chh, false);
      });
    }
    rafRef.current = requestAnimationFrame(renderFrame);
  }, [sceneRef, ensureAudio, drawTile]);

  const cleanup = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (resumeKickRef.current) {
      for (const ev of ["pointerdown", "keydown", "touchstart"]) {
        window.removeEventListener(ev, resumeKickRef.current);
      }
      resumeKickRef.current = null;
    }
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    destRef.current = null;
    busRef.current = null;
    connectedAudioRef.current.clear();
    for (const el of videosRef.current.values()) {
      el.srcObject = null;
    }
    videosRef.current.clear();
  }, []);

  const uploadRecording = useCallback(
    async (blob: Blob, contentType: string, durationMs: number) => {
      // Read the meeting id from a ref snapshotted at record start -- if the
      // person leaves while the recording is still uploading, the meeting
      // state may already be cleared, but the recording must still attach to
      // the meeting it belongs to.
      const dbId = dbIdRef.current;
      if (!dbId) {
        setUploadStatus("unavailable");
        return;
      }
      setUploadStatus("uploading");
      const target = await requestRecordingUploadUrl(dbId, contentType);
      if (!target) {
        setUploadStatus("unavailable");
        return;
      }
      // Fast path: the browser PUTs straight to R2 with the presigned URL
      // (retry once so a single transient hiccup doesn't cost the recording).
      // A CORS-blocked PUT makes fetch reject rather than return !ok, so both
      // outcomes funnel to the same fallback below.
      const putOnce = () =>
        fetch(target.uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: blob });
      let directOk = false;
      try {
        let res = await putOnce();
        if (!res.ok) {
          await new Promise((r) => setTimeout(r, 1000));
          res = await putOnce();
        }
        directOk = res.ok;
      } catch {
        directOk = false;
      }

      if (directOk) {
        // durationMs lets the server anchor the transcript to the video.
        await confirmRecordingComplete(dbId, target.publicUrl, durationMs);
        setUploadStatus("uploaded");
        return;
      }

      // Fallback: stream the video through our own server (no browser CORS in
      // play), which uploads to R2 and attaches it to the meeting itself -- so
      // the recording reaches the history even if the bucket's CORS isn't set
      // up to allow a direct browser PUT.
      const viaServer = await uploadRecordingViaServer(dbId, blob, contentType, durationMs);
      setUploadStatus(viaServer ? "uploaded" : "failed");
    },
    []
  );

  const start = useCallback(async () => {
    if (recorderRef.current) return;
    setError(null);
    setResultUrl(null);
    setUploadStatus("idle");
    try {
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      canvasRef.current = canvas;
      // Draw one frame immediately so captureStream has content from t=0.
      renderFrame();

      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      await audioCtx.resume().catch(() => {});
      // If it's still suspended (no user gesture yet), resume on the very next
      // interaction so hands-off recordings don't lose their audio.
      if (audioCtx.state !== "running") {
        const kick = () => audioCtx.resume().catch(() => {});
        resumeKickRef.current = kick;
        for (const ev of ["pointerdown", "keydown", "touchstart"]) {
          window.addEventListener(ev, kick, { passive: true });
        }
      }

      const dest = audioCtx.createMediaStreamDestination();
      destRef.current = dest;
      // Clean audio bus: every voice sums into a pre-gain (leaves headroom so
      // a single loud source can never reach full scale on its own), then a
      // limiter catches the peaks when several people talk at once. The result
      // never clips/saturates yet stays at a natural level. Sources connect to
      // the pre-gain (busRef); it feeds limiter -> destination.
      const preGain = audioCtx.createGain();
      preGain.gain.value = 0.8; // -1.9 dB headroom per source
      const limiter = audioCtx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.2;
      preGain.connect(limiter).connect(dest);
      busRef.current = preGain;
      ensureAudio(sceneRef.current);

      const canvasStream = canvas.captureStream(FPS);
      const combined = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...destRef.current.stream.getAudioTracks(),
      ]);

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(combined, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: 4_000_000,
        audioBitsPerSecond: 128_000,
      });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const contentType = (mimeType || "video/webm").split(";")[0];
        const blob = new Blob(chunksRef.current, { type: contentType });
        cleanup();
        if (blob.size < 20_000) {
          setError("La grabación quedó vacía. Probá de nuevo.");
          setStatus("error");
          return;
        }
        setResultType(contentType);
        setResultUrl(URL.createObjectURL(blob));
        setStatus("done");
        const durationMs = Date.now() - startedAtRef.current;
        void uploadRecording(blob, contentType, durationMs);
      };
      recorder.onerror = () => {
        setError("Hubo un error grabando la reunión.");
        setStatus("error");
        cleanup();
      };

      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      dbIdRef.current = meetingDbId; // snapshot for the eventual upload
      recorder.start(1000);
      setStatus("recording");
      // Anchor the video's t=0 on the server right now, so the saved transcript
      // lines up with the recording (see markRecordingStarted).
      if (meetingDbId) void markRecordingStarted(meetingDbId);
    } catch {
      setError("No se pudo iniciar la grabación de la reunión.");
      setStatus("error");
      cleanup();
    }
  }, [renderFrame, ensureAudio, sceneRef, cleanup, uploadRecording, meetingDbId]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      setStatus("processing");
      recorder.stop();
    }
    recorderRef.current = null;
  }, []);

  const reset = useCallback(() => {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setResultUrl(null);
    setStatus("idle");
    setUploadStatus("idle");
    setError(null);
  }, [resultUrl]);

  // Stop + free on unmount so leaving the meeting mid-recording still flushes
  // the file (onstop uploads) and never leaks the canvas loop / AudioContext.
  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      cleanup();
      if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
    };
  }, [cleanup]);

  return { status, uploadStatus, error, resultUrl, resultType, start, stop, reset };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

type MediaStreamDestination = MediaStreamAudioDestinationNode;
