import { anthropicClient } from "./anthropicClient";
import {
  getMeetingDetailForUser,
  getMeetingDetailRaw,
  MeetingDetail,
  PersistedMessage,
  saveMeetingReport,
} from "./db";

// Override with ANTHROPIC_MODEL if you want a cheaper/faster model (e.g.
// "claude-haiku-4-5"). Defaults to Anthropic's most capable model since
// people ask this for real work -- full meeting reports, statistics on who
// spoke how much, not just one-line lookups -- and that needs real
// reasoning over a long transcript, not just pattern matching.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

// Opus has a 1M-token context window, so there's no real need to truncate
// aggressively -- and truncating is exactly wrong for "summarize the whole
// meeting" style requests, which need the full transcript.
const MAX_TRANSCRIPT_CHARS = 100_000;

function buildTranscriptText(messages: PersistedMessage[]): string {
  const lines = messages.map((m) => {
    const role = m.roleName ? ` (${m.roleName})` : "";
    const via = m.kind === "chat" ? " [chat]" : "";
    return `${m.senderName}${role}${via}: ${m.text}`;
  });
  let text = lines.join("\n");
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = "...(inicio recortado por ser una reunión muy larga)...\n" + text.slice(text.length - MAX_TRANSCRIPT_CHARS);
  }
  return text;
}

// LLMs are unreliable at counting things by reading a long transcript --
// they'll approximate or hallucinate round numbers. So for anything a
// report/statistics request would ask ("who talked the most", "how many
// messages"), compute the real numbers here and hand them over as ground
// truth instead of asking the model to count.
interface ParticipantStats {
  name: string;
  role: string | null;
  voiceLines: number;
  chatMessages: number;
  wordsSpoken: number;
}

function computeStats(meeting: MeetingDetail): {
  durationLabel: string;
  totalChat: number;
  totalVoice: number;
  perPerson: ParticipantStats[];
} {
  const perPerson = new Map<string, ParticipantStats>();

  for (const m of meeting.messages) {
    const entry = perPerson.get(m.senderName) ?? {
      name: m.senderName,
      role: m.roleName,
      voiceLines: 0,
      chatMessages: 0,
      wordsSpoken: 0,
    };
    if (m.kind === "chat") entry.chatMessages += 1;
    else entry.voiceLines += 1;
    entry.wordsSpoken += m.text.trim().split(/\s+/).filter(Boolean).length;
    if (!entry.role && m.roleName) entry.role = m.roleName;
    perPerson.set(m.senderName, entry);
  }

  let durationLabel = "desconocida";
  const lastMessageAt = meeting.messages[meeting.messages.length - 1]?.createdAt;
  const endSource = meeting.endedAt ?? lastMessageAt;
  if (meeting.startedAt && endSource) {
    const minutes = Math.max(
      0,
      Math.round((new Date(endSource).getTime() - new Date(meeting.startedAt).getTime()) / 60000)
    );
    durationLabel = `${minutes} minuto${minutes === 1 ? "" : "s"}`;
  }

  return {
    durationLabel,
    totalChat: meeting.messages.filter((m) => m.kind === "chat").length,
    totalVoice: meeting.messages.filter((m) => m.kind === "transcript").length,
    perPerson: Array.from(perPerson.values()).sort(
      (a, b) => b.voiceLines + b.chatMessages - (a.voiceLines + a.chatMessages)
    ),
  };
}

function formatStats(stats: ReturnType<typeof computeStats>): string {
  const lines = stats.perPerson
    .map(
      (p) =>
        `  - ${p.name}${p.role ? ` (${p.role})` : ""}: ${p.voiceLines} intervención(es) de voz, ` +
        `${p.chatMessages} mensaje(s) de chat, ~${p.wordsSpoken} palabras en total`
    )
    .join("\n");

  return `Estadísticas ya calculadas de esta reunión (son datos exactos -- si te preguntan
cantidades, duración o quién participó más, usá estos números tal cual, NO los
recalcules leyendo la transcripción):
- Duración aproximada: ${stats.durationLabel}
- Mensajes de chat: ${stats.totalChat}
- Intervenciones habladas (transcriptas por voz): ${stats.totalVoice}
- Por persona (ordenado de quien más participó a quien menos):
${lines || "  (sin datos)"}`;
}

// Shared context builder: the system prompt that grounds both the Q&A and the
// full-report generation in a single meeting's real data (transcript + exact
// precomputed stats + participant list). Kept in one place so the two flows
// never drift in what the model is allowed to use.
function buildMeetingSystemPrompt(meeting: MeetingDetail): string {
  const transcriptText = buildTranscriptText(meeting.messages);
  const statsText = formatStats(computeStats(meeting));
  const participantList = meeting.participants
    .map((p) => {
      const role = p.roleId ? meeting.roles.find((r) => r.id === p.roleId)?.name : null;
      return `- ${p.name}${role ? ` (${role})` : ""}${p.isHost ? " — anfitrión" : ""}`;
    })
    .join("\n");

  return `Sos un asistente que analiza reuniones. Respondés preguntas y generás
informes EXCLUSIVAMENTE en base a lo que pasó en una reunión específica: la transcripción de
lo que se dijo (por voz o por chat), quién lo dijo, y las estadísticas ya calculadas.

Reglas estrictas:
- Usá solo información de la transcripción, las estadísticas de abajo y -- si el mensaje trae
  imágenes -- los fotogramas del video grabado de ESTA reunión. No uses conocimiento externo
  ni inventes nada. Si algo no está en esas fuentes, decilo explícitamente en vez de adivinar.
- Si hay fotogramas y la pregunta es sobre algo visual (qué se mostró en pantalla, una
  lámina, un gráfico, quién aparecía), respondé mirándolos y citá el minuto del fotograma.
- Para cantidades, duración o "quién habló más": usá las estadísticas ya calculadas, no
  cuentes vos desde la transcripción (es fácil que te equivoques contando texto largo).
- Si te piden un resumen, informe o reporte completo de la reunión, generalo con estructura
  clara (temas tratados, decisiones, pendientes, participación de cada persona) usando
  Markdown (títulos con **, listas con -).
- Cuando cites lo que dijo alguien, mencioná su nombre.
- Respondé en español.

Participantes de la reunión:
${participantList || "(sin datos de participantes)"}

${statsText}

Transcripción completa de la reunión (orden cronológico; "[chat]" marca lo escrito, el resto
es lo que se dijo por voz):
${transcriptText}`;
}

function firstText(content: { type: string; text?: string }[]): string {
  for (const block of content) {
    if (block.type === "text" && block.text) return block.text;
  }
  return "No pude generar una respuesta.";
}

export type AskResult = { ok: true; answer: string } | { ok: false; error: string };

/**
 * Un fotograma del VIDEO GRABADO de la reunión, capturado por el navegador
 * (el cliente busca el video a distintos segundos, lo dibuja en un canvas y
 * manda JPEGs chicos). Así la IA no responde sólo desde la transcripción:
 * también mira lo que se veía en pantalla -- una lámina compartida, un
 * gráfico, quién estaba en cámara.
 *
 * El servidor NO procesa video (no hay ffmpeg ni descargas de R2 acá): los
 * bytes llegan ya listos, chicos y acotados. index.ts valida cantidad y
 * tamaño antes de que esto se llame.
 */
export interface VideoFrame {
  /** Segundo del video del que salió el fotograma. */
  atSec: number;
  /** JPEG en base64, SIN el prefijo data:. */
  data: string;
}

function fmtSec(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

export async function answerFromMeeting(
  meetingId: string,
  question: string,
  userId: string,
  // True when the caller has verified this user is a current participant of the
  // live meeting -- then they can query it even if they're not its owner (e.g.
  // everyone in a shared external/companion room, not just whoever opened it).
  liveParticipant = false,
  // Fotogramas del video grabado (ver VideoFrame). Vacío = sólo transcripción.
  frames: VideoFrame[] = []
): Promise<AskResult> {
  if (!anthropicClient) {
    return { ok: false, error: "La función de IA no está configurada en el servidor." };
  }

  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    return { ok: false, error: "Escribí una pregunta." };
  }

  let meeting = await getMeetingDetailForUser(meetingId, userId);
  if (!meeting && liveParticipant) {
    meeting = await getMeetingDetailRaw(meetingId);
  }
  if (!meeting) {
    return { ok: false, error: "No encontramos esa reunión." };
  }
  if (meeting.messages.length === 0) {
    return { ok: false, error: "Esa reunión todavía no tiene mensajes ni transcripción guardada." };
  }

  try {
    // Con fotogramas, el mensaje del usuario pasa a ser multimodal: cada
    // imagen va precedida de su momento en el video, así el modelo puede
    // cruzar "lo que se veía" con "lo que se decía" en ese instante.
    const pregunta = trimmedQuestion.slice(0, 2000);
    type Bloque =
      | { type: "text"; text: string }
      | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } };
    let content: string | Bloque[] = pregunta;
    if (frames.length > 0) {
      const bloques: Bloque[] = [
        {
          type: "text",
          text:
            "Estos son fotogramas REALES del video grabado de la reunión, con el minuto del que " +
            "sale cada uno. Usalos junto con la transcripción: si la pregunta es sobre algo que se " +
            "VIO (una lámina, un gráfico, quién estaba en cámara, qué se compartió en pantalla), " +
            "respondé desde las imágenes y decí en qué minuto se ve.",
        },
      ];
      for (const f of frames) {
        bloques.push({ type: "text", text: `Fotograma en ${fmtSec(f.atSec)}:` });
        bloques.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.data } });
      }
      bloques.push({ type: "text", text: pregunta });
      content = bloques;
    }
    const response = await anthropicClient.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: buildMeetingSystemPrompt(meeting),
      messages: [{ role: "user", content }],
    });
    return { ok: true, answer: firstText(response.content) };
  } catch (err) {
    console.error("Error llamando a la API de Anthropic:", err);
    return { ok: false, error: "No se pudo consultar a la IA en este momento." };
  }
}

// Generates a full structured report for the meeting and PERSISTS it, so it's
// produced once (a real model call over the whole transcript) and then served
// instantly from the DB on every later open. `regenerate` forces a fresh one.
const REPORT_REQUEST = `Generá un informe completo y profesional de esta reunión, en español y en
Markdown, con estas secciones (omití una sección solo si de verdad no hay información para ella):

## Resumen ejecutivo
2-4 frases con lo esencial de la reunión.

## Temas tratados
Lista de los temas principales que se discutieron.

## Decisiones tomadas
Qué se decidió. Si no se tomaron decisiones, decilo.

## Tareas y pendientes
Quién quedó a cargo de qué (si se mencionó). Formato: - **Responsable**: tarea.

## Participación
Un renglón por persona con su aporte principal, usando las estadísticas ya calculadas.

## Próximos pasos
Qué sigue después de esta reunión, si se mencionó.

No inventes nada que no esté en la transcripción.`;

export async function generateMeetingReport(
  meetingId: string,
  userId: string,
  regenerate = false
): Promise<AskResult> {
  const meeting = await getMeetingDetailForUser(meetingId, userId);
  if (!meeting) {
    return { ok: false, error: "No encontramos esa reunión." };
  }
  // Serve the saved report unless a fresh one was explicitly requested.
  if (!regenerate && meeting.report) {
    return { ok: true, answer: meeting.report };
  }
  if (!anthropicClient) {
    return { ok: false, error: "La función de IA no está configurada en el servidor." };
  }
  if (meeting.messages.length === 0) {
    return { ok: false, error: "Esa reunión todavía no tiene transcripción para armar un informe." };
  }

  try {
    const response = await anthropicClient.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: buildMeetingSystemPrompt(meeting),
      messages: [{ role: "user", content: REPORT_REQUEST }],
    });
    const answer = firstText(response.content);
    await saveMeetingReport(meetingId, answer);
    return { ok: true, answer };
  } catch (err) {
    console.error("Error generando el informe con la API de Anthropic:", err);
    return { ok: false, error: "No se pudo generar el informe en este momento." };
  }
}

// El resumen automático al quedar la sala vacía (lo que Granola hace bien):
// nadie tiene que acordarse de pedir el informe. Si la reunión tuvo
// conversación de verdad y todavía no tiene informe guardado, se genera uno
// corto y accionable en el MISMO lugar que el informe a pedido
// (meetings.report): el historial lo muestra sin ninguna pieza nueva, y un
// informe pedido a mano nunca se pisa.
export async function autoReportOnFinalize(
  meetingId: string,
  lines: { speakerName: string; text: string }[]
): Promise<void> {
  if (!anthropicClient) return;
  const conTexto = lines.filter((l) => l.text?.trim());
  // El umbral es de CONTENIDO, no de cantidad de líneas: el flujo nativo
  // fusiona fragmentos seguidos del mismo hablante en una sola línea larga
  // (anti-entrecortado), así que "pocas líneas" no significa "poca reunión".
  const totalChars = conTexto.reduce((a, l) => a + l.text.length, 0);
  if (conTexto.length === 0 || totalChars < 150) return; // un "hola, probando" no merece informe
  const existente = await getMeetingDetailRaw(meetingId);
  if (!existente || existente.report) return;
  const texto = conTexto
    .map((l) => `${l.speakerName}: ${l.text}`)
    .join("\n")
    .slice(0, MAX_TRANSCRIPT_CHARS);
  try {
    const response = await anthropicClient.messages.create(
      {
        model: MODEL,
        max_tokens: 1024,
        system:
          "Sos el asistente de reuniones de Unify. La reunión acaba de terminar; te paso su " +
          "transcripción. Escribí un resumen BREVE y accionable en el idioma predominante de la " +
          "conversación: dos o tres líneas de contexto y después viñetas con las decisiones " +
          "tomadas y las tareas pendientes (con responsable si se nombró). No inventes nada que " +
          "no esté en la transcripción; si fue una conversación trivial o de prueba, decilo en " +
          "una línea y nada más.",
        messages: [{ role: "user", content: texto }],
      },
      { timeout: 30_000 }
    );
    const resumen = firstText(response.content).trim();
    if (resumen) await saveMeetingReport(meetingId, resumen.slice(0, 12_000));
  } catch (err) {
    // Sin resumen no pasa nada: la transcripción completa queda igual.
    console.error("No se pudo generar el resumen automático:", (err as Error).message);
  }
}
