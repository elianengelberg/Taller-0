import { useEffect, useRef, useState } from "react";

// How loud (RMS on a 0-255 time-domain scale, 128 = silence) counts as
// "speaking", and how often we sample. Tuned for voice: high enough to ignore
// room noise / keystrokes, low enough to catch normal talking.
const SPEAKING_RMS = 6;
const SAMPLE_MS = 120;
// Keep the ring up briefly after the level drops so it doesn't flicker on the
// natural micro-pauses between words.
const HOLD_MS = 500;

interface Tap {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  data: Uint8Array<ArrayBuffer>;
  lastLoud: number;
}

// Detects who is currently talking by tapping each participant's audio with a
// Web Audio AnalyserNode (a passive VU meter -- never connected to the output,
// so it doesn't play anything back). Returns a map of participantId -> boolean
// so the UI can highlight the active speaker like Zoom/Meet.
export function useActiveSpeakers(streams: Record<string, MediaStream | null>): Record<string, boolean> {
  const [speaking, setSpeaking] = useState<Record<string, boolean>>({});
  const ctxRef = useRef<AudioContext | null>(null);
  const tapsRef = useRef<Map<string, Tap>>(new Map());

  // (Re)build the analyser taps to match the current streams.
  useEffect(() => {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    if (!ctxRef.current) ctxRef.current = new AC();
    const ctx = ctxRef.current;
    void ctx.resume().catch(() => {});
    const taps = tapsRef.current;

    const wanted = new Set<string>();
    for (const [id, stream] of Object.entries(streams)) {
      if (!stream || stream.getAudioTracks().length === 0) continue;
      wanted.add(id);
      const existing = taps.get(id);
      // Recreate the tap if this participant's stream object changed.
      if (existing && existing.stream !== stream) {
        try {
          existing.source.disconnect();
        } catch {
          /* noop */
        }
        taps.delete(id);
      }
      if (!taps.has(id)) {
        try {
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          const data = new Uint8Array(new ArrayBuffer(analyser.fftSize));
          taps.set(id, { stream, source, analyser, data, lastLoud: 0 });
        } catch {
          // A stream with no live audio track can throw -- just skip it.
        }
      }
    }
    for (const id of Array.from(taps.keys())) {
      if (!wanted.has(id)) {
        try {
          taps.get(id)?.source.disconnect();
        } catch {
          /* noop */
        }
        taps.delete(id);
      }
    }
  }, [streams]);

  // Sample the levels on an interval and publish who's talking.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const taps = tapsRef.current;
      if (taps.size === 0) return;
      const now = performance.now();
      const next: Record<string, boolean> = {};
      taps.forEach((tap, id) => {
        tap.analyser.getByteTimeDomainData(tap.data);
        let sumSq = 0;
        for (let i = 0; i < tap.data.length; i++) {
          const d = tap.data[i] - 128;
          sumSq += d * d;
        }
        const rms = Math.sqrt(sumSq / tap.data.length);
        if (rms > SPEAKING_RMS) tap.lastLoud = now;
        next[id] = now - tap.lastLoud < HOLD_MS;
      });
      setSpeaking((prev) => {
        const ids = new Set([...Object.keys(prev), ...Object.keys(next)]);
        for (const id of ids) {
          if (Boolean(prev[id]) !== Boolean(next[id])) return next;
        }
        return prev; // unchanged -- avoid a needless re-render
      });
    }, SAMPLE_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Tear everything down on unmount.
  useEffect(() => {
    return () => {
      tapsRef.current.forEach((tap) => {
        try {
          tap.source.disconnect();
        } catch {
          /* noop */
        }
      });
      tapsRef.current.clear();
      ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
    };
  }, []);

  return speaking;
}
