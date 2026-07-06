// Self-contained auth: password hashing (scrypt) + signed session tokens
// (HS256 JWT), both built on node:crypto so there are no extra dependencies to
// install/build on the host. Accounts exist so each person's meeting history
// is private to them (see db.ts owner_id + the /api/auth/* and /api/meetings
// routes in index.ts).
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";

// Signing secret for session tokens. MUST be set in production (Render) so
// tokens survive restarts and can't be forged; falls back to a fixed dev
// value locally with a warning. Rotating it logs everyone out (by design).
const AUTH_SECRET = process.env.AUTH_SECRET || "encuentro-dev-secret-change-me";
if (!process.env.AUTH_SECRET) {
  console.warn(
    "[auth] AUTH_SECRET no está configurado -- usando un valor de desarrollo inseguro. " +
      "Definí AUTH_SECRET en el entorno para producción."
  );
}

// 30 days: long enough that people aren't constantly re-logging in, short
// enough that a leaked token eventually stops working.
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

// --- Passwords -------------------------------------------------------------

// Returns "salt:hash" (both hex). scrypt is a deliberately slow, memory-hard
// KDF, so a leaked hash is expensive to brute-force.
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  // Constant-time compare so timing can't leak how much of the hash matched.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// --- Session tokens (JWT HS256) --------------------------------------------

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(data: string): string {
  return base64url(createHmac("sha256", AUTH_SECRET).update(data).digest());
}

export function signToken(userId: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({ sub: userId, iat: now, exp: now + TOKEN_TTL_SECONDS }));
  const signature = sign(`${header}.${payload}`);
  return `${header}.${payload}.${signature}`;
}

// Returns the user id encoded in a valid, unexpired token, or null for
// anything malformed / tampered / expired.
export function verifyToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = sign(`${header}.${payload}`);
  // timingSafeEqual throws on length mismatch -- guard first.
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString()) as { sub?: string; exp?: number };
    if (!decoded.sub || !decoded.exp) return null;
    if (decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded.sub;
  } catch {
    return null;
  }
}
