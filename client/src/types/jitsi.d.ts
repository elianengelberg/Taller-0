// Minimal typings for Jitsi's official embed API (external_api.js). It's
// loaded at runtime from meet.jit.si and attaches JitsiMeetExternalAPI to
// window, so there's no npm package to pull types from -- we declare just the
// surface we use.
interface JitsiMeetExternalAPIOptions {
  roomName?: string;
  width?: string | number;
  height?: string | number;
  parentNode?: HTMLElement | null;
  userInfo?: { displayName?: string; email?: string };
  configOverwrite?: Record<string, unknown>;
  interfaceConfigOverwrite?: Record<string, unknown>;
}

declare class JitsiMeetExternalAPI {
  constructor(domain: string, options: JitsiMeetExternalAPIOptions);
  dispose(): void;
  addEventListener(event: string, listener: (payload?: unknown) => void): void;
  removeEventListener(event: string, listener: (payload?: unknown) => void): void;
  executeCommand(command: string, ...args: unknown[]): void;
}

interface Window {
  JitsiMeetExternalAPI?: typeof JitsiMeetExternalAPI;
}
