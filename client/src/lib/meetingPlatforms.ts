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
  | "webex"
  | "skype"
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
    label: "Unify",
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
    joinMode: "embed",
    official: true,
    requires: [
      "Recurso de Azure Communication Services (ACS_CONNECTION_STRING en el servidor)",
      "Endpoint /api/teams/token que emite el token ACS (interop de Teams)",
      "SDK @azure/communication-calling en el cliente para unirse por el link",
    ],
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
  webex: {
    platform: "webex",
    label: "Webex",
    joinMode: "redirect",
    official: false,
    requires: ["Webex exige una app registrada y su SDK no permite unirse por enlace desde un tercero"],
  },
  skype: {
    platform: "skype",
    label: "Skype",
    joinMode: "redirect",
    official: false,
    requires: ["Skype no ofrece forma de unirse a una llamada por enlace desde otra web"],
  },
  unknown: {
    platform: "unknown",
    label: "Plataforma desconocida",
    joinMode: "redirect",
    official: false,
    requires: [],
  },
};

// A saved meeting's join code is either a native code (e.g. "ABC123") or an
// external companion key ("ZOOM:123", "TEAMS:...", "JITSI:room"). For history
// display we only want to show WHERE it happened -- never the raw (often long)
// key/link, which just confuses people.
export function meetingSourceLabel(joinCode: string): string {
  const prefix = joinCode.match(/^([a-z-]+):/i)?.[1]?.toLowerCase();
  switch (prefix) {
    case "zoom":
      return "Zoom";
    case "teams":
      return "Microsoft Teams";
    case "jitsi":
      return "Jitsi";
    case "google-meet":
      return "Google Meet";
    case "webex":
      return "Webex";
    case "skype":
      return "Skype";
    case "discord":
      return "Discord";
    default:
      return "Unify";
  }
}

export function isExternalMeeting(joinCode: string): boolean {
  return /^[a-z-]+:/i.test(joinCode);
}

// Saca la contraseña del texto pegado. La gente copia la invitación entera
// ("...ID: 123 456 789 / Código de acceso: 4821"), así que si está ahí, la
// usamos en vez de hacérsela buscar y tipear de nuevo. Devuelve null cuando no
// hay nada que se parezca a una clave.
export function extractPasscode(raw: string): string | null {
  const m = raw.match(
    /(?:passcode|password|contrase[ñn]a|clave|c[óo]digo de acceso|access code)\s*[:\-]?\s*([A-Za-z0-9]{4,20})/i
  );
  return m ? m[1] : null;
}

export interface DetectedMeeting {
  platform: MeetingPlatform;
  info: PlatformInfo;
  /** Normalized absolute URL (scheme guaranteed). Null if the input wasn't a URL at all. */
  url: string | null;
  /** Platform-native id when the link exposes one: Zoom meeting number, Meet code, Unify join code, Jitsi room. */
  meetingId?: string;
  /** Passcode/password when the link carries one (e.g. Zoom `pwd`). Treat as sensitive -- never log it. */
  passcode?: string;
  /**
   * Teams personal / "Teams for life" (teams.live.com). Microsoft blocks ACS
   * interop for these, so they can NEVER be embedded -- the caller must go
   * straight to companion mode instead of trying (and failing) to join.
   */
  personal?: boolean;
  /**
   * Stable key for the shared Unify room. Derived from the meeting's own
   * identity ONLY -- never from query strings, which carry per-person tokens
   * and would otherwise split people who pasted the same meeting into
   * separate rooms (and persist those secrets as our join code).
   */
  roomKey?: string;
}

// Un-wraps the redirector URLs corporate mail and chat apps rewrite links
// with. An Outlook "safelink" or a Google redirect is not a meeting link, but
// it CONTAINS one -- without this, pasting a Teams invite straight out of
// Outlook is simply not recognized.
function unwrapRedirects(url: URL): URL {
  for (let i = 0; i < 3; i++) {
    const host = url.hostname.toLowerCase();
    const wrapped =
      host.endsWith("safelinks.protection.outlook.com") || host.endsWith("protection.outlook.com")
        ? url.searchParams.get("url")
        : host === "www.google.com" || host === "google.com"
          ? url.searchParams.get("q")
          : host === "l.facebook.com" || host === "lm.facebook.com"
            ? url.searchParams.get("u")
            : host === "out.reddit.com" || host === "href.li"
              ? url.searchParams.get("url")
              : null;
    if (!wrapped) return url;
    try {
      const next = new URL(safeDecode(wrapped));
      if (next.protocol !== "http:" && next.protocol !== "https:") return url;
      url = next;
    } catch {
      return url;
    }
  }
  return url;
}

// Normalizes the text a person actually pastes into something we can parse:
// strips the invisible characters chat apps inject (zero-width space, BOM,
// non-breaking space), collapses whitespace and removes the wrapping
// punctuation of a quoted link. Exported so the input field can show the user
// the cleaned-up value instead of silently parsing something different from
// what they see.
export function sanitizeMeetingInput(raw: string): string {
  return raw
    // Zero-width + BOM + word-joiner: WhatsApp/Slack/Outlook slip these into
    // pasted links and they break URL parsing invisibly.
    .replace(/[\u200b-\u200d\ufeff\u2060]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[<"'«([]+/, "")
    .replace(/[>"'»)\]]+$/, "");
}

// Last resort when there is no URL in the text at all: people very often paste
// only the invitation body ("ID de reunión: 891 2345 6789") or just the Meet
// code they read out loud. Recognizing those is the difference between
// "no reconocimos ese enlace" and joining.
function detectFromBareText(text: string): DetectedMeeting | null {
  const meetCode = text.match(/(?:^|[\s:])([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[\s.,])/i)?.[1];
  if (meetCode) {
    const code = meetCode.toLowerCase();
    return {
      platform: "google-meet",
      info: PLATFORM_REGISTRY["google-meet"],
      url: `https://meet.google.com/${code}`,
      meetingId: code,
      roomKey: `google-meet:${code}`,
    };
  }
  // Zoom ids are 9-11 digits, usually written in groups ("891 2345 6789").
  // Require an explicit id/meeting word so a random phone number in the text
  // isn't mistaken for a meeting.
  const zoomId = text
    .match(/(?:zoom|id de reuni[óo]n|meeting id|reuni[óo]n)\D{0,20}((?:\d[\s-]?){9,11})/i)?.[1]
    ?.replace(/\D/g, "");
  if (zoomId && zoomId.length >= 9 && zoomId.length <= 11) {
    return {
      platform: "zoom",
      info: PLATFORM_REGISTRY.zoom,
      url: `https://zoom.us/j/${zoomId}`,
      meetingId: zoomId,
      roomKey: `zoom:${zoomId}`,
    };
  }
  return null;
}

// People paste links with and without the scheme ("zoom.us/j/123" vs the full
// https URL), so tolerate a missing scheme instead of failing to detect.
// Teams links are URL-encoded; decode defensively (a malformed % sequence
// throws) so we can pull the meeting thread id out of the path.
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeUrl(raw: string): URL | null {
  const trimmed = sanitizeMeetingInput(raw);
  if (!trimmed) return null;
  // People rarely paste a bare link: they paste the whole invitation
  // ("Unite a mi llamada https://…", "Reunión: <https://…>", a WhatsApp message
  // with the passcode after it). Pull the first http(s) URL out of the text
  // instead of failing on everything around it; if there isn't one, fall back
  // to the raw text with surrounding brackets/quotes stripped so a bare
  // "zoom.us/j/123" still works.
  // Trailing sentence punctuation is stripped too: "...abc-defg-hij." would
  // otherwise become part of the path and hide the meeting code.
  const embedded = trimmed.match(/https?:\/\/[^\s<>"'«»()[\]]+/i)?.[0]?.replace(/[.,;:!?]+$/, "");
  const candidate = embedded ?? trimmed;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate);
  // Sin esquema, sólo vale si el primer tramo parece un dominio ("zoom.us/j/1").
  // Sin este chequeo, pegar sólo el código de Meet ("abc-defg-hij") se
  // convertía en "https://abc-defg-hij", que es una URL válida con un host
  // inexistente -- y se perdía la única pista que la persona había dado.
  if (!hasScheme && !/^[^/\s]+\.[a-z]{2,}(?:[:/?#]|$)/i.test(candidate)) return null;
  const withScheme = hasScheme ? candidate : `https://${candidate}`;
  try {
    const url = new URL(withScheme);
    // Only ever treat real web links as meetings: anything else (javascript:,
    // data:, custom schemes) is rejected outright rather than parsed further.
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return unwrapRedirects(url);
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
    // No parseable URL at all -- but the invitation text alone often carries
    // enough (a Meet code, a Zoom meeting id) to join anyway.
    return (
      detectFromBareText(sanitizeMeetingInput(input)) ?? {
        platform: "unknown",
        info: PLATFORM_REGISTRY.unknown,
        url: null,
      }
    );
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
    // The digits can be written with separators inside the path on some
    // rewritten links ("/j/891-2345-6789"), so strip them before matching.
    const meetingId = url.pathname
      .replace(/(\d)[\s-](?=\d)/g, "$1")
      .match(/\/(?:j|w|wc)\/(\d{9,11})/)?.[1];
    const passcode = url.searchParams.get("pwd") ?? undefined;
    // A vanity link (/my/name) has no number in the URL, but the invitation
    // text pasted around it usually does.
    const fromText = meetingId ? null : detectFromBareText(sanitizeMeetingInput(input));
    const id = meetingId ?? (fromText?.platform === "zoom" ? fromText.meetingId : undefined);
    return build("zoom", { meetingId: id, passcode, roomKey: id ? `zoom:${id}` : undefined });
  }

  // Google Meet codes look like abc-defg-hij; /lookup/ aliases don't expose one.
  if (host === "meet.google.com") {
    const code = url.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/i)?.[1]?.toLowerCase();
    return build("google-meet", {
      meetingId: code,
      roomKey: code ? `google-meet:${code}` : undefined,
      // Keep only the code in the URL we hand around: the query string of a
      // Meet link carries per-account params (authuser, pli, hs) that send
      // other people to the wrong Google account.
      ...(code ? { url: `https://meet.google.com/${code}` } : {}),
    });
  }

  // Teams join links carry the meeting's stable thread id
  // (19:meeting_XXXX@thread.v2, usually URL-encoded). We surface it as the
  // meetingId so everyone who pastes the same link shares one companion room;
  // the full URL is what ACS actually joins (see TeamsMeetingLinkLocator).
  if (host === "teams.microsoft.com" || host.endsWith(".teams.microsoft.com")) {
    const decodedPath = safeDecode(url.pathname);
    const threadId = decodedPath.match(/(19:meeting_[^/@]+@thread\.v2)/i)?.[1]?.toLowerCase();
    return build("microsoft-teams", {
      meetingId: threadId,
      // Falls back to origin+path (never the query): the `context`/`launchAgent`
      // params differ per person, so keying the room on the full URL would put
      // two people who opened the SAME meeting into two separate Unify rooms.
      roomKey: `teams:${threadId ?? `${url.origin}${url.pathname}`.toLowerCase()}`,
    });
  }

  // teams.live.com is personal / "Teams for life". Microsoft does not allow
  // ACS interop into these, so there is no embed to attempt: it is a companion
  // meeting by nature, and needs no server credentials at all.
  if (host === "teams.live.com" || host.endsWith(".teams.live.com")) {
    const meetId = url.pathname.match(/\/meet\/(\d{6,})/)?.[1];
    return build("microsoft-teams", {
      meetingId: meetId,
      personal: true,
      // `?p=` is this meeting's passcode -- it must never become the room key
      // (it would be persisted as our join code and shown around).
      passcode: url.searchParams.get("p") ?? undefined,
      roomKey: `teams:${meetId ?? `${url.origin}${url.pathname}`.toLowerCase()}`,
    });
  }

  // Only the hosted meet.jit.si here; self-hosted Jitsi lives on arbitrary
  // domains we can't recognize generically.
  if (host === "meet.jit.si") {
    // Decoded on purpose: a room with accents/ñ arrives percent-encoded in the
    // pathname ("reuni%C3%B3n"), and Jitsi's embed API expects the PLAIN name
    // (it encodes it again itself). Passing the encoded form would open a
    // literally different room than the one the link points at.
    const raw = url.pathname.replace(/^\/+/, "").split("/")[0];
    const room = raw ? safeDecode(raw) : undefined;
    // Lowercased key only (Jitsi normalizes room names that way), so two people
    // typing different casing still land in the same Unify room.
    return build("jitsi", { meetingId: room, roomKey: room ? `jitsi:${room.toLowerCase()}` : undefined });
  }

  if (host === "discord.gg" || host === "discord.com" || host.endsWith(".discord.com")) {
    return build("discord", { roomKey: `discord:${url.pathname.toLowerCase()}` });
  }

  // Webex and Skype can't be embedded (no third-party join SDK), but the Unify
  // companion layer doesn't need one -- so we still recognize them and give
  // them a stable room key. The path alone identifies the meeting; the query
  // string carries per-person tokens and stays out of the key.
  if (host.endsWith("webex.com") || host.endsWith("webex.com.cn")) {
    return build("webex", { roomKey: `webex:${host}${url.pathname.toLowerCase()}` });
  }
  if (host === "join.skype.com" || host === "skype.com" || host.endsWith(".skype.com")) {
    return build("skype", { roomKey: `skype:${url.pathname.toLowerCase()}` });
  }

  return build("unknown");
}
