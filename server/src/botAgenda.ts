// El piloto automático del bot: mira el calendario de cada persona que lo
// activó y, cuando una reunión con link está por empezar, manda el bot solo.
// La persona no toca nada -- conecta el calendario UNA vez y listo.
//
// Fuentes de calendario (se combinan):
//  - Outlook/365, si conectó su cuenta (ya existía para el panel de próximas).
//  - La dirección iCal secreta de Google Calendar (una URL .ics que Google da
//    en "Configuración del calendario -> Dirección secreta en formato iCal").
//    Es el camino sin pedir permisos de Google ni pantalla de revisión.
//
// El bot se despacha por la MISMA función que usa el botón de la web
// (despacharBot, inyectada desde index.ts), así la reunión queda a nombre de
// la persona y con video+transcripción+resumen, idéntica a las demás.

import {
  listBotAgendaUsers,
  tryMarkBotDispatch,
  getMsRefreshToken,
  setMsRefreshToken,
} from "./db.js";
import { refreshAccessToken, fetchUpcomingEvents, microsoftEnabled, type CalendarEvent } from "./microsoftAuth.js";

// Una reunión candidata, ya normalizada desde cualquier fuente.
export interface EventoAgenda {
  /** Clave estable del evento (para no despacharlo dos veces). */
  key: string;
  subject: string;
  startMs: number;
  joinUrl: string;
}

// --- Derivación URL -> plataforma + clave de sala --------------------------
// ESPEJO EXACTO de bot/lanzar.mjs y de detectMeetingPlatform en la web: el bot
// y la gente tienen que caer en la MISMA sala. Si cambia una, cambian las dos.
export function derivarSala(raw: string): { platform: string; roomKey: string; url: string } | null {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();

  if (host === "zoom.us" || host.endsWith(".zoom.us")) {
    const id = url.pathname
      .replace(/(\d)[\s-](?=\d)/g, "$1")
      .match(/\/(?:j|w|wc)\/(?:join\/)?(\d{9,11})/)?.[1];
    if (!id) return null;
    return { platform: "zoom-web", roomKey: `zoom:${id}`, url: url.toString() };
  }
  if (host === "meet.google.com") {
    const code = url.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/i)?.[1]?.toLowerCase();
    if (!code) return null;
    return { platform: "google-meet", roomKey: `google-meet:${code}`, url: `https://meet.google.com/${code}` };
  }
  const esJitsi =
    host === "meet.jit.si" || host === "8x8.vc" || host.endsWith(".8x8.vc") || /(^|\.)jitsi\./.test(host);
  if (esJitsi) {
    const seg = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    const take = host === "8x8.vc" || host.endsWith(".8x8.vc") ? 2 : 1;
    const crudo = seg.slice(0, take).join("/");
    if (!crudo) return null;
    let sala = crudo;
    try { sala = decodeURIComponent(crudo); } catch { /* queda como vino */ }
    return { platform: "jitsi", roomKey: `jitsi:${host}/${sala.toLowerCase()}`, url: url.toString() };
  }
  // Teams se puede acompañar pero el bot no lo entra por navegador de forma
  // confiable todavía -- se omite del piloto automático (no derivamos sala).
  return null;
}

// --- Parser ICS (mínimo, suficiente para calendarios reales) ---------------
// No traemos una librería: un .ics es texto plano y sólo necesitamos VEVENTs
// con su inicio y su link. Contempla lo que aparece de verdad: líneas
// plegadas, DTSTART con Z / con TZID / fecha suelta, y repeticiones simples
// (RRULE diaria/semanal con EXDATE), que es la mayoría de las reuniones.

function desplegar(texto: string): string[] {
  // RFC 5545: una línea que sigue a otra y empieza con espacio/tab es
  // continuación de la anterior.
  const crudas = texto.replace(/\r\n/g, "\n").split("\n");
  const salida: string[] = [];
  for (const linea of crudas) {
    if ((linea.startsWith(" ") || linea.startsWith("\t")) && salida.length) {
      salida[salida.length - 1] += linea.slice(1);
    } else {
      salida.push(linea);
    }
  }
  return salida;
}

// Convierte un valor DTSTART a epoch ms. Soporta:
//  20260826T140000Z         (UTC)
//  20260826T140000          (hora local del TZID, resuelta con Intl)
//  20260826                 (fecha suelta -> medianoche UTC)
function fechaAEpoch(valor: string, tzid: string | null): number | null {
  const m = valor.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh = "0", mm = "0", ss = "0", z] = m;
  if (z || !m[4]) {
    // UTC explícito, o fecha suelta: Date.UTC directo.
    return Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss);
  }
  if (!tzid) {
    // Sin zona: lo tratamos como UTC (mejor eso que fallar; el desfasaje real
    // lo tienen muy pocos calendarios y el poller igual dispara por ventana).
    return Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss);
  }
  // Con TZID: averiguamos el offset de esa zona en ese instante y lo aplicamos.
  const comoUtc = Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss);
  const offset = offsetDeZona(tzid, comoUtc);
  return comoUtc - offset;
}

// Offset (ms) de una zona IANA en un instante dado, vía Intl (sin librerías).
function offsetDeZona(tzid: string, instante: number): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tzid,
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p = Object.fromEntries(dtf.formatToParts(new Date(instante)).map((x) => [x.type, x.value]));
    const comoSiFueraUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return comoSiFueraUtc - instante;
  } catch {
    return 0; // TZID desconocido -> sin offset
  }
}

const JOIN_RES: { re: RegExp }[] = [
  { re: /https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i },
  { re: /https:\/\/[\w.-]*zoom\.us\/(?:j|w|wc)\/(?:join\/)?\d[\d\s-]{7,}[^\s"'<>]*/i },
  { re: /https:\/\/meet\.jit\.si\/[^\s"'<>]+/i },
  { re: /https:\/\/8x8\.vc\/[^\s"'<>]+/i },
];

function extraerJoin(campos: string): string | null {
  for (const { re } of JOIN_RES) {
    const m = campos.match(re);
    if (m) return m[0].replace(/[.,;:]+$/, "");
  }
  return null;
}

// Parsea un .ics y devuelve las reuniones (con link) que empiezan dentro de la
// ventana [ahora - graciaMs, ahora + horizonteMs]. Expande repeticiones
// simples para no perderse la instancia de hoy de una reunión semanal.
export function parsearICS(
  ics: string,
  ahora: number,
  horizonteMs = 15 * 60_000,
  graciaMs = 5 * 60_000
): EventoAgenda[] {
  const lineas = desplegar(ics);
  const eventos: EventoAgenda[] = [];
  let dentro = false;
  let uid = "";
  let subject = "";
  let dtstartRaw = "";
  let tzid: string | null = null;
  let startMs: number | null = null;
  let rrule = "";
  const exdate: number[] = [];
  let bloque: string[] = [];

  const cerrar = () => {
    if (startMs != null) {
      const join = extraerJoin(bloque.join("\n"));
      if (join) {
        const candidatos = expandirRepeticion(startMs, rrule, exdate, ahora, horizonteMs, graciaMs);
        for (const t of candidatos) {
          eventos.push({
            key: `${uid || subject}|${new Date(t).toISOString().slice(0, 16)}`,
            subject: subject || "(sin título)",
            startMs: t,
            joinUrl: join,
          });
        }
      }
    }
    dentro = false; uid = ""; subject = ""; dtstartRaw = ""; tzid = null; startMs = null; rrule = ""; exdate.length = 0; bloque = [];
  };

  for (const linea of lineas) {
    if (linea === "BEGIN:VEVENT") { dentro = true; bloque = []; continue; }
    if (linea === "END:VEVENT") { cerrar(); continue; }
    if (!dentro) continue;
    bloque.push(linea);
    const idx = linea.indexOf(":");
    if (idx < 0) return eventos.length ? eventos : eventos; // línea rara; seguir
    const clave = linea.slice(0, idx);
    const valor = linea.slice(idx + 1).trim();
    const nombre = clave.split(";")[0].toUpperCase();
    if (nombre === "UID") uid = valor;
    else if (nombre === "SUMMARY") subject = valor.slice(0, 200);
    else if (nombre === "DTSTART") {
      dtstartRaw = valor;
      tzid = clave.match(/TZID=([^;:]+)/i)?.[1] ?? null;
      startMs = fechaAEpoch(valor, tzid);
    }
    else if (nombre === "RRULE") rrule = valor;
    else if (nombre === "EXDATE") {
      const t = fechaAEpoch(valor.split(",")[0], clave.match(/TZID=([^;:]+)/i)?.[1] ?? null);
      if (t != null) exdate.push(t);
    }
  }
  void dtstartRaw;
  return eventos;
}

// Expande una RRULE simple (FREQ=DAILY|WEEKLY, con INTERVAL y COUNT/UNTIL) para
// ver si CAE una instancia dentro de la ventana. La mayoría de las reuniones
// recurrentes de trabajo son diarias o semanales; para lo más raro cae el
// evento base (que igual sirve si es hoy).
function expandirRepeticion(
  base: number,
  rrule: string,
  exdate: number[],
  ahora: number,
  horizonteMs: number,
  graciaMs: number
): number[] {
  const desde = ahora - graciaMs;
  const hasta = ahora + horizonteMs;
  const enVentana = (t: number) => t >= desde && t <= hasta && !exdate.some((e) => Math.abs(e - t) < 60_000);

  if (!rrule) return enVentana(base) ? [base] : [];
  const p = Object.fromEntries(
    rrule.split(";").map((kv) => { const [k, v] = kv.split("="); return [k.toUpperCase(), v]; })
  );
  const freq = p.FREQ;
  const interval = Math.max(1, Number(p.INTERVAL) || 1);
  const paso = freq === "DAILY" ? 86_400_000 * interval : freq === "WEEKLY" ? 604_800_000 * interval : 0;
  if (!paso) return enVentana(base) ? [base] : [];

  const until = p.UNTIL ? fechaAEpoch(p.UNTIL.replace(/Z$/, "") + (p.UNTIL.endsWith("Z") ? "Z" : ""), null) : null;
  const count = p.COUNT ? Number(p.COUNT) : null;

  // Saltamos hasta cerca de la ventana en vez de iterar desde el origen.
  const salida: number[] = [];
  let t = base;
  if (t < desde) {
    const saltos = Math.floor((desde - t) / paso);
    t += saltos * paso;
  }
  let emitidos = 0;
  for (let i = 0; i < 400 && t <= hasta; i++, t += paso) {
    if (until != null && t > until) break;
    if (count != null && emitidos >= count) break;
    if (enVentana(t)) salida.push(t);
    emitidos++;
  }
  return salida;
}

// --- El poller --------------------------------------------------------------
// Cada ~60 s revisa la agenda de todos los que tienen el piloto encendido y
// despacha el bot a las reuniones que están por empezar. despacharBot lo
// inyecta index.ts (la misma función del botón de la web).

// La PACIENCIA del bot de calendario, distinta a la del botón manual: a una
// reunión programada la gente puede llegar tarde. El bot espera hasta MEDIA
// HORA (a que llegue alguien, o a que lo admitan) y si no hay respuesta se
// retira solo, sin dejar nada colgado.
export const ESPERA_AGENDA_MS = 30 * 60_000;

type Despachador = (args: {
  url: string;
  roomKey: string;
  platform: string;
  ownerId: string;
  /** Cuánto esperar (vacío/llegada tarde y admisión) antes de retirarse. */
  esperaMs?: number;
}) => Promise<void>;

// Overridable para las pruebas: de dónde bajar un .ics.
let bajarICS = async (url: string): Promise<string | null> => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const txt = await r.text();
    return txt.length > 5_000_000 ? txt.slice(0, 5_000_000) : txt;
  } catch {
    return null;
  }
};
export function _setBajarICS(fn: typeof bajarICS): void { bajarICS = fn; }

async function eventosDeUsuario(
  u: { id: string; icsUrl: string | null; msConnected: boolean },
  ahora: number
): Promise<EventoAgenda[]> {
  const out: EventoAgenda[] = [];
  // 1. iCal de Google (o cualquier .ics).
  if (u.icsUrl && /^https?:\/\//i.test(u.icsUrl)) {
    const ics = await bajarICS(u.icsUrl);
    if (ics) out.push(...parsearICS(ics, ahora));
  }
  // 2. Outlook/365 conectado.
  if (u.msConnected && microsoftEnabled) {
    try {
      const rt = await getMsRefreshToken(u.id);
      if (rt) {
        const { accessToken, refreshToken } = await refreshAccessToken(rt);
        if (refreshToken && refreshToken !== rt) await setMsRefreshToken(u.id, refreshToken);
        const eventos = await fetchUpcomingEvents(accessToken, 1);
        for (const ev of eventos) out.push(...deOutlook(ev, ahora));
      }
    } catch { /* si Outlook falla, el iCal ya pudo aportar */ }
  }
  return out;
}

function deOutlook(ev: CalendarEvent, ahora: number): EventoAgenda[] {
  if (!ev.joinUrl) return [];
  const t = Date.parse(ev.start);
  if (!Number.isFinite(t)) return [];
  if (t < ahora - 5 * 60_000 || t > ahora + 15 * 60_000) return [];
  return [{ key: `ms|${ev.id}`, subject: ev.subject, startMs: t, joinUrl: ev.joinUrl }];
}

/** Una pasada del poller. Exportada para poder ejercerla desde las pruebas. */
export async function repasarAgenda(despachar: Despachador, ahora = Date.now()): Promise<number> {
  const usuarios = await listBotAgendaUsers();
  let despachados = 0;
  for (const u of usuarios) {
    let eventos: EventoAgenda[];
    try { eventos = await eventosDeUsuario(u, ahora); } catch { continue; }
    for (const ev of eventos) {
      const sala = derivarSala(ev.joinUrl);
      if (!sala) continue;
      // El bot entra CUANDO la reunión empieza, no cuando el poller la ve:
      // la ventana de parseo mira 15 min adelante, pero despachar ahí hacía
      // que el bot llegara a una sala vacía, esperara su minuto a solas y se
      // fuera -- y el dedup le impedía volver a la hora real. Un evento
      // todavía lejano queda SIN marcar, para una próxima pasada.
      if (ev.startMs > ahora + 90_000) continue;
      // dedup ANTES de despachar: si ya lo mandamos a este evento, nada.
      const primero = await tryMarkBotDispatch(u.id, ev.key);
      if (!primero) continue;
      try {
        await despachar({
          url: sala.url,
          roomKey: sala.roomKey,
          platform: sala.platform,
          ownerId: u.id,
          esperaMs: ESPERA_AGENDA_MS,
        });
        despachados++;
      } catch { /* el próximo repaso reintenta con otro evento */ }
    }
  }
  return despachados;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Arranca el poller (index.ts lo llama sólo si BOT_ENABLED). */
export function arrancarAgenda(despachar: Despachador, cadaMs = 60_000): void {
  if (timer) return;
  const tick = () => { void repasarAgenda(despachar).catch(() => {}); };
  timer = setInterval(tick, cadaMs);
  if (typeof timer.unref === "function") timer.unref();
  tick();
}

export function detenerAgenda(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
