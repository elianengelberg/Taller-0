// Browser speech recognition sometimes mishears a word and swaps in a
// similar-sounding but nonsensical one, which then reads as gibberish and
// makes downstream translation nonsensical too (translating garbage just
// gives fluent garbage). This runs each freshly-recognized line through
// Claude to restore the most likely intended words before it's ever stored,
// broadcast, or translated -- fixing the problem at the source instead of
// papering over it later.
import { anthropicClient } from "./anthropicClient";
import { languageName } from "./translate";

const CLEANUP_MODEL = process.env.ANTHROPIC_TRANSCRIPT_MODEL || "claude-haiku-4-5";
// Live captions need to feel instant -- if the correction call takes too
// long, ship the raw recognized text instead of stalling the conversation.
const CLEANUP_TIMEOUT_MS = 3500;

// This is a video-meeting app, so certain everyday words come up constantly
// in the conversations being transcribed (people talking about the app
// itself, not just their meeting topic) and are worth being biased toward
// when a candidate reading is ambiguous -- e.g. "chat" getting misheard as
// "champ" happens because "chat" alone is a shorter, less common word for
// the recognizer to lock onto than it should be here.
const DOMAIN_HINT =
  "Esto es una videollamada, así que estas palabras aparecen seguido y son buenas candidatas " +
  "cuando una lectura es ambigua: chat, pantalla, compartir pantalla, micrófono, cámara, " +
  "subtítulos, transcripción, reunión, grabar, grabación, rol, participante, anfitrión, silenciar.";

function buildUserMessage(alternatives: string[], recentContext: string[]): string {
  const contextBlock = recentContext.length
    ? `Contexto reciente de la conversación (más antiguo primero):\n${recentContext.join("\n")}\n\n`
    : "";
  const alternativesBlock = alternatives.map((a, i) => `${i + 1}. ${a}`).join("\n");
  return `${contextBlock}Lecturas candidatas del mismo fragmento:\n${alternativesBlock}`;
}

const CLEANUP_SYSTEM_PROMPT = `Corregís fragmentos cortos de una transcripción de voz a texto en vivo. El
reconocimiento de voz a veces confunde una palabra con otra parecida fonéticamente pero sin
sentido en el contexto, lo que rompe el significado de la frase.

Para cada fragmento te paso varias lecturas candidatas que el propio reconocimiento de voz
generó para el mismo audio (ordenadas de más a menos probable según el reconocimiento), más el
contexto reciente de la conversación. Estas lecturas alternativas son tu pista más fuerte de
qué se dijo realmente -- muchas veces la palabra correcta aparece en una alternativa aunque no
sea la primera.

${DOMAIN_HINT}

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

  try {
    const response = await anthropicClient.messages.create(
      {
        model: CLEANUP_MODEL,
        max_tokens: 512,
        system: CLEANUP_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserMessage(trimmedAlternatives, recentContext) }],
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

// Translating a caption used to happen strictly *after* cleanup finished
// (fix the words, then translate the fixed text) -- correct, but it meant
// every translated viewer waited for two Claude calls back to back. This
// does the same "figure out what was actually said" correction internally
// in the SAME call as the translation, so it can be kicked off in parallel
// with cleanTranscriptFragment (which still exists to produce the original-
// language caption) instead of waiting for it -- roughly halving the time
// before a translated caption shows up, which matters a lot for keeping up
// with back-to-back sentences instead of a translation losing the race
// against the next line coming in.
function cleanAndTranslateSystemPrompt(targetLanguage: string): string {
  return `Te paso varias lecturas candidatas que un reconocimiento de voz en vivo generó para el
mismo fragmento de audio (ordenadas de más a menos probable), más el contexto reciente de la
conversación. El reconocimiento a veces confunde una palabra con otra que suena parecida pero
no tiene sentido en el contexto.

${DOMAIN_HINT}

Tu tarea, en dos pasos internos (pero respondé ÚNICAMENTE con el resultado del paso 2, nunca
muestres el paso 1):
1. Reconstruí mentalmente cuál es la versión más coherente del fragmento original, dando
   prioridad a lo que ya aparece en alguna lectura candidata antes que a inventar algo que
   ninguna sugiere. Usá el contexto reciente para decidir qué lectura tiene más sentido.
2. Traducí esa versión corregida a ${targetLanguage}.

Reglas:
- Si no hay ambigüedad real entre las lecturas, no inventes cambios -- traducí tal cual dice
  la lectura más probable.
- No agregues ni saques contenido más allá de lo que ya está en el fragmento.
- Respondé ÚNICAMENTE con la traducción final -- sin comillas, sin notas, sin explicaciones,
  sin mostrar el fragmento corregido en el idioma original.`;
}

export async function cleanAndTranslateFragment(
  alternatives: string[],
  recentContext: string[],
  targetLang: string
): Promise<string | null> {
  const trimmedAlternatives = alternatives.map((a) => a.trim()).filter(Boolean);
  if (!anthropicClient || trimmedAlternatives.length === 0) return null;

  try {
    const response = await anthropicClient.messages.create(
      {
        model: CLEANUP_MODEL,
        max_tokens: 512,
        system: cleanAndTranslateSystemPrompt(languageName(targetLang)),
        messages: [{ role: "user", content: buildUserMessage(trimmedAlternatives, recentContext) }],
      },
      { timeout: CLEANUP_TIMEOUT_MS }
    );
    for (const block of response.content) {
      if (block.type === "text") {
        const translated = block.text.trim();
        return translated || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
