import cors from "cors";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { answerFromMeeting } from "./ai";
import { attachRecording, getMeetingDetail, listMeetings } from "./db";
import { explainError } from "./explainError";
import { answerAcrossMeetings } from "./globalAi";
import { registerSocketHandlers } from "./socketHandlers";
import { createRecordingUploadUrl, storageEnabled } from "./storage";
import { translateText } from "./translate";
import { generateMeetingSdkSignature, zoomEnabled } from "./zoom";

const PORT = Number(process.env.PORT) || 4000;
// Trim a trailing slash: the browser's Origin header never has one (it's
// scheme+host+port only), so "https://x.vercel.app/" here would never match
// and silently break every REST request with a CORS error.
const CLIENT_ORIGIN = (process.env.CLIENT_ORIGIN || "http://localhost:5173").replace(/\/+$/, "");

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/translate", async (req, res) => {
  const { text, source, target } = req.body ?? {};
  if (typeof text !== "string" || typeof source !== "string" || typeof target !== "string") {
    res.status(400).json({ error: "text, source y target son obligatorios." });
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

app.post("/api/explain-error", async (req, res) => {
  const { error, context } = req.body ?? {};
  if (typeof error !== "string" || !error.trim()) {
    res.status(400).json({ error: "error es obligatorio." });
    return;
  }
  const explanation = await explainError(error, typeof context === "string" ? context : undefined);
  // Not an error response even when there's no explanation available (no
  // API key, or the call failed) -- callers are expected to fall back to
  // showing the raw error themselves in that case.
  res.json({ explanation });
});

// Past-meetings history: list, detail, recording upload, and the AI Q&A
// endpoint. All backed by Postgres (see db.ts) -- if DATABASE_URL isn't
// configured these quietly return empty results instead of erroring, so a
// deploy without the database doesn't break live video calls.
app.get("/api/meetings", async (_req, res) => {
  const meetings = await listMeetings();
  res.json({ meetings });
});

app.get("/api/meetings/:id", async (req, res) => {
  const meeting = await getMeetingDetail(req.params.id);
  if (!meeting) {
    res.status(404).json({ error: "No encontramos esa reunión." });
    return;
  }
  res.json({ meeting });
});

app.post("/api/meetings/:id/recording-upload-url", async (req, res) => {
  if (!storageEnabled) {
    res.status(503).json({ error: "El almacenamiento de grabaciones no está configurado." });
    return;
  }
  const contentType = typeof req.body?.contentType === "string" ? req.body.contentType : "video/webm";
  const target = await createRecordingUploadUrl(req.params.id, contentType);
  if (!target) {
    res.status(503).json({ error: "No se pudo preparar la subida de la grabación." });
    return;
  }
  res.json(target);
});

app.post("/api/meetings/:id/recording-complete", async (req, res) => {
  const { publicUrl } = req.body ?? {};
  if (typeof publicUrl !== "string" || !publicUrl) {
    res.status(400).json({ error: "publicUrl es obligatorio." });
    return;
  }
  await attachRecording(req.params.id, publicUrl);
  res.json({ ok: true });
});

app.post("/api/meetings/:id/ask", async (req, res) => {
  const question = typeof req.body?.question === "string" ? req.body.question : "";
  const result = await answerFromMeeting(req.params.id, question);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ answer: result.answer });
});

// Same idea as /api/meetings/:id/ask, but grounded across every saved
// meeting instead of one -- "what did I talk about on the 17th", "what was
// my last meeting about", etc.
app.post("/api/meetings/ask-all", async (req, res) => {
  const question = typeof req.body?.question === "string" ? req.body.question : "";
  const result = await answerAcrossMeetings(question);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ answer: result.answer });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: CLIENT_ORIGIN },
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

httpServer.listen(PORT, () => {
  console.log(`Servidor de reuniones escuchando en el puerto ${PORT}`);
});
