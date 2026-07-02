import Anthropic from "@anthropic-ai/sdk";
import { getMeetingDetail } from "./db";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Override with ANTHROPIC_MODEL if you want a cheaper/faster model
// (e.g. "claude-haiku-4-5") for this simple grounded-QA use case.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

export const aiEnabled = Boolean(ANTHROPIC_API_KEY);

const client = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const MAX_TRANSCRIPT_CHARS = 15000;

interface TranscriptSource {
  senderName: string;
  roleName: string | null;
  text: string;
}

function buildTranscriptText(messages: TranscriptSource[]): string {
  const lines = messages.map((m) => {
    const role = m.roleName ? ` (${m.roleName})` : "";
    return `${m.senderName}${role}: ${m.text}`;
  });
  let text = lines.join("\n");
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = "...(inicio recortado)...\n" + text.slice(text.length - MAX_TRANSCRIPT_CHARS);
  }
  return text;
}

export type AskResult = { ok: true; answer: string } | { ok: false; error: string };

export async function answerFromMeeting(meetingId: string, question: string): Promise<AskResult> {
  if (!client) {
    return { ok: false, error: "La función de IA no está configurada en el servidor." };
  }

  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    return { ok: false, error: "Escribí una pregunta." };
  }

  const meeting = await getMeetingDetail(meetingId);
  if (!meeting) {
    return { ok: false, error: "No encontramos esa reunión." };
  }
  if (meeting.messages.length === 0) {
    return { ok: false, error: "Esa reunión todavía no tiene mensajes ni transcripción guardada." };
  }

  const transcriptText = buildTranscriptText(meeting.messages);
  const participantList = meeting.participants
    .map((p) => {
      const role = p.roleId ? meeting.roles.find((r) => r.id === p.roleId)?.name : null;
      return `- ${p.name}${role ? ` (${role})` : ""}${p.isHost ? " — anfitrión" : ""}`;
    })
    .join("\n");

  const systemPrompt = `Sos un asistente que responde preguntas EXCLUSIVAMENTE en base a lo que pasó en una reunión específica: la transcripción de lo que se dijo (por voz o por chat) y quién lo dijo.

Reglas estrictas:
- Respondé solo con información que aparece en la transcripción de abajo. No uses conocimiento externo ni inventes nada.
- Si la respuesta no está en la transcripción, decilo explícitamente ("No encuentro eso en lo que se habló durante la reunión") en vez de adivinar.
- Cuando cites lo que dijo alguien, mencioná su nombre.
- Respondé en español, de forma breve y directa.

Participantes de la reunión:
${participantList || "(sin datos de participantes)"}

Transcripción de la reunión (orden cronológico, incluye chat y lo que se habló por voz):
${transcriptText}`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
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
    console.error("Error llamando a la API de Anthropic:", err);
    return { ok: false, error: "No se pudo consultar a la IA en este momento." };
  }
}
