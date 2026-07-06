// A second, separate AI surface from ai.ts: instead of being scoped to one
// meeting, this answers questions across the user's *entire* saved meeting
// history ("did I have a meeting on June 17th?", "what was my last meeting
// about?"). Grounded in an index of every saved meeting plus full
// transcripts for as many of the most recent ones as fit a size budget --
// with meetings beyond that budget still findable by date/participants
// through the index, just without their word-for-word content.
import { anthropicClient, anthropicEnabled } from "./anthropicClient";
import { AskResult } from "./ai";
import { getMeetingDetail, listMeetings, MeetingSummary } from "./db";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
export const globalAiEnabled = anthropicEnabled;

const MAX_MEETINGS_IN_INDEX = 200;
// Across ALL meetings combined -- keeps a long history from ballooning the
// request. Most recent meetings are fetched first, so "my last meeting" and
// anything recent always has full content; older ones fall back to the
// index entry alone once the budget runs out.
const MAX_TOTAL_TRANSCRIPT_CHARS = 300_000;
const MAX_PER_MEETING_CHARS = 60_000;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    dateStyle: "full",
    timeStyle: "short",
  });
}

function participantNames(m: MeetingSummary): string {
  return m.participants.map((p) => p.name).join(", ") || "(sin datos)";
}

function buildIndex(summaries: MeetingSummary[]): string {
  return summaries
    .map((m, i) => {
      const recording = m.recordingUrl ? " Tiene grabación." : "";
      return `${i + 1}. [id:${m.id}] ${formatDate(m.startedAt)} -- Anfitrión: ${m.hostName}. Participantes: ${participantNames(
        m
      )}. Mensajes guardados: ${m.messageCount}.${recording}`;
    })
    .join("\n");
}

export async function answerAcrossMeetings(question: string, ownerId: string): Promise<AskResult> {
  if (!anthropicClient) {
    return { ok: false, error: "La función de IA no está configurada en el servidor." };
  }
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    return { ok: false, error: "Escribí una pregunta." };
  }

  const summaries = await listMeetings(ownerId, MAX_MEETINGS_IN_INDEX);
  if (summaries.length === 0) {
    return { ok: false, error: "Todavía no hay reuniones guardadas para consultar." };
  }

  const index = buildIndex(summaries);

  // Pull full transcripts starting from the most recent meeting, stopping
  // once the combined budget is used up.
  let remainingBudget = MAX_TOTAL_TRANSCRIPT_CHARS;
  const transcriptBlocks: string[] = [];
  for (const summary of summaries) {
    if (remainingBudget <= 0) break;
    if (summary.messageCount === 0) continue;

    const detail = await getMeetingDetail(summary.id, ownerId);
    if (!detail || detail.messages.length === 0) continue;

    const lines = detail.messages.map((m) => {
      const role = m.roleName ? ` (${m.roleName})` : "";
      const via = m.kind === "chat" ? " [chat]" : "";
      return `${m.senderName}${role}${via}: ${m.text}`;
    });
    let text = lines.join("\n");

    const cap = Math.min(MAX_PER_MEETING_CHARS, remainingBudget);
    if (text.length > cap) {
      text = text.slice(0, cap) + "\n...(recortado)...";
    }
    remainingBudget -= text.length;

    transcriptBlocks.push(
      `=== Reunión del ${formatDate(summary.startedAt)} [id:${summary.id}], anfitrión ${summary.hostName} ===\n${text}`
    );
  }

  const systemPrompt = `Sos un asistente que responde preguntas sobre TODO el historial de reuniones
guardadas de este usuario -- no una reunión puntual. Pensá en vos como el "buscador" de todas
sus reuniones pasadas.

Tenés dos fuentes de información abajo:
1. Un índice con TODAS las reuniones guardadas (fecha, anfitrión, participantes, cantidad de
   mensajes), ordenado de la más reciente a la más vieja.
2. La transcripción completa (chat + lo que se dijo por voz) de las reuniones más recientes que
   entraron en el presupuesto de contexto disponible. Las reuniones que NO tienen un bloque de
   transcripción más abajo solo están disponibles en el índice -- para esas podés responder
   fecha/participantes/cantidad de mensajes, pero NO inventes de qué se habló ahí.

Reglas estrictas:
- Usá solo la información de abajo. No inventes contenido que no esté en la transcripción ni
  reuniones que no estén en el índice.
- Si preguntan por una fecha concreta ("¿tuve una reunión el 17 de junio?"), buscá en el índice
  la reunión de esa fecha y decí lo que encontraste (o que no hay ninguna esa fecha).
- "La última reunión" / "mi reunión más reciente" es la primera de la lista del índice (está
  ordenado de más reciente a más vieja).
- Si te preguntan por el contenido de una reunión que solo está en el índice (sin transcripción
  cargada acá), decilo explícitamente en vez de inventar, y ofrecé los datos que sí tenés
  (fecha, participantes, cantidad de mensajes).
- Cuando cites contenido de una reunión, mencioná de qué fecha/reunión viene, para que quede
  claro de cuál estás hablando si hay varias.
- Si te piden un resumen o comparación entre varias reuniones, usá Markdown (negritas, listas)
  para que quede prolijo.
- Respondé en español.

Índice de reuniones guardadas (de la más reciente a la más vieja):
${index}

Transcripciones completas disponibles (solo para algunas de las reuniones más recientes de arriba):
${transcriptBlocks.join("\n\n") || "(ninguna transcripción completa entró en el presupuesto de contexto)"}`;

  try {
    const response = await anthropicClient.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: trimmedQuestion.slice(0, 2000) }],
    });

    let answer = "No pude generar una respuesta.";
    for (const block of response.content) {
      if (block.type === "text") {
        answer = block.text;
        break;
      }
    }
    return { ok: true, answer };
  } catch (err) {
    console.error("Error llamando a la API de Anthropic (multi-reunión):", err);
    return { ok: false, error: "No se pudo consultar a la IA en este momento." };
  }
}
