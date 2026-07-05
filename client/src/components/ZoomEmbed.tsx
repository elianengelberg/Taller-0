import { useEffect, useRef, useState } from "react";
import { fetchZoomSignature } from "../lib/api";
import { loadZoomSdk } from "../lib/zoom";

interface Props {
  meetingNumber: string;
  passcode?: string;
  displayName: string;
  // Fired when the meeting connection closes (user left / meeting ended), so
  // the host page navigates away instead of leaving an empty frame -- mirrors
  // JitsiEmbed's onLeave.
  onLeave?: () => void;
}

// Zoom rejects join() with a { type, reason } object, not an Error, so pull the
// human-readable reason out when we can.
function zoomErrorMessage(e: unknown, fallback: string): string {
  if (e && typeof e === "object" && "reason" in e) {
    const reason = (e as { reason?: unknown }).reason;
    if (typeof reason === "string" && reason.trim()) return reason;
  }
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

// Runs a real Zoom meeting embedded inside our layout via the official Meeting
// SDK for web (Component View). Like Jitsi, the meeting media lives inside the
// SDK's own DOM; our AI/transcription overlay works by listening to the user's
// OWN microphone (see ExternalMeeting), not by reaching into Zoom.
//
// Flow: ask our backend for a signed join token (the SDK secret never touches
// the browser) -> load the SDK from Zoom's CDN -> createClient/init/join. Once
// join() is invoked we HAND OFF to Zoom's own UI, which renders its own
// connecting / waiting-room / connected states -- our "preparing" overlay only
// covers the brief signature-fetch + SDK-load phase, so it can never mask a
// meeting that actually connected.
export default function ZoomEmbed({ meetingNumber, passcode, displayName, onLeave }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  // "preparing": our overlay (fetching signature + loading SDK + init).
  // "in-zoom": handed off -- Zoom's own UI is showing.
  // "error": something failed; show the reason instead of the embed.
  const [status, setStatus] = useState<"preparing" | "in-zoom" | "error">("preparing");

  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;

  useEffect(() => {
    let disposed = false;
    let client: ZoomEmbeddedClient | null = null;

    async function start() {
      // 1. Get the signed join token from our server (503 if Zoom isn't set up).
      const { signature, error: sigError } = await fetchZoomSignature(meetingNumber, 0);
      if (disposed) return;
      if (!signature) {
        setError(sigError ?? "No se pudo autorizar el ingreso a Zoom.");
        setStatus("error");
        return;
      }

      // 2. Load the official SDK bundle from Zoom's CDN.
      await loadZoomSdk();
      if (disposed || !containerRef.current || !window.ZoomMtgEmbedded) return;

      // 3. Init. By default the Component View is a small draggable popper, so
      //    we pin it to the container's real size and a fixed view so it fills
      //    the pane. patchJsMedia lets video work without cross-origin
      //    isolation (no COOP/COEP, which would break the Jitsi iframe).
      const rect = containerRef.current.getBoundingClientRect();
      const width = Math.max(Math.floor(rect.width), 360);
      const height = Math.max(Math.floor(rect.height), 320);

      client = window.ZoomMtgEmbedded.createClient();
      await client.init({
        zoomAppRoot: containerRef.current,
        language: "es-ES",
        patchJsMedia: true,
        leaveOnPageUnload: true,
        customize: {
          video: {
            isResizable: false,
            viewSizes: { default: { width, height } },
            defaultViewType: "speaker",
          },
        },
      });
      if (disposed) return;

      // Event listeners must be registered AFTER init() -- registering them on a
      // freshly-created (un-inited) client silently no-ops, which previously
      // meant we never learned the meeting closed.
      client.on("connection-change", (payload) => {
        if (payload?.state === "Closed") onLeaveRef.current?.();
      });

      // 4. Hand off to Zoom's own UI now, so its connecting / waiting-room /
      //    connected states are visible instead of our overlay masking them.
      setStatus("in-zoom");

      // Zoom's `password` field expects the PLAIN meeting passcode -- the `pwd`
      // in a share link is an encrypted token that does NOT work here, so we
      // only pass a passcode the user actually typed.
      const result = await client.join({
        signature,
        meetingNumber,
        password: passcode || undefined,
        userName: displayName || "Invitado",
      });
      // join() can resolve with an ExecutedFailure object instead of throwing.
      if (!disposed && result && typeof result === "object" && "reason" in result) {
        setError(zoomErrorMessage(result, "No se pudo unir a la reunión de Zoom."));
        setStatus("error");
      }
    }

    start().catch((e: unknown) => {
      if (disposed) return;
      setError(zoomErrorMessage(e, "No se pudo unir a la reunión de Zoom."));
      setStatus("error");
    });

    return () => {
      disposed = true;
      try {
        client?.leaveMeeting();
      } catch {
        // Never joined / already gone -- nothing to clean up.
      }
    };
  }, [meetingNumber, passcode, displayName]);

  if (status === "error") {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <p className="max-w-sm text-sm text-brand-300">{error}</p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {status === "preparing" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center">
          <p className="text-sm text-ink-300">Preparando Zoom…</p>
        </div>
      )}
    </div>
  );
}
