// Browser speech recognition sometimes mishears a word and swaps in a
// similar-sounding but nonsensical one, which then reads as gibberish and
// makes downstream translation nonsensical too (translating garbage just
// gives fluent garbage). This runs each freshly-recognized line through
// Claude to restore the most likely intended words before it's ever stored,
// broadcast, or translated -- fixing the problem at the source instead of
// papering over it later.
//
// It also has to cope with someone speaking a *different* language than
// whatever they've configured (they switched languages, forgot to change
// the setting, or -- as happened once -- someone tested with foreign-
// language audio). The recognizer can still hand back correctly-scripted
// text in that other language even though it was told to expect a
// different one, and the recent conversation context will look like a
// mismatch. Left unhandled, a model asked to "stay in the context's
// language" can get confused enough to refuse outright instead of just
// transcribing what's actually there -- which is exactly what leaking a
// paragraph like "No puedo procesar este fragmento..." into someone's
// caption looks like. Everything below is built to never do that: always
// trust what the candidate readings actually say over what the
// conversation *should* be in, always answer in a fixed, mechanical format
// instead of open-ended prose, and always fall back to the raw reading
// rather than ever surface model chatter as a "transcription".
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

const LANGUAGE_MISMATCH_RULE =
  "Las lecturas candidatas son SIEMPRE tu fuente de verdad sobre qué idioma se habló, incluso " +
  "si el contexto reciente de la conversación está en otro idioma -- eso solo significa que la " +
  "persona cambió de idioma, que estás escuchando a alguien nuevo, o que hay más de un idioma " +
  "en la reunión (esta app traduce en vivo entre idiomas, así que eso es normal y esperado). " +
  "Nunca fuerces el fragmento al idioma del contexto ni trates un idioma distinto como un " +
  "error a corregir.";

const NEVER_REFUSE_RULE =
  "Nunca respondas con una explicación, una pregunta, una disculpa, ni digas que no podés " +
  "procesar algo o que necesitás más información -- siempre completá el formato de respuesta " +
  "pedido con tu mejor estimación posible, aunque tengas dudas. Es preferible una estimación " +
  "imperfecta a no responder.";

function buildUserMessage(alternatives: string[], recentContext: string[]): string {
  const contextBlock = recentContext.length
    ? `Contexto reciente de la conversación (más antiguo primero):\n${recentContext.join("\n")}\n\n`
    : "";
  const alternativesBlock = alternatives.map((a, i) => `${i + 1}. ${a}`).join("\n");
  return `${contextBlock}Lecturas candidatas del mismo fragmento:\n${alternativesBlock}`;
}

// Anything this long or this apologetic/question-y is not a transcription
// fragment -- it's the model breaking format despite instructions. Better to
// silently fall back than ever show a user a paragraph like this as their
// caption.
function looksLikeModelChatter(text: string): boolean {
  if (text.length > 300) return true;
  const lower = text.toLowerCase();
  return [
    "no puedo",
    "no tengo suficiente",
    "¿podrías",
    "podrías proporcionar",
    "necesito lecturas",
    "necesito más",
    "como asistente",
    "lo siento",
    "disculpa",
    "no está claro",
    // The system prompt is in Spanish, but never trust that a confused
    // model won't slip into English when it breaks format anyway.
    "i cannot",
    "i can't",
    "i'm sorry",
    "as an ai",
    "could you provide",
  ].some((phrase) => lower.includes(phrase));
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

${LANGUAGE_MISMATCH_RULE}

${NEVER_REFUSE_RULE}

Reglas estrictas:
- Elegí o reconstruí la versión más coherente del fragmento, dando prioridad a lo que ya
  aparece en alguna de las lecturas candidatas antes que a inventar una palabra que no esté
  sugerida por ninguna de ellas.
- Corregí el fragmento en el idioma en el que realmente está (el de las lecturas candidatas) --
  no lo traduzcas a otro idioma.
- No parafrasees, no resumas, no agregues ni saques contenido más allá de corregir errores
  claros de reconocimiento.
- Si la primera lectura ya tiene sentido tal cual está, dejala exactamente igual, sin cambios.

Formato de respuesta obligatorio, EXACTAMENTE estas dos líneas y nada más (sin texto antes ni
después):
IDIOMA: <código de idioma de 2 letras del fragmento final -- ej: es, en, zh, it, pt, fr, de, ja>
TEXTO: <el fragmento corregido>`;

export interface CleanupResult {
  text: string;
  // Best-guess short language code (e.g. "es", "zh") for what was actually
  // said, which may differ from whatever the participant has configured.
  // null when Claude is unavailable/unreliable -- callers should fall back
  // to the participant's configured language in that case.
  detectedLang: string | null;
}

function parseCleanupResponse(raw: string, fallback: string): CleanupResult {
  const langMatch = raw.match(/IDIOMA:\s*([a-z]{2})/i);
  const textMatch = raw.match(/TEXTO:\s*([\s\S]*)/i);
  const text = textMatch?.[1]?.trim();

  if (!text || looksLikeModelChatter(text)) {
    return { text: fallback, detectedLang: null };
  }
  return { text, detectedLang: langMatch?.[1]?.toLowerCase() ?? null };
}

export async function cleanTranscriptFragment(
  alternatives: string[],
  recentContext: string[]
): Promise<CleanupResult> {
  const trimmedAlternatives = alternatives.map((a) => a.trim()).filter(Boolean);
  const best = trimmedAlternatives[0] ?? "";
  if (!anthropicClient || !best) return { text: best, detectedLang: null };

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
        return parseCleanupResponse(block.text, best);
      }
    }
    return { text: best, detectedLang: null };
  } catch {
    // Timeout, rate limit, network error, etc. -- never block captions on this.
    return { text: best, detectedLang: null };
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

${LANGUAGE_MISMATCH_RULE}

${NEVER_REFUSE_RULE}

Tu tarea, en dos pasos internos (pero respondé ÚNICAMENTE con el resultado del paso 2, nunca
muestres el paso 1 ni menciones en qué idioma estaba el original):
1. Reconstruí mentalmente cuál es la versión más coherente del fragmento original -- en el
   idioma en el que las lecturas candidatas realmente están --, dando prioridad a lo que ya
   aparece en alguna lectura candidata antes que a inventar algo que ninguna sugiere.
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
        if (!translated || looksLikeModelChatter(translated)) return null;
        return translated;
      }
    }
    return null;
  } catch {
    return null;
  }
}
