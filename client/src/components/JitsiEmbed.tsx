import { useEffect, useRef, useState } from "react";
import { JITSI_MEET_DOMAIN, loadJitsiApi } from "../lib/jitsi";

interface Props {
  roomName: string;
  displayName: string;
  // Fired when the user leaves the meeting from Jitsi's own hang-up button,
  // so the host page can navigate away instead of leaving an empty frame.
  onLeave?: () => void;
}

// Runs a real Jitsi meeting embedded inside our layout via the official
// external_api. Note: the meeting itself lives in a cross-origin iframe, so
// our own AI/transcription tools can't reach into its media -- embedding
// keeps our branding/chrome around a real external call, but overlaying our
// features *inside* it is a separate, platform-specific effort.
export default function JitsiEmbed({ roomName, displayName, onLeave }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  // onLeave can change identity between renders; keep the effect from tearing
  // down and rebuilding the whole meeting just because the callback did.
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;

  useEffect(() => {
    let disposed = false;
    let api: JitsiMeetExternalAPI | null = null;

    loadJitsiApi()
      .then(() => {
        if (disposed || !containerRef.current || !window.JitsiMeetExternalAPI) return;
        api = new window.JitsiMeetExternalAPI(JITSI_MEET_DOMAIN, {
          roomName,
          parentNode: containerRef.current,
          width: "100%",
          height: "100%",
          userInfo: { displayName },
        });
        api.addEventListener("readyToClose", () => onLeaveRef.current?.());
      })
      .catch((e: unknown) => {
        if (!disposed) setError(e instanceof Error ? e.message : "No se pudo cargar la reunión.");
      });

    return () => {
      disposed = true;
      try {
        api?.dispose();
      } catch {
        // Already disposed / never constructed -- nothing to clean up.
      }
    };
  }, [roomName, displayName]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <p className="max-w-sm text-sm text-brand-300">{error}</p>
      </div>
    );
  }

  return <div ref={containerRef} className="h-full w-full" />;
}
