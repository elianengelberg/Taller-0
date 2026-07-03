// Turns a raw/cryptic error (a browser API error code, a network failure
// message, etc.) into one short plain-Spanish sentence a non-technical user
// can actually act on, instead of showing them something like "error 9823".
import { anthropicClient } from "./anthropicClient";

const MODEL = process.env.ANTHROPIC_ERROR_MODEL || "claude-haiku-4-5";
const TIMEOUT_MS = 3500;

const SYSTEM_PROMPT = `Te paso un error técnico crudo (código de error de una API del navegador, un
mensaje de red, etc.) que va a mostrarse a una persona que no sabe de programación. Tu trabajo
es explicarlo en UNA sola oración corta, en español, sin jerga técnica.

Reglas:
- Decí en términos simples qué está pasando (ej: "se cortó la conexión a internet", "el
  navegador bloqueó el acceso al micrófono").
- Si podés, sugerí brevemente qué hacer (ej: "revisá tu conexión", "recargá la página").
- No inventes una causa que no puedas inferir razonablemente del texto del error -- si no
  tenés forma de saber qué significa, decilo así de simple ("no pudimos identificar la causa
  exacta") en vez de inventar algo.
- Respondé ÚNICAMENTE con esa oración -- sin comillas, sin prefijos como "Error:", sin notas.`;

export async function explainError(rawError: string, context?: string): Promise<string | null> {
  if (!anthropicClient) return null;
  const trimmed = rawError.trim();
  if (!trimmed) return null;

  try {
    const response = await anthropicClient.messages.create(
      {
        model: MODEL,
        max_tokens: 200,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: context ? `Contexto: ${context}\nError crudo: ${trimmed}` : `Error crudo: ${trimmed}`,
          },
        ],
      },
      { timeout: TIMEOUT_MS }
    );
    for (const block of response.content) {
      if (block.type === "text") {
        const explanation = block.text.trim();
        return explanation || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
