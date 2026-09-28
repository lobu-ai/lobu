import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";

const output = new URL(
  "../packages/server/src/generated/models-dev.json",
  import.meta.url
);

// A release packages this immutable snapshot. Reuse it for subsequent builds
// in the same checkout; --refresh explicitly starts a new catalog revision.
async function buildModelCatalog() {
  if (existsSync(output) && !process.argv.includes("--refresh")) return;
  const response = await fetch("https://models.dev/api.json", {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`models.dev: HTTP ${response.status}`);
  const raw = await response.text();
  const providers = JSON.parse(raw);
  const models = {};
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider.models || typeof provider.models !== "object")
      throw new Error(`Invalid models.dev provider: ${providerId}`);
    models[providerId] = {};
    for (const [id, model] of Object.entries(provider.models)) {
      if (!model.modalities?.output?.includes("text")) continue;
      const input = model.modalities.input.filter(
        (value) => value === "text" || value === "image"
      );
      const contextWindow = model.limit?.context;
      const maxTokens = model.limit?.output;
      if (
        !input.includes("text") ||
        !Number.isSafeInteger(contextWindow) ||
        contextWindow <= 0
      )
        continue;
      models[providerId][id] = {
        input,
        contextWindow,
        maxTokens:
          Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : null,
        reasoning: model.reasoning,
        toolCall: model.tool_call,
      };
    }
  }
  if (
    !Object.values(models).some((provider) => Object.keys(provider).length > 0)
  )
    throw new Error("models.dev returned an empty catalog");
  const revision = createHash("sha256").update(raw).digest("hex");
  mkdirSync(new URL(".", output), { recursive: true });
  const temporary = new URL(`models-dev.${process.pid}.tmp`, output);
  writeFileSync(temporary, JSON.stringify({ revision, models }));
  renameSync(temporary, output);
  console.log(`models.dev snapshot: ${revision}`);
}

await buildModelCatalog();
