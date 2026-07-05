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

// If Zoom hasn't confirmed the join after this long, the meeting is almost
// always waiting on something on the user's side (not started by the host, a
// waiting room, a wrong passcode, or the post-2026-03 external-account
// authorization). Surface an actionable hint instead of spinning forever.
const SLOW_JOIN_MS = 20_000;

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
// the browser) -> load the SDK from Zoom's CDN -> createClient/init/join. We
// treat the `connection-change` -> "Connected" event (not the join() promise)
// as the real success signal, since join() can stay pending in a waiting room.
export default function ZoomEmbed({ meetingNumber, passcode, displayName, onLeave }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"connecting" | "joined" | "error">("connecting");
  const [slowHint, setSlowHint] = useState(false);

  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;

  useEffect(() => {
    let disposed = false;
    let client: ZoomEmbeddedClient | null = null;
    const slowTimer = window.setTimeout(() => {
      if (!disposed) setSlowHint(true);
    }, SLOW_JOIN_MS);

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

      // 3. Embed + join. By default the Component View is a small draggable
      //    popper, so we pin it to the container's real size and a fixed view
      //    so it fills the pane. patchJsMedia lets video work without
      //    cross-origin isolation (no COOP/COEP, which would break Jitsi).
      const rect = containerRef.current.getBoundingClientRect();
      const width = Math.max(Math.floor(rect.width), 360);
      const height = Math.max(Math.floor(rect.height), 320);

      client = window.ZoomMtgEmbedded.createClient();

      client.on("connection-change", (payload) => {
        const state = payload?.state;
        if (state === "Connected") {
          if (!disposed) {
            setStatus("joined");
            setSlowHint(false);
          }
        } else if (state === "Closed") {
          onLeaveRef.current?.();
        } else if (state === "Fail") {
          if (!disposed) {
            setError(payload?.reason ?? "Zoom no pudo conectar la reunión.");
            setStatus("error");
          }
        }
      });

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

      const result = await client.join({
        signature,
        meetingNumber,
        password: passcode,
        userName: displayName || "Invitado",
      });
      // join() resolves with an ExecutedFailure object (not a throw) on some
      // failures -- treat a returned reason as an error too.
      if (!disposed && result && typeof result === "object" && "reason" in result) {
        setError(zoomErrorMessage(result, "No se pudo unir a la reunión de Zoom."));
        setStatus("error");
      }
      // On success we rely on the connection-change "Connected" event above to
      // flip to "joined"; don't force it here, since join() can resolve while
      // still in a waiting room.
    }

    start().catch((e: unknown) => {
      if (disposed) return;
      setError(zoomErrorMessage(e, "No se pudo unir a la reunión de Zoom."));
      setStatus("error");
    });

    return () => {
      disposed = true;
      window.clearTimeout(slowTimer);
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
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm text-ink-300">Conectando con Zoom…</p>
          {slowHint && (
            <p className="max-w-md text-xs text-ink-400">
              Está tardando más de lo normal. Si sos el anfitrión, asegurate de haber{" "}
              <span className="text-ink-200">iniciado la reunión</span> en Zoom. Si es de otra
              persona, quizás haya sala de espera o falte la contraseña. (Desde marzo 2026 Zoom
              exige autorización extra para unirse a reuniones de otras cuentas.)
            </p>
          )}
        </div>
      )}
    </div>
  );
}
