import { useEffect, useRef, useState } from "react";
import { Participant, Role } from "../types";
import { CollapseIcon, ExpandIcon } from "./icons";
import ParticipantTile from "./ParticipantTile";

interface Props {
  participants: Participant[];
  roles: Role[];
  selfId: string | null;
  localStream: MediaStream | null;
  remoteStreams: Record<string, MediaStream>;
  // Chosen audio output device (see Opciones panel); applied to remote tiles.
  speakerId?: string | null;
  // participantId -> true when they're currently talking (active-speaker ring).
  speaking?: Record<string, boolean>;
}

// Older iOS/iPadOS Safari never implemented the standard Fullscreen API on
// arbitrary elements (only vendor-prefixed fullscreen for <video> itself),
// so `document.exitFullscreen`/`element.requestFullscreen` can simply not
// exist there -- calling them as functions would throw a TypeError, not
// just reject a promise. Feature-detect before ever touching them.
function fullscreenSupported(): boolean {
  return typeof document.exitFullscreen === "function";
}

export default function VideoGrid({
  participants,
  roles,
  selfId,
  localStream,
  remoteStreams,
  speakerId,
  speaking,
}: Props) {
  const presenter = participants.find((p) => p.sharingScreen) ?? null;
  const containerRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreenSupported()) return;
    function handleChange() {
      setFullscreen(document.fullscreenElement === containerRef.current);
    }
    document.addEventListener("fullscreenchange", handleChange);
    return () => document.removeEventListener("fullscreenchange", handleChange);
  }, []);

  // If the presenter stops sharing while we're in fullscreen, don't strand
  // the user in a fullscreen view of a layout that no longer makes sense.
  useEffect(() => {
    if (!fullscreenSupported()) return;
    if (!presenter && document.fullscreenElement === containerRef.current) {
      document.exitFullscreen().catch(() => {});
    }
  }, [presenter]);

  function toggleFullscreen() {
    if (!fullscreenSupported()) return;
    if (document.fullscreenElement === containerRef.current) {
      document.exitFullscreen().catch(() => {});
    } else {
      containerRef.current?.requestFullscreen().catch(() => {});
    }
  }

  function tileFor(participant: Participant) {
    const isSelf = participant.id === selfId;
    const stream = isSelf ? localStream : remoteStreams[participant.id] ?? null;
    const role = roles.find((r) => r.id === participant.roleId) ?? null;
    return (
      <ParticipantTile
        key={participant.id}
        participant={participant}
        role={role}
        stream={stream}
        isSelf={isSelf}
        speakerId={speakerId}
        speaking={Boolean(speaking?.[participant.id])}
      />
    );
  }

  if (presenter) {
    const others = participants.filter((p) => p.id !== presenter.id);
    return (
      <div
        ref={containerRef}
        className={`flex flex-col gap-3 ${fullscreen ? "h-dvh bg-ink-950 p-4" : ""}`}
      >
        <div className="relative">
          {tileFor(presenter)}
          {fullscreenSupported() && (
            <button
              type="button"
              onClick={toggleFullscreen}
              title={fullscreen ? "Achicar pantalla compartida" : "Agrandar pantalla compartida"}
              className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
            >
              {fullscreen ? <CollapseIcon className="h-4 w-4" /> : <ExpandIcon className="h-4 w-4" />}
            </button>
          )}
        </div>
        {others.length > 0 && (
          <div className="flex gap-3 overflow-x-auto pb-1">
            {others.map((participant) => (
              <div key={participant.id} className="w-40 shrink-0 sm:w-48">
                {tileFor(participant)}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return <div className={`grid gap-4 ${gridColumnsFor(participants.length)}`}>{participants.map(tileFor)}</div>;
}

function gridColumnsFor(count: number): string {
  if (count <= 1) return "mx-auto max-w-2xl grid-cols-1";
  if (count === 2) return "grid-cols-1 sm:grid-cols-2";
  if (count <= 4) return "grid-cols-2";
  if (count <= 6) return "grid-cols-2 sm:grid-cols-3";
  return "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4";
}
