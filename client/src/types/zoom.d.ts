// Minimal typings for Zoom's Meeting SDK for web, Component View
// (zoom-meeting-embedded-*.min.js). It's loaded at runtime from source.zoom.us
// and attaches ZoomMtgEmbedded to window, so we declare just the surface we
// use (createClient -> init/join/leaveMeeting/on). Mirrors the shape of the
// official @zoom/meetingsdk `embedded` types.

interface ZoomInitOptions {
  zoomAppRoot: HTMLElement;
  language?: string;
  // Patches the media layer so it loads from Zoom's CDN and works WITHOUT
  // cross-origin isolation (SharedArrayBuffer). Lets us skip COOP/COEP headers
  // that would otherwise break our cross-origin Jitsi iframe and other embeds.
  patchJsMedia?: boolean;
  assetPath?: string;
  debug?: boolean;
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

interface ZoomEmbeddedClient {
  init(options: ZoomInitOptions): Promise<unknown>;
  join(options: ZoomJoinOptions): Promise<unknown>;
  leaveMeeting(): Promise<unknown>;
  on(event: "connection-change", callback: (payload: { state?: string }) => void): void;
  off?(event: string, callback: (payload: unknown) => void): void;
}

interface ZoomMtgEmbedded {
  createClient(): ZoomEmbeddedClient;
}

interface Window {
  ZoomMtgEmbedded?: ZoomMtgEmbedded;
}
