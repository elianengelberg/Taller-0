import crypto from "crypto";

// Generates the JWT "signature" the Zoom Meeting SDK needs to join a meeting.
// This MUST live on the server: it's signed with the Meeting SDK Secret
// (Client Secret), which can never reach the browser. The client only ever
// receives the finished signature, never the secret.
//
// Credentials come from the environment (set these in Render):
//   ZOOM_SDK_KEY    -> the app's Client ID  (a.k.a. SDK Key -- not sensitive)
//   ZOOM_SDK_SECRET -> the app's Client Secret (SENSITIVE -- server-only)
// If either is missing we treat Zoom as "not configured" and the signature
// endpoint returns a clear 503 instead of minting a broken token, exactly
// like the rest of the app degrades gracefully when an integration isn't set
// up (see storage/db).

const SDK_KEY = process.env.ZOOM_SDK_KEY?.trim() ?? "";
const SDK_SECRET = process.env.ZOOM_SDK_SECRET?.trim() ?? "";

export const zoomEnabled = Boolean(SDK_KEY && SDK_SECRET);

// The SDK caps token lifetime at [1800s, 172800s] (30 min .. 48 h). We default
// to 2 hours -- long enough for a real meeting, short enough to limit reuse.
const DEFAULT_EXP_SECONDS = 60 * 60 * 2;
const MIN_EXP_SECONDS = 1800;
const MAX_EXP_SECONDS = 172800;

// role 0 = attendee (what we always are: we join meetings we don't own),
// role 1 = host/start (only valid for meetings on the SDK app's own account,
// and needs a ZAK on top -- out of scope for joining shared links).
export type ZoomRole = 0 | 1;

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// Minimal HS256 JWT signer -- avoids pulling in jsonwebtoken/jsrsasign just for
// this one token. Node's crypto is already a dependency everywhere.
function signHs256(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encoded = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.createHmac("sha256", secret).update(encoded).digest();
  return `${encoded}.${base64url(signature)}`;
}

export interface SignatureRequest {
  meetingNumber: string;
  role?: ZoomRole;
  expirationSeconds?: number;
}

// Builds the Meeting SDK signature. Since SDK v5 the payload MUST carry the
// app key both as `appKey` and `sdkKey` (the web SDK reads `appKey:<key>` out
// of the signature during join); omitting it makes the join silently fail with
// "signature is invalid".
export function generateMeetingSdkSignature({
  meetingNumber,
  role = 0,
  expirationSeconds = DEFAULT_EXP_SECONDS,
}: SignatureRequest): string {
  if (!zoomEnabled) {
    throw new Error("Zoom no está configurado en el servidor.");
  }

  const iat = Math.floor(Date.now() / 1000) - 30; // small backdate for clock skew
  const clampedExp = Math.min(Math.max(expirationSeconds, MIN_EXP_SECONDS), MAX_EXP_SECONDS);
  const exp = iat + clampedExp;

  const payload = {
    appKey: SDK_KEY,
    sdkKey: SDK_KEY,
    mn: meetingNumber,
    role,
    iat,
    exp,
    tokenExp: exp,
  };

  return signHs256(payload, SDK_SECRET);
}
