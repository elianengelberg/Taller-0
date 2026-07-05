// Recognizes what kind of meeting link the user pasted, so the app can route
// it to the right integration (join a Zoom meeting embedded via the Zoom SDK,
// hand a Google Meet link to the browser extension overlay, join our own
// meetings natively, etc.). This module is deliberately PURE and side-effect
// free -- it only parses a string into a platform + identifiers. Actually
// joining is each adapter's job; keeping detection separate is what lets us
// add Teams/Discord/Jitsi later by touching only the registry below.

export type MeetingPlatform =
  | "encuentro"
  | "zoom"
  | "google-meet"
  | "microsoft-teams"
  | "jitsi"
  | "discord"
  | "unknown";

// How a given platform can be brought into our app -- the honest, real-world
// constraint, not a wish. Drives what the UI offers for a detected link.
//  - "native": it's our own meeting; use the existing in-app flow.
//  - "embed": an official SDK/iframe lets us render the meeting inside our
//    layout (Zoom Meeting SDK, Jitsi external_api).
//  - "overlay-extension": the platform has NO embed SDK, so our tools live in
//    a browser-extension overlay injected on top of their site (Google Meet).
//  - "redirect": we can recognize it but can only send the user to the
//    platform's own page (no supported embed/overlay yet).
export type JoinMode = "native" | "embed" | "overlay-extension" | "redirect";

export interface PlatformInfo {
  platform: MeetingPlatform;
  /** Human-facing name (Spanish UI). */
  label: string;
  joinMode: JoinMode;
  /** Whether the integration path relies on an official, vendor-supported API. */
  official: boolean;
  /** What still has to exist/be configured before this can actually connect. */
  requires: string[];
}

// Single source of truth. Adding a new platform later = one entry here + one
// adapter that reads `joinMode`; nothing else in the app needs to know the
// specifics.
export const PLATFORM_REGISTRY: Record<MeetingPlatform, PlatformInfo> = {
  encuentro: {
    platform: "encuentro",
    label: "Encuentro",
    joinMode: "native",
    official: true,
    requires: [],
  },
  zoom: {
    platform: "zoom",
    label: "Zoom",
    joinMode: "embed",
    official: true,
    requires: [
      "App de Zoom Marketplace con Meeting SDK habilitado (Client ID + Client Secret)",
      "ZOOM_SDK_KEY / ZOOM_SDK_SECRET en el servidor (endpoint /api/zoom/signature)",
      "Meeting SDK web (Component View) cargado desde el CDN de Zoom con patchJsMedia",
    ],
  },
  "google-meet": {
    platform: "google-meet",
    label: "Google Meet",
    joinMode: "overlay-extension",
    official: false,
    requires: [
      "Extensión de navegador (Chrome/Edge) instalada",
      "Bridge en el backend (WebSocket con token) entre la extensión y la app",
    ],
  },
  "microsoft-teams": {
    platform: "microsoft-teams",
    label: "Microsoft Teams",
    joinMode: "redirect",
    official: true,
    requires: ["Azure Communication Services / Microsoft Graph (integración futura)"],
  },
  jitsi: {
    platform: "jitsi",
    label: "Jitsi Meet",
    joinMode: "embed",
    official: true,
    requires: ["Jitsi external_api.js (embebido, sin credenciales)"],
  },
  discord: {
    platform: "discord",
    label: "Discord",
    joinMode: "redirect",
    official: false,
    requires: ["Discord no ofrece un SDK para embeber llamadas de voz por enlace"],
  },
  unknown: {
    platform: "unknown",
    label: "Plataforma desconocida",
    joinMode: "redirect",
    official: false,
    requires: [],
  },
};

export interface DetectedMeeting {
  platform: MeetingPlatform;
  info: PlatformInfo;
  /** Normalized absolute URL (scheme guaranteed). Null if the input wasn't a URL at all. */
  url: string | null;
  /** Platform-native id when the link exposes one: Zoom meeting number, Meet code, Encuentro join code, Jitsi room. */
  meetingId?: string;
  /** Passcode/password when the link carries one (e.g. Zoom `pwd`). Treat as sensitive -- never log it. */
  passcode?: string;
}

// People paste links with and without the scheme ("zoom.us/j/123" vs the full
// https URL), so tolerate a missing scheme instead of failing to detect.
function normalizeUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

export function detectMeetingPlatform(
  input: string,
  options: { selfHosts?: string[] } = {}
): DetectedMeeting {
  const url = normalizeUrl(input);
  if (!url) {
    return { platform: "unknown", info: PLATFORM_REGISTRY.unknown, url: null };
  }

  const host = url.hostname.toLowerCase();
  const normalized = url.toString();
  const selfHosts = (options.selfHosts ?? []).map((h) => h.toLowerCase());
  const build = (platform: MeetingPlatform, extra?: Partial<DetectedMeeting>): DetectedMeeting => ({
    platform,
    info: PLATFORM_REGISTRY[platform],
    url: normalized,
    ...extra,
  });

  // Our own invite links -> join natively through the existing flow, no
  // external integration involved.
  if (selfHosts.includes(host)) {
    const code = url.pathname.match(/\/unirse\/([^/?#]+)/i)?.[1];
    return build("encuentro", { meetingId: code?.toUpperCase() });
  }

  // Zoom hands out per-company subdomains (acme.zoom.us), so match the whole
  // family, not just the bare domain. Meeting number lives after /j/, /w/ or
  // /wc/; personal/vanity links (/my/name) legitimately have no number in the
  // URL, which the caller surfaces as "pedile el número o la contraseña".
  if (host === "zoom.us" || host.endsWith(".zoom.us")) {
    const meetingId = url.pathname.match(/\/(?:j|w|wc)\/(\d{9,})/)?.[1];
    const passcode = url.searchParams.get("pwd") ?? undefined;
    return build("zoom", { meetingId, passcode });
  }

  // Google Meet codes look like abc-defg-hij; /lookup/ aliases don't expose one.
  if (host === "meet.google.com") {
    const code = url.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/i)?.[1];
    return build("google-meet", { meetingId: code?.toLowerCase() });
  }

  if (host === "teams.microsoft.com" || host === "teams.live.com" || host.endsWith(".teams.microsoft.com")) {
    return build("microsoft-teams");
  }

  // Only the hosted meet.jit.si here; self-hosted Jitsi lives on arbitrary
  // domains we can't recognize generically.
  if (host === "meet.jit.si") {
    const room = url.pathname.replace(/^\/+/, "").split("/")[0] || undefined;
    return build("jitsi", { meetingId: room });
  }

  if (host === "discord.gg" || host === "discord.com" || host.endsWith(".discord.com")) {
    return build("discord");
  }

  return build("unknown");
}
