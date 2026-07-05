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

// Runs a real Zoom meeting embedded inside our layout via the official Meeting
// SDK for web (Component View). Like Jitsi, the meeting media lives inside the
// SDK's own DOM/iframe; our AI/transcription overlay works by listening to the
// user's OWN microphone (see ExternalMeeting), not by reaching into Zoom.
//
// Flow: ask our backend for a signed join token (the SDK secret never touches
// the browser) -> load the SDK from Zoom's CDN -> createClient/init/join.
export default function ZoomEmbed({ meetingNumber, passcode, displayName, onLeave }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"connecting" | "joined" | "error">("connecting");

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

      // 3. Embed + join. patchJsMedia lets video work without cross-origin
      //    isolation, so we don't need COOP/COEP headers (which would break
      //    our cross-origin Jitsi iframe).
      client = window.ZoomMtgEmbedded.createClient();
      await client.init({
        zoomAppRoot: containerRef.current,
        language: "es-ES",
        patchJsMedia: true,
      });
      if (disposed) return;

      client.on("connection-change", (payload) => {
        // "Closed" fires when the user leaves or the host ends the meeting.
        if (payload?.state === "Closed") onLeaveRef.current?.();
      });

      await client.join({
        signature,
        meetingNumber,
        password: passcode,
        userName: displayName || "Invitado",
      });
      if (!disposed) setStatus("joined");
    }

    start().catch((e: unknown) => {
      if (disposed) return;
      setError(e instanceof Error ? e.message : "No se pudo unir a la reunión de Zoom.");
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
      {status === "connecting" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-sm text-ink-300">Conectando con Zoom…</p>
        </div>
      )}
    </div>
  );
}
