import { SERVER_URL } from "./socket";

const cache = new Map<string, string>();

function key(text: string, source: string, target: string): string {
  return `${source}|${target}|${text}`;
}

// `context`: las últimas líneas de la charla (sin la que se traduce). "No lo
// veo" se traduce distinto si venían hablando de un archivo o de una
// persona; el servidor ordena a la IA no traducir el contexto, sólo usarlo.
export async function translate(
  text: string,
  source: string,
  target: string,
  context: string[] = []
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (source.split("-")[0] === target.split("-")[0]) return text;

  const cacheKey = key(trimmed, source, target);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const response = await fetch(`${SERVER_URL}/api/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: trimmed, source, target, context: context.slice(-3) }),
  });

  if (!response.ok) {
    throw new Error("No se pudo traducir el mensaje.");
  }

  const data = (await response.json()) as { translatedText: string };
  cache.set(cacheKey, data.translatedText);
  return data.translatedText;
}
