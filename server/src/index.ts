import cors from "cors";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { answerFromMeeting } from "./ai";
import { attachRecording, getMeetingDetail, listMeetings } from "./db";
import { registerSocketHandlers } from "./socketHandlers";
import { createRecordingUploadUrl, storageEnabled } from "./storage";
import { translateText } from "./translate";

const PORT = Number(process.env.PORT) || 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";

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
