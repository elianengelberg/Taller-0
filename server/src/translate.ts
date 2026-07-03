// Translation provider. When ANTHROPIC_API_KEY is configured, uses Claude
// Haiku (fast + cheap, no extended thinking needed for a short phrase) so
// live captions/chat keep up with a real conversation. Falls back to the
// free, keyless MyMemory API otherwise so the app still works without any
// extra setup -- just slower and less reliable under load.
import { anthropicClient, anthropicEnabled } from "./anthropicClient";

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 1000 * 60 * 30;

// Deliberately NOT the same (larger, slower) model used for the AI Q&A
// feature: translation is high-volume and latency-sensitive, and a short
// phrase doesn't benefit from extra reasoning power.
const TRANSLATE_MODEL = process.env.ANTHROPIC_TRANSLATE_MODEL || "claude-haiku-4-5";

const LANGUAGE_NAMES: Record<string, string> = {
  es: "Spanish",
  en: "English",
  pt: "Portuguese",
  fr: "French",
  it: "Italian",
  de: "German",
  // Explicit about the script, not just the language: mainland China,
  // Singapore, etc. use simplified characters (简体字); Taiwan/Hong Kong use
  // traditional (繁體字). Naming it plainly "Chinese" left the model free to
  // pick either -- this pins every translation/correction to simplified.
  zh: "Simplified Chinese",
  ja: "Japanese",
};

// Real linguistic knowledge for the two languages worth calling out
// explicitly -- not a "training" step (Claude already knows these languages
// deeply; there's no separate study phase to run), but concrete failure
// patterns worth naming so the model actively watches for them instead of
// just doing generic correction/translation. Keyed by short language code;
// only languages where this pays off are listed.
const LANGUAGE_EXPERTISE: Partial<Record<string, string>> = {
  zh:
    "Chino: escribí SIEMPRE en caracteres simplificados (简体字), nunca en tradicionales (繁體字), " +
    "sin importar qué haya usado el reconocimiento de voz o el texto de origen. El reconocimiento de " +
    "voz en chino se equivoca casi siempre por HOMÓFONOS -- muchos caracteres distintos suenan igual o " +
    "casi igual, a veces la única diferencia es el tono (ej: 是/十/时/使/世 se pronuncian todos \"shi\"; " +
    "在/再 ambos \"zai\"; 你/泥/逆 todos \"ni\"). Usá tu conocimiento del pinyin y qué carácter tiene " +
    "sentido semántico en el contexto para elegir el correcto -- no asumas que el primero que dio el " +
    "reconocimiento es el correcto solo por aparecer primero entre las alternativas. El chino no separa " +
    "las palabras con espacios: prestá atención a dónde probablemente empieza y termina cada palabra " +
    "dentro del fragmento antes de corregirlo o traducirlo.",
  de:
    "Alemán: prestá especial atención a la diéresis (ä, ö, ü) y a la ß (Eszett) -- el reconocimiento de " +
    "voz muchas veces las reemplaza por la vocal simple o por \"ae\"/\"oe\"/\"ue\"/\"ss\", lo que cambia " +
    "el significado real de la palabra (ej: \"schon\" ≠ \"schön\", \"Strasse\" ≠ \"Straße\", \"fuer\" ≠ " +
    "\"für\", \"Bar\" ≠ \"Bär\"). El alemán también forma sustantivos compuestos largos uniendo varias " +
    "palabras sin espacio (ej: \"Lebensmittelgeschäft\"); el reconocimiento a veces los separa por error " +
    "en palabras sueltas sin sentido -- reconstruilos como una sola palabra compuesta cuando el contexto " +
    "lo sugiera. Los sustantivos en alemán siempre llevan mayúscula inicial.",
};

export function shortLang(lang: string): string {
  return lang.split("-")[0].toLowerCase();
}

export function languageName(code: string): string {
  return LANGUAGE_NAMES[shortLang(code)] ?? code;
}

// Returns the combined expertise notes for whichever of the given codes have
// one, deduped by short code, in a form ready to drop into a system prompt.
// Codes with no specific entry are silently skipped (nothing to add).
export function languageExpertiseHints(codes: string[]): string {
  const seen = new Set<string>();
  const hints: string[] = [];
  for (const code of codes) {
    const short = shortLang(code);
    const hint = LANGUAGE_EXPERTISE[short];
    if (hint && !seen.has(short)) {
      seen.add(short);
      hints.push(hint);
    }
  }
  return hints.join("\n\n");
}

function cacheKey(text: string, source: string, target: string): string {
  return `${shortLang(source)}|${shortLang(target)}|${text}`;
}

async function translateWithClaude(text: string, from: string, to: string): Promise<string> {
  const expertise = languageExpertiseHints([from, to]);
  const system =
    `Translate the user's message from ${languageName(from)} to ${languageName(to)}. ` +
    `Reply with ONLY the translated text -- no quotes, no notes, no explanations.` +
    (expertise ? `\n\n${expertise}` : "");
  const response = await anthropicClient!.messages.create({
    model: TRANSLATE_MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: text }],
  });

  for (const block of response.content) {
    if (block.type === "text") return block.text.trim();
  }
  throw new Error("Claude no devolvió texto traducido");
}

async function translateWithMyMemory(text: string, from: string, to: string): Promise<string> {
  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", text);
  url.searchParams.set("langpair", `${from}|${to}`);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Translation provider responded with ${response.status}`);
  }

  const data = (await response.json()) as {
    responseData?: { translatedText?: string };
    responseStatus?: number;
  };

  const translated = data.responseData?.translatedText;
  if (!translated) {
    throw new Error("Translation provider returned no result");
  }
  return translated;
}

export async function translateText(
  text: string,
  source: string,
  target: string
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return "";

  const from = shortLang(source);
  const to = shortLang(target);
  if (from === to) return text;

  const key = cacheKey(trimmed, from, to);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const translated = anthropicEnabled
    ? await translateWithClaude(trimmed, from, to)
    : await translateWithMyMemory(trimmed, from, to);

  cache.set(key, { value: translated, expiresAt: Date.now() + CACHE_TTL_MS });
  return translated;
}
