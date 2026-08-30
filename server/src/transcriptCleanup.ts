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
import { languageExpertiseHints, languageName, translateText } from "./translate";

// Mismo motor que la traducción (Sonnet 5, el punto medio): corrige los
// homófonos del chino y los compuestos del alemán casi como el modelo
// grande, pero con la velocidad que un subtítulo en vivo pide. Sin
// razonamiento extra, temperatura 0, system cacheado y el timeout duro.
const CLEANUP_MODEL = process.env.ANTHROPIC_TRANSCRIPT_MODEL || "claude-sonnet-5";
// Live captions need to feel instant -- if the correction call takes too
// long, ship the raw recognized text instead of stalling the conversation.
// 4,5 s y no menos: con 3,5 s una porción real de correcciones se vencía y
// la línea salía CRUDA -- "subtítulos flojos" sin ningún error a la vista.
// El subtítulo en vivo no espera a esto (se pinta local al instante); esto
// demora sólo la versión buena de la línea del panel/historial.
const CLEANUP_TIMEOUT_MS = 4500;
// Las traducciones NO bloquean el subtítulo (llegan como parche sobre la
// línea ya emitida), así que pueden esperar más. Con el timeout corto de la
// corrección, una llamada multi-idioma se vencía seguido y caía EN SILENCIO
// al proveedor gratuito: eso era literalmente "las traducciones flojas" --
// se pagaba Sonnet y se servía el traductor de respaldo.
const TRANSLATE_TIMEOUT_MS = 9000;

// Every language the app offers has an expertise entry (which itself
// includes that language's own translated app-vocabulary anchors -- see
// DOMAIN_VOCAB in translate.ts), but always dumping all eight into every
// single call (regardless of which language is even remotely relevant) made
// each system prompt roughly 4x longer with mostly irrelevant examples --
// risking diluting the model's adherence to the much more important "always
// correct/translate the WHOLE fragment" instructions below. Scoped instead
// to whichever language(s) are actually plausible for this call (the
// caller's best guess at who's speaking, plus -- for translation --
// whichever languages it's translating into); falls back to every language
// only if no guess is available at all.
const ALL_EXPERTISE_LANGS = ["es", "en", "pt", "fr", "it", "de", "zh", "ja"];

function expertiseBlockFor(relevantCodes: (string | undefined)[]): string {
  const codes = relevantCodes.filter((c): c is string => Boolean(c));
  return languageExpertiseHints(codes.length ? codes : ALL_EXPERTISE_LANGS);
}

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
  "imperfecta a no responder. Ejemplos concretos de respuestas PROHIBIDAS, sin importar cuán " +
  "razonables parezcan: \"No pude entender bien el inglés/alemán/etc., ¿podrían hablar más " +
  "claro?\", \"Necesitaríamos que traduzcan esto\", \"No quedó claro en qué idioma está esto\" -- " +
  "ninguna de estas es una transcripción válida, son comentarios sobre la tarea, y jamás tienen " +
  "que aparecer como resultado. Si dos idiomas te parecen igual de posibles (por ejemplo, sonidos " +
  "que podrían ser tanto alemán como inglés), elegí la interpretación más probable en UN solo " +
  "idioma y corregí el fragmento ahí -- nunca comentes la ambigüedad ni pidas que se aclare.";

// A fragment that starts with something short and recognizable on its own
// (a greeting, a yes/no) is still ONE fragment, not a cue to stop early --
// this exists because a model can be tempted to treat the recognizable part
// as "the complete thought" and drop whatever comes after it.
const NEVER_TRUNCATE_RULE =
  "El resultado tiene que cubrir TODO el contenido de la lectura candidata más completa, de " +
  "principio a fin, incluso si al principio del fragmento hay un saludo, una pregunta corta u " +
  "otra frase que ya suene completa por sí sola -- eso NO es una señal para cortar ahí. Nunca " +
  "devuelvas solo la primera parte de un fragmento más largo.";

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
//
// This started as a list of exact phrases, but every real leak so far has
// been a slightly different conjugation of the same underlying pattern --
// "no puedo" caught a Mandarin leak, then "no pude" (past tense) slipped a
// German/English one straight through the same list. Matching word STEMS
// instead of whole phrases is meant to survive the next conjugation too,
// instead of turning into a permanent game of whack-a-mole.
//
// A stem alone isn't enough, though -- "no pude" or "disculpen" are things
// real meeting participants genuinely say ("no pude terminar el informe",
// "disculpen la demora"), so those only count as chatter when they show up
// together with a reference to the language/translation task itself, which
// is what actually distinguishes the model talking about ITS OWN job from
// someone's real spoken content. A short list of phrases that are never
// legitimate spoken content either way (no meeting participant introduces
// themselves as "as an assistant") are flagged on their own.
const ALWAYS_CHATTER: RegExp[] = [/\bcomo\s+asistente\b/, /\bas\s+an\s+ai\b/];

const REFUSAL_STEM =
  /\bno\s+(puedo|pude|podemos|pudimos|logro|logr[eé]|logramos|se\s+pudo|fue\s+posible|es\s+posible|est[aá]\s+claro|qued[oó]\s+claro|entend[ií])\b|\b(lo\s+siento|disculp[ae])\b|\bi'?m\s+sorry\b|\bi\s+(cannot|can't|couldn't|could\s+not|am\s+unable)\b/;

const TASK_REFERENCE =
  /\b(idioma|language|ingl[eé]s|alem[aá]n|espa[ñn]ol|franc[eé]s|italiano|portugu[eé]s|chino|mandar[ií]n|japon[eé]s|fragmento|audio|reconocimiento|lectura|transcrib|traduc)\b/;

// A direct request/instruction aimed at the reader is inherently meta -- a
// transcription of what someone said never asks the reader to do something
// about the transcription process -- so these don't need the task-reference
// co-occurrence check.
const META_REQUEST =
  /\b(necesit(o|amos|ar[ií]a)|ser[ií]a\s+necesario|podr[ií]an|podr[ií]as|could\s+you|please)\b.{0,40}\b(traduc|hablar|aclarar|clarificar|repetir|repitan|speak|translate|clarify|repeat)/;

function looksLikeModelChatter(text: string): boolean {
  if (text.length > 300) return true;
  const lower = text.toLowerCase();
  if (ALWAYS_CHATTER.some((pattern) => pattern.test(lower))) return true;
  if (META_REQUEST.test(lower)) return true;
  return REFUSAL_STEM.test(lower) && TASK_REFERENCE.test(lower);
}

function buildCleanupSystemPrompt(expertiseBlock: string): string {
  return `Corregís fragmentos cortos de una transcripción de voz a texto en vivo. El
reconocimiento de voz a veces confunde una palabra con otra parecida fonéticamente pero sin
sentido en el contexto, lo que rompe el significado de la frase.

Para cada fragmento te paso varias lecturas candidatas que el propio reconocimiento de voz
generó para el mismo audio (ordenadas de más a menos probable según el reconocimiento), más el
contexto reciente de la conversación. Estas lecturas alternativas son tu pista más fuerte de
qué se dijo realmente -- muchas veces la palabra correcta aparece en una alternativa aunque no
sea la primera. Esto es una videollamada, así que las palabras propias de la app aparecen
seguido en la conversación (más abajo hay una lista específica del idioma correspondiente, si
está disponible).

${LANGUAGE_MISMATCH_RULE}

${NEVER_REFUSE_RULE}

${NEVER_TRUNCATE_RULE}

${expertiseBlock}

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
TEXTO: <el fragmento corregido, completo de principio a fin>`;
}

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
// Both caches only ever grow (expired entries are checked, not swept) --
// cap them so a long-running server doesn't accumulate entries forever.
const CACHE_MAX_ENTRIES = 3000;

function boundedSet<V>(map: Map<string, V>, key: string, value: V): void {
  if (map.size >= CACHE_MAX_ENTRIES) {
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
  }
  map.set(key, value);
}

// `expectedLang` is the caller's best guess at who's speaking (their
// configured language) -- used only to scope which languages' expertise
// notes are worth including, never to force the correction into that
// language (LANGUAGE_MISMATCH_RULE still overrides it if the candidate
// readings say otherwise).
export async function cleanTranscriptFragment(
  alternatives: string[],
  recentContext: string[],
  expectedLang?: string
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
        temperature: 0,
        // El system por idioma se repite en cada frase: cacheado, la reunión
        // entera paga las instrucciones una sola vez y responde más rápido.
        system: [
          {
            type: "text" as const,
            text: buildCleanupSystemPrompt(expertiseBlockFor([expectedLang])),
            cache_control: { type: "ephemeral" as const },
          },
        ],
        messages: [{ role: "user", content: buildUserMessage(trimmedAlternatives, recentContext) }],
      },
      { timeout: CLEANUP_TIMEOUT_MS }
    );
    for (const block of response.content) {
      if (block.type === "text") {
        const result = parseCleanupResponse(block.text, best);
        if (cacheKey && result.detectedLang) {
          boundedSet(cleanupCache, cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
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
function translateAllSystemPrompt(targets: { code: string; name: string }[], expertiseBlock: string): string {
  const targetList = targets.map((t) => `${t.name} (código ${t.code})`).join(", ");
  const responseLines = targets.map((t) => `TRAD_${t.code}: <traducción del fragmento corregido a ${t.name}>`).join("\n");
  return `Te paso varias lecturas candidatas que un reconocimiento de voz en vivo generó para el
mismo fragmento de audio (ordenadas de más a menos probable), más el contexto reciente de la
conversación. El reconocimiento a veces confunde una palabra con otra que suena parecida pero
no tiene sentido en el contexto. Esto es una videollamada, así que las palabras propias de la
app aparecen seguido en la conversación (más abajo hay una lista específica del idioma
correspondiente, si está disponible).

${LANGUAGE_MISMATCH_RULE}

${NEVER_REFUSE_RULE}

${NEVER_TRUNCATE_RULE}

${expertiseBlock}

Tu tarea:
1. Reconstruí cuál es la versión más coherente del fragmento original -- en el idioma en el
   que las lecturas candidatas realmente están --, dando prioridad a lo que ya aparece en
   alguna lectura candidata antes que a inventar algo que ninguna sugiere.
2. Traducí esa versión corregida a cada uno de estos idiomas: ${targetList}.

Reglas:
- Si no hay ambigüedad real entre las lecturas, no inventes cambios -- traducí tal cual dice
  la lectura más probable.
- No agregues ni saques contenido más allá de lo que ya está en el fragmento.
- Cada traducción tiene que cubrir el fragmento COMPLETO, de principio a fin -- ninguna
  traducción puede quedarse corta ni cortar el final aunque el principio ya suene completo.
- Cada traducción tiene que basarse en la MISMA versión corregida del fragmento -- no
  reinterpretes el fragmento de forma distinta para cada idioma.
- Esto es HABLA de una reunión en vivo, no un documento: traducí como lo diría un hablante
  nativo conversando -- registro oral natural del idioma destino, no una traducción palabra
  por palabra. Los modismos y frases hechas se traducen por su SENTIDO (el equivalente
  natural en el idioma destino), nunca literalmente.
- Usá el contexto reciente de la conversación para desambiguar pronombres, género y de qué
  se está hablando: la traducción tiene que sonar como parte de ESA charla.
- Los nombres propios, marcas, números, siglas y términos técnicos que se dicen en su forma
  original quedan tal cual -- no los traduzcas ni los "corrijas".

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
// `sourceLangHint` is the caller's best guess at who's speaking -- like in
// `cleanTranscriptFragment`, only used to scope which languages' expertise
// notes are worth including.
export async function translateFragmentToAll(
  alternatives: string[],
  recentContext: string[],
  targetLangCodes: string[],
  sourceLangHint?: string
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
  const expertiseBlock = expertiseBlockFor([sourceLangHint, ...targetLangCodes]);

  try {
    const response = await anthropicClient.messages.create(
      {
        model: CLEANUP_MODEL,
        max_tokens: 1536,
        temperature: 0,
        // Mismo caché que arriba: el juego de idiomas destino de una reunión
        // no cambia frase a frase.
        system: [
          {
            type: "text" as const,
            text: translateAllSystemPrompt(targets, expertiseBlock),
            cache_control: { type: "ephemeral" as const },
          },
        ],
        messages: [{ role: "user", content: buildUserMessage(trimmedAlternatives, recentContext) }],
      },
      { timeout: TRANSLATE_TIMEOUT_MS }
    );
    for (const block of response.content) {
      if (block.type === "text") {
        const translations = parseTranslateAllResponse(block.text, targets);
        if (fullCacheKey && Object.keys(translations).length === targetLangCodes.length) {
          boundedSet(translateAllCache, fullCacheKey, { result: translations, expiresAt: Date.now() + CACHE_TTL_MS });
        }
        // NADIE se queda sin su idioma. Si la respuesta vino incompleta (una
        // línea con formato roto, un idioma filtrado por el detector de
        // parloteo), esos idiomas se rellenan uno por uno -- antes acá se
        // devolvía lo que hubiera y la línea quedaba SIN traducir para esas
        // personas, para siempre y sin ningún error a la vista.
        const faltantes = targetLangCodes.filter((code) => !translations[code]);
        if (faltantes.length > 0) {
          Object.assign(translations, await traducirUnoPorUno(best, faltantes, sourceLangHint));
        }
        return translations;
      }
    }
    return await traducirUnoPorUno(best, targetLangCodes, sourceLangHint);
  } catch {
    // Claude caído no deja la reunión sin traducciones: se traduce la mejor
    // lectura idioma por idioma con translateText, que a su vez cae al
    // proveedor gratuito. Degradado (sin el contexto de la charla), pero vivo.
    return await traducirUnoPorUno(best, targetLangCodes, sourceLangHint);
  }
}

async function traducirUnoPorUno(
  texto: string,
  targetLangCodes: string[],
  sourceLangHint?: string
): Promise<Record<string, string>> {
  // Sin idioma de origen no hay respaldo posible: el proveedor gratuito
  // rechaza "auto" como origen (con un error DENTRO de un 200, ya aprendido).
  if (!sourceLangHint) return {};
  const result: Record<string, string> = {};
  // Pocos idiomas por sala (los que hablan los presentes); igual se acota por
  // cortesía con el proveedor de respaldo.
  for (const code of targetLangCodes.slice(0, 4)) {
    try {
      result[code] = await translateText(texto, sourceLangHint, code);
    } catch {
      // Sin ese idioma: la línea queda en original para esa persona.
    }
  }
  return result;
}
