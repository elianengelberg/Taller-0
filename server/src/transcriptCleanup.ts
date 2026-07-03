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
import { languageExpertiseHints, languageName } from "./translate";

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

// The fragment's language isn't known until the model figures it out (that's
// part of its job here), so this can't be scoped to "only when it's Chinese"
// in advance -- it's always included, self-scoped by its own "cuando el
// fragmento esté en..." wording, and simply doesn't apply when the fragment
// turns out to be some other language.
const KNOWN_EXPERTISE_LANGS = ["zh", "de"];
const LANGUAGE_EXPERTISE_BLOCK = languageExpertiseHints(KNOWN_EXPERTISE_LANGS);

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

${LANGUAGE_EXPERTISE_BLOCK}

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

// Short, everyday utterances ("hola", "gracias", "listo", "sí") come up
// over and over in a normal call and always resolve the same way regardless
// of context -- caching them skips a whole Claude round trip on repeat.
// Longer sentences essentially never repeat verbatim, so there's no upside
// (and some risk, since longer fragments are more context-dependent) to
// caching them -- they're not even looked up.
const CACHEABLE_MAX_CHARS = 60;
const CACHE_TTL_MS = 60 * 60 * 1000;

function normalizeForCache(text: string): string | null {
  const normalized = text.trim().toLowerCase().replace(/[.,!?¡¿]+$/g, "").replace(/\s+/g, " ");
  if (!normalized || normalized.length > CACHEABLE_MAX_CHARS) return null;
  return normalized;
}

const cleanupCache = new Map<string, { result: CleanupResult; expiresAt: number }>();

export async function cleanTranscriptFragment(
  alternatives: string[],
  recentContext: string[]
): Promise<CleanupResult> {
  const trimmedAlternatives = alternatives.map((a) => a.trim()).filter(Boolean);
  const best = trimmedAlternatives[0] ?? "";
  if (!anthropicClient || !best) return { text: best, detectedLang: null };

  const cacheKey = normalizeForCache(best);
  if (cacheKey) {
    const cached = cleanupCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
  }

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
        const result = parseCleanupResponse(block.text, best);
        if (cacheKey && result.detectedLang) {
          cleanupCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
        }
        return result;
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
// language caption) instead of waiting for it.
//
// It also used to fire one of these calls PER target language (three people
// in the meeting speaking three different languages than the speaker meant
// three separate Claude calls, each silently redoing the exact same "what
// did they actually say" correction internally). Asking for every
// translation in one shot cuts that back to a single call: cheaper, and
// every language ends up translated from the exact same corrected text
// instead of three independently-reconstructed guesses that could disagree
// with each other on an ambiguous word.
function translateAllSystemPrompt(targets: { code: string; name: string }[]): string {
  const targetList = targets.map((t) => `${t.name} (código ${t.code})`).join(", ");
  const responseLines = targets.map((t) => `TRAD_${t.code}: <traducción del fragmento corregido a ${t.name}>`).join("\n");
  return `Te paso varias lecturas candidatas que un reconocimiento de voz en vivo generó para el
mismo fragmento de audio (ordenadas de más a menos probable), más el contexto reciente de la
conversación. El reconocimiento a veces confunde una palabra con otra que suena parecida pero
no tiene sentido en el contexto.

${DOMAIN_HINT}

${LANGUAGE_MISMATCH_RULE}

${NEVER_REFUSE_RULE}

${LANGUAGE_EXPERTISE_BLOCK}

Tu tarea:
1. Reconstruí cuál es la versión más coherente del fragmento original -- en el idioma en el
   que las lecturas candidatas realmente están --, dando prioridad a lo que ya aparece en
   alguna lectura candidata antes que a inventar algo que ninguna sugiere.
2. Traducí esa versión corregida a cada uno de estos idiomas: ${targetList}.

Reglas:
- Si no hay ambigüedad real entre las lecturas, no inventes cambios -- traducí tal cual dice
  la lectura más probable.
- No agregues ni saques contenido más allá de lo que ya está en el fragmento.
- Cada traducción tiene que basarse en la MISMA versión corregida del fragmento -- no
  reinterpretes el fragmento de forma distinta para cada idioma.

Formato de respuesta obligatorio, EXACTAMENTE estas líneas y nada más (sin texto antes ni
después, una línea por elemento, sin mostrar el fragmento corregido en su idioma original):
${responseLines}`;
}

// Parsed with a fixed pattern and cross-checked against `targets` by plain
// string comparison, rather than building a RegExp out of each code, since
// language codes ultimately trace back to unvalidated user input (the
// `set-language` socket event never restricts its format) -- interpolating
// one into a RegExp constructor would be a regex-injection/ReDoS risk.
function parseTranslateAllResponse(raw: string, targets: { code: string; name: string }[]): Record<string, string> {
  const wanted = new Set(targets.map((t) => t.code));
  const translations: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^TRAD_([A-Za-z]{2,8}):\s*(.+)$/);
    if (!match) continue;
    const code = match[1].toLowerCase();
    const value = match[2].trim();
    if (wanted.has(code) && value && !looksLikeModelChatter(value)) {
      translations[code] = value;
    }
  }
  return translations;
}

const translateAllCache = new Map<string, { result: Record<string, string>; expiresAt: number }>();

// `targetLangCodes` are already-deduped short codes (e.g. "en", not
// "en-US" -- see the caller, which collapses everyone speaking English
// variants into a single "en" translation instead of one per variant).
export async function translateFragmentToAll(
  alternatives: string[],
  recentContext: string[],
  targetLangCodes: string[]
): Promise<Record<string, string>> {
  const trimmedAlternatives = alternatives.map((a) => a.trim()).filter(Boolean);
  if (!anthropicClient || trimmedAlternatives.length === 0 || targetLangCodes.length === 0) return {};

  const best = trimmedAlternatives[0];
  const cacheKey = normalizeForCache(best);
  const fullCacheKey = cacheKey ? `${cacheKey}|${[...targetLangCodes].sort().join(",")}` : null;
  if (fullCacheKey) {
    const cached = translateAllCache.get(fullCacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
  }

  const targets = targetLangCodes.map((code) => ({ code, name: languageName(code) }));

  try {
    const response = await anthropicClient.messages.create(
      {
        model: CLEANUP_MODEL,
        max_tokens: 1536,
        system: translateAllSystemPrompt(targets),
        messages: [{ role: "user", content: buildUserMessage(trimmedAlternatives, recentContext) }],
      },
      { timeout: CLEANUP_TIMEOUT_MS }
    );
    for (const block of response.content) {
      if (block.type === "text") {
        const translations = parseTranslateAllResponse(block.text, targets);
        if (fullCacheKey && Object.keys(translations).length === targetLangCodes.length) {
          translateAllCache.set(fullCacheKey, { result: translations, expiresAt: Date.now() + CACHE_TTL_MS });
        }
        return translations;
      }
    }
    return {};
  } catch {
    return {};
  }
}
