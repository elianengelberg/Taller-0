// Minimal typings for the surface we use of Zoom's Meeting SDK for web,
// Component View (@zoom/meetingsdk/embedded): createClient ->
// init/join/leaveMeeting/on. We cast the SDK's client to ZoomEmbeddedClient so
// our call sites are typed against just what we use, mirroring the shape of the
// official `embedded` types.

interface ZoomCustomSize {
  width: number;
  height: number;
}

// By default the Component View renders a small, draggable, resizable video
// popper. We pin it to the container size and a fixed view so it fills our
// embed pane instead of floating in a corner.
interface ZoomVideoOptions {
  isResizable?: boolean;
  viewSizes?: { default?: ZoomCustomSize; ribbon?: ZoomCustomSize };
  defaultViewType?: "minimized" | "speaker" | "ribbon" | "gallery" | "active";
  // disableDraggable pins the video so it can't be dragged around the pane.
  popper?: { disableDraggable?: boolean };
}

interface ZoomInitOptions {
  zoomAppRoot: HTMLElement;
  language?: string;
  // Patches the media layer so it loads from Zoom's CDN and works WITHOUT
  // cross-origin isolation (SharedArrayBuffer). Lets us skip COOP/COEP headers
  // that would otherwise break our cross-origin Jitsi iframe and other embeds.
  patchJsMedia?: boolean;
  // Leave the meeting immediately on page unload instead of a failover delay.
  leaveOnPageUnload?: boolean;
  assetPath?: string;
  debug?: boolean;
  customize?: {
    video?: ZoomVideoOptions;
  };
}

interface ZoomJoinOptions {
  signature: string;
  meetingNumber: string;
  userName: string;
  password?: string;
  userEmail?: string;
  // Optional tokens for the post-2026-03 "authorize apps joining meetings
  // outside their account" requirement (zak = start as host / obfToken = join
  // on behalf of another user). Mutually exclusive.
  zak?: string;
  obfToken?: string;
  tk?: string;
}

// connection-change reports the meeting connection lifecycle. `state` is one of
// Zoom's connection states ('Connected' | 'Closed' | 'Fail' | 'Reconnecting').
interface ZoomConnectionChangePayload {
  state?: string;
  reason?: string;
}

interface ZoomEmbeddedClient {
  init(options: ZoomInitOptions): Promise<unknown>;
  join(options: ZoomJoinOptions): Promise<unknown>;
  leaveMeeting(): Promise<unknown>;
  on(event: "connection-change", callback: (payload: ZoomConnectionChangePayload) => void): void;
  off?(event: string, callback: (payload: unknown) => void): void;
}
