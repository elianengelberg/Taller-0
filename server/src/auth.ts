// Self-contained auth: password hashing (scrypt) + signed session tokens
// (HS256 JWT), both built on node:crypto so there are no extra dependencies to
// install/build on the host. Accounts exist so each person's meeting history
// is private to them (see db.ts owner_id + the /api/auth/* and /api/meetings
// routes in index.ts).
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";

// Clave con la que se firman los tokens de sesión. DEBE estar en el entorno
// (Render) para que los tokens sobrevivan a un reinicio. Rotarla cierra la
// sesión de todos, a propósito.
//
// Antes, si faltaba, se usaba una clave fija escrita acá mismo. Eso es una
// puerta abierta: el código es público, así que cualquiera podía firmarse un
// token con el id de usuario de otra persona y entrar a su cuenta y a su
// historial completo -- sin contraseña y sin dejar rastro. Un `console.warn`
// no protege nada.
//
// Ahora, si falta, se genera una clave aleatoria al arrancar. Nadie puede
// falsificar nada, y lo que se rompe es visible y benigno: hay que volver a
// iniciar sesión después de cada reinicio, que es exactamente el síntoma que
// lleva a configurar la variable.
function resolveAuthSecret(): string {
  const configured = process.env.AUTH_SECRET;
  if (configured && configured.length >= 16) return configured;
  if (configured) {
    console.error(
      "[auth] AUTH_SECRET es demasiado corto (mínimo 16 caracteres). " +
        "Se ignora y se usa una clave aleatoria de este arranque."
    );
  } else {
    console.error(
      "[auth] AUTH_SECRET no está configurado. Se genera una clave aleatoria para este arranque: " +
        "nadie puede falsificar tokens, pero las sesiones se cierran en cada reinicio. " +
        "Definí AUTH_SECRET en el entorno para que persistan."
    );
  }
  return randomBytes(48).toString("hex");
}

const AUTH_SECRET = resolveAuthSecret();

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
// Un token real ronda los 200 caracteres. El tope evita gastar CPU en HMAC y
// JSON.parse sobre una cadena enorme mandada sólo para hacernos trabajar.
const MAX_TOKEN_CHARS = 4096;

export function verifyToken(token: string | null | undefined): string | null {
  if (!token || token.length > MAX_TOKEN_CHARS) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = sign(`${header}.${payload}`);
  // timingSafeEqual throws on length mismatch -- guard first.
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    // Verificar el algoritmo declarado es defensa en profundidad: acá siempre
    // se recalcula el HMAC, así que un `alg: none` ya no pasaba -- pero si
    // alguna vez alguien agrega otro algoritmo, este chequeo evita el ataque
    // clásico de degradar la firma cambiando el encabezado.
    const head = JSON.parse(Buffer.from(header, "base64").toString()) as { alg?: string };
    if (head.alg !== "HS256") return null;
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString()) as { sub?: string; exp?: number };
    if (typeof decoded.sub !== "string" || !decoded.sub) return null;
    if (typeof decoded.exp !== "number") return null;
    if (decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded.sub;
  } catch {
    return null;
  }
}
