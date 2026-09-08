// Zoom Realtime Media Streams (RTMS): la reunión SIN bot.
//
// Zoom, cuando el anfitrión tiene la app de Unify autorizada, transmite la
// reunión a este servidor por WebSocket (transcripción en vivo, y si se pide,
// audio/video) y muestra a todos el aviso «El contenido de esta reunión se
// está compartiendo con una o más apps». No entra ningún participante extra.
//
// Cómo encaja: cada frase que llega se POSTea al MISMO puente que usan la
// extensión, la web y el bot (`/api/meet-bridge/:clave/transcript`), así que
// corrección con IA, traducción, historial, resumen, sala companion en vivo y
// analíticas salen gratis. Este módulo es "un par de oídos" más, como el bot.
//
// El protocolo (documentado por Zoom en developers.zoom.us/docs/rtms):
//   1. Webhook `meeting.rtms_started` → { meeting_uuid, rtms_stream_id, server_urls }.
//   2. WebSocket de SEÑALIZACIÓN a server_urls: SIGNALING_HAND_SHAKE_REQ (1)
//      con la firma HMAC-SHA256(secret, "clientId,meeting_uuid,rtms_stream_id").
//      La respuesta (2) trae las URLs del servidor de MEDIOS.
//   3. WebSocket de MEDIOS: DATA_HAND_SHAKE_REQ (3) con la misma firma y el
//      media_type pedido (8 = transcripción). Respuesta (4) → se avisa
//      CLIENT_READY_ACK (7) por la señalización y empiezan a llegar los datos:
//      MEDIA_DATA_TRANSCRIPT (17) con { user_name, data (texto), timestamp }.
//   4. Los dos sockets mandan KEEP_ALIVE_REQ (12) y esperan KEEP_ALIVE_RESP
//      (13) con el mismo timestamp; sin respuesta Zoom corta.
//   5. `meeting.rtms_stopped` (o STREAM_STATE_UPDATE terminado) → se cierra.
//
// Sin dependencias nativas a propósito: el SDK oficial (@zoom/rtms) descarga
// un binario C en el `npm install`, que en Render es frágil y acá no se puede
// probar. Con `ws` y este archivo, la suite (pruebas/sim_rtms.js) ejercita el
// protocolo entero contra un Zoom falso.
//
// Variables de entorno (Render):
//   ZOOM_RTMS_CLIENT_ID / ZOOM_RTMS_CLIENT_SECRET  la app General del
//       Marketplace con RTMS (si es la misma app del Meeting SDK, se reusan
//       ZOOM_SDK_KEY / ZOOM_SDK_SECRET)
//   ZOOM_WEBHOOK_SECRET_TOKEN  el «Secret Token» de la app (valida los webhooks)
//   ZOOM_RTMS_LANG             idioma que se etiqueta en las frases (default es-AR;
//       el servidor detecta el idioma REAL de cada frase igual)
//   ZOOM_S2S_ACCOUNT_ID / ZOOM_S2S_CLIENT_ID / ZOOM_S2S_CLIENT_SECRET  (opcional)
//       una app Server-to-Server OAuth: con ella el UUID de la reunión se
//       traduce al NÚMERO (la sala «zoom:<número>», la misma que abre la web
//       con el enlace) y al mail del anfitrión (la reunión queda A SU NOMBRE
//       en el historial).
//   ZOOM_RTMS_OWNER_EMAIL      (opcional) sin S2S, la cuenta de Unify dueña de
//       toda reunión que llegue por RTMS.
import crypto from "crypto";
import WebSocket from "ws";
import type { Request, Response } from "express";

export const MSG = {
  SIGNALING_HAND_SHAKE_REQ: 1,
  SIGNALING_HAND_SHAKE_RESP: 2,
  DATA_HAND_SHAKE_REQ: 3,
  DATA_HAND_SHAKE_RESP: 4,
  EVENT_SUBSCRIPTION: 5,
  EVENT_UPDATE: 6,
  CLIENT_READY_ACK: 7,
  STREAM_STATE_UPDATE: 8,
  SESSION_STATE_UPDATE: 9,
  KEEP_ALIVE_REQ: 12,
  KEEP_ALIVE_RESP: 13,
  MEDIA_DATA_AUDIO: 14,
  MEDIA_DATA_TRANSCRIPT: 17,
} as const;

export const MEDIA = { AUDIO: 1, VIDEO: 2, DESKSHARE: 4, TRANSCRIPT: 8, CHAT: 16, ALL: 32 } as const;

// Estados de STREAM_STATE_UPDATE / SESSION_STATE_UPDATE.
const ESTADO = { STARTED: 1, PAUSED: 2, RESUMED: 3, TERMINATED: 4 } as const;
// EVENT_UPDATE.event.event_type
const EVENTO = { ACTIVE_SPEAKER: 1, PARTICIPANT_JOIN: 2, PARTICIPANT_LEAVE: 3 } as const;

export interface ConfigRtms {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  lang: string;
  s2s: { accountId: string; clientId: string; clientSecret: string } | null;
  duenoPorDefecto: string;
  oauthBase: string;
  apiBase: string;
}

export function leerConfigRtms(env: NodeJS.ProcessEnv): ConfigRtms {
  const v = (k: string) => (env[k] ?? "").trim();
  const s2sAccount = v("ZOOM_S2S_ACCOUNT_ID");
  const s2sId = v("ZOOM_S2S_CLIENT_ID");
  const s2sSecret = v("ZOOM_S2S_CLIENT_SECRET");
  return {
    clientId: v("ZOOM_RTMS_CLIENT_ID") || v("ZOOM_SDK_KEY"),
    clientSecret: v("ZOOM_RTMS_CLIENT_SECRET") || v("ZOOM_SDK_SECRET"),
    webhookSecret: v("ZOOM_WEBHOOK_SECRET_TOKEN"),
    lang: v("ZOOM_RTMS_LANG") || "es-AR",
    s2s: s2sAccount && s2sId && s2sSecret ? { accountId: s2sAccount, clientId: s2sId, clientSecret: s2sSecret } : null,
    duenoPorDefecto: v("ZOOM_RTMS_OWNER_EMAIL").toLowerCase(),
    oauthBase: (v("ZOOM_OAUTH_BASE") || "https://zoom.us").replace(/\/+$/, ""),
    apiBase: (v("ZOOM_API_BASE") || "https://api.zoom.us").replace(/\/+$/, ""),
  };
}

const cfg = leerConfigRtms(process.env);
export const rtmsEnabled = Boolean(cfg.clientId && cfg.clientSecret && cfg.webhookSecret);

// Lo que este módulo necesita del resto del servidor, inyectado desde
// index.ts para no importar la mitad del servidor desde acá.
export interface GanchosRtms {
  /** El puerto propio: las frases viajan por el puente HTTP local. */
  puerto: () => number;
  /** La cuenta de Unify con ese mail (o null). */
  duenoPorEmail: (email: string) => Promise<string | null>;
  /** Deja la reunión de esa sala a nombre de la cuenta (reintenta un rato). */
  reclamarSala: (roomKey: string, userId: string) => Promise<void>;
}
let ganchos: GanchosRtms | null = null;
export function configurarRtms(g: GanchosRtms): void {
  ganchos = g;
}

const log = (...p: unknown[]) => console.log("[rtms]", ...p);
// undici envuelve el error real ("fetch failed") y la causa queda en `cause`.
const porQue = (e: unknown): string => {
  const err = e as { message?: string; cause?: { message?: string; code?: string } };
  const causa = err?.cause?.code || err?.cause?.message;
  return `${err?.message ?? String(e)}${causa ? ` (${causa})` : ""}`;
};

// ── Firmas ────────────────────────────────────────────────────────────────
export function firmaRtms(clientId: string, secret: string, meetingUuid: string, streamId: string): string {
  return crypto.createHmac("sha256", secret).update(`${clientId},${meetingUuid},${streamId}`).digest("hex");
}

export function firmaWebhook(secretToken: string, timestamp: string, cuerpoCrudo: string): string {
  return `v0=${crypto.createHmac("sha256", secretToken).update(`v0:${timestamp}:${cuerpoCrudo}`).digest("hex")}`;
}

export function tokenDeValidacion(secretToken: string, plainToken: string): string {
  return crypto.createHmac("sha256", secretToken).update(plainToken).digest("hex");
}

const TOLERANCIA_SEG = 300;
export function webhookAutentico(
  headers: Record<string, string | string[] | undefined>,
  cuerpoCrudo: string,
  secretToken: string,
  ahoraSeg = Math.floor(Date.now() / 1000)
): boolean {
  const ts = String(headers["x-zm-request-timestamp"] ?? "");
  const firma = String(headers["x-zm-signature"] ?? "");
  if (!/^\d{9,11}$/.test(ts) || !firma.startsWith("v0=")) return false;
  if (Math.abs(ahoraSeg - Number(ts)) > TOLERANCIA_SEG) return false;
  const esperada = firmaWebhook(secretToken, ts, cuerpoCrudo);
  const a = Buffer.from(firma);
  const b = Buffer.from(esperada);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// La sala del puente: con el número de reunión, la MISMA que abre la web con
// el enlace (así, quien tenga Unify al lado ve las frases en vivo). Sin él,
// una clave estable derivada del UUID.
export function claveDeSala(meetingUuid: string, numero?: string | null): string {
  const n = String(numero ?? "").replace(/\D/g, "");
  if (n.length >= 9) return `zoom:${n}`;
  return `zoom:rtms-${crypto.createHash("sha1").update(meetingUuid).digest("hex").slice(0, 16)}`;
}

// ── Zoom REST (opcional, Server-to-Server): UUID → número + anfitrión ──────
let tokenS2S: { valor: string; vence: number } = { valor: "", vence: 0 };
async function tokenServerToServer(): Promise<string | null> {
  if (!cfg.s2s) return null;
  if (tokenS2S.vence > Date.now() + 30_000) return tokenS2S.valor;
  try {
    const basic = Buffer.from(`${cfg.s2s.clientId}:${cfg.s2s.clientSecret}`).toString("base64");
    const r = await fetch(
      `${cfg.oauthBase}/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(cfg.s2s.accountId)}`,
      { method: "POST", headers: { Authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(10_000) }
    );
    if (!r.ok) {
      log(`token S2S rechazado: HTTP ${r.status}`);
      return null;
    }
    const j = (await r.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) return null;
    tokenS2S = { valor: j.access_token, vence: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
    return j.access_token;
  } catch (e) {
    log("token S2S:", porQue(e));
    return null;
  }
}

export interface ReunionZoom {
  id: string;
  topic: string;
  hostEmail: string;
}
async function reunionPorUuid(meetingUuid: string): Promise<ReunionZoom | null> {
  const token = await tokenServerToServer();
  if (!token) return null;
  try {
    // Zoom pide el UUID codificado DOS veces cuando trae "/" o "//".
    const id = encodeURIComponent(encodeURIComponent(meetingUuid));
    const r = await fetch(`${cfg.apiBase}/v2/meetings/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      log(`la reunión ${meetingUuid} no se pudo leer por la API: HTTP ${r.status}`);
      return null;
    }
    const j = (await r.json()) as { id?: number | string; topic?: string; host_email?: string };
    return { id: String(j.id ?? ""), topic: String(j.topic ?? ""), hostEmail: String(j.host_email ?? "").toLowerCase() };
  } catch (e) {
    log("API de Zoom:", porQue(e));
    return null;
  }
}

// ── La sesión: una reunión transmitida ────────────────────────────────────
type Fase = "conectando" | "adentro" | "pausada" | "cerrada" | "fallo";
const ESPERAS_RECONEXION_MS = [2_000, 5_000, 10_000, 20_000];

class SesionRtms {
  fase: Fase = "conectando";
  detalle = "";
  lineas = 0;
  desde = Date.now();
  private senal: WebSocket | null = null;
  private medios: WebSocket | null = null;
  private intentos = 0;
  private timerReconexion: NodeJS.Timeout | null = null;
  private participantes = new Map<string, string>();

  constructor(
    readonly meetingUuid: string,
    readonly streamId: string,
    readonly serverUrl: string,
    readonly roomKey: string,
    readonly etiqueta: string
  ) {}

  resumen() {
    return {
      meetingUuid: this.meetingUuid,
      streamId: this.streamId,
      roomKey: this.roomKey,
      etiqueta: this.etiqueta,
      fase: this.fase,
      detalle: this.detalle,
      lineas: this.lineas,
      participantes: [...this.participantes.values()],
      desde: this.desde,
    };
  }

  private firma(): string {
    return firmaRtms(cfg.clientId, cfg.clientSecret, this.meetingUuid, this.streamId);
  }

  async arrancar(): Promise<void> {
    await this.alPuente("", {
      inCall: false,
      participantCount: 0,
      botFase: "abriendo",
      botDetalle: "Zoom está por transmitir la reunión (sin bot).",
    });
    this.conectar();
  }

  private conectar(): void {
    this.cerrarSockets();
    if (this.fase === "cerrada" || this.fase === "fallo") return;
    log(`señalización → ${this.serverUrl} (intento ${this.intentos + 1})`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.serverUrl);
    } catch (e) {
      this.reconectar(`no se pudo abrir la señalización: ${(e as Error).message}`);
      return;
    }
    this.senal = ws;
    ws.on("open", () => {
      this.enviar(ws, {
        msg_type: MSG.SIGNALING_HAND_SHAKE_REQ,
        protocol_version: 1,
        sequence: 0,
        meeting_uuid: this.meetingUuid,
        rtms_stream_id: this.streamId,
        signature: this.firma(),
      });
    });
    ws.on("message", (raw) => this.enSenal(parsear(raw)));
    ws.on("error", (e) => log("señalización:", e.message));
    ws.on("close", (code) => {
      if (this.senal === ws) this.senal = null;
      this.reconectar(`la señalización se cerró (${code})`);
    });
  }

  private enSenal(m: Mensaje | null): void {
    if (!m || !this.senal) return;
    switch (m.msg_type) {
      case MSG.SIGNALING_HAND_SHAKE_RESP: {
        if (m.status_code === 0) {
          const urls = (m.media_server as { server_urls?: Record<string, string> } | undefined)?.server_urls ?? {};
          const url = urls.all || urls.transcript || urls.audio || "";
          if (!url) {
            this.fallar("Zoom no informó el servidor de medios.");
            return;
          }
          // Quién entra y sale, para el contador de la sala.
          this.enviar(this.senal, {
            msg_type: MSG.EVENT_SUBSCRIPTION,
            events: [
              { event_type: EVENTO.PARTICIPANT_JOIN, subscribe: true },
              { event_type: EVENTO.PARTICIPANT_LEAVE, subscribe: true },
            ],
          });
          this.conectarMedios(url);
        } else {
          this.fallar(`Zoom rechazó la señalización: ${m.reason ?? `código ${m.status_code}`}`);
        }
        return;
      }
      case MSG.KEEP_ALIVE_REQ:
        this.enviar(this.senal, { msg_type: MSG.KEEP_ALIVE_RESP, timestamp: m.timestamp });
        return;
      case MSG.STREAM_STATE_UPDATE:
      case MSG.SESSION_STATE_UPDATE:
        this.cambioDeEstado(Number(m.state), String(m.reason ?? ""));
        return;
      case MSG.EVENT_UPDATE:
        this.evento(m.event as Record<string, unknown> | undefined);
        return;
      default:
        return;
    }
  }

  private conectarMedios(url: string): void {
    log(`medios → ${url}`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.reconectar(`no se pudo abrir el servidor de medios: ${(e as Error).message}`);
      return;
    }
    this.medios = ws;
    ws.on("open", () => {
      this.enviar(ws, {
        msg_type: MSG.DATA_HAND_SHAKE_REQ,
        protocol_version: 1,
        sequence: 0,
        meeting_uuid: this.meetingUuid,
        rtms_stream_id: this.streamId,
        signature: this.firma(),
        media_type: MEDIA.TRANSCRIPT,
        payload_encryption: false,
      });
    });
    ws.on("message", (raw) => this.enMedios(parsear(raw)));
    ws.on("error", (e) => log("medios:", e.message));
    ws.on("close", (code) => {
      if (this.medios === ws) this.medios = null;
      this.reconectar(`el servidor de medios se cerró (${code})`);
    });
  }

  private enMedios(m: Mensaje | null): void {
    if (!m || !this.medios) return;
    switch (m.msg_type) {
      case MSG.DATA_HAND_SHAKE_RESP: {
        if (m.status_code === 0) {
          if (this.senal) this.enviar(this.senal, { msg_type: MSG.CLIENT_READY_ACK, rtms_stream_id: this.streamId });
          this.intentos = 0;
          this.fase = "adentro";
          this.detalle = "";
          log(`adentro: ${this.etiqueta} → sala ${this.roomKey}`);
          void this.alPuente("", { inCall: true, participantCount: Math.max(2, this.participantes.size), botFase: "adentro" });
        } else {
          this.fallar(`Zoom rechazó el pedido de medios: ${m.reason ?? `código ${m.status_code}`}`);
        }
        return;
      }
      case MSG.KEEP_ALIVE_REQ:
        this.enviar(this.medios, { msg_type: MSG.KEEP_ALIVE_RESP, timestamp: m.timestamp });
        return;
      case MSG.MEDIA_DATA_TRANSCRIPT:
        this.transcripcion(m.content as Record<string, unknown> | undefined);
        return;
      case MSG.STREAM_STATE_UPDATE:
        this.cambioDeEstado(Number(m.state), String(m.reason ?? ""));
        return;
      default:
        return; // audio/video: no se pidieron; cualquier otra cosa se ignora
    }
  }

  private transcripcion(c: Record<string, unknown> | undefined): void {
    const texto = String(c?.data ?? "").trim();
    if (!texto) return;
    const quien = String(c?.user_name ?? "").trim().slice(0, 60) || "Participante";
    this.lineas++;
    void this.alPuente("/transcript", { speaker: quien, text: texto.slice(0, 2000), lang: cfg.lang });
  }

  private evento(ev: Record<string, unknown> | undefined): void {
    if (!ev) return;
    const tipo = Number(ev.event_type);
    const lista = Array.isArray(ev.participants) ? (ev.participants as Array<Record<string, unknown>>) : [];
    let cambio = false;
    for (const p of lista) {
      const id = String(p.user_id ?? p.user_name ?? "");
      const nombre = String(p.user_name ?? "").trim().slice(0, 60);
      if (!id) continue;
      if (tipo === EVENTO.PARTICIPANT_JOIN && nombre) {
        this.participantes.set(id, nombre);
        cambio = true;
      } else if (tipo === EVENTO.PARTICIPANT_LEAVE) {
        cambio = this.participantes.delete(id) || cambio;
      }
    }
    if (cambio && this.fase === "adentro") {
      void this.alPuente("", {
        inCall: true,
        participantCount: Math.max(1, this.participantes.size),
        participants: [...this.participantes.values()].slice(0, 100),
      });
    }
  }

  private cambioDeEstado(estado: number, motivo: string): void {
    if (estado === ESTADO.TERMINATED) {
      void this.detener(motivo ? `Zoom terminó la transmisión: ${motivo}` : "Zoom terminó la transmisión");
    } else if (estado === ESTADO.PAUSED) {
      this.fase = "pausada";
      this.detalle = motivo;
    } else if (estado === ESTADO.RESUMED && this.fase === "pausada") {
      this.fase = "adentro";
      this.detalle = "";
    }
  }

  private reconectar(motivo: string): void {
    if (this.fase === "cerrada" || this.fase === "fallo" || this.timerReconexion) return;
    if (this.intentos >= ESPERAS_RECONEXION_MS.length) {
      this.fallar(`se cortó la conexión con Zoom y no volvió (${motivo}).`);
      return;
    }
    const espera = ESPERAS_RECONEXION_MS[this.intentos++];
    log(`${motivo}; reintento en ${espera / 1000} s`);
    this.fase = "conectando";
    this.timerReconexion = setTimeout(() => {
      this.timerReconexion = null;
      this.conectar();
    }, espera);
  }

  private fallar(motivo: string): void {
    if (this.fase === "cerrada" || this.fase === "fallo") return;
    this.fase = "fallo";
    this.detalle = motivo;
    log(`FALLÓ ${this.etiqueta}: ${motivo}`);
    this.cerrarSockets();
    void this.alPuente("", { inCall: false, participantCount: 0, botFase: "fallo", botDetalle: motivo });
    sesiones.delete(this.streamId);
  }

  async detener(motivo: string): Promise<void> {
    if (this.fase === "cerrada") return;
    this.fase = "cerrada";
    this.detalle = motivo;
    log(`cierre ${this.etiqueta}: ${motivo} (${this.lineas} frases)`);
    if (this.timerReconexion) {
      clearTimeout(this.timerReconexion);
      this.timerReconexion = null;
    }
    this.cerrarSockets();
    sesiones.delete(this.streamId);
    await this.alPuente("", { inCall: false, participantCount: 0 });
  }

  private cerrarSockets(): void {
    for (const ws of [this.senal, this.medios]) {
      try {
        ws?.removeAllListeners("close");
        ws?.close();
      } catch {
        /* ya cerrado */
      }
    }
    this.senal = null;
    this.medios = null;
  }

  private enviar(ws: WebSocket, mensaje: Record<string, unknown>): void {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(mensaje));
    } catch (e) {
      log("no se pudo enviar:", (e as Error).message);
    }
  }

  private async alPuente(camino: "" | "/transcript", cuerpo: Record<string, unknown>): Promise<void> {
    const puerto = ganchos?.puerto() ?? Number(process.env.PORT || 4001);
    try {
      await fetch(`http://127.0.0.1:${puerto}/api/meet-bridge/${encodeURIComponent(this.roomKey)}${camino}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      log("puente:", porQue(e));
    }
  }
}

type Mensaje = { msg_type?: number; [k: string]: unknown };
function parsear(raw: WebSocket.RawData): Mensaje | null {
  try {
    const m = JSON.parse(raw.toString()) as Mensaje;
    return m && typeof m === "object" ? m : null;
  } catch {
    return null;
  }
}

const sesiones = new Map<string, SesionRtms>();

async function iniciarSesion(payload: Record<string, unknown>): Promise<void> {
  const meetingUuid = String(payload.meeting_uuid ?? "").trim();
  const streamId = String(payload.rtms_stream_id ?? "").trim();
  const serverUrl = String(payload.server_urls ?? "").trim();
  if (!meetingUuid || !streamId || !/^wss?:\/\//.test(serverUrl)) {
    log("webhook rtms_started incompleto:", JSON.stringify(payload).slice(0, 200));
    return;
  }
  // Zoom reintenta el webhook si tarda la respuesta: un stream, una sesión.
  if (sesiones.has(streamId)) return;

  const info = await reunionPorUuid(meetingUuid);
  const roomKey = claveDeSala(meetingUuid, info?.id);
  const etiqueta = info?.topic ? `Zoom · ${info.topic}` : info?.id ? `Zoom · ${info.id}` : "Zoom";
  const sesion = new SesionRtms(meetingUuid, streamId, serverUrl, roomKey, etiqueta);
  sesiones.set(streamId, sesion);
  await sesion.arrancar();

  // La reunión, a nombre de quien corresponde: el anfitrión (por S2S) o la
  // cuenta configurada. Sin dueño se ve en vivo pero no en ningún historial.
  const email = info?.hostEmail || cfg.duenoPorDefecto;
  if (email && ganchos) {
    const userId = await ganchos.duenoPorEmail(email).catch(() => null);
    if (userId) void ganchos.reclamarSala(roomKey, userId);
    else log(`sin cuenta de Unify para ${email}: la reunión queda sin dueño`);
  }
}

function detenerPorStream(streamId: string, motivo: string): void {
  const s = sesiones.get(String(streamId ?? ""));
  if (s) void s.detener(motivo);
}

// ── El webhook de Zoom ────────────────────────────────────────────────────
// Ruta: POST /api/zoom/webhook. Zoom exige contestar en menos de 3 s, así que
// se responde primero y el trabajo sigue aparte.
export function manejarWebhookZoom(req: Request & { rawBody?: string }, res: Response): void {
  if (!rtmsEnabled) {
    res.status(503).json({
      error:
        "Zoom RTMS no está configurado en este servidor (faltan ZOOM_RTMS_CLIENT_ID, ZOOM_RTMS_CLIENT_SECRET o ZOOM_WEBHOOK_SECRET_TOKEN).",
    });
    return;
  }
  const body = (req.body ?? {}) as { event?: string; payload?: Record<string, unknown> };
  // El reto de validación de la URL (al guardar el webhook en el Marketplace).
  if (body.event === "endpoint.url_validation") {
    log("webhook: Zoom valida la URL");
    const plain = String(body.payload?.plainToken ?? "");
    if (!plain) {
      res.status(400).json({ error: "Falta plainToken." });
      return;
    }
    res.json({ plainToken: plain, encryptedToken: tokenDeValidacion(cfg.webhookSecret, plain) });
    return;
  }
  const crudo = req.rawBody ?? JSON.stringify(req.body ?? {});
  if (!webhookAutentico(req.headers as Record<string, string | string[] | undefined>, crudo, cfg.webhookSecret)) {
    // Diagnóstico honesto: distinguir "Zoom nunca llamó" de "llamó y la firma
    // no cerró" (secret token distinto al de la app, o reloj corrido).
    log(`webhook ${body.event ?? "(sin evento)"} RECHAZADO: la firma no cierra (¿ZOOM_WEBHOOK_SECRET_TOKEN es el Secret Token de ESTA app?) ts=${String(req.headers["x-zm-request-timestamp"] ?? "-")}`);
    res.status(401).json({ error: "La firma del webhook no es de Zoom." });
    return;
  }
  const payload = ((body.payload as { object?: Record<string, unknown> } | undefined)?.object ??
    body.payload ??
    {}) as Record<string, unknown>;
  log(`webhook ${body.event ?? "(sin evento)"} stream=${String(payload.rtms_stream_id ?? "-")} reunión=${String(payload.meeting_uuid ?? "-")}`);
  switch (body.event) {
    case "meeting.rtms_started":
      res.json({ ok: true });
      void iniciarSesion(payload);
      return;
    case "meeting.rtms_stopped":
      res.json({ ok: true });
      detenerPorStream(String(payload.rtms_stream_id ?? ""), "Zoom avisó que la transmisión terminó");
      return;
    default:
      res.json({ ok: true, ignorado: body.event ?? "" });
  }
}

export function estadoRtms() {
  return {
    habilitado: rtmsEnabled,
    conNumeroYAnfitrion: Boolean(cfg.s2s),
    duenoPorDefecto: cfg.duenoPorDefecto || null,
    sesiones: [...sesiones.values()].map((s) => s.resumen()),
  };
}

export async function apagarRtms(motivo = "el servidor se apaga"): Promise<void> {
  await Promise.all([...sesiones.values()].map((s) => s.detener(motivo)));
}
