import { memo, useEffect, useRef } from "react";
import { Participant, Role } from "../types";
import { HandIcon, ScreenShareIcon } from "./icons";
import RoleBadge from "./RoleBadge";

interface Props {
  participant: Participant;
  role: Role | null;
  stream: MediaStream | null;
  isSelf: boolean;
  speakerId?: string | null;
  speaking?: boolean;
  // Presenter mode: fill the parent's height instead of keeping a 16:9 box,
  // and letterbox the content (object-contain) so a shared document/window
  // never gets cropped or deformed.
  fill?: boolean;
}

// setSinkId is non-standard and typed loosely across browsers.
type WithSinkId = HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> };

function ParticipantTile({ participant, role, stream, isSelf, speakerId, speaking, fill }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  // Route this tile's audio to the chosen speaker. Only remote tiles play
  // audio (our own is muted to avoid echo), so self tiles skip it.
  useEffect(() => {
    const el = videoRef.current as WithSinkId | null;
    if (!el || isSelf || !speakerId || typeof el.setSinkId !== "function") return;
    el.setSinkId(speakerId).catch(() => {
      // Output selection not permitted / device gone -- keep the default.
    });
  }, [speakerId, isSelf, stream]);

  // While sharing a screen, the shared content rides the same video track
  // slot the camera normally uses -- keep showing it even if the person's
  // camera itself is toggled off.
  const showVideo = Boolean(stream) && (!participant.cameraOff || participant.sharingScreen);

  // A soft ring while this person is talking -- the active-speaker cue every
  // other meeting app uses. Muted people never light up (their track is
  // silent), so it stays meaningful.
  const speakingRing = speaking && !participant.muted ? "ring-2 ring-brand-400 ring-offset-2 ring-offset-ink-950" : "ring-0";

  return (
    <div
      className={`relative flex items-center justify-center overflow-hidden rounded-2xl shadow-lg ring-1 ring-white/[0.06] transition-all duration-150 ${
        fill ? "h-full w-full bg-black" : "aspect-video bg-ink-900"
      } ${speakingRing}`}
    >
      {/* Always keep <video> mounted once we have a stream: conditionally
          rendering it in/out of the tree meant the DOM node (and its
          srcObject binding) got recreated every time the camera toggled
          back on, leaving the tile stuck black. We just hide it with CSS
          and overlay the avatar instead. */}
      {stream && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isSelf}
          className={`h-full w-full ${
            participant.sharingScreen ? "object-contain" : "object-cover"
          } ${isSelf && !participant.sharingScreen ? "-scale-x-100" : ""} ${
            showVideo ? "" : "hidden"
          }`}
        />
      )}
      {!showVideo && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-ink-800 to-ink-900">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-xl font-bold text-on-accent shadow-lg ring-4 ring-white/10">
            {initials(participant.name)}
          </div>
        </div>
      )}

      {/* Soft scrim behind the name row so it stays legible over any video
          content, not just the flat pill -- the same layered look Zoom/Meet
          use instead of a hard-edged bar. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/60 to-transparent" />
      <div className="absolute inset-x-2 bottom-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 shadow-soft backdrop-blur-sm">
          <span className="max-w-[10rem] truncate text-xs font-medium text-on-accent">
            {participant.name}
            {isSelf ? " (vos)" : ""}
          </span>
          {participant.muted && <MicOffIcon className="h-3.5 w-3.5 shrink-0 text-brand-300" />}
        </div>
        <RoleBadge role={role} size="sm" />
      </div>

      {participant.handRaised && (
        <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-900 shadow-soft">
          <HandIcon className="h-3.5 w-3.5 animate-bounce" />
          Mano
        </span>
      )}
      {participant.isHost && (
        <span className="absolute left-2 top-2 rounded-full bg-brand-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-on-accent shadow-soft">
          Anfitrión
        </span>
      )}
      {participant.sharingScreen && (
        <span
          className={`absolute ${
            participant.isHost ? "left-24" : "left-2"
          } top-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-on-accent shadow-soft backdrop-blur-sm`}
        >
          <ScreenShareIcon className="h-3 w-3" />
          Compartiendo pantalla
        </span>
      )}
    </div>
  );
}

// Memoized: in a large meeting every roster update creates a new
// participants array, but unchanged participants keep their object identity
// (see meetingReducer), so this skips re-rendering every other tile.
export default memo(ParticipantTile);

function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase() || "?";
}

function MicOffIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M3 3l18 18M9 9v3a3 3 0 0 0 4.24 2.73M15 9V6a3 3 0 0 0-5.91-.74M12 18v3m-4 0h8M5 11a7 7 0 0 0 9.9 6.36"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
