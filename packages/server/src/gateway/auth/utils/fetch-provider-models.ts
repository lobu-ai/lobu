import type { ProviderModel } from "../../modules/module-system.js";

/**
 * The one JSON model-list fetcher every provider listing goes through.
 *
 * Provider modules (Claude, ChatGPT, OpenAI-compatible, Ollama, Gemini, …)
 * each GET a models endpoint and reshape the response. The mechanics are
 * identical: fetch → parse JSON → map to `{ id, label }`. The variation lives
 * in two places — auth headers and the response shape — so the helper takes
 * both as inputs.
 *
 * Throws on any failure (network, non-2xx, JSON parse). The error never
 * carries the URL, headers or upstream body: this is a credential boundary.
 */
export async function fetchProviderModels<T>(opts: {
  url: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  pick: (payload: T) => Array<{ id: string; label?: string } | null>;
}): Promise<ProviderModel[]> {
  let payload: T;
  try {
    const response = await fetch(opts.url, {
      headers: { Accept: "application/json", ...opts.headers },
      redirect: "error",
      signal: opts.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Model catalog returned HTTP ${response.status}`);
    }
    payload = (await response.json()) as T;
  } catch {
    throw new Error("Model catalog request failed");
  }
  return opts
    .pick(payload)
    .filter((item): item is { id: string; label?: string } => Boolean(item))
    .map((item) => ({ id: item.id, label: item.label || item.id }));
}
