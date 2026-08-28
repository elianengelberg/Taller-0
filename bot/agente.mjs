#!/usr/bin/env node
// El agente del host del bot: un oyente HTTP chiquito que corre EN el droplet
// y recibe los despachos del servidor de Unify. Hace falta porque el web
// service de Render no puede abrir un navegador -- el droplet sí. El servidor
// (con BOT_HOST_URL + BOT_HOST_SECRET) le reenvía los pedidos del botón
// "Que entre el bot por mí", y este agente lanza joinbot.mjs acá.
//
// Lo instala y lo deja corriendo (systemd) bot/instalar-host.sh. A mano:
//
//   BOT_HOST_SECRET=un-secreto-largo SERVER_URL=https://taller-0.onrender.com \
//   node bot/agente.mjs
//
// Endpoints (todos autenticados con la cabecera x-unify-secret, salvo /salud):
//   POST /despachar {url, roomKey, platform}  lanza el bot hacia esa reunión
//   POST /colgar    {roomKey}                 le pide al bot de esa sala que cuelgue
//   GET  /salud                               {ok, botsVivos}
import { createServer } from "http";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const SECRETO = process.env.BOT_HOST_SECRET || "";
const PUERTO = Number(process.env.BOT_AGENT_PORT) > 0 ? Number(process.env.BOT_AGENT_PORT) : 4790;
const SERVER_URL = (process.env.SERVER_URL || "https://taller-0.onrender.com").replace(/\/+$/, "");
const RAIZ = dirname(fileURLToPath(import.meta.url));

if (!SECRETO || SECRETO.length < 16) {
  console.error(
    "[agente] falta BOT_HOST_SECRET (mínimo 16 caracteres). Sin secreto, " +
      "cualquiera en internet podría mandarle bots a este host."
  );
  process.exit(2);
}

const vivos = new Map(); // roomKey -> proceso del bot

const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/salud") {
    json(res, 200, { ok: true, botsVivos: vivos.size });
    return;
  }
  if (req.headers["x-unify-secret"] !== SECRETO) {
    json(res, 401, { error: "Secreto inválido." });
    return;
  }
  let cuerpo = "";
  req.on("data", (d) => {
    cuerpo += d;
    if (cuerpo.length > 10_000) req.destroy();
  });
  req.on("end", () => {
    let datos = {};
    try {
      datos = JSON.parse(cuerpo || "{}");
    } catch {
      json(res, 400, { error: "JSON inválido." });
      return;
    }
    const roomKey = String(datos.roomKey || "").slice(0, 300);

    if (req.method === "POST" && req.url === "/despachar") {
      const url = String(datos.url || "").slice(0, 2000);
      const platform = String(datos.platform || "jitsi");
      const langCrudo = String(datos.lang || "").trim();
      const lang = /^[a-z]{2,3}(-[a-zA-Z]{2,4})?$/.test(langCrudo) ? langCrudo : "";
      if (!/^https?:\/\//.test(url) || !roomKey) {
        json(res, 400, { error: "Faltan url o roomKey." });
        return;
      }
      if (vivos.has(roomKey)) {
        json(res, 200, { ok: true, yaEstaba: true });
        return;
      }
      const hijo = spawn("node", [join(RAIZ, "joinbot.mjs")], {
        env: {
          ...process.env,
          MEETING_URL: url,
          ROOM_KEY: roomKey,
          SERVER_URL,
          PLATFORM: platform,
          BOT_NAME: process.env.BOT_NAME || "Unify Notetaker",
          // El oído del bot en el idioma de ESTA reunión (el que eligió
          // quien lo mandó), no en el default del host.
          ...(lang ? { BOT_LANG: lang } : {}),
        },
        // La salida del bot pasa por el agente: con el agente corriendo como
        // servicio, queda en journald (journalctl -u unify-bot-agent) y se
        // puede depurar una reunión real sin lanzar nada a mano.
        stdio: ["ignore", "inherit", "inherit"],
        detached: true,
      });
      vivos.set(roomKey, hijo);
      hijo.on("exit", () => vivos.delete(roomKey));
      console.log(`[agente] bot despachado -> ${platform} :: ${roomKey}`);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && req.url === "/colgar") {
      const hijo = vivos.get(roomKey);
      if (!hijo) {
        json(res, 200, { ok: false, message: "No hay un bot en esa sala." });
        return;
      }
      try {
        process.kill(-hijo.pid, "SIGTERM");
      } catch {
        try { hijo.kill("SIGTERM"); } catch { /* ya no está */ }
      }
      console.log(`[agente] colgar -> ${roomKey}`);
      json(res, 200, { ok: true });
      return;
    }

    json(res, 404, { error: "Ruta desconocida." });
  });
});

server.listen(PUERTO, () => {
  console.log(`[agente] escuchando en :${PUERTO} — los bots hablan con ${SERVER_URL}`);
});
