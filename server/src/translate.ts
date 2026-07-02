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
  zh: "Chinese",
  ja: "Japanese",
};

function shortLang(lang: string): string {
  return lang.split("-")[0].toLowerCase();
}

function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

function cacheKey(text: string, source: string, target: string): string {
  return `${shortLang(source)}|${shortLang(target)}|${text}`;
}

async function translateWithClaude(text: string, from: string, to: string): Promise<string> {
  const response = await anthropicClient!.messages.create({
    model: TRANSLATE_MODEL,
    max_tokens: 1024,
    system:
      `Translate the user's message from ${languageName(from)} to ${languageName(to)}. ` +
      `Reply with ONLY the translated text -- no quotes, no notes, no explanations.`,
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
