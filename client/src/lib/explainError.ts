import { SERVER_URL } from "./socket";

const cache = new Map<string, string>();

// Best-effort: turns a raw/cryptic error into a plain-Spanish sentence via
// the server's Claude-backed endpoint. Always resolves -- falls back to the
// raw error text (never throws, never leaves the caller hanging) if the AI
// isn't configured, the request fails, or it takes too long.
export async function explainError(rawError: string, context?: string): Promise<string> {
  const trimmed = rawError.trim();
  if (!trimmed) return rawError;

  const cached = cache.get(trimmed);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  try {
    const response = await fetch(`${SERVER_URL}/api/explain-error`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: trimmed, context }),
      signal: controller.signal,
    });
    if (!response.ok) return rawError;

    const data = (await response.json()) as { explanation: string | null };
    if (!data.explanation) return rawError;

    cache.set(trimmed, data.explanation);
    return data.explanation;
  } catch {
    return rawError;
  } finally {
    clearTimeout(timeout);
  }
}
