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
  /** El id de usuario de Zoom del anfitrión (para arrancar RTMS a su nombre). */
  hostId: string;
  /** La contraseña en texto (la que el SDK web sí acepta), si la reunión tiene. */
  password: string;
}
// Lee una reunión de la cuenta por su UUID (lo que trae el webhook) o por su
// número (lo que trae un enlace). Sólo con la app Server-to-Server.
async function leerReunion(idOUuid: string): Promise<ReunionZoom | null> {
  const token = await tokenServerToServer();
  if (!token) return null;
  try {
    // Zoom pide el UUID codificado DOS veces cuando trae "/" o "//".
    const id = encodeURIComponent(encodeURIComponent(idOUuid));
    const r = await fetch(`${cfg.apiBase}/v2/meetings/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      log(`la reunión ${idOUuid} no se pudo leer por la API: HTTP ${r.status}`);
      return null;
    }
    const j = (await r.json()) as {
      id?: number | string;
      topic?: string;
      host_email?: string;
      host_id?: string;
      password?: string;
    };
    return {
      id: String(j.id ?? ""),
      topic: String(j.topic ?? ""),
      hostEmail: String(j.host_email ?? "").toLowerCase(),
      hostId: String(j.host_id ?? "").trim(),
      password: String(j.password ?? "").trim(),
    };
  } catch (e) {
    log("API de Zoom:", porQue(e));
    return null;
  }
}
const reunionPorUuid = leerReunion;
/** La reunión por su número (para la contraseña real al unirse desde la web). */
export function reunionPorNumero(numero: string): Promise<ReunionZoom | null> {
  const n = String(numero ?? "").replace(/\D/g, "");
  return n.length >= 9 ? leerReunion(n) : Promise.resolve(null);
}

// ── Pedirle a Zoom que arranque la transmisión YA (Server-to-Server) ──────
// PATCH /v2/live_meetings/{número}/rtms_app/status con action "start" y, en
// settings, el client_id de la app de RTMS y el user id del anfitrión (a
// nombre de quien arranca). Scope de la app S2S:
// meeting:update:participant_rtms_app_status:admin. Si Zoom dice que no, el
// motivo se devuelve TAL CUAL (el código 2310 «Failed to perform RTMS app
// operation» es el clásico "Zoom todavía no habilitó RTMS para esta app").
export type RespuestaArranque = { ok: true } | { ok: false; motivo: string; codigo: number | null };
async function arrancarPorApi(numero: string, hostId: string): Promise<RespuestaArranque> {
  const token = await tokenServerToServer();
  if (!token) return { ok: false, motivo: "no hay app Server-to-Server configurada", codigo: null };
  try {
    const r = await fetch(`${cfg.apiBase}/v2/live_meetings/${encodeURIComponent(numero)}/rtms_app/status`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start", settings: { client_id: cfg.clientId, participant_user_id: hostId } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) {
      log(`arranque por API de la reunión ${numero}: Zoom aceptó (HTTP ${r.status})`);
      return { ok: true };
    }
    const j = (await r.json().catch(() => ({}))) as { code?: number; message?: string };
    const codigo = typeof j.code === "number" ? j.code : null;
    const motivo = `Zoom contestó HTTP ${r.status}${codigo !== null ? ` (código ${codigo})` : ""}${j.message ? `: ${String(j.message).slice(0, 200)}` : ""}`;
    log(`arranque por API de la reunión ${numero}: ${motivo}`);
    return { ok: false, motivo, codigo };
  } catch (e) {
    const motivo = `no se pudo hablar con la API de Zoom (${porQue(e)})`;
    log(`arranque por API de la reunión ${numero}: ${motivo}`);
    return { ok: false, motivo, codigo: null };
  }
}

// ── El puente local: por acá entran las frases y el estado a la sala ──────
async function publicarEnPuente(roomKey: string, camino: "" | "/transcript", cuerpo: Record<string, unknown>): Promise<void> {
  const puerto = ganchos?.puerto() ?? Number(process.env.PORT || 4001);
  try {
    await fetch(`http://127.0.0.1:${puerto}/api/meet-bridge/${encodeURIComponent(roomKey)}${camino}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    log("puente:", porQue(e));
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
    public roomKey: string,
    readonly etiqueta: string
  ) {}

  viva(): boolean {
    return this.fase !== "cerrada" && this.fase !== "fallo";
  }

  // Cambiar de sala EN VIVO: pasa cuando Zoom transmitió una reunión cuyo
  // número no se pudo saber (sin app Server-to-Server la sala es un hash) y
  // recién después alguien tocó «que Unify escuche» desde la sala con número.
  // La sala vieja se cierra prolija; las frases que vienen van a la nueva.
  async reasignar(roomKey: string): Promise<void> {
    const anterior = this.roomKey;
    if (anterior === roomKey) return;
    log(`${this.etiqueta}: la sala pasa de ${anterior} a ${roomKey}`);
    await publicarEnPuente(anterior, "", { inCall: false, participantCount: 0 });
    this.roomKey = roomKey;
    await this.alPuente("", {
      inCall: this.fase === "adentro",
      participantCount: this.fase === "adentro" ? Math.max(2, this.participantes.size) : 0,
      participants: [...this.participantes.values()].slice(0, 100),
      botFase: this.fase === "adentro" ? "adentro" : "abriendo",
      botDetalle: this.fase === "adentro" ? null : "Zoom está por transmitir la reunión (sin bot).",
    });
  }

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

  private alPuente(camino: "" | "/transcript", cuerpo: Record<string, unknown>): Promise<void> {
    return publicarEnPuente(this.roomKey, camino, cuerpo);
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

// ── «Que Unify escuche por mí»: la versión sin participante del bot ───────
// Quien toca el botón desde la sala «zoom:<número>» deja una ESPERA: cuando
// Zoom avise que esa reunión se transmite, la transmisión cae en ESA sala y
// la reunión queda a su nombre. Sin app Server-to-Server el webhook no trae
// el número: si hay UNA sola espera, es esa reunión (una cuenta chica no
// tiene dos anfitriones esperando a la vez; si los hubiera, se avisa en el
// log y la transmisión cae en su sala por hash, como siempre).
interface Espera {
  roomKey: string;
  numero: string;
  userId: string;
  desde: number;
}
const esperas = new Map<string, Espera>();
const ESPERA_MAX_MS = 6 * 60 * 60 * 1000;
function limpiarEsperas(): void {
  for (const [k, e] of esperas) if (Date.now() - e.desde > ESPERA_MAX_MS) esperas.delete(k);
}
function tomarEspera(numero: string | null | undefined): Espera | null {
  limpiarEsperas();
  const n = String(numero ?? "").replace(/\D/g, "");
  if (n.length >= 9) {
    const e = esperas.get(`zoom:${n}`) ?? null;
    if (e) esperas.delete(e.roomKey);
    return e;
  }
  if (esperas.size === 1) {
    const e = [...esperas.values()][0];
    esperas.delete(e.roomKey);
    return e;
  }
  if (esperas.size > 1) log(`hay ${esperas.size} esperas y el webhook no trae número: no se puede saber cuál es (falta la app Server-to-Server)`);
  return null;
}
// La misma reunión (mismo UUID) puede transmitirse de nuevo (Zoom corta y
// vuelve a avisar): se queda en la sala que ya tenía.
const salasPorUuid = new Map<string, { roomKey: string; userId: string | null }>();

const MENSAJE_ESPERANDO =
  "Cuando la reunión empiece, Zoom se la transmite a Unify sin ningún participante extra. Hace falta que seas el anfitrión y que la app de Unify esté autorizada en tu Zoom, con el auto-inicio encendido.";

export type ResultadoEscucha =
  | { ok: true; estado: "escuchando" | "arrancando" | "esperando"; message: string; aviso: string | null }
  | { ok: false; status: number; error: string };

export async function escucharSinBot(args: { numero: string; roomKey: string; userId: string }): Promise<ResultadoEscucha> {
  if (!rtmsEnabled) {
    return {
      ok: false,
      status: 503,
      error: "Zoom sin bot no está configurado en este servidor (faltan las variables ZOOM_RTMS_*).",
    };
  }
  const { numero, roomKey, userId } = args;
  // La reunión es de quien pidió escuchar (no pisa a un dueño anterior).
  if (ganchos) void ganchos.reclamarSala(roomKey, userId).catch(() => undefined);

  // 1. Esa reunión ya se está transmitiendo a esta sala.
  const viva = [...sesiones.values()].find((s) => s.roomKey === roomKey && s.viva());
  if (viva) {
    return {
      ok: true,
      estado: "escuchando",
      message: "Unify ya está escuchando esta reunión, sin aparecer como participante.",
      aviso: null,
    };
  }
  // 2. Hay una transmisión en curso cuyo número no se supo (sala por hash):
  //    si es la única, es esta reunión, y pasa a esta sala en vivo.
  const sinNumero = [...sesiones.values()].filter((s) => s.viva() && s.roomKey.startsWith("zoom:rtms-"));
  if (sinNumero.length === 1) {
    await sinNumero[0].reasignar(roomKey);
    salasPorUuid.set(sinNumero[0].meetingUuid, { roomKey, userId });
    return {
      ok: true,
      estado: "escuchando",
      message: "Unify ya estaba escuchando una reunión de Zoom en curso: ahora cae en esta sala, sin participante extra.",
      aviso: null,
    };
  }
  // 3. Queda la espera; y si hay app Server-to-Server, se le pide a Zoom que
  //    arranque ya (si la reunión ya empezó) en vez de esperar al auto-inicio.
  limpiarEsperas();
  if (esperas.size >= 200) {
    const primera = esperas.keys().next().value;
    if (primera !== undefined) esperas.delete(primera);
  }
  esperas.set(roomKey, { roomKey, numero, userId, desde: Date.now() });
  await publicarEnPuente(roomKey, "", {
    inCall: false,
    participantCount: 0,
    botFase: "esperando-zoom",
    botDetalle: "Esperando que Zoom transmita la reunión (sin participante extra).",
  });
  if (!cfg.s2s) return { ok: true, estado: "esperando", message: MENSAJE_ESPERANDO, aviso: null };
  const info = await leerReunion(numero);
  if (!info) {
    return {
      ok: true,
      estado: "esperando",
      message: MENSAJE_ESPERANDO,
      aviso: "Zoom no dejó leer esa reunión con la cuenta de Unify: si es de otra cuenta, Zoom no la va a transmitir.",
    };
  }
  if (!info.hostId) return { ok: true, estado: "esperando", message: MENSAJE_ESPERANDO, aviso: null };
  const r = await arrancarPorApi(numero, info.hostId);
  if (r.ok) {
    return {
      ok: true,
      estado: "arrancando",
      message: "Zoom está arrancando la transmisión a Unify. Nadie ve un participante extra.",
      aviso: null,
    };
  }
  return {
    ok: true,
    estado: "esperando",
    message: MENSAJE_ESPERANDO,
    aviso:
      `No se pudo arrancar desde acá: ${r.motivo}.` +
      (r.codigo === 2310
        ? " Ese código es de Zoom cuando todavía no habilitó RTMS para la app: hay que pedirlo en el Marketplace (soporte de desarrolladores) con el Client ID."
        : " Si la reunión ya empezó y el auto-inicio está encendido, Zoom avisa sola."),
  };
}

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
  // La sala: la que ya tenía esta reunión, la de quien pidió escucharla, o
  // la de siempre (número si se sabe, hash si no).
  const previa = salasPorUuid.get(meetingUuid) ?? null;
  const espera = previa ? null : tomarEspera(info?.id);
  const roomKey = previa?.roomKey ?? espera?.roomKey ?? claveDeSala(meetingUuid, info?.id);
  const etiqueta = info?.topic ? `Zoom · ${info.topic}` : info?.id ? `Zoom · ${info.id}` : "Zoom";
  if (espera) log(`la transmisión ${etiqueta} cae en la sala ${roomKey}: la pidió la cuenta ${espera.userId.slice(0, 8)}…`);
  if (salasPorUuid.size >= 500) {
    const primera = salasPorUuid.keys().next().value;
    if (primera !== undefined) salasPorUuid.delete(primera);
  }
  salasPorUuid.set(meetingUuid, { roomKey, userId: espera?.userId ?? previa?.userId ?? null });
  const sesion = new SesionRtms(meetingUuid, streamId, serverUrl, roomKey, etiqueta);
  sesiones.set(streamId, sesion);
  await sesion.arrancar();

  // La reunión, a nombre de quien corresponde: quien pidió escucharla, el
  // anfitrión (por S2S) o la cuenta configurada. Sin dueño se ve en vivo
  // pero no en ningún historial.
  const pedida = espera?.userId ?? previa?.userId ?? null;
  if (pedida && ganchos) void ganchos.reclamarSala(roomKey, pedida).catch(() => undefined);
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
    // Quiénes tocaron «que Unify escuche» y todavía esperan que Zoom avise.
    esperas: [...esperas.values()].map((e) => ({ roomKey: e.roomKey, numero: e.numero, desde: e.desde })),
  };
}

export async function apagarRtms(motivo = "el servidor se apaga"): Promise<void> {
  await Promise.all([...sesiones.values()].map((s) => s.detener(motivo)));
}
