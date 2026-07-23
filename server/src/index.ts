import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { answerFromMeeting, generateMeetingReport } from "./ai";
import { hashPassword, signToken, verifyPassword, verifyToken } from "./auth";
import {
  attachRecording,
  canAccessFolder,
  claimMeeting,
  clearMsRefreshToken,
  createFolder,
  createUser,
  createUserWithGoogle,
  dbEnabled,
  deleteFolder,
  deleteMeeting,
  getMeetingDetailForUser,
  getMsRefreshToken,
  getUserAuthById,
  getUserByEmail,
  getUserByGoogleId,
  getUserById,
  linkGoogleId,
  listFolders,
  listFolderShares,
  listMeetings,
  listMeetingsInFolder,
  listSharedFolders,
  meetingExists,
  moveMeetingToFolder,
  renameFolder,
  setMsRefreshToken,
  shareFolderWithEmail,
  unshareFolder,
  updateUserName,
  updateUserPasswordHash,
} from "./db";
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
import { registerSocketHandlers } from "./socketHandlers";
import {
  createRecordingUploadUrl,
  isOwnRecordingUrl,
  storageEnabled,
  uploadRecordingStream,
} from "./storage";
import { createTeamsUserToken, teamsEnabled } from "./teams";
import { translateText } from "./translate";
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
app.use(cors(corsDelegate));
app.use(express.json());

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
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  const userId = verifyToken(token);
  if (!userId) {
    res.status(401).json({ error: "Iniciá sesión para continuar." });
    return;
  }
  (req as AuthedRequest).userId = userId;
  next();
}

const accountsUnavailable = "Las cuentas no están disponibles: falta configurar la base de datos.";

app.post("/api/auth/register", async (req, res) => {
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
  if (password.length < 8) {
    res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres." });
    return;
  }
  if (!name) {
    res.status(400).json({ error: "Ingresá tu nombre." });
    return;
  }
  const result = await createUser({ email, name, passwordHash: hashPassword(password) });
  if (!result.ok) {
    if (result.reason === "duplicate") {
      res.status(409).json({ error: "Ya existe una cuenta con ese email." });
      return;
    }
    res.status(503).json({ error: "No se pudo crear la cuenta en este momento." });
    return;
  }
  res.json({ token: signToken(result.user.id), user: result.user });
});

app.post("/api/auth/login", async (req, res) => {
  if (!dbEnabled) {
    res.status(503).json({ error: accountsUnavailable });
    return;
  }
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  const user = await getUserByEmail(email);
  if (user && user.passwordHash === null) {
    res.status(401).json({ error: "Esa cuenta se creó con Google. Iniciá sesión con Google." });
    return;
  }
  // Same message whether the email is unknown or the password is wrong, so we
  // don't reveal which emails have accounts.
  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    res.status(401).json({ error: "Email o contraseña incorrectos." });
    return;
  }
  res.json({ token: signToken(user.id), user: { id: user.id, email: user.email, name: user.name } });
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  const user = await getUserById((req as AuthedRequest).userId!);
  if (!user) {
    res.status(401).json({ error: "Sesión inválida." });
    return;
  }
  res.json({ user });
});

// Basic account settings: rename and change password.
app.patch("/api/auth/me", requireAuth, async (req, res) => {
  const name = String(req.body?.name ?? "").trim().slice(0, 80);
  if (!name) {
    res.status(400).json({ error: "Ingresá tu nombre." });
    return;
  }
  await updateUserName((req as AuthedRequest).userId!, name);
  const user = await getUserById((req as AuthedRequest).userId!);
  res.json({ user });
});

app.post("/api/auth/change-password", requireAuth, async (req, res) => {
  const currentPassword = String(req.body?.currentPassword ?? "");
  const newPassword = String(req.body?.newPassword ?? "");
  if (newPassword.length < 8) {
    res.status(400).json({ error: "La nueva contraseña debe tener al menos 8 caracteres." });
    return;
  }
  const user = await getUserAuthById((req as AuthedRequest).userId!);
  if (!user) {
    res.status(401).json({ error: "Sesión inválida." });
    return;
  }
  if (!user.passwordHash) {
    res.status(400).json({ error: "Esta cuenta usa Google para iniciar sesión y no tiene contraseña." });
    return;
  }
  if (!verifyPassword(currentPassword, user.passwordHash)) {
    res.status(401).json({ error: "La contraseña actual no es correcta." });
    return;
  }
  await updateUserPasswordHash(user.id, hashPassword(newPassword));
  res.json({ ok: true });
});

// Lets the client show/hide "Continuar con Google" without guessing --
// enabled only once the server has real Google OAuth credentials configured.
app.get("/api/auth/config", (_req, res) => {
  res.json({ googleEnabled: googleAuthEnabled });
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
        // Same email already has a password account -- link Google to it
        // instead of failing on the duplicate-email constraint.
        await linkGoogleId(byEmail.id, profile.googleId);
        user = byEmail;
      } else {
        const created = await createUserWithGoogle(profile);
        user = { ...created, passwordHash: null, googleId: profile.googleId };
      }
    }
    // Token travels in the URL FRAGMENT, not a query param: fragments never
    // leave the browser, so the token can't end up in Vercel's request logs
    // or a Referer header on its way to the client.
    res.redirect(`${CLIENT_ORIGIN}/auth/google#token=${signToken(user.id)}`);
  } catch (err) {
    console.error("[google-auth] callback error:", err instanceof Error ? err.message : err);
    res.redirect(`${CLIENT_ORIGIN}/ingresar?googleError=1`);
  }
});

app.post("/api/translate", async (req, res) => {
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
app.post("/api/zoom/signature", (req, res) => {
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
app.post("/api/teams/token", async (_req, res) => {
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
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[teams] token error:", detail);
    res.status(502).json({ error: `No se pudo generar el acceso a Teams: ${detail}` });
  }
});

app.post("/api/explain-error", async (req, res) => {
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
  const meeting = await getMeetingDetailForUser(req.params.id, (req as AuthedRequest).userId!);
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
app.post("/api/meetings/:id/report", requireAuth, async (req, res) => {
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

app.post("/api/meetings/:id/recording-upload-url", async (req, res) => {
  if (!storageEnabled) {
    res.status(503).json({ error: "El almacenamiento de grabaciones no está configurado." });
    return;
  }
  // Only the two container types the recorder actually produces -- an
  // arbitrary contentType would let anyone store arbitrary files under a
  // presigned URL on our bucket.
  const rawType = typeof req.body?.contentType === "string" ? req.body.contentType : "video/webm";
  const contentType = rawType.startsWith("video/mp4") ? "video/mp4" : "video/webm";
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
app.post("/api/meetings/:id/recording-upload", async (req, res) => {
  if (!storageEnabled) {
    res.status(503).json({ error: "El almacenamiento de grabaciones no está configurado." });
    return;
  }
  const rawType = req.headers["content-type"] ?? "video/webm";
  const contentType = String(rawType).startsWith("video/mp4") ? "video/mp4" : "video/webm";
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

app.post("/api/meetings/:id/ask", requireAuth, async (req, res) => {
  const question = typeof req.body?.question === "string" ? req.body.question : "";
  const result = await answerFromMeeting(req.params.id, question, (req as AuthedRequest).userId!);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ answer: result.answer });
});

// Same idea as /api/meetings/:id/ask, but grounded across every saved
// meeting instead of one -- "what did I talk about on the 17th", "what was
// my last meeting about", etc.
app.post("/api/meetings/ask-all", requireAuth, async (req, res) => {
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

app.post("/api/meet-bridge/:meetId", (req, res) => {
  const meetId = String(req.params.meetId).toLowerCase();
  if (!MEET_CODE_RE.test(meetId)) {
    res.status(400).json({ error: "Código de Meet inválido." });
    return;
  }
  if (!allowMeetBridge(meetId)) {
    res.status(429).json({ error: "Demasiadas actualizaciones." });
    return;
  }
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
  io.to(`meeting:GOOGLE-MEET:${meetId.toUpperCase()}`).emit("meet-state", state);
  res.json({ ok: true });
});


httpServer.listen(PORT, () => {
  console.log(`Servidor de reuniones escuchando en el puerto ${PORT}`);
});
