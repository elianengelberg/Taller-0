// Translation provider. Uses the free MyMemory API (no API key required) so the
// project runs out of the box. Swap the implementation of `translateText` below
// to plug in a production-grade provider (DeepL, Google Cloud Translation, etc.)
// without touching any of the call sites.

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 1000 * 60 * 30;

function shortLang(lang: string): string {
  return lang.split("-")[0].toLowerCase();
}

function cacheKey(text: string, source: string, target: string): string {
  return `${shortLang(source)}|${shortLang(target)}|${text}`;
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

  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", trimmed);
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

  cache.set(key, { value: translated, expiresAt: Date.now() + CACHE_TTL_MS });
  return translated;
}
