import { useEffect, useRef } from "react";
import { Participant, Role } from "../types";
import RoleBadge from "./RoleBadge";

interface Props {
  participant: Participant;
  role: Role | null;
  stream: MediaStream | null;
  isSelf: boolean;
}

export default function ParticipantTile({ participant, role, stream, isSelf }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  const showVideo = Boolean(stream) && !participant.cameraOff;

  return (
    <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-2xl bg-ink-900 shadow-soft">
      {showVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isSelf}
          className={`h-full w-full object-cover ${isSelf ? "-scale-x-100" : ""}`}
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-ink-800 to-ink-900">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-500 text-xl font-bold text-white">
            {initials(participant.name)}
          </div>
        </div>
      )}

      <div className="absolute inset-x-2 bottom-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 backdrop-blur-sm">
          <span className="max-w-[10rem] truncate text-xs font-medium text-white">
            {participant.name}
            {isSelf ? " (vos)" : ""}
          </span>
          {participant.muted && <MicOffIcon className="h-3.5 w-3.5 shrink-0 text-brand-300" />}
        </div>
        <RoleBadge role={role} size="sm" />
      </div>

      {participant.isHost && (
        <span className="absolute left-2 top-2 rounded-full bg-brand-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow-soft">
          Anfitrión
        </span>
      )}
    </div>
  );
}

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
