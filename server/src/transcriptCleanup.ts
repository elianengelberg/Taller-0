// Browser speech recognition sometimes mishears a word and swaps in a
// similar-sounding but nonsensical one, which then reads as gibberish and
// makes downstream translation nonsensical too (translating garbage just
// gives fluent garbage). This runs each freshly-recognized line through
// Claude to restore the most likely intended words before it's ever stored,
// broadcast, or translated -- fixing the problem at the source instead of
// papering over it later.
import { anthropicClient } from "./anthropicClient";

const CLEANUP_MODEL = process.env.ANTHROPIC_TRANSCRIPT_MODEL || "claude-haiku-4-5";
// Live captions need to feel instant -- if the correction call takes too
// long, ship the raw recognized text instead of stalling the conversation.
const CLEANUP_TIMEOUT_MS = 3500;

const SYSTEM_PROMPT = `Corregís fragmentos cortos de una transcripción de voz a texto en vivo. El
reconocimiento de voz a veces confunde una palabra con otra parecida fonéticamente pero sin
sentido en el contexto, lo que rompe el significado de la frase.

Para cada fragmento te paso varias lecturas candidatas que el propio reconocimiento de voz
generó para el mismo audio (ordenadas de más a menos probable según el reconocimiento), más el
contexto reciente de la conversación. Estas lecturas alternativas son tu pista más fuerte de
qué se dijo realmente -- muchas veces la palabra correcta aparece en una alternativa aunque no
sea la primera.

Reglas estrictas:
- Elegí o reconstruí la versión más coherente del fragmento, dando prioridad a lo que ya
  aparece en alguna de las lecturas candidatas antes que a inventar una palabra que no esté
  sugerida por ninguna de ellas.
- Usá el contexto reciente de la conversación para decidir qué lectura tiene más sentido.
- No traduzcas, no cambies el idioma del fragmento.
- No parafrasees, no resumas, no agregues ni saques contenido más allá de corregir errores
  claros de reconocimiento.
- Si la primera lectura ya tiene sentido tal cual está, devolvela exactamente igual, sin cambios.
- Respondé ÚNICAMENTE con el fragmento final -- sin comillas, sin notas, sin explicaciones.`;

export async function cleanTranscriptFragment(
  alternatives: string[],
  recentContext: string[]
): Promise<string> {
  const trimmedAlternatives = alternatives.map((a) => a.trim()).filter(Boolean);
  const best = trimmedAlternatives[0] ?? "";
  if (!anthropicClient || !best) return best;

  const contextBlock = recentContext.length
    ? `Contexto reciente de la conversación (más antiguo primero):\n${recentContext.join("\n")}\n\n`
    : "";
  const alternativesBlock = trimmedAlternatives
    .map((a, i) => `${i + 1}. ${a}`)
    .join("\n");

  try {
    const response = await anthropicClient.messages.create(
      {
        model: CLEANUP_MODEL,
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `${contextBlock}Lecturas candidatas del mismo fragmento:\n${alternativesBlock}`,
          },
        ],
      },
      { timeout: CLEANUP_TIMEOUT_MS }
    );
    for (const block of response.content) {
      if (block.type === "text") {
        const cleaned = block.text.trim();
        return cleaned || best;
      }
    }
    return best;
  } catch {
    // Timeout, rate limit, network error, etc. -- never block captions on this.
    return best;
  }
}
