import { createLogger, type ModelOption } from "@lobu/core";

const logger = createLogger("fetch-model-options");

/**
 * Generic JSON model-list fetcher.
 *
 * Provider modules (Claude, ChatGPT, OpenAI-compat, Ollama, Gemini, …) each
 * GET a `/models` endpoint and reshape the response into `ModelOption[]`. The
 * mechanics are identical: fetch → parse JSON → map to `{ value: "${prefix}/${id}", label }`.
 * The variation lives in two places — auth (Bearer header vs `?key=` query
 * vs Anthropic's `x-api-key`) and the response shape — so the helper takes
 * both as inputs.
 *
 * Returns `[]` on any failure (network, non-2xx, JSON parse). Callers that
 * want a fallback model list should check for an empty array.
 */
export async function fetchModelOptions<T>(opts: {
  url: string;
  headers?: Record<string, string>;
  prefix: string;
  signal?: AbortSignal;
  strict?: boolean;
  pick: (payload: T) => Array<{ id: string; label?: string } | null>;
}): Promise<ModelOption[]> {
  let payload: T;
  try {
    const response = await fetch(opts.url, {
      headers: { Accept: "application/json", ...opts.headers },
      redirect: "error",
      signal: opts.signal ?? AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Model catalog returned HTTP ${response.status}`);
    }
    payload = await response.json() as T;
  } catch {
    // No URL, headers, or upstream body in diagnostics at the credential boundary.
    if (opts.strict) throw new Error("Model catalog request failed");
    logger.warn("Model catalog request failed");
    return [];
  }
  return opts
    .pick(payload)
    .filter((item): item is { id: string; label?: string } => Boolean(item))
    .map((item) => ({
      value: `${opts.prefix}/${item.id}`,
      label: item.label ?? item.id,
    }));
}
