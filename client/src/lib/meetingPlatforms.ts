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
  | "whereby"
  | "element-call"
  | "discord"
  | "webex"
  | "skype"
  | "goto"
  | "bluejeans"
  | "chime"
  | "slack"
  | "whatsapp"
  | "zoho"
  | "dialpad"
  | "ringcentral"
  | "livestorm"
  | "gather"
  // Un enlace de videollamada que no reconocemos por nombre. No es lo mismo
  // que "unknown": igual se puede acompañar con subtítulos, traducción, IA y
  // grabación, porque nada de eso depende de la otra plataforma.
  | "generica"
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

// Plataformas que sólo hace falta reconocer: no se pueden embeber, pero con el
// modo companion igual tienen subtítulos, traducción, IA y grabación. Sumar
// una es una línea acá -- por eso conviene que sea una tabla y no otro `if`.
interface SimplePlatform {
  platform: MeetingPlatform;
  label: string;
  /** Dominio exacto, o sufijo si empieza con punto. */
  hosts: readonly string[];
  /** Por qué no se puede embeber (va a `requires`). */
  reason: string;
  /**
   * Parámetros del query que identifican la reunión, cuando el path solo no
   * alcanza (Chime la lleva en `?pin=`, Zoho en `?key=`). Sin esto, TODAS las
   * reuniones de esa plataforma comparten el mismo path y caerían en una única
   * sala de Unify -- gente de reuniones distintas viéndose la transcripción.
   * Se listan de a uno a propósito: el resto del query trae tokens por persona
   * que partirían en dos a quienes abrieron la misma reunión.
   */
  idParams?: readonly string[];
}

const SIMPLE_PLATFORMS = [
  {
    platform: "webex",
    label: "Webex",
    hosts: [".webex.com", "webex.com", ".webex.com.cn"],
    reason: "Webex exige una app registrada y su SDK no permite unirse por enlace desde un tercero",
  },
  {
    platform: "skype",
    label: "Skype",
    hosts: ["join.skype.com", "skype.com", ".skype.com"],
    reason: "Skype no ofrece forma de unirse a una llamada por enlace desde otra web",
  },
  {
    platform: "discord",
    label: "Discord",
    hosts: ["discord.gg", "discord.com", ".discord.com"],
    reason: "Discord no ofrece un SDK para embeber llamadas de voz por enlace",
  },
  {
    platform: "goto",
    label: "GoTo Meeting",
    hosts: ["gotomeet.me", "goto.com", ".goto.com", "gotomeeting.com", ".gotomeeting.com", "global.gotomeeting.com"],
    reason: "GoTo no publica un SDK web para unirse a una reunión desde otro sitio",
  },
  {
    platform: "bluejeans",
    label: "BlueJeans",
    hosts: ["bluejeans.com", ".bluejeans.com"],
    reason: "BlueJeans no permite embeber la llamada fuera de su propio cliente",
  },
  {
    platform: "chime",
    label: "Amazon Chime",
    hosts: ["chime.aws", ".chime.aws", "app.chime.aws"],
    reason: "Chime necesita credenciales de AWS por reunión; su SDK no se une por enlace público",
    idParams: ["pin", "meetingId"],
  },
  {
    platform: "slack",
    label: "Slack",
    hosts: ["app.slack.com", ".slack.com"],
    reason: "Los huddles de Slack sólo funcionan dentro de Slack",
  },
  {
    platform: "whatsapp",
    label: "WhatsApp",
    hosts: ["call.whatsapp.com"],
    reason: "WhatsApp no permite unirse a una videollamada desde la web de un tercero",
  },
  {
    platform: "zoho",
    label: "Zoho Meeting",
    hosts: ["meeting.zoho.com", ".zoho.com", ".zohomeeting.com"],
    reason: "Zoho Meeting no ofrece un SDK web para unirse desde otro sitio",
    idParams: ["key", "sessionKey"],
  },
  {
    platform: "dialpad",
    label: "Dialpad",
    hosts: ["dialpad.com", ".dialpad.com", "meetings.dialpad.com"],
    reason: "Dialpad no publica un SDK para embeber sus reuniones",
  },
  {
    platform: "ringcentral",
    label: "RingCentral",
    hosts: ["v.ringcentral.com", ".ringcentral.com", "ringcentral.com"],
    reason: "RingCentral Video no permite unirse embebido desde otro dominio",
  },
  {
    platform: "livestorm",
    label: "Livestorm",
    hosts: ["app.livestorm.co", ".livestorm.co"],
    reason: "Livestorm sólo permite asistir desde su propia página",
  },
  {
    platform: "gather",
    label: "Gather",
    hosts: ["app.gather.town", ".gather.town", "gather.town"],
    reason: "Gather corre su propio mundo virtual y no se puede embeber",
  },
] as const satisfies readonly SimplePlatform[];

// Los ids de la tabla, derivados de ella misma: agregar una plataforma arriba
// la hace obligatoria en el registro, sin poder olvidarse.
type SimplePlatformId = (typeof SIMPLE_PLATFORMS)[number]["platform"];

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

function simpleRegistryEntries(): Record<SimplePlatformId, PlatformInfo> {
  return Object.fromEntries(
    SIMPLE_PLATFORMS.map((p) => [
      p.platform,
      {
        platform: p.platform,
        label: p.label,
        joinMode: "redirect" as JoinMode,
        official: false,
        requires: [p.reason],
      },
    ])
  ) as Record<SimplePlatformId, PlatformInfo>;
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
  whereby: {
    platform: "whereby",
    label: "Whereby",
    joinMode: "embed",
    official: true,
    requires: ["Nada: las salas de Whereby se embeben por iframe con ?embed"],
  },
  "element-call": {
    platform: "element-call",
    label: "Element Call",
    joinMode: "embed",
    official: true,
    requires: ["Nada: Element Call está pensado para embeberse por iframe"],
  },
  // Las que sólo se reconocen (ver SIMPLE_PLATFORMS) se arman solas más abajo.
  ...simpleRegistryEntries(),
  generica: {
    platform: "generica",
    label: "Reunión externa",
    joinMode: "redirect",
    official: false,
    requires: [],
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
// Prefijo de la clave de sala -> nombre para mostrar. Los que no coinciden con
// el id de la plataforma se listan aparte; el resto sale del registro, así
// sumar una plataforma no deja su historial diciendo "Unify".
const SOURCE_LABEL_OVERRIDES: Record<string, string> = {
  teams: "Microsoft Teams",
  element: "Element Call",
  externa: "Reunión externa",
};

export function meetingSourceLabel(joinCode: string): string {
  const prefix = joinCode.match(/^([a-z-]+):/i)?.[1]?.toLowerCase();
  if (!prefix) return "Unify";
  const override = SOURCE_LABEL_OVERRIDES[prefix];
  if (override) return override;
  const known = PLATFORM_REGISTRY[prefix as MeetingPlatform];
  return known && prefix !== "encuentro" && prefix !== "unknown" ? known.label : "Unify";
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
  /** URL lista para poner como src de un iframe (Whereby, Element Call). */
  embedUrl?: string;
  /** Dominio del servidor de Jitsi: meet.jit.si, 8x8.vc o uno propio. */
  jitsiDomain?: string;
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

// Dominios de plataformas conocidas, para detectar imitaciones.
const KNOWN_MEETING_DOMAINS = [
  "zoom.us",
  "meet.google.com",
  "teams.microsoft.com",
  "teams.live.com",
  "meet.jit.si",
  "whereby.com",
  "webex.com",
  "gotomeeting.com",
  "bluejeans.com",
  "chime.aws",
  "slack.com",
  "whatsapp.com",
];

/**
 * ¿Este host IMITA a una plataforma conocida sin serlo?
 * ("meet.google.com.evil.co" contiene "meet.google.com" pero no es Google.)
 *
 * Hace falta desde que aceptamos acompañar cualquier enlace: antes un dominio
 * así simplemente no se reconocía y no se ofrecía nada, ahora se ofrece entrar
 * -- y un enlace de phishing no debería recibir la misma cara de confianza que
 * uno legítimo sólo porque nosotros mostramos un botón al lado.
 */
export function impersonatedDomain(host: string): string | null {
  const h = host.toLowerCase();
  for (const known of KNOWN_MEETING_DOMAINS) {
    // Es el dominio de verdad (o un subdominio suyo): todo bien.
    if (h === known || h.endsWith(`.${known}`)) return null;
    // Lo contiene en cualquier otra posición: lo está imitando.
    if (h.includes(known)) return known;
  }
  return null;
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
      // "/wc/join/<id>" es la URL que Zoom usa al elegir "unirse desde el
      // navegador": el segmento "join" va ANTES del número. Sin contemplarlo,
      // Unify se quedaba muda justo al entrar a la reunión por el navegador.
      .match(/\/(?:j|w|wc)\/(?:join\/)?(\d{9,11})/)?.[1];
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
  // Familia Jitsi. Además del meet.jit.si público:
  //  - 8x8.vc es "Jitsi as a Service", el mismo external_api con otro dominio.
  //  - una instalación propia suele vivir en jitsi.<empresa>.com.
  // Todas usan el mismo embed, sólo cambia el dominio del script.
  const jitsiDomain =
    host === "meet.jit.si" || host === "8x8.vc" || host.endsWith(".8x8.vc") || /(^|\.)jitsi\./.test(host)
      ? host
      : null;
  if (jitsiDomain) {
    // Decoded on purpose: a room with accents/ñ arrives percent-encoded in the
    // pathname ("reuni%C3%B3n"), and Jitsi's embed API expects the PLAIN name
    // (it encodes it again itself). Passing the encoded form would open a
    // literally different room than the one the link points at.
    // En 8x8 la sala es "<inquilino>/<sala>": los dos tramos hacen falta.
    const segments = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    const take = host === "8x8.vc" || host.endsWith(".8x8.vc") ? 2 : 1;
    const raw = segments.slice(0, take).join("/");
    const room = raw ? safeDecode(raw) : undefined;
    // Lowercased key only (Jitsi normalizes room names that way), so two people
    // typing different casing still land in the same Unify room. El dominio
    // entra en la clave: la misma sala en dos servidores distintos NO es la
    // misma reunión.
    return build("jitsi", {
      meetingId: room,
      jitsiDomain,
      roomKey: room ? `jitsi:${jitsiDomain}/${room.toLowerCase()}` : undefined,
    });
  }

  // Whereby: sus salas SÍ se pueden embeber -- es lo que vende como "Whereby
  // Embedded", y una sala gratis también acepta ?embed. Se agrega `minimal`
  // para que el iframe no muestre su propio encabezado dentro del nuestro.
  if (host === "whereby.com" || host.endsWith(".whereby.com")) {
    const room = url.pathname.replace(/^\/+/, "").split("/")[0];
    if (!room) return build("whereby");
    const embedUrl = `${url.origin}/${room}?embed&minimal`;
    return build("whereby", {
      meetingId: room,
      roomKey: `whereby:${host}/${room.toLowerCase()}`,
      embedUrl,
    });
  }

  // Element Call está hecho para embeberse (así corre dentro de Element), así
  // que su propia URL sirve tal cual como src del iframe.
  if (host === "call.element.io" || host.endsWith(".element.io")) {
    const room = `${url.pathname}${url.hash}`.replace(/^\/+/, "");
    if (!room) return build("element-call");
    return build("element-call", {
      meetingId: room.slice(0, 60),
      roomKey: `element:${host}${url.pathname.toLowerCase()}`,
      embedUrl: normalized,
    });
  }

  // El resto de las plataformas que reconocemos por nombre pero no podemos
  // embeber. La clave de sala sale del host + path (nunca del query, que trae
  // tokens por persona), igual que en el resto del módulo.
  for (const simple of SIMPLE_PLATFORMS as readonly SimplePlatform[]) {
    const hit = simple.hosts.some((h) => (h.startsWith(".") ? host.endsWith(h) : host === h));
    if (!hit) continue;
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    const ids = (simple.idParams ?? [])
      .map((k) => url.searchParams.get(k))
      .filter((v): v is string => Boolean(v))
      .map((v) => v.toLowerCase());
    const tail = [path, ...ids].filter(Boolean).join("/");
    // Sin nada que distinga esta reunión de otra de la misma plataforma no se
    // arma clave: meter a todos en una sala común sería mucho peor que pedir
    // el enlace completo.
    return build(simple.platform, {
      roomKey: tail ? `${simple.platform}:${host}${tail}` : undefined,
    });
  }

  return build("unknown");
}
