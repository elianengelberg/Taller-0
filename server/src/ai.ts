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
- Usá solo información de la transcripción y las estadísticas de abajo. No uses conocimiento
  externo ni inventes nada. Si algo no está ahí, decilo explícitamente en vez de adivinar.
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

export async function answerFromMeeting(
  meetingId: string,
  question: string,
  userId: string,
  // True when the caller has verified this user is a current participant of the
  // live meeting -- then they can query it even if they're not its owner (e.g.
  // everyone in a shared external/companion room, not just whoever opened it).
  liveParticipant = false
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
    const response = await anthropicClient.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: buildMeetingSystemPrompt(meeting),
      messages: [{ role: "user", content: trimmedQuestion.slice(0, 2000) }],
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
