import cors from "cors";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { registerSocketHandlers } from "./socketHandlers";
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
