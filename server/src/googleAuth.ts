// Google Sign-In via plain OAuth 2.0 (authorization code flow) -- no SDK
// dependency, just two HTTPS calls, matching how zoom.ts/teams.ts avoid heavy
// client libraries. Requires the user to create their own OAuth client in
// Google Cloud Console (Client ID + Secret are project-specific credentials
// we can't generate) and configure it via Render env vars -- never pasted in
// chat, same rule as every other third-party secret in this app.
import { randomBytes } from "crypto";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// Must exactly match an "Authorized redirect URI" configured on the Google
// OAuth client, e.g. https://your-backend.onrender.com/api/auth/google/callback
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

export const googleAuthEnabled = Boolean(
  GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI
);

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

// Where to send the browser to start the consent flow. `state` is an opaque,
// random per-request value the caller generates and later checks on the
// callback, as a CSRF guard on the redirect.
export function googleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID!,
    redirect_uri: GOOGLE_REDIRECT_URI!,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

// Single-use, short-lived state tokens: a login-CSRF guard for the OAuth
// redirect (an attacker linking a victim's browser to the attacker's own
// Google session). No cookies needed -- just an in-memory nonce store, since
// the whole round trip normally takes seconds.
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

export function createState(): string {
  // Sweep expired entries here (the only growth point) so abandoned login
  // attempts -- people who never finish Google's consent screen -- don't
  // accumulate in this map forever.
  const now = Date.now();
  for (const [key, expiresAt] of pendingStates) {
    if (expiresAt <= now) pendingStates.delete(key);
  }
  const state = randomBytes(16).toString("hex");
  pendingStates.set(state, now + STATE_TTL_MS);
  return state;
}

export function consumeState(state: string | undefined): boolean {
  if (!state) return false;
  const expiresAt = pendingStates.get(state);
  pendingStates.delete(state);
  return expiresAt !== undefined && expiresAt > Date.now();
}

export interface GoogleProfile {
  googleId: string;
  email: string;
  name: string;
  /** Foto de la cuenta de Google (URL de su CDN), o null si no tiene. */
  picture: string | null;
}

// Exchanges the one-time authorization code for the person's Google profile.
export async function exchangeGoogleCode(code: string): Promise<GoogleProfile> {
  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID!,
      client_secret: GOOGLE_CLIENT_SECRET!,
      redirect_uri: GOOGLE_REDIRECT_URI!,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Google rechazó el código de autorización (${tokenRes.status}).`);
  }
  const tokenData = (await tokenRes.json()) as { access_token?: string };
  if (!tokenData.access_token) {
    throw new Error("Google no devolvió un token de acceso.");
  }

  const profileRes = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!profileRes.ok) {
    throw new Error(`No se pudo obtener el perfil de Google (${profileRes.status}).`);
  }
  const profile = (await profileRes.json()) as {
    sub?: string;
    email?: string;
    name?: string;
    picture?: string;
  };
  if (!profile.sub || !profile.email) {
    throw new Error("El perfil de Google no incluyó email.");
  }
  // `picture` ya viene con el scope "profile" que pedimos: es la foto que la
  // persona ya eligió en su cuenta, así que la usamos como foto de perfil en
  // vez de hacérsela subir de nuevo. Sólo se acepta si es https de Google.
  const picture =
    typeof profile.picture === "string" && /^https:\/\/[\w.-]*googleusercontent\.com\//.test(profile.picture)
      ? profile.picture
      : null;
  return {
    googleId: profile.sub,
    email: profile.email.toLowerCase(),
    name: profile.name || profile.email,
    picture,
  };
}
