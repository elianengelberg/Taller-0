import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import { createServer } from "http";
import { spawn } from "child_process";
import { resolve as resolvePath } from "path";
import { Server } from "socket.io";
import { answerFromMeeting, generateMeetingReport, autoReportOnFinalize } from "./ai";
import {
  createNumericCode,
  createSecretToken,
  hashPassword,
  hashSecretToken,
  signToken,
  verifyPassword,
  verifyToken,
  verifyTokenClaims,
} from "./auth";
import {
  applyPasswordReset,
  attachRecording,
  bumpTokenVersion,
  canAccessFolder,
  claimAccountForVerifiedEmail,
  claimMeeting,
  consumeAuthToken,
  consumeAuthTokenByCode,
  countRecentAuthTokens,
  createAuthToken,
  createMeetingRecord,
  clearMsRefreshToken,
  createFolder,
  createUser,
  createUserWithGoogle,
  dbEnabled,
  deleteFolder,
  deleteMeeting,
  invalidateAuthTokens,
  markEmailVerified,
  peekAuthToken,
  wasAuthTokenRecentlyUsed,
  getMeetingDetailForUser,
  getMeetingDetailRaw,
  getMsRefreshToken,
  getUserAuthById,
  getUserByEmail,
  getUserByGoogleId,
  getTokenVersion,
  getUserById,
  linkGoogleId,
  listFolders,
  listFolderShares,
  listMeetings,
  listMeetingsInFolder,
  listSharedFolders,
  markRecordingStarted,
  meetingExists,
  moveMeetingToFolder,
  recordMessage,
  renameFolder,
  setMsRefreshToken,
  shareFolderWithEmail,
  unshareFolder,
  setAvatarIfMissing,
  updateUserAvatar,
  updateUserName,
  updateUserPasswordHash,
} from "./db";
import {
  sendGoogleOnlyResetEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "./authMail";
import { explainError } from "./explainError";
import { answerAcrossMeetings } from "./globalAi";
import { consumeState, createState, exchangeGoogleCode, googleAuthEnabled, googleAuthUrl } from "./googleAuth";
import {
  calendarAuthUrl,
  consumeCalendarState,
  createCalendarState,
  exchangeCalendarCode,
  fetchUpcomingEvents,
  microsoftEnabled,
  refreshAccessToken,
} from "./microsoftAuth";
import { addNamedTranscriptLine, getOrCreateCompanionMeeting, isLiveParticipant, onMeetingFinalized } from "./meetingStore";
import { cleanTranscriptFragment, translateFragmentToAll } from "./transcriptCleanup";
import { mailerEnabled } from "./mailer";
import { rateLimit, userOrIp } from "./rateLimit";
import { registerSocketHandlers } from "./socketHandlers";
import {
  createRecordingUploadUrl,
  isOwnAvatarUrl,
  isOwnRecordingUrl,
  normalizeAvatarType,
  normalizeRecordingType,
  storageEnabled,
  uploadAvatarStream,
  uploadRecordingStream,
} from "./storage";
import { createTeamsUserToken, teamsEnabled } from "./teams";
import { shortLang, translateText } from "./translate";
import { generateMeetingSdkSignature, zoomEnabled } from "./zoom";

// Since Node 15 an unhandled promise rejection CRASHES the process by
// default -- on this server that would drop every live meeting because one
// stray rejection slipped past a handler. Log it loudly and keep running
// instead. A synchronous uncaught exception still exits (state can't be
// trusted after one), but with a clear log line first; Render restarts the
// process automatically.
process.on("unhandledRejection", (reason) => {
  console.error("[proceso] Promesa rechazada sin manejar:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[proceso] Excepción no capturada:", err);
  process.exit(1);
});

const PORT = Number(process.env.PORT) || 4000;
// The browser's Origin header is always lowercase, has no trailing slash and
// no quotes -- but a hand-typed env var can differ in any of those ways, and
// a single stray character here silently breaks every API call from the app
// (while top-level redirects, which skip CORS, keep working -- very
// confusing to debug). Normalize both sides before comparing, and log any
// rejection so the mismatch shows up in the server logs instead of only as
// opaque failed fetches in the browser.
function normalizeOrigin(value: string): string {
  return value.trim().replace(/^["']+|["']+$/g, "").replace(/\/+$/, "").toLowerCase();
}
// CLIENT_ORIGIN accepts a comma-separated list so a domain migration doesn't
// cut off the old origin overnight. The FIRST entry is the canonical one:
// OAuth redirects always land there.
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
  .split(",")
  .map(normalizeOrigin)
  .filter(Boolean);
const CLIENT_ORIGIN = CLIENT_ORIGINS[0];
console.log(`[cors] orígenes permitidos: ${CLIENT_ORIGINS.join(", ")}`);

function corsOrigin(
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void
): void {
  if (!origin || CLIENT_ORIGINS.includes(normalizeOrigin(origin))) {
    cb(null, true);
    return;
  }
  console.warn(`[cors] Origin rechazado: "${origin}" (esperados: ${CLIENT_ORIGINS.join(", ")})`);
  cb(null, false);
}

// Per-request CORS: the Google Meet bridge is written to by the Unify
// extension running INSIDE meet.google.com, so its Origin is
// https://meet.google.com -- never the app's origin. That endpoint must
// therefore accept any origin (its payload is whitelisted, clamped and
// rate-limited, and treated as display-only, never as authority). Every
// other endpoint keeps the strict CLIENT_ORIGIN allowlist.
function corsDelegate(
  req: Request,
  callback: (err: Error | null, options?: import("cors").CorsOptions) => void
): void {
  if (req.path.startsWith("/api/meet-bridge/")) {
    callback(null, { origin: true, methods: ["POST", "OPTIONS"] });
    return;
  }
  const origin = req.headers.origin;
  const allowed = !origin || CLIENT_ORIGINS.includes(normalizeOrigin(origin));
  if (origin && !allowed) {
    console.warn(`[cors] Origin rechazado: "${origin}" (esperados: ${CLIENT_ORIGINS.join(", ")})`);
  }
  callback(null, { origin: allowed });
}

const app = express();
// Behind Render's proxy: trust the first hop so req.ip is the real client IP
// (needed for the auth rate limiter below), not the proxy's address.
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(cors(corsDelegate));
// Baseline security headers on every API response. (The API serves JSON, not
// the app HTML -- that's on Vercel -- so no CSP here; these are the ones that
// matter for an API: no MIME sniffing, no framing, no referrer leakage, and
// HSTS since Render terminates TLS.)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  // Esta API devuelve JSON, nunca páginas: con `default-src 'none'` un
  // endpoint que alguna vez devolviera HTML (por un error, por un bug futuro)
  // no podría ejecutar absolutamente nada en el navegador.
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; sandbox");
  // Que otro sitio no pueda incrustar nuestras respuestas como si fueran un
  // recurso suyo (imagen, script) para espiar tamaños o contenido.
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  // Nada de lo que sale de /api/auth puede quedar guardado: esas respuestas
  // llevan el token de sesión y los datos de la cuenta, y un proxy corporativo
  // o el disco del navegador son lugares donde eso no debe sobrevivir.
  if (req.path.startsWith("/api/auth")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
  }
  next();
});
// Dos parsers de JSON: el chico (100 KB, el default) para todo, y uno grande
// SOLO para la pregunta a la IA de una reunión, que puede traer fotogramas del
// video en base64. Subir el límite global habría agrandado la superficie de
// todos los endpoints por una necesidad de uno solo.
const jsonChico = express.json();
const jsonGrande = express.json({ limit: "4mb" });
const RUTA_ASK = /^\/api\/meetings\/[^/]+\/ask$/;
app.use((req, res, next) => {
  (RUTA_ASK.test(req.path) ? jsonGrande : jsonChico)(req, res, next);
});

// Los topes de los limitadores "calientes" se ajustan por entorno. El motivo
// es una oficina entera detrás de UNA sola IP (NAT corporativo): cien
// computadoras comparten el mismo balde por IP, así que los valores por
// defecto están dimensionados para eso. Las suites de prueba definen topes
// chicos (ver pruebas/LEEME.md) para probar el 429 sin hacer mil pedidos.
// En producción no definas estas variables salvo que sepas por qué.
const tope = (env: string, porDefecto: number): number => {
  const v = Number(process.env[env]);
  return Number.isFinite(v) && v > 0 ? v : porDefecto;
};

// In-memory per-IP limiter to blunt credential brute-forcing on the auth
// endpoints. Single-instance deploy, so a shared map is enough; the window is
// short and the cap is far above what a real person logging in ever hits.
const authAttempts = new Map<string, { count: number; windowStart: number }>();
// 30 alcanzaba para una persona; una oficina detrás de una IP necesita más.
// La fuerza bruta contra UNA cuenta la frena el contador POR CUENTA (5
// intentos), no éste: acá sólo se corta el diluvio ciego desde una IP.
const AUTH_MAX_PER_WINDOW = tope("LIMITE_AUTH_POR_IP", 240);
const AUTH_WINDOW_MS = 60_000;
function authRateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  // Occasional prune so the map can't grow unbounded across many distinct IPs.
  if (authAttempts.size > 5000) {
    for (const [k, v] of authAttempts) if (now - v.windowStart > AUTH_WINDOW_MS) authAttempts.delete(k);
  }
  const rec = authAttempts.get(ip);
  if (!rec || now - rec.windowStart > AUTH_WINDOW_MS) {
    authAttempts.set(ip, { count: 1, windowStart: now });
    next();
    return;
  }
  rec.count += 1;
  if (rec.count > AUTH_MAX_PER_WINDOW) {
    res.status(429).json({ error: "Demasiados intentos. Esperá un momento y probá de nuevo." });
    return;
  }
  next();
}

// Límites por superficie. Los que llaman a Claude o emiten credenciales de un
// tercero se limitan POR USUARIO cuando hay sesión (la identidad que de verdad
// gasta) y por IP cuando no la hay.
//
// Los números están muy por encima de lo que produce un uso real: una reunión
// larga traduce decenas de líneas por minuto, nadie le pregunta a la IA treinta
// veces en cinco minutos, y nadie sube diez grabaciones por hora.
const aiLimit = rateLimit({
  max: 30,
  windowMs: 5 * 60_000,
  keyBy: userOrIp,
  message: "Hiciste muchas consultas a la IA seguidas. Esperá un momento y probá de nuevo.",
});
// La reunión quedó vacía y pasó la gracia: resumen automático estilo Granola
// (ver autoReportOnFinalize). Fire-and-forget: jamás frena la limpieza.
onMeetingFinalized((dbId, transcript) => {
  void autoReportOnFinalize(
    dbId,
    transcript.map((l) => ({ speakerName: l.speakerName, text: l.text }))
  );
});

const translateLimit = rateLimit({ max: tope("LIMITE_TRADUCCIONES", 1200), windowMs: 60_000, keyBy: userOrIp });
const explainLimit = rateLimit({ max: 60, windowMs: 60_000 });
// Emiten credenciales de Zoom/Azure contra NUESTRA cuenta: sin límite, este
// servidor era un proveedor gratuito de accesos para cualquiera.
const credentialLimit = rateLimit({ max: tope("LIMITE_CREDENCIALES", 120), windowMs: 60_000 });
// Las subidas son deliberadamente sin sesión (los invitados también graban),
// así que el límite es lo único que impide usarlas como alojamiento gratis.
const uploadLimit = rateLimit({
  max: tope("LIMITE_SUBIDAS", 100),
  windowMs: 60 * 60_000,
  message: "Se subieron demasiadas grabaciones desde acá. Probá de nuevo en un rato.",
});
const avatarLimit = rateLimit({ max: 20, windowMs: 60 * 60_000, keyBy: userOrIp });
// Pedir que nos manden un correo. El freno que de verdad importa es el de por
// cuenta (5 por hora, contra la base): éste es el que evita que una sola IP
// use el servidor como cañón de correos contra muchas direcciones distintas.
const mailLimit = rateLimit({
  max: tope("LIMITE_CORREOS", 60),
  windowMs: 15 * 60_000,
  message: "Pediste demasiados correos seguidos. Esperá unos minutos.",
});
// El bridge lo escribe la extensión desde meet.google.com, así que acepta
// cualquier origen: el límite es lo que evita que se convierta en un canal
// abierto para inundar salas ajenas.
// Una oficina entera manda líneas por la misma IP: el tope por IP es alto y
// el freno fino contra inundar UNA sala es allowMeetBridge (40 cada 10 s).
const bridgeLimit = rateLimit({ max: tope("LIMITE_BRIDGE", 2400), windowMs: 60_000 });

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// --- Auth ------------------------------------------------------------------

interface AuthedRequest extends Request {
  userId?: string;
}

// Gate for the private endpoints (meeting history + its AI). Reads the Bearer
// token, and 401s if it's missing/expired/forged. On success the caller's user
// id is attached to the request for owner-scoped queries.
// Versión de sesión vigente por cuenta. La base es la fuente de verdad; esto
// evita una consulta por cada pedido autenticado. Se refresca al invalidar.
const tokenVersionCache = new Map<string, number>();

async function currentTokenVersion(userId: string): Promise<number | null> {
  const cached = tokenVersionCache.get(userId);
  if (cached !== undefined) return cached;
  const fresh = await getTokenVersion(userId);
  if (fresh === null) return null;
  if (tokenVersionCache.size > 10_000) tokenVersionCache.clear();
  tokenVersionCache.set(userId, fresh);
  return fresh;
}

function invalidateSessions(userId: string, newVersion: number): void {
  tokenVersionCache.set(userId, newVersion);
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  const claims = verifyTokenClaims(token);
  if (!claims) {
    res.status(401).json({ error: "Iniciá sesión para continuar." });
    return;
  }
  // La firma es válida, pero puede ser un token de antes de que se cambiara la
  // contraseña o se cerraran las sesiones. Eso es justamente lo que saca de la
  // cuenta a quien te robó la sesión.
  void currentTokenVersion(claims.userId).then((version) => {
    if (version === null || claims.version < version) {
      res.status(401).json({ error: "Tu sesión ya no es válida. Iniciá sesión de nuevo." });
      return;
    }
    (req as AuthedRequest).userId = claims.userId;
    next();
  });
}

// Freno por CUENTA, además del que ya hay por IP.
//
// El límite por IP no alcanza: quien prueba contraseñas contra una cuenta
// concreta puede repartir los intentos entre muchas IPs (proxies, botnets) y
// nunca tocar ese tope. Esto cuenta los fallos por email y hace esperar cada
// vez más, que es lo que vuelve inviable adivinar una contraseña.
//
// Los intentos exitosos limpian el contador, así que a quien sabe su
// contraseña esto no lo toca nunca.
const failedLogins = new Map<string, { count: number; until: number }>();
const LOGIN_LOCK_AFTER = 5;
const LOGIN_LOCK_MAX_MS = 15 * 60_000;

function loginLockRemainingMs(email: string): number {
  const rec = failedLogins.get(email);
  if (!rec) return 0;
  return Math.max(0, rec.until - Date.now());
}

function noteFailedLogin(email: string): void {
  if (failedLogins.size > 20_000) {
    const now = Date.now();
    for (const [k, v] of failedLogins) if (v.until < now) failedLogins.delete(k);
    if (failedLogins.size > 20_000) failedLogins.clear();
  }
  const rec = failedLogins.get(email) ?? { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_LOCK_AFTER) {
    // Espera creciente: 30s, 1m, 2m, 4m… hasta 15 minutos.
    const step = rec.count - LOGIN_LOCK_AFTER;
    rec.until = Date.now() + Math.min(LOGIN_LOCK_MAX_MS, 30_000 * 2 ** step);
  }
  failedLogins.set(email, rec);
}

function clearFailedLogins(email: string): void {
  failedLogins.delete(email);
}

// Contraseñas que no protegen nada. Una cuenta con "12345678" es una cuenta
// abierta, por más límites que tenga el servidor.
const WEAK_PASSWORDS = new Set([
  "12345678", "123456789", "1234567890", "password", "contrasena", "contraseña",
  "qwertyui", "11111111", "00000000", "iloveyou", "princess", "abc12345",
  "password1", "passw0rd", "unify123", "admin123", "12341234", "qwerty123",
]);

/** Devuelve el motivo del rechazo, o null si la contraseña sirve. */
function weakPasswordReason(password: string, email: string): string | null {
  if (password.length < 8) return "La contraseña debe tener al menos 8 caracteres.";
  if (password.length > 200) return "La contraseña es demasiado larga.";
  const lower = password.toLowerCase();
  if (WEAK_PASSWORDS.has(lower)) {
    return "Esa contraseña es de las más usadas del mundo y se adivina al instante. Elegí otra.";
  }
  const localPart = email.split("@")[0]?.toLowerCase();
  if (localPart && localPart.length >= 4 && lower.includes(localPart)) {
    return "La contraseña no puede contener tu email: es lo primero que se prueba.";
  }
  if (/^(.)\1+$/.test(password)) return "Una contraseña de un solo carácter repetido no protege nada.";
  // Secuencias corridas ("12345678", "abcdefgh").
  let run = 1;
  for (let i = 1; i < password.length; i++) {
    run = password.charCodeAt(i) === password.charCodeAt(i - 1) + 1 ? run + 1 : 1;
    if (run >= 6) return "Evitá secuencias corridas como 12345678 o abcdefgh.";
  }
  // Al menos dos tipos de carácter: letras, números o símbolos.
  const kinds = [/[a-záéíóúñ]/i.test(password), /\d/.test(password), /[^a-záéíóúñ\d]/i.test(password)];
  if (kinds.filter(Boolean).length < 2) {
    return "Combiná al menos letras y números para que no se adivine.";
  }
  return null;
}

const accountsUnavailable = "Las cuentas no están disponibles: falta configurar la base de datos.";
const mailUnavailable =
  "El servidor todavía no tiene configurado el envío de correos, así que no puede mandar ese enlace.";

// --- Enlaces por correo: verificar el email y recuperar la contraseña -------

// El de verificación dura un día (te registrás de noche, lo abrís a la
// mañana). El de contraseña dura una hora: es la llave de la cuenta y no tiene
// por qué quedar dando vueltas en un buzón toda la tarde.
const VERIFY_TTL_MS = 24 * 60 * 60_000;
const RESET_TTL_MS = 60 * 60_000;
// Tope POR CUENTA. Éste no se puede saltear cambiando de IP, y es lo que evita
// que se use el registro de otra persona para inundarle el buzón.
const LINKS_PER_HOUR = 5;

type LinkOutcome = "sent" | "throttled" | "failed";

async function issueEmailLink(
  user: { id: string; email: string; name: string },
  purpose: "verify-email" | "reset-password"
): Promise<LinkOutcome> {
  const recent = await countRecentAuthTokens(user.id, purpose, 60 * 60_000);
  if (recent >= LINKS_PER_HOUR) return "throttled";
  const token = createSecretToken();
  // El código de 6 dígitos SÓLO para verificar el email. Restablecer la
  // contraseña se queda con el enlace de 256 bits: es la llave de la cuenta y
  // ahí la comodidad no compensa el riesgo.
  const code = purpose === "verify-email" ? createNumericCode() : null;
  // Primero se guarda el hash y sólo después sale el correo: al revés, un
  // fallo de la base mandaría un enlace que nadie puede canjear.
  const stored = await createAuthToken({
    userId: user.id,
    purpose,
    tokenHash: hashSecretToken(token),
    codeHash: code ? hashSecretToken(code) : undefined,
    email: user.email,
    ttlMs: purpose === "verify-email" ? VERIFY_TTL_MS : RESET_TTL_MS,
  });
  if (!stored) return "failed";
  const sent =
    purpose === "verify-email"
      ? await sendVerificationEmail({
          to: user.email,
          name: user.name,
          token,
          code: code!,
          appOrigin: CLIENT_ORIGIN,
        })
      : await sendPasswordResetEmail({
          to: user.email,
          name: user.name,
          token,
          appOrigin: CLIENT_ORIGIN,
        });
  return sent ? "sent" : "failed";
}

// Se dispara sin esperarlo: quien se registra no tiene por qué mirar una
// ruedita porque el proveedor de correo está lento. Si falla, queda en el log
// y la persona siempre puede pedir el reenvío desde la app.
function issueEmailLinkInBackground(
  user: { id: string; email: string; name: string },
  purpose: "verify-email" | "reset-password"
): void {
  void issueEmailLink(user, purpose)
    .then((outcome) => {
      if (outcome !== "sent") {
        console.warn(`[mail] ${purpose} para ${user.id}: ${outcome}`);
      }
    })
    .catch((err) => {
      console.error("[mail] error inesperado enviando el enlace:", err);
    });
}

/** El id de sesión si el pedido trae una válida, o null. No corta el pedido. */
async function optionalUserId(req: Request): Promise<string | null> {
  const header = req.headers.authorization;
  const claims = verifyTokenClaims(header?.startsWith("Bearer ") ? header.slice(7) : null);
  if (!claims) return null;
  const version = await currentTokenVersion(claims.userId);
  if (version === null || claims.version < version) return null;
  return claims.userId;
}

app.post("/api/auth/register", authRateLimit, async (req, res) => {
  if (!dbEnabled) {
    res.status(503).json({ error: accountsUnavailable });
    return;
  }
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  const name = String(req.body?.name ?? "").trim().slice(0, 80);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: "Ingresá un email válido." });
    return;
  }
  const weak = weakPasswordReason(password, email);
  if (weak) {
    res.status(400).json({ error: weak });
    return;
  }
  if (!name) {
    res.status(400).json({ error: "Ingresá tu nombre." });
    return;
  }
  const result = await createUser({
    email,
    name,
    passwordHash: hashPassword(password),
    // Sólo se exige verificar si el servidor puede mandar el correo. Marcarlo
    // igual dejaría cuentas creadas y trabadas para siempre.
    verificationRequired: mailerEnabled,
  });
  if (!result.ok) {
    if (result.reason === "duplicate") {
      res.status(409).json({ error: "Ya existe una cuenta con ese email." });
      return;
    }
    res.status(503).json({ error: "No se pudo crear la cuenta en este momento." });
    return;
  }
  if (mailerEnabled) issueEmailLinkInBackground(result.user, "verify-email");
  // Se devuelve la sesión igual, sin esperar la verificación: quien acaba de
  // registrarse suele venir de una reunión de invitado que quiere guardar, y
  // mandarlo al buzón en ese momento le haría perder la reunión. La
  // verificación se exige al volver a entrar (ver /api/auth/login), que es
  // cuando hace falta probar que la dirección es suya.
  res.json({
    token: signToken(result.user.id, 1),
    user: result.user,
    verificationSent: mailerEnabled,
  });
});

app.post("/api/auth/login", authRateLimit, async (req, res) => {
  if (!dbEnabled) {
    res.status(503).json({ error: accountsUnavailable });
    return;
  }
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");

  // Freno por cuenta antes de tocar la base: quien está probando contraseñas
  // contra ESTE email espera cada vez más, aunque cambie de IP en cada intento.
  const lockedFor = loginLockRemainingMs(email);
  if (lockedFor > 0) {
    res.setHeader("Retry-After", String(Math.ceil(lockedFor / 1000)));
    res.status(429).json({
      error: `Demasiados intentos fallidos con este email. Probá de nuevo en ${Math.ceil(lockedFor / 60000)} minuto(s).`,
    });
    return;
  }

  const user = await getUserByEmail(email);
  if (user && user.passwordHash === null) {
    res.status(401).json({ error: "Esa cuenta se creó con Google. Iniciá sesión con Google." });
    return;
  }
  // Same message whether the email is unknown or the password is wrong, so we
  // don't reveal which emails have accounts.
  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    noteFailedLogin(email);
    res.status(401).json({ error: "Email o contraseña incorrectos." });
    return;
  }
  clearFailedLogins(email);

  // La contraseña ya es correcta: recién ACÁ se puede hablar de verificación.
  // Chequearlo antes convertiría este endpoint en un delator: cualquiera
  // podría preguntar por una dirección y saber si tiene cuenta y en qué
  // estado, sin conocer la contraseña.
  if (mailerEnabled && user.verificationRequired && !user.emailVerified) {
    // El motivo más común de llegar acá es que el correo se perdió, así que se
    // manda otro sin que haya que pedirlo (con el tope por cuenta puesto).
    issueEmailLinkInBackground(user, "verify-email");
    res.status(403).json({
      error:
        "Todavía no confirmaste tu email. Te mandamos el enlace de nuevo a " +
        `${user.email}: abrilo y entrá.`,
      needsVerification: true,
    });
    return;
  }

  res.json({
    token: signToken(user.id, user.tokenVersion),
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerified,
    },
  });
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  const user = await getUserById((req as AuthedRequest).userId!);
  if (!user) {
    res.status(401).json({ error: "Sesión inválida." });
    return;
  }
  res.json({ user });
});

// Basic account settings: rename, profile photo and change password.
app.patch("/api/auth/me", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId!;
  const name = String(req.body?.name ?? "").trim().slice(0, 80);
  if (!name) {
    res.status(400).json({ error: "Ingresá tu nombre." });
    return;
  }
  await updateUserName(userId, name);

  // La foto sólo se toca si vino en el pedido: `null` la saca, una URL la
  // cambia, y omitirla la deja como estaba (guardar el nombre no debería
  // borrar la foto sin querer).
  if ("avatarUrl" in (req.body ?? {})) {
    const raw = req.body.avatarUrl;
    if (raw === null || raw === "") {
      await updateUserAvatar(userId, null);
    } else if (typeof raw === "string" && isAcceptableAvatarUrl(raw)) {
      await updateUserAvatar(userId, raw);
    } else {
      res.status(400).json({ error: "Esa foto de perfil no es válida." });
      return;
    }
  }
  const user = await getUserById(userId);
  res.json({ user });
});

// Sólo se guarda una foto que salga de nuestro bucket o del CDN de Google:
// cualquier otra URL convertiría el perfil en un enlace arbitrario que después
// mostramos a todos los participantes de una reunión.
function isAcceptableAvatarUrl(url: string): boolean {
  return isOwnAvatarUrl(url) || /^https:\/\/[\w.-]*googleusercontent\.com\//.test(url);
}

// Subida de la foto de perfil. El cuerpo es la imagen cruda (el navegador ya
// la recortó y comprimió a 256px), así que express.json() la deja pasar y la
// mandamos derecho al bucket sin bufferearla entera.
const MAX_AVATAR_BYTES = 3 * 1024 * 1024;
app.post("/api/auth/me/avatar", requireAuth, avatarLimit, async (req, res) => {
  if (!storageEnabled) {
    res.status(503).json({ error: "El servidor no tiene configurado dónde guardar las fotos." });
    return;
  }
  const contentType = normalizeAvatarType(req.headers["content-type"]);
  if (!contentType) {
    res.status(400).json({ error: "La foto tiene que ser una imagen JPG, PNG o WEBP." });
    return;
  }
  const declaredLen = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLen) && declaredLen > MAX_AVATAR_BYTES) {
    res.status(413).json({ error: "La foto es demasiado grande." });
    return;
  }
  const userId = (req as AuthedRequest).userId!;
  try {
    const url = await uploadAvatarStream(userId, contentType, req);
    if (!url) {
      res.status(503).json({ error: "No se pudo guardar la foto." });
      return;
    }
    await updateUserAvatar(userId, url);
    const user = await getUserById(userId);
    res.json({ user });
  } catch (err) {
    console.error("[storage] avatar upload error:", err instanceof Error ? err.message : err);
    res.status(503).json({ error: "No se pudo guardar la foto." });
  }
});

// Cierra la sesión en TODOS los dispositivos y devuelve un token nuevo para
// este. Es lo que hay que tocar si sospechás que alguien entró a tu cuenta.
app.post("/api/auth/logout-everywhere", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId!;
  const version = await bumpTokenVersion(userId);
  invalidateSessions(userId, version);
  res.json({ ok: true, token: signToken(userId, version) });
});

app.post("/api/auth/change-password", authRateLimit, requireAuth, async (req, res) => {
  const currentPassword = String(req.body?.currentPassword ?? "");
  const newPassword = String(req.body?.newPassword ?? "");
  const user = await getUserAuthById((req as AuthedRequest).userId!);
  if (!user) {
    res.status(401).json({ error: "Sesión inválida." });
    return;
  }
  if (!user.passwordHash) {
    res.status(400).json({ error: "Esta cuenta usa Google para iniciar sesión y no tiene contraseña." });
    return;
  }
  const weakNew = weakPasswordReason(newPassword, user.email);
  if (weakNew) {
    res.status(400).json({ error: weakNew });
    return;
  }
  if (!verifyPassword(currentPassword, user.passwordHash)) {
    res.status(401).json({ error: "La contraseña actual no es correcta." });
    return;
  }
  await updateUserPasswordHash(user.id, hashPassword(newPassword));
  // Cambiar la contraseña ahora SÍ echa a quien tuviera la sesión abierta --
  // que es el motivo por el que uno la cambia cuando sospecha algo. Se devuelve
  // un token nuevo para no cerrarle la sesión a quien acaba de cambiarla.
  const version = await bumpTokenVersion(user.id);
  invalidateSessions(user.id, version);
  // Y los enlaces de recuperación que estuvieran dando vueltas se queman: si
  // alguien pidió uno por vos, cambiar la contraseña tiene que dejarlo inútil.
  await invalidateAuthTokens(user.id, "reset-password");
  res.json({ ok: true, token: signToken(user.id, version) });
});

// --- Verificación del email -------------------------------------------------

// Pedir (o volver a pedir) el enlace. Sirve con sesión abierta -- el aviso
// dentro de la app -- y sin ella, que es el caso de quien no puede entrar
// justamente porque no verificó.
app.post("/api/auth/verify-email/request", authRateLimit, mailLimit, async (req, res) => {
  if (!dbEnabled) {
    res.status(503).json({ error: accountsUnavailable });
    return;
  }
  if (!mailerEnabled) {
    res.status(503).json({ error: mailUnavailable });
    return;
  }
  const sessionUserId = await optionalUserId(req);
  const user = sessionUserId
    ? await getUserAuthById(sessionUserId)
    : await getUserByEmail(String(req.body?.email ?? "").trim().toLowerCase());
  if (user && !user.emailVerified) {
    issueEmailLinkInBackground(user, "verify-email");
  }
  // Siempre la misma respuesta: preguntar por una dirección no puede servir
  // para averiguar si tiene cuenta.
  res.json({ ok: true });
});

// Canje del enlace. Es un POST desde la página, no un GET desde el correo:
// así el escáner de enlaces del trabajo no te quema el token antes de que lo
// abras (ver authMail.ts).
app.post("/api/auth/verify-email/confirm", authRateLimit, async (req, res) => {
  if (!dbEnabled) {
    res.status(503).json({ error: accountsUnavailable });
    return;
  }
  const raw = String(req.body?.token ?? "");
  if (!raw || raw.length > 200) {
    res.status(400).json({ error: "Ese enlace no es válido." });
    return;
  }
  const hash = hashSecretToken(raw);
  const claim = await consumeAuthToken(hash, "verify-email");
  if (!claim) {
    // Segundo clic, botón "atrás", o el escáner de correo que lo abrió antes.
    // Si la cuenta ya quedó verificada, eso no es un error: es "ya está".
    const previousUserId = await wasAuthTokenRecentlyUsed(hash, "verify-email");
    if (previousUserId) {
      const previous = await getUserAuthById(previousUserId);
      if (previous?.emailVerified) {
        res.json({ ok: true, alreadyVerified: true });
        return;
      }
    }
    res.status(400).json({
      error: "Ese enlace venció o ya se usó. Pedí uno nuevo e intentá otra vez.",
    });
    return;
  }
  await markEmailVerified(claim.userId);
  await invalidateAuthTokens(claim.userId, "verify-email");
  const user = await getUserAuthById(claim.userId);
  if (!user) {
    res.status(400).json({ error: "Esa cuenta ya no existe." });
    return;
  }
  // Se devuelve sesión: abrir el enlace ya probó que el buzón es tuyo, así que
  // obligarte a escribir la contraseña de nuevo no agrega nada.
  res.json({
    ok: true,
    token: signToken(user.id, user.tokenVersion),
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      emailVerified: true,
    },
  });
});

// Canje por CÓDIGO: los 6 dígitos que van grandes en el correo, para quien lo
// lee en el teléfono y tiene Unify abierto en la computadora.
//
// Seguridad de un código corto, en tres capas: la base cuenta los intentos y
// quema el token al quinto fallo; el límite por IP de authRateLimit frena el
// martilleo; y el tope por cuenta (LINKS_PER_HOUR) impide fabricarse ventanas
// nuevas pidiendo correos sin parar.
app.post("/api/auth/verify-email/code", authRateLimit, async (req, res) => {
  if (!dbEnabled) {
    res.status(503).json({ error: accountsUnavailable });
    return;
  }
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const code = String(req.body?.code ?? "").replace(/\D/g, "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || code.length !== 6) {
    res.status(400).json({ error: "Escribí tu email y los 6 dígitos del código." });
    return;
  }
  const intento = await consumeAuthTokenByCode({
    email,
    purpose: "verify-email",
    codeHash: hashSecretToken(code),
  });
  if (!intento.ok) {
    // Los tres mensajes hablan del CÓDIGO, nunca de la cuenta: contestar
    // distinto para un email que no existe delataría quién tiene cuenta acá.
    const mensaje =
      intento.reason === "sin-intentos"
        ? "Probaste demasiadas veces con ese código. Pedí uno nuevo."
        : intento.reason === "sin-codigo"
          ? "Ese código venció o ya se usó. Pedí uno nuevo."
          : `Ese código no es correcto. Te ${intento.left === 1 ? "queda 1 intento" : `quedan ${intento.left} intentos`}.`;
    res.status(400).json({ error: mensaje });
    return;
  }
  await markEmailVerified(intento.userId);
  await invalidateAuthTokens(intento.userId, "verify-email");
  const user = await getUserAuthById(intento.userId);
  if (!user) {
    res.status(400).json({ error: "Esa cuenta ya no existe." });
    return;
  }
  // Igual que el enlace: escribir el código prueba que el buzón es tuyo.
  res.json({
    ok: true,
    token: signToken(user.id, user.tokenVersion),
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      emailVerified: true,
    },
  });
});

// --- Recuperar la contraseña ------------------------------------------------

app.post("/api/auth/password-reset/request", authRateLimit, mailLimit, async (req, res) => {
  if (!dbEnabled) {
    res.status(503).json({ error: accountsUnavailable });
    return;
  }
  if (!mailerEnabled) {
    res.status(503).json({ error: mailUnavailable });
    return;
  }
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: "Ingresá un email válido." });
    return;
  }
  const user = await getUserByEmail(email);
  if (user) {
    if (!user.passwordHash && user.googleId) {
      // No tiene contraseña que restablecer, y crearle una desde acá sería
      // abrirle una segunda puerta a una cuenta que hoy sólo abre Google. Se
      // le manda un correo explicando dónde está el botón -- callarse sería
      // peor: el silencio delataría qué cuentas usan Google.
      void sendGoogleOnlyResetEmail({
        to: user.email,
        name: user.name,
        appOrigin: CLIENT_ORIGIN,
      }).catch((err) => console.error("[mail] aviso de cuenta-Google:", err));
    } else {
      issueEmailLinkInBackground(user, "reset-password");
    }
  }
  // Misma respuesta exista o no la cuenta: si no, esto sería una forma cómoda
  // de averiguar quién está registrado en Unify.
  res.json({ ok: true });
});

app.post("/api/auth/password-reset/confirm", authRateLimit, async (req, res) => {
  if (!dbEnabled) {
    res.status(503).json({ error: accountsUnavailable });
    return;
  }
  const raw = String(req.body?.token ?? "");
  const password = String(req.body?.password ?? "");
  if (!raw || raw.length > 200) {
    res.status(400).json({ error: "Ese enlace no es válido." });
    return;
  }
  const hash = hashSecretToken(raw);
  // Se mira el enlace sin gastarlo para poder revisar la contraseña primero:
  // si se canjeara antes, escribir una contraseña débil te dejaría sin enlace
  // y sin contraseña nueva.
  const pending = await peekAuthToken(hash, "reset-password");
  if (!pending) {
    res.status(400).json({
      error: "Ese enlace venció o ya se usó. Pedí uno nuevo desde “Olvidé mi contraseña”.",
    });
    return;
  }
  const weak = weakPasswordReason(password, pending.email);
  if (weak) {
    res.status(400).json({ error: weak });
    return;
  }
  const claim = await consumeAuthToken(hash, "reset-password");
  if (!claim) {
    res.status(400).json({ error: "Ese enlace ya se usó. Pedí uno nuevo." });
    return;
  }
  const version = await applyPasswordReset(claim.userId, hashPassword(password));
  invalidateSessions(claim.userId, version);
  await invalidateAuthTokens(claim.userId, "reset-password");
  // Si la cuenta estaba trabada por intentos fallidos, recuperar la contraseña
  // la destraba: quien probó el buzón es la dueña, no quien estaba adivinando.
  clearFailedLogins(claim.email);
  const user = await getUserById(claim.userId);
  res.json({ ok: true, token: signToken(claim.userId, version), user });
});

// Señal de vida del proceso. Sirve para dos cosas concretas:
//
//  - En producción, para que el monitoreo (Render, un pinger externo) sepa si
//    el servidor está arriba SIN tocar la base de datos ni una cuenta.
//  - Para poder afirmar que el proceso NO se reinició: `startedAt` es el
//    instante en que arrancó, así que si cambia, hubo caída. (Las pruebas lo
//    usan para eso; antes miraban el PID con pgrep y terminaban midiendo
//    procesos del propio banco de pruebas en vez del servidor.)
//
// No dice nada sensible: ni versiones, ni rutas, ni configuración.
const ARRANCO_EN = new Date().toISOString();
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, startedAt: ARRANCO_EN, uptimeSec: Math.round(process.uptime()) });
});

// Lets the client show/hide "Continuar con Google" without guessing --
// enabled only once the server has real Google OAuth credentials configured.
app.get("/api/auth/config", (_req, res) => {
  res.json({
    googleEnabled: googleAuthEnabled,
    // Sin correo configurado no hay verificación ni recuperación posibles. El
    // cliente esconde los botones en vez de ofrecer un enlace que nunca llega.
    emailVerification: mailerEnabled,
    passwordReset: mailerEnabled,
  });
});

// Which external-meeting integrations are actually configured on this server,
// so the join UI can tell the user UP FRONT whether an embed will really work
// (Zoom/Teams need credentials) instead of only finding out after they try.
// Jitsi needs no server config, and Google Meet always runs as a companion
// (subtitles/AI over the mic + optional extension) -- so both are always on.
app.get("/api/platforms", (_req, res) => {
  res.json({
    zoom: zoomEnabled,
    teams: teamsEnabled,
    jitsi: true,
    "google-meet": true,
    // Sin almacenamiento configurado, una grabación no puede llegar al
    // historial. El cliente lo necesita saber ANTES de grabar: si no, guarda
    // el archivo en el navegador para reintentar una subida que nunca va a
    // poder funcionar, y le come el disco al usuario para nada.
    recording: storageEnabled,
    // Subir una foto propia necesita el mismo almacenamiento que las
    // grabaciones; sin él la UI oculta el botón en vez de fallar al tocarlo.
    avatars: storageEnabled,
  });
});

// Google Sign-In (plain OAuth2, see googleAuth.ts). Step 1: send the browser
// to Google's consent screen. A full page redirect, not a fetch -- the
// frontend button just navigates here directly.
app.get("/api/auth/google", (_req, res) => {
  if (!googleAuthEnabled) {
    res.status(503).send("El inicio de sesión con Google no está configurado en el servidor.");
    return;
  }
  res.redirect(googleAuthUrl(createState()));
});

// Step 2: Google redirects back here with a one-time code. Exchange it,
// find-or-create/link the account, and hand the browser our own session
// token via a redirect to a tiny frontend page that stores it and continues.
app.get("/api/auth/google/callback", async (req, res) => {
  if (!googleAuthEnabled) {
    res.status(503).send("El inicio de sesión con Google no está configurado en el servidor.");
    return;
  }
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  if (!consumeState(state) || !code) {
    res.redirect(`${CLIENT_ORIGIN}/ingresar?googleError=1`);
    return;
  }
  try {
    const profile = await exchangeGoogleCode(code);
    let user = await getUserByGoogleId(profile.googleId);
    if (!user) {
      const byEmail = await getUserByEmail(profile.email);
      if (byEmail) {
        // Ya existe una cuenta con ese email. Vincularla a ciegas era un
        // agujero: cualquiera podía registrarse ANTES con el email de otra
        // persona (nada obliga a probar que el email es tuyo), esperar a que
        // la dueña real entrara con Google, y quedarse con acceso permanente
        // a su historial usando la contraseña que él mismo había puesto.
        //
        // Google sí prueba el email. Así que si esa cuenta nunca lo probó, la
        // contraseña que tenía la puso alguien sin derecho: se borra y se
        // cierran sus sesiones. La dueña real se queda con la cuenta y entra
        // por Google.
        const { passwordCleared } = await claimAccountForVerifiedEmail(byEmail.id, profile.googleId);
        if (passwordCleared) {
          console.warn(
            `[google-auth] cuenta ${byEmail.id} reclamada por su email verificado; se limpió una contraseña sin verificar`
          );
        }
        if (profile.picture && !byEmail.avatarUrl) {
          await setAvatarIfMissing(byEmail.id, profile.picture);
        }
        const refreshed = await getUserByEmail(profile.email);
        user = refreshed ?? byEmail;
      } else {
        const created = await createUserWithGoogle({ ...profile, avatarUrl: profile.picture });
        user = {
          ...created,
          passwordHash: null,
          googleId: profile.googleId,
          emailVerified: true,
          tokenVersion: 1,
          // Google ya probó el email, así que a esta cuenta nunca hay que
          // exigirle el enlace por correo.
          verificationRequired: false,
        };
      }
    }
    // Token travels in the URL FRAGMENT, not a query param: fragments never
    // leave the browser, so the token can't end up in Vercel's request logs
    // or a Referer header on its way to the client.
    res.redirect(`${CLIENT_ORIGIN}/auth/google#token=${signToken(user.id, user.tokenVersion)}`);
  } catch (err) {
    console.error("[google-auth] callback error:", err instanceof Error ? err.message : err);
    res.redirect(`${CLIENT_ORIGIN}/ingresar?googleError=1`);
  }
});

app.post("/api/translate", translateLimit, async (req, res) => {
  const { text, source, target } = req.body ?? {};
  if (typeof text !== "string" || typeof source !== "string" || typeof target !== "string") {
    res.status(400).json({ error: "text, source y target son obligatorios." });
    return;
  }
  // Real captions/chat lines are short; anything huge is someone using this
  // open endpoint as a free translation API on our Anthropic bill.
  if (text.length > 4000) {
    res.status(400).json({ error: "El texto es demasiado largo para traducir." });
    return;
  }
  try {
    const translatedText = await translateText(text, source, target);
    res.json({ translatedText });
  } catch (err) {
    res.status(502).json({ error: "No se pudo traducir el texto en este momento." });
  }
});

// Mints the Zoom Meeting SDK "signature" (a JWT) the browser needs to join an
// embedded Zoom meeting. The signing secret lives only here -- the client
// posts the meeting number and gets back an opaque, short-lived token. Returns
// 503 (not 500) when Zoom credentials aren't configured, so the client can
// show an honest "Zoom no está configurado" message instead of a generic error.
app.post("/api/zoom/signature", credentialLimit, (req, res) => {
  if (!zoomEnabled) {
    res.status(503).json({ error: "La integración con Zoom no está configurada en el servidor." });
    return;
  }
  const rawNumber = req.body?.meetingNumber;
  const meetingNumber = typeof rawNumber === "string" ? rawNumber.replace(/\D/g, "") : String(rawNumber ?? "");
  if (!meetingNumber) {
    res.status(400).json({ error: "meetingNumber es obligatorio." });
    return;
  }
  // We only ever join as an attendee (role 0). Starting/hosting a meeting
  // (role 1) needs a ZAK and only works for the app account's own meetings.
  const role = req.body?.role === 1 ? 1 : 0;
  try {
    const signature = generateMeetingSdkSignature({ meetingNumber, role });
    res.json({ signature });
  } catch {
    res.status(502).json({ error: "No se pudo generar la autorización de Zoom." });
  }
});

// Issues an ACS access token so the browser can join a Teams meeting via
// Azure Communication Services (Teams interop). The ACS connection string
// stays server-side; the client gets only a short-lived per-session token.
// 503 when Teams/ACS isn't configured, so the client shows an honest message.
app.post("/api/teams/token", credentialLimit, async (_req, res) => {
  if (!teamsEnabled) {
    res.status(503).json({ error: "La integración con Microsoft Teams no está configurada en el servidor." });
    return;
  }
  try {
    const credentials = await createTeamsUserToken();
    res.json(credentials);
  } catch (err) {
    // Surface the real reason so a misconfigured ACS connection string /
    // Azure error is diagnosable from the client instead of an opaque 502.
    // El detalle va al log del servidor, no al cliente: el mensaje de Azure
    // puede nombrar el recurso, la región o la forma de la configuración.
    console.error("[teams] token error:", err instanceof Error ? err.message : String(err));
    res.status(502).json({ error: "No se pudo generar el acceso a Teams. Probá de nuevo en un momento." });
  }
});

app.post("/api/explain-error", explainLimit, async (req, res) => {
  const { error, context } = req.body ?? {};
  if (typeof error !== "string" || !error.trim()) {
    res.status(400).json({ error: "error es obligatorio." });
    return;
  }
  // Raw browser/network errors are short strings; cap so this open endpoint
  // can't be fed arbitrarily large prompts on our Anthropic bill.
  const explanation = await explainError(
    error.slice(0, 1000),
    typeof context === "string" ? context.slice(0, 500) : undefined
  );
  // Not an error response even when there's no explanation available (no
  // API key, or the call failed) -- callers are expected to fall back to
  // showing the raw error themselves in that case.
  res.json({ explanation });
});

// Past-meetings history: list, detail, recording upload, and the AI Q&A
// endpoint. All backed by Postgres (see db.ts) -- if DATABASE_URL isn't
// configured these quietly return empty results instead of erroring, so a
// deploy without the database doesn't break live video calls.
app.get("/api/meetings", requireAuth, async (req, res) => {
  const meetings = await listMeetings((req as AuthedRequest).userId!);
  res.json({ meetings });
});

app.get("/api/meetings/:id", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId!;
  let meeting = await getMeetingDetailForUser(req.params.id, userId);
  // A logged-in participant of the LIVE meeting can read it while they're in
  // it, even if they're not the owner (e.g. everyone in a shared external
  // companion room). Read-only -- surfaced as a shared view.
  if (!meeting && isLiveParticipant(req.params.id, userId)) {
    const raw = await getMeetingDetailRaw(req.params.id);
    if (raw) meeting = { ...raw, sharedView: true };
  }
  if (!meeting) {
    res.status(404).json({ error: "No encontramos esa reunión." });
    return;
  }
  res.json({ meeting });
});

// --- Folders ---------------------------------------------------------------
// Organize saved meetings into folders ("Ingeniería", "Clientes"…), move
// meetings between them, and share a whole folder (read-only) with another
// account. All owner-scoped in SQL; sharing is by the recipient's email.

app.get("/api/folders", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId!;
  const [owned, shared] = await Promise.all([listFolders(userId), listSharedFolders(userId)]);
  res.json({ folders: owned, shared });
});

app.post("/api/folders", requireAuth, async (req, res) => {
  const name = String(req.body?.name ?? "").trim().slice(0, 80);
  if (!name) {
    res.status(400).json({ error: "Poné un nombre para la carpeta." });
    return;
  }
  const folder = await createFolder((req as AuthedRequest).userId!, name);
  if (!folder) {
    res.status(503).json({ error: "No se pudo crear la carpeta en este momento." });
    return;
  }
  res.json({ folder });
});

app.patch("/api/folders/:id", requireAuth, async (req, res) => {
  const name = String(req.body?.name ?? "").trim().slice(0, 80);
  if (!name) {
    res.status(400).json({ error: "Poné un nombre para la carpeta." });
    return;
  }
  const ok = await renameFolder(req.params.id, (req as AuthedRequest).userId!, name);
  if (!ok) {
    res.status(404).json({ error: "No encontramos esa carpeta." });
    return;
  }
  res.json({ ok: true });
});

app.delete("/api/folders/:id", requireAuth, async (req, res) => {
  const ok = await deleteFolder(req.params.id, (req as AuthedRequest).userId!);
  if (!ok) {
    res.status(404).json({ error: "No encontramos esa carpeta." });
    return;
  }
  res.json({ ok: true });
});

// Meetings inside a folder -- owner or a share recipient. 403 if the caller
// has no access to the folder at all.
app.get("/api/folders/:id/meetings", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId!;
  if (!(await canAccessFolder(req.params.id, userId))) {
    res.status(403).json({ error: "No tenés acceso a esa carpeta." });
    return;
  }
  const meetings = await listMeetingsInFolder(req.params.id);
  res.json({ meetings });
});

app.get("/api/folders/:id/shares", requireAuth, async (req, res) => {
  const recipients = await listFolderShares(req.params.id, (req as AuthedRequest).userId!);
  res.json({ recipients });
});

app.post("/api/folders/:id/share", requireAuth, async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: "Ingresá el email de la persona." });
    return;
  }
  const result = await shareFolderWithEmail(req.params.id, (req as AuthedRequest).userId!, email);
  if (!result.ok) {
    const msg =
      result.reason === "not-owner"
        ? "No encontramos esa carpeta."
        : result.reason === "no-user"
          ? "No hay ninguna cuenta de Unify con ese email. La persona tiene que registrarse primero."
          : result.reason === "self"
            ? "Esa carpeta ya es tuya."
            : "No se pudo compartir la carpeta en este momento.";
    res.status(result.reason === "not-owner" ? 404 : 400).json({ error: msg });
    return;
  }
  res.json({ ok: true });
});

app.delete("/api/folders/:id/share/:userId", requireAuth, async (req, res) => {
  const ok = await unshareFolder(
    req.params.id,
    (req as AuthedRequest).userId!,
    req.params.userId
  );
  if (!ok) {
    res.status(404).json({ error: "No encontramos esa carpeta." });
    return;
  }
  res.json({ ok: true });
});

// Move (or remove, folderId=null) one of the caller's meetings into one of
// their folders.
app.post("/api/meetings/:id/folder", requireAuth, async (req, res) => {
  const raw = req.body?.folderId;
  const folderId = typeof raw === "string" && raw ? raw : null;
  const ok = await moveMeetingToFolder(req.params.id, (req as AuthedRequest).userId!, folderId);
  if (!ok) {
    res.status(404).json({ error: "No se pudo mover la reunión (revisá que sea tuya)." });
    return;
  }
  res.json({ ok: true });
});

// Delete one of the caller's own meetings (and its messages, via cascade).
app.delete("/api/meetings/:id", requireAuth, async (req, res) => {
  const ok = await deleteMeeting(req.params.id, (req as AuthedRequest).userId!);
  if (!ok) {
    res.status(404).json({ error: "No se pudo eliminar la reunión (revisá que sea tuya)." });
    return;
  }
  res.json({ ok: true });
});

// AI report: generated once over the whole transcript and saved, then served
// instantly on later opens. `?regenerate=1` forces a fresh one.
app.post("/api/meetings/:id/report", requireAuth, aiLimit, async (req, res) => {
  const regenerate = req.query.regenerate === "1" || req.body?.regenerate === true;
  const result = await generateMeetingReport(
    req.params.id,
    (req as AuthedRequest).userId!,
    regenerate
  );
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ report: result.answer });
});

app.post("/api/meetings/:id/recording-upload-url", uploadLimit, async (req, res) => {
  if (!storageEnabled) {
    res.status(503).json({ error: "El almacenamiento de grabaciones no está configurado." });
    return;
  }
  // Only the container types the recorder actually produces -- an arbitrary
  // contentType would let anyone store arbitrary files under a presigned URL
  // on our bucket. Audio is included: an automatically started recording is
  // microphone-only, because capturing the screen needs a user gesture.
  const contentType = normalizeRecordingType(req.body?.contentType);
  // The meeting id is unauthenticated by design (guests record too), but it
  // must at least reference a real meeting -- not be a free upload endpoint.
  if (dbEnabled && !(await meetingExists(req.params.id))) {
    res.status(404).json({ error: "No encontramos esa reunión." });
    return;
  }
  try {
    const target = await createRecordingUploadUrl(req.params.id, contentType);
    if (!target) {
      res.status(503).json({ error: "No se pudo preparar la subida de la grabación." });
      return;
    }
    res.json(target);
  } catch (err) {
    console.error("[storage] presign error:", err instanceof Error ? err.message : err);
    res.status(503).json({ error: "No se pudo preparar la subida de la grabación." });
  }
});

// Pinged the instant a recording starts, so we anchor the video's t=0 to a
// real server-clock timestamp (skew-free, no upload delay) for transcript sync.
app.post("/api/meetings/:id/recording-started", async (req, res) => {
  if (dbEnabled && !(await meetingExists(req.params.id))) {
    res.status(404).json({ error: "No encontramos esa reunión." });
    return;
  }
  await markRecordingStarted(req.params.id);
  res.json({ ok: true });
});

app.post("/api/meetings/:id/recording-complete", async (req, res) => {
  const { publicUrl } = req.body ?? {};
  if (typeof publicUrl !== "string" || !publicUrl) {
    res.status(400).json({ error: "publicUrl es obligatorio." });
    return;
  }
  // Never store a URL we didn't mint: the history page renders this as a
  // <video src> and a download link for the owner, so an arbitrary value
  // here would let any participant plant arbitrary content (or a hostile
  // link) in someone else's history.
  if (!isOwnRecordingUrl(publicUrl)) {
    res.status(400).json({ error: "La URL de la grabación no es válida." });
    return;
  }
  // Optional: how long the recording ran (ms). The server back-computes the
  // start time from its own clock so the history player can align the
  // transcript to the video without any client/server clock skew.
  const rawDuration = Number(req.body?.durationMs);
  const durationMs = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : undefined;
  await attachRecording(req.params.id, publicUrl, durationMs);
  res.json({ ok: true });
});

// Fallback path when the browser's direct-to-R2 PUT fails (typically the
// bucket's CORS not allowing PUT from the app origin). The client re-sends the
// raw video body here; the server streams it to R2 with its own credentials
// (no browser CORS involved) and attaches it to the meeting. The body is the
// video itself (Content-Type video/mp4|webm), so express.json() leaves the
// stream untouched and we pipe `req` straight into the multipart upload without
// buffering the whole file. durationMs comes as a query param so we never have
// to read the body twice.
app.post("/api/meetings/:id/recording-upload", uploadLimit, async (req, res) => {
  if (!storageEnabled) {
    res.status(503).json({ error: "El almacenamiento de grabaciones no está configurado." });
    return;
  }
  const contentType = normalizeRecordingType(req.headers["content-type"]);
  // Reject an oversized/garbage body up front (this endpoint is unauthenticated
  // by design, like the presign one, so it must not become a free file host).
  const declaredLen = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLen) && declaredLen > 800 * 1024 * 1024) {
    res.status(413).json({ error: "La grabación es demasiado grande." });
    return;
  }
  if (dbEnabled && !(await meetingExists(req.params.id))) {
    res.status(404).json({ error: "No encontramos esa reunión." });
    return;
  }
  const rawDuration = Number(req.query.durationMs);
  const durationMs = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : undefined;
  try {
    const publicUrl = await uploadRecordingStream(req.params.id, contentType, req);
    if (!publicUrl) {
      res.status(503).json({ error: "No se pudo subir la grabación." });
      return;
    }
    await attachRecording(req.params.id, publicUrl, durationMs);
    res.json({ ok: true, publicUrl });
  } catch (err) {
    console.error("[storage] server upload error:", err instanceof Error ? err.message : err);
    res.status(503).json({ error: "No se pudo subir la grabación." });
  }
});

// Lets a just-registered/logged-in user claim a meeting they created/joined
// as a guest (before this call, owner_id is NULL) so it appears in their
// history. No-ops (ok: false) if the meeting already has a different owner.
app.post("/api/meetings/:id/claim", requireAuth, async (req, res) => {
  const ok = await claimMeeting(req.params.id, (req as AuthedRequest).userId!);
  res.json({ ok });
});

// Tope de fotogramas por pregunta y de tamaño por fotograma. Ocho imágenes
// chicas alcanzan para "mirar" una reunión entera, y el tope corta en seco a
// quien quiera usar la IA como OCR gratis de archivos gigantes.
const MAX_FRAMES = 8;
const MAX_FRAME_B64_CHARS = 400_000; // ~300 KB de JPEG por fotograma

/** Se queda sólo con los fotogramas bien formados; el resto se descarta. */
function sanitizeFrames(raw: unknown): { atSec: number; data: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { atSec: number; data: string }[] = [];
  for (const f of raw.slice(0, MAX_FRAMES)) {
    const atSec = Number((f as { atSec?: unknown })?.atSec);
    const rawData = (f as { data?: unknown })?.data;
    if (typeof rawData !== "string" || !Number.isFinite(atSec) || atSec < 0) continue;
    let data: string = rawData;
    // Se acepta con o sin el prefijo data:, pero se guarda pelado.
    data = data.replace(/^data:image\/jpeg;base64,/, "");
    if (data.length === 0 || data.length > MAX_FRAME_B64_CHARS) continue;
    if (!/^[A-Za-z0-9+/=]+$/.test(data)) continue;
    out.push({ atSec: Math.floor(atSec), data });
  }
  return out;
}

app.post("/api/meetings/:id/ask", requireAuth, aiLimit, async (req, res) => {
  const question = typeof req.body?.question === "string" ? req.body.question : "";
  const userId = (req as AuthedRequest).userId!;
  // Fotogramas del video grabado, capturados por el navegador: la IA no sólo
  // lee la transcripción, también MIRA el video (ver ai.ts / VideoFrame).
  const frames = sanitizeFrames(req.body?.frames);
  // Anyone currently in the live meeting (not just its owner) can ask the AI --
  // this is what makes the in-meeting assistant work for every participant of a
  // shared external companion room, not only whoever opened it first.
  const result = await answerFromMeeting(
    req.params.id,
    question,
    userId,
    isLiveParticipant(req.params.id, userId),
    frames
  );
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ answer: result.answer });
});

// Same idea as /api/meetings/:id/ask, but grounded across every saved
// meeting instead of one -- "what did I talk about on the 17th", "what was
// my last meeting about", etc.
app.post("/api/meetings/ask-all", requireAuth, aiLimit, async (req, res) => {
  const question = typeof req.body?.question === "string" ? req.body.question : "";
  const result = await answerAcrossMeetings(question, (req as AuthedRequest).userId!);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ answer: result.answer });
});

// --- Outlook / Microsoft calendar ------------------------------------------
// Connect a Microsoft 365 / Outlook calendar so the app can show upcoming
// meetings and offer to auto-record. `configured` reflects whether the server
// has Azure credentials at all; `connected` whether THIS user linked their
// calendar. Everything degrades gracefully when unconfigured.

app.get("/api/calendar/status", requireAuth, async (req, res) => {
  if (!microsoftEnabled) {
    res.json({ configured: false, connected: false });
    return;
  }
  const token = await getMsRefreshToken((req as AuthedRequest).userId!);
  res.json({ configured: true, connected: Boolean(token) });
});

// The client fetches this WITH its Bearer token, then navigates the browser to
// the returned URL. Doing it this way (instead of a plain redirect endpoint)
// keeps the session token out of the URL/query logs while still binding the
// OAuth `state` to the right Unify account.
app.get("/api/calendar/connect-url", requireAuth, (req, res) => {
  if (!microsoftEnabled) {
    res.status(503).json({ error: "La conexión con Outlook no está configurada en el servidor." });
    return;
  }
  const state = createCalendarState((req as AuthedRequest).userId!);
  res.json({ url: calendarAuthUrl(state) });
});

app.get("/api/calendar/callback", async (req, res) => {
  if (!microsoftEnabled) {
    res.status(503).send("La conexión con Outlook no está configurada en el servidor.");
    return;
  }
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  const userId = consumeCalendarState(state);
  if (!userId || !code) {
    res.redirect(`${CLIENT_ORIGIN}/historial?calendar=error`);
    return;
  }
  try {
    const { refreshToken } = await exchangeCalendarCode(code);
    await setMsRefreshToken(userId, refreshToken);
    res.redirect(`${CLIENT_ORIGIN}/historial?calendar=connected`);
  } catch (err) {
    console.error("[calendar] callback error:", err instanceof Error ? err.message : err);
    res.redirect(`${CLIENT_ORIGIN}/historial?calendar=error`);
  }
});

app.post("/api/calendar/disconnect", requireAuth, async (req, res) => {
  await clearMsRefreshToken((req as AuthedRequest).userId!);
  res.json({ ok: true });
});

app.get("/api/calendar/upcoming", requireAuth, async (req, res) => {
  if (!microsoftEnabled) {
    res.json({ configured: false, connected: false, events: [] });
    return;
  }
  const userId = (req as AuthedRequest).userId!;
  const refreshToken = await getMsRefreshToken(userId);
  if (!refreshToken) {
    res.json({ configured: true, connected: false, events: [] });
    return;
  }
  try {
    const { accessToken, refreshToken: rotated } = await refreshAccessToken(refreshToken);
    // Microsoft rotates refresh tokens -- persist the new one so the link
    // doesn't silently die after the old token expires.
    if (rotated && rotated !== refreshToken) await setMsRefreshToken(userId, rotated);
    const events = await fetchUpcomingEvents(accessToken);
    res.json({ configured: true, connected: true, events });
  } catch (err) {
    console.error("[calendar] upcoming error:", err instanceof Error ? err.message : err);
    // A failed refresh usually means the user revoked access on Microsoft's
    // side; surface it so the client can offer to reconnect.
    res.status(502).json({ configured: true, connected: true, events: [], error: "refresh-failed" });
  }
});

// Last-resort error handler so a malformed JSON body (or any synchronous
// throw in a route) answers with a JSON error instead of Express's default
// HTML stack page.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = (err as { status?: number })?.status ?? 500;
  if (status >= 500) console.error("Error no manejado en la API:", err);
  res.status(status).json({ error: status === 400 ? "El cuerpo de la solicitud no es válido." : "Error interno del servidor." });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: corsOrigin },
  // Backgrounded/throttled browser tabs can delay the heartbeat past the
  // default 20s pingTimeout, which reads as a real disconnect and (without
  // this) used to make the meeting "disappear" out from under the host.
  // Give it a lot more slack before giving up on a connection.
  pingTimeout: 60_000,
  pingInterval: 25_000,
});

io.on("connection", (socket) => {
  registerSocketHandlers(io, socket);
});

// ============================================================================
// Google Meet bridge: the Unify browser extension (see /extension) scrapes
// what Meet's page exposes and POSTs it here; we relay it into the matching
// companion room ("google-meet:<code>") where the web app renders it live.
// Meet has NO official API for third-party in-call state -- DOM observation
// from an extension is the only technically possible integration, which is
// why this input is treated as best-effort display data, never as authority
// for anything (no moderation, no persistence beyond the transcript flow).
// ============================================================================
const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

// El bridge ya no es sólo de Meet: la extensión también acompaña reuniones de
// Zoom, Teams, Jitsi y compañía. La identidad de la sala es la MISMA clave que
// deriva el cliente (meetingPlatforms.ts): "plataforma:resto". Eso es lo que
// hace que el overlay de la extensión y el companion web caigan en la misma
// sala de Unify y sus transcripciones se fundan en un solo hilo, en vez de
// fabricar una isla por superficie.
//
// La lista es cerrada a propósito: este endpoint crea reuniones y registros en
// la base sin sesión, así que un prefijo libre sería una canilla de basura.
const BRIDGE_PLATFORMS = new Set([
  "google-meet", "zoom", "teams", "jitsi", "webex", "whereby", "element",
  "chime", "goto", "bluejeans", "ringcentral", "dialpad", "livestorm", "zoho",
  "skype", "discord", "slack", "whatsapp", "gather", "generica",
  // Cualquier web: la clave que la web y la extensión derivan de un enlace
  // que no reconocen por nombre (origen + path). Ver externalFallbackKey.
  "externa",
]);

// Cómo se titula la reunión en el historial ("Reunión de Zoom", etc.).
const BRIDGE_LABELS: Record<string, string> = {
  "google-meet": "Google Meet", zoom: "Zoom", teams: "Microsoft Teams",
  jitsi: "Jitsi", webex: "Webex", whereby: "Whereby", element: "Element Call",
  chime: "Amazon Chime", goto: "GoTo Meeting", bluejeans: "BlueJeans",
  ringcentral: "RingCentral", dialpad: "Dialpad", livestorm: "Livestorm",
  zoho: "Zoho Meeting", skype: "Skype", discord: "Discord", slack: "Slack",
  whatsapp: "WhatsApp", gather: "Gather", generica: "Reunión externa",
  externa: "Reunión externa",
};

/**
 * Normaliza el id que llega por la URL a una clave de sala, o null si no es
 * válido. Un código de Meet pelado ("abc-defg-hij") sigue andando tal cual --
 * es lo que manda la extensión v3 instalada -- y se mapea a la misma clave
 * "google-meet:código" de siempre, así que nadie pierde su sala.
 */
function bridgeRoomKey(raw: string): string | null {
  const value = String(raw ?? "").trim().toLowerCase().slice(0, 240);
  if (MEET_CODE_RE.test(value)) return `google-meet:${value}`;
  const sep = value.indexOf(":");
  if (sep <= 0) return null;
  const platform = value.slice(0, sep);
  const tail = value.slice(sep + 1);
  if (!BRIDGE_PLATFORMS.has(platform)) return null;
  // El resto de la clave sale de hosts, paths y ids de reunión: letras,
  // números y la puntuación que esos formatos usan de verdad (Teams mete
  // "19:meeting_...@thread.v2", Jitsi "dominio/sala"). Nada de espacios ni
  // caracteres de control.
  if (!/^[a-z0-9][a-z0-9\-._~:/@%+=]{0,200}$/.test(tail)) return null;
  return `${platform}:${tail}`;
}

const meetBridgeLimiters = new Map<string, { windowStart: number; count: number }>();

function allowMeetBridge(meetId: string): boolean {
  const now = Date.now();
  const entry = meetBridgeLimiters.get(meetId) ?? { windowStart: now, count: 0 };
  if (now - entry.windowStart > 10_000) {
    entry.windowStart = now;
    entry.count = 0;
  }
  entry.count += 1;
  meetBridgeLimiters.set(meetId, entry);
  if (meetBridgeLimiters.size > 500) {
    const firstKey = meetBridgeLimiters.keys().next().value;
    if (firstKey !== undefined) meetBridgeLimiters.delete(firstKey);
  }
  return entry.count <= 40;
}

// --- El bot que entra a la reunión (estilo "Notetaker") ---------------------
// Manda un participante-bot a una reunión para grabarla y transcribirla desde
// dentro, aunque vos no estés. La detección (URL -> plataforma + clave de
// sala) la hace el CLIENTE con detectMeetingPlatform (una sola fuente de
// verdad); acá se valida y se lanza el proceso del bot (bot/joinbot.mjs), que
// POSTea al mismo bridge que todo lo demás.
//
// Gated por BOT_ENABLED: unir un navegador headless a Zoom/Meet reales exige
// un host que lo permita (no el web dyno de siempre) y afinar selectores por
// plataforma, así que en producción se enciende a propósito, no por descuido.
const BOT_ENABLED = process.env.BOT_ENABLED === "1";
const BOT_PLATFORMS = new Set(["jitsi", "google-meet", "zoom-web", "test"]);
const botsVivos = new Map<string, ReturnType<typeof spawn>>();

app.post("/api/bot/dispatch", requireAuth, (req, res) => {
  if (!BOT_ENABLED) {
    res.status(503).json({
      error:
        "El bot no está habilitado en este servidor. Se enciende con BOT_ENABLED=1 en un host que permita navegador headless.",
    });
    return;
  }
  const url = String(req.body?.url ?? "").trim().slice(0, 2000);
  const roomKey = bridgeRoomKey(String(req.body?.roomKey ?? ""));
  const platform = String(req.body?.platform ?? "");
  if (!/^https?:\/\//.test(url)) {
    res.status(400).json({ error: "Falta la URL de la reunión." });
    return;
  }
  if (!roomKey) {
    res.status(400).json({ error: "La clave de sala no es válida." });
    return;
  }
  const plataformaBot = BOT_PLATFORMS.has(platform) ? platform : "jitsi";
  if (botsVivos.has(roomKey)) {
    res.json({ ok: true, yaEstaba: true, message: "El bot ya está en esa reunión." });
    return;
  }
  const hijo = spawn("node", [resolvePath(process.cwd(), "..", "bot", "joinbot.mjs")], {
    env: {
      ...process.env,
      MEETING_URL: url,
      ROOM_KEY: roomKey,
      SERVER_URL: `http://localhost:${process.env.PORT || 4001}`,
      BOT_NAME: process.env.BOT_NAME || "Unify Notetaker",
      PLATFORM: plataformaBot,
    },
    stdio: "ignore",
    detached: true,
  });
  botsVivos.set(roomKey, hijo);
  hijo.on("exit", () => botsVivos.delete(roomKey));
  res.json({ ok: true, roomKey, platform: plataformaBot, message: "El bot está entrando a la reunión." });
});

// Sacar el bot de una reunión a mano.
app.post("/api/bot/leave", requireAuth, (req, res) => {
  const roomKey = bridgeRoomKey(String(req.body?.roomKey ?? ""));
  const hijo = roomKey ? botsVivos.get(roomKey) : undefined;
  if (hijo) {
    try {
      process.kill(-hijo.pid!, "SIGTERM");
    } catch {
      try {
        hijo.kill("SIGTERM");
      } catch {
        /* ya no está */
      }
    }
    res.json({ ok: true });
    return;
  }
  res.json({ ok: false, message: "No hay un bot en esa reunión." });
});

app.post("/api/meet-bridge/:meetId", bridgeLimit, (req, res) => {
  const roomKey = bridgeRoomKey(req.params.meetId);
  if (!roomKey) {
    res.status(400).json({ error: "Clave de reunión inválida." });
    return;
  }
  if (!allowMeetBridge(roomKey)) {
    res.status(429).json({ error: "Demasiadas actualizaciones." });
    return;
  }
  const meetId = roomKey;
  const b = req.body ?? {};
  // Whitelist + clamp every field: this endpoint is reachable by anyone who
  // knows the meet code, so nothing here is trusted beyond display.
  const state = {
    meetId,
    inCall: Boolean(b.inCall),
    participantCount:
      Number.isFinite(Number(b.participantCount)) && Number(b.participantCount) >= 0
        ? Math.min(Math.floor(Number(b.participantCount)), 1000)
        : null,
    micMuted: typeof b.micMuted === "boolean" ? b.micMuted : null,
    cameraOff: typeof b.cameraOff === "boolean" ? b.cameraOff : null,
    presenting: typeof b.presenting === "boolean" ? b.presenting : null,
    activeSpeakers: Array.isArray(b.activeSpeakers)
      ? b.activeSpeakers.slice(0, 10).map((n: unknown) => String(n).slice(0, 60))
      : [],
    participants: Array.isArray(b.participants)
      ? b.participants.slice(0, 100).map((n: unknown) => String(n).slice(0, 60))
      : null,
    at: Date.now(),
  };
  // La sala del socket es la misma que crea getOrCreateCompanionMeeting: la
  // clave en mayúsculas. Antes esto estaba clavado a GOOGLE-MEET.
  io.to(`meeting:${meetId.toUpperCase()}`).emit("meet-state", state);
  res.json({ ok: true });
});

// --- Extension transcript relay ---------------------------------------------
// Google Meet's OWN live captions carry every speaker (with their name), which
// is the only way to transcribe a whole external meeting: our in-browser
// recognizer can only ever hear the local microphone, so it would capture just
// the person running Unify. The extension reads those captions and posts each
// finished line here; we persist it and broadcast it to the companion room so
// the web app, the extension panel and the saved history all show EVERYONE.

// Socket.io room for a meeting id -- must match socketHandlers' roomName().
const roomFor = (meetingId: string) => `meeting:${meetingId}`;

// Resuelve (creando si hace falta) la reunión companion que respalda una
// clave de sala. El título del historial sale de la plataforma: "Reunión de
// Zoom", "Reunión de Microsoft Teams", igual que las creadas desde la web.
function companionForRoomKey(roomKey: string) {
  const { meeting, created } = getOrCreateCompanionMeeting(roomKey);
  if (created) {
    const platform = roomKey.split(":")[0];
    void createMeetingRecord({
      id: meeting.dbId,
      joinCode: meeting.id,
      hostName: BRIDGE_LABELS[platform] ?? "Reunión externa",
      roles: [],
      ownerId: null,
    });
  }
  return meeting;
}

app.post("/api/meet-bridge/:meetId/transcript", bridgeLimit, async (req, res) => {
  const roomKey = bridgeRoomKey(req.params.meetId);
  if (!roomKey) {
    res.status(400).json({ error: "Clave de reunión inválida." });
    return;
  }
  if (!allowMeetBridge(roomKey)) {
    res.status(429).json({ error: "Demasiadas líneas seguidas." });
    return;
  }
  const speaker = String(req.body?.speaker ?? "").slice(0, 60);
  const text = String(req.body?.text ?? "").trim().slice(0, 2000);
  const lang = String(req.body?.lang ?? "es-AR").slice(0, 16);
  // Lecturas alternativas del reconocimiento, si el cliente las tiene: más
  // hipótesis para que la IA reconstruya la palabra que de verdad se dijo.
  const alts = Array.isArray(req.body?.alts)
    ? (req.body.alts as unknown[])
        .filter((a): a is string => typeof a === "string")
        .map((a) => a.trim().slice(0, 2000))
        .filter(Boolean)
        .slice(0, 3)
    : [];
  if (!text) {
    res.status(400).json({ error: "text es obligatorio." });
    return;
  }

  const meeting = companionForRoomKey(roomKey);

  // El MISMO cerebro que las reuniones nativas (sin clave de Anthropic las
  // dos funciones se apagan solas y esto queda exactamente como antes): la
  // IA reconstruye la frase más probable a partir de las lecturas candidatas
  // y el contexto reciente -- el reconocimiento confunde palabras que suenan
  // parecido -- y las traducciones a los idiomas de los PRESENTES se calculan
  // en paralelo y se emparchan sobre la línea apenas están listas.
  const recentContext = meeting.transcript.slice(-4).map((l) => `${l.speakerName}: ${l.text}`);
  const candidatas = [text, ...alts.filter((a) => a !== text)];
  const targetLangs = Array.from(
    new Set(
      Array.from(meeting.participants.values())
        .map((p) => shortLang(p.language ?? ""))
        .filter((c) => c && c !== shortLang(lang))
    )
  );
  const traduccionesPromise = translateFragmentToAll(candidatas, recentContext, targetLangs, lang);
  const cleanup = await cleanTranscriptFragment(candidatas, recentContext, lang);
  const textoFinal = cleanup.text || text;
  const mismatch = cleanup.detectedLang !== null && cleanup.detectedLang !== shortLang(lang);
  const sourceLang = mismatch ? cleanup.detectedLang! : lang;

  const line = addNamedTranscriptLine(meeting, speaker, textoFinal, sourceLang);
  io.to(roomFor(meeting.id)).emit("transcript-line", { line });
  void recordMessage({
    meetingId: meeting.dbId,
    kind: "transcript",
    senderName: line.speakerName,
    roleName: null,
    text: line.text,
    sourceLang: line.sourceLang,
    spokenAt: new Date(),
  });
  void traduccionesPromise.then((translations) => {
    if (Object.keys(translations).length === 0) return;
    line.translations = translations;
    io.to(roomFor(meeting.id)).emit("transcript-line-translations", { lineId: line.id, translations });
  });
  res.json({ ok: true, dbId: meeting.dbId, lineId: line.id });
});

// Lets the extension panel bootstrap: which saved meeting backs this Meet code,
// and what has been said so far (so re-opening the panel isn't a blank slate).
app.get("/api/meet-bridge/:meetId/session", bridgeLimit, (req, res) => {
  const roomKey = bridgeRoomKey(req.params.meetId);
  if (!roomKey) {
    res.status(400).json({ error: "Clave de reunión inválida." });
    return;
  }
  const meeting = companionForRoomKey(roomKey);
  res.json({
    dbId: meeting.dbId,
    joinCode: meeting.id,
    transcript: meeting.transcript.slice(-120),
    // La foto viene resuelta por el SERVIDOR a partir de la cuenta (regla de
    // siempre: si la mandara el cliente, cualquiera podría ponerse la cara de
    // otro). El overlay la usa para el subtítulo con foto, como en la web.
    participants: Array.from(meeting.participants.values()).map((p) => ({
      id: p.id,
      name: p.name,
      avatarUrl: p.avatarUrl ?? null,
    })),
  });
});

// AI for the extension panel, scoped to this Meet's companion meeting. Requires
// a signed-in account (the AI costs money per question, so it is never open to
// anonymous callers), but knowing the Meet code is what grants access to THAT
// meeting's content -- the same trust model as the rest of the bridge.
app.post("/api/meet-bridge/:meetId/ask", requireAuth, aiLimit, async (req, res) => {
  const roomKey = bridgeRoomKey(req.params.meetId);
  if (!roomKey) {
    res.status(400).json({ error: "Clave de reunión inválida." });
    return;
  }
  const question = typeof req.body?.question === "string" ? req.body.question : "";
  const meeting = companionForRoomKey(roomKey);
  const result = await answerFromMeeting(
    meeting.dbId,
    question,
    (req as AuthedRequest).userId!,
    true // authorized above: signed in + holds this meeting's code
  );
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ answer: result.answer });
});


httpServer.listen(PORT, () => {
  console.log(`Servidor de reuniones escuchando en el puerto ${PORT}`);
});
