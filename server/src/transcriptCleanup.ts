// Browser speech recognition sometimes mishears a word and swaps in a
// similar-sounding but nonsensical one, which then reads as gibberish and
// makes downstream translation nonsensical too (translating garbage just
// gives fluent garbage). This runs each freshly-recognized line through
// Claude to restore the most likely intended words before it's ever stored,
// broadcast, or translated -- fixing the problem at the source instead of
// papering over it later.
import { anthropicClient, anthropicEnabled } from "./anthropicClient";

const CLEANUP_MODEL = process.env.ANTHROPIC_TRANSCRIPT_MODEL || "claude-haiku-4-5";
// Live captions need to feel instant -- if the correction call takes too
// long, ship the raw recognized text instead of stalling the conversation.
const CLEANUP_TIMEOUT_MS = 4000;

const SYSTEM_PROMPT = `Corregís fragmentos cortos de una transcripción de voz a texto en vivo. El
reconocimiento de voz a veces confunde una palabra con otra parecida fonéticamente pero sin
sentido en el contexto, lo que rompe el significado de la frase.

Reglas estrictas:
- Corregí SOLO errores claros de reconocimiento de voz (palabras que no tienen sentido y que
  probablemente el reconocimiento confundió con otra que suena parecida). Usá el contexto
  reciente de la conversación para elegir la corrección más probable.
- No traduzcas, no cambies el idioma del fragmento.
- No parafrasees, no resumas, no agregues ni saques contenido más allá de corregir errores
  claros de reconocimiento.
- Si el fragmento ya tiene sentido tal cual está, devolvelo exactamente igual, sin cambios.
- Respondé ÚNICAMENTE con el fragmento corregido -- sin comillas, sin notas, sin explicaciones.`;

export async function cleanTranscriptFragment(
  text: string,
  recentContext: string[]
): Promise<string> {
  if (!anthropicClient) return text;
  const trimmed = text.trim();
  if (!trimmed) return text;

  const contextBlock = recentContext.length
    ? `Contexto reciente de la conversación (más antiguo primero):\n${recentContext.join("\n")}\n\n`
    : "";

  try {
    const response = await anthropicClient.messages.create(
      {
        model: CLEANUP_MODEL,
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [
          { role: "user", content: `${contextBlock}Fragmento a corregir:\n${trimmed}` },
        ],
      },
      { timeout: CLEANUP_TIMEOUT_MS }
    );
    for (const block of response.content) {
      if (block.type === "text") {
        const cleaned = block.text.trim();
        return cleaned || text;
      }
    }
    return text;
  } catch {
    // Timeout, rate limit, network error, etc. -- never block captions on this.
    return text;
  }
}
