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
  // Remembered across shares and sessions. "bottom" = filmstrip under the
  // screen (Meet/Zoom style), "side" = column beside it.
  const [presenterLayout, setPresenterLayout] = useState<PresenterLayout>(
    () => (localStorage.getItem("unify_presenter_layout") as PresenterLayout) || "bottom"
  );
  useEffect(() => {
    localStorage.setItem("unify_presenter_layout", presenterLayout);
  }, [presenterLayout]);

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
    // Everyone except the presenter still gets a camera tile -- the whole
    // point of the fix: the shared screen is primary, but the people don't
    // vanish. Both layouts below keep them all visible (scroll only kicks in
    // past what fits, never hiding someone at 5).
    const others = participants.filter((p) => p.id !== presenter.id);
    const side = presenterLayout === "side";

    const presenterStage = (
      <div className="relative min-h-0 min-w-0 flex-1">
        <ParticipantTile
          key={presenter.id}
          participant={presenter}
          role={roles.find((r) => r.id === presenter.roleId) ?? null}
          stream={presenter.id === selfId ? localStream : remoteStreams[presenter.id] ?? null}
          isSelf={presenter.id === selfId}
          speakerId={speakerId}
          speaking={Boolean(speaking?.[presenter.id])}
          fill
        />
        {/* Layout toggle + fullscreen, top-right over the shared screen. */}
        <div className="absolute right-2 top-2 flex items-center gap-1.5">
          <LayoutToggle layout={presenterLayout} onChange={setPresenterLayout} />
          {fullscreenSupported() && (
            <button
              type="button"
              onClick={toggleFullscreen}
              title={fullscreen ? "Achicar pantalla compartida" : "Agrandar pantalla compartida"}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-on-accent hover:bg-black/80"
            >
              {fullscreen ? <CollapseIcon className="h-4 w-4" /> : <ExpandIcon className="h-4 w-4" />}
            </button>
          )}
        </div>
      </div>
    );

    // Camera strip. In "side" mode it's a vertical column to the right; in
    // "bottom" mode a centered horizontal filmstrip below. In both, tiles
    // flex-shrink so at least ~5 fit before any scrolling starts.
    const cameraStrip = others.length > 0 && (
      <div
        className={
          side
            ? "flex w-40 shrink-0 flex-col gap-2 overflow-y-auto sm:w-48"
            : "flex shrink-0 items-stretch justify-center gap-2 overflow-x-auto pb-1"
        }
      >
        {others.map((participant) => (
          <div
            key={participant.id}
            className={
              side
                ? "w-full shrink-0"
                : "aspect-video min-w-[6rem] max-w-[11rem] grow basis-0 sm:min-w-[7.5rem]"
            }
          >
            {tileFor(participant)}
          </div>
        ))}
      </div>
    );

    return (
      <div
        ref={containerRef}
        className={`flex h-full min-h-[60vh] gap-3 ${side ? "flex-row" : "flex-col"} ${
          fullscreen ? "h-dvh bg-ink-950 p-4" : ""
        }`}
      >
        {presenterStage}
        {cameraStrip}
      </div>
    );
  }

  return <div className={`grid gap-4 ${gridColumnsFor(participants.length)}`}>{participants.map(tileFor)}</div>;
}

// Segmented control to switch the camera layout during a screen share.
// Persisted so the choice sticks across shares and sessions.
type PresenterLayout = "side" | "bottom";

function LayoutToggle({
  layout,
  onChange,
}: {
  layout: PresenterLayout;
  onChange: (l: PresenterLayout) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-full bg-black/60 p-0.5 text-on-accent">
      <button
        type="button"
        onClick={() => onChange("bottom")}
        aria-pressed={layout === "bottom"}
        title="Cámaras abajo (estilo Meet/Zoom)"
        className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
          layout === "bottom" ? "bg-white/20" : "hover:bg-white/10"
        }`}
      >
        Abajo
      </button>
      <button
        type="button"
        onClick={() => onChange("side")}
        aria-pressed={layout === "side"}
        title="Cámaras al costado"
        className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
          layout === "side" ? "bg-white/20" : "hover:bg-white/10"
        }`}
      >
        Al costado
      </button>
    </div>
  );
}

function gridColumnsFor(count: number): string {
  if (count <= 1) return "mx-auto max-w-2xl grid-cols-1";
  if (count === 2) return "grid-cols-1 sm:grid-cols-2";
  if (count <= 4) return "grid-cols-2";
  if (count <= 6) return "grid-cols-2 sm:grid-cols-3";
  return "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4";
}
