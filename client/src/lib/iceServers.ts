// WebRTC ICE configuration for the peer mesh.
//
// Why this matters: a plain STUN-only setup fails for the meaningful fraction
// of users behind symmetric NATs or restrictive corporate firewalls -- their
// peers can never find a working path and the call silently stays black/silent
// for them. A TURN relay is the fallback that makes those connections work, so
// a production video app needs one. We keep public STUN servers as the default
// (they cover most home networks) and let a TURN server be supplied via env so
// it can be provisioned without a code change.
//
// Env (all optional, read at build time by Vite):
//   VITE_ICE_SERVERS   -- full JSON RTCIceServer[] (advanced; overrides all)
//   VITE_STUN_URLS     -- comma-separated stun: URLs (overrides the defaults)
//   VITE_TURN_URLS     -- comma-separated turn:/turns: URLs
//   VITE_TURN_USERNAME -- TURN username (required if VITE_TURN_URLS is set)
//   VITE_TURN_CREDENTIAL -- TURN credential/password

const DEFAULT_STUN = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:global.stun.twilio.com:3478",
];

function parseList(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getIceServers(): RTCIceServer[] {
  const env = import.meta.env as Record<string, string | undefined>;

  // Advanced escape hatch: a complete, hand-authored server list.
  const raw = env.VITE_ICE_SERVERS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as RTCIceServer[];
    } catch {
      // fall through to the structured vars below
    }
  }

  const servers: RTCIceServer[] = [];

  const stunUrls = parseList(env.VITE_STUN_URLS);
  servers.push({ urls: stunUrls.length > 0 ? stunUrls : DEFAULT_STUN });

  const turnUrls = parseList(env.VITE_TURN_URLS);
  const turnUsername = env.VITE_TURN_USERNAME;
  const turnCredential = env.VITE_TURN_CREDENTIAL;
  if (turnUrls.length > 0 && turnUsername && turnCredential) {
    servers.push({ urls: turnUrls, username: turnUsername, credential: turnCredential });
  }

  return servers;
}

// True when a TURN relay is configured -- lets the UI warn (in dev) that
// without one, some networks won't connect.
export function hasTurnConfigured(): boolean {
  const env = import.meta.env as Record<string, string | undefined>;
  if (env.VITE_ICE_SERVERS?.includes("turn:") || env.VITE_ICE_SERVERS?.includes("turns:")) return true;
  return parseList(env.VITE_TURN_URLS).length > 0;
}
