import { createLogger } from "@lobu/core";

const logger = createLogger("models-dev");

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 60 * 60 * 1000;

/** One provider's models in the models.dev catalog, keyed by model id. */
export interface ModelsDevProvider {
  /** Entries are fetched JSON, so each is checked before use. */
  models?: Record<string, unknown>;
}

type ModelsDevCatalog = Record<string, ModelsDevProvider | undefined>;

// A process-local cache is acceptable here: it holds a public, read-only
// catalog, not tenant or shared state, so each replica keeping its own copy
// cannot diverge in a way that matters.
let cached: { at: number; catalog: ModelsDevCatalog } | undefined;
let inFlight: Promise<ModelsDevCatalog | undefined> | undefined;

async function fetchModelsDevCatalog(): Promise<ModelsDevCatalog | undefined> {
  try {
    const response = await fetch(MODELS_DEV_URL, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`models.dev returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("models.dev returned an unexpected payload");
    }
    cached = { at: Date.now(), catalog: payload as ModelsDevCatalog };
    return cached.catalog;
  } catch {
    // Keep filtering with the last catalog models.dev returned; only a
    // process that has never reached it lists models unfiltered.
    logger.warn(
      cached
        ? "models.dev catalog refresh failed; filtering with the last fetched catalog"
        : "models.dev catalog unavailable; model listings stay unfiltered",
    );
    return cached?.catalog;
  }
}

/**
 * The models.dev entry for one provider, or undefined when the provider has no
 * models.dev id or no catalog has ever been fetched (callers then fail open).
 * After the cache expires, a failed refresh keeps the last fetched catalog.
 */
export async function loadModelsDevProvider(
  modelsDevId: string | undefined,
): Promise<ModelsDevProvider | undefined> {
  if (!modelsDevId) return undefined;
  let catalog: ModelsDevCatalog | undefined;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    catalog = cached.catalog;
  } else {
    inFlight ??= fetchModelsDevCatalog().finally(() => {
      inFlight = undefined;
    });
    catalog = await inFlight;
  }
  return catalog && Object.hasOwn(catalog, modelsDevId)
    ? catalog[modelsDevId]
    : undefined;
}

/**
 * Keep the models an agent can run: ones models.dev lists under this provider
 * as current, text-producing and able to call tools. models.dev uses each
 * provider's own model ids, so this also drops what a provider's raw listing
 * mixes in (speech, image, embedding, moderation and retired models). A model
 * models.dev has not recorded yet stays usable as a typed model id. Without a
 * models.dev entry for the provider the listing is returned unfiltered.
 */
export function filterModelsByModelsDev<T extends { id: string }>(
  models: T[],
  provider: ModelsDevProvider | undefined,
): T[] {
  const known = provider?.models;
  if (!known || typeof known !== "object") return models;
  return models.filter((model) => {
    const entry = Object.hasOwn(known, model.id) ? known[model.id] : undefined;
    if (!entry || typeof entry !== "object") return false;
    const { status, tool_call, modalities } = entry as {
      status?: unknown;
      tool_call?: unknown;
      modalities?: { output?: unknown } | null;
    };
    const output = modalities?.output;
    return (
      status !== "deprecated" &&
      tool_call === true &&
      Array.isArray(output) &&
      output.includes("text")
    );
  });
}

export function __resetModelsDevCacheForTests(): void {
  cached = undefined;
  inFlight = undefined;
}
