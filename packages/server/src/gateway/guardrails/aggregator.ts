import {
  type Guardrail,
  type GuardrailRegistry,
  type GuardrailStage,
  createLogger,
} from "@lobu/core";
import type { ApplyingGuardrail } from "../../guardrails/workspace-guardrails.js";

const logger = createLogger("guardrail-aggregator");

const MESSAGE_STAGES = ["input", "output", "pre-tool"] as const;

/**
 * Materialize the message-pipeline guardrails (input, output, pre-tool) from
 * the library rows `resolveGuardrails` returned for a principal.
 *
 * Guardrails accumulate: every row runs, under its own library name, and any
 * trip wins. Nothing is deduplicated or shadowed by name. A row runs the
 * registered built-in at every stage it implements; a row naming an unknown
 * built-in is logged and skipped, the same posture as
 * `GuardrailRegistry.resolve()`.
 */
export function buildGuardrailsByStage(
  guardrails: readonly ApplyingGuardrail[],
  registry: GuardrailRegistry
): Record<GuardrailStage, Guardrail[]> {
  const byStage: Record<GuardrailStage, Guardrail[]> = {
    input: [],
    output: [],
    "pre-tool": [],
  };

  for (const row of guardrails) {
    const { builtin } = row.config;
    let found = false;
    for (const stage of MESSAGE_STAGES) {
      const registered = registry.get(stage, builtin);
      if (!registered) continue;
      found = true;
      byStage[stage].push({ ...registered, name: row.name });
    }
    if (!found) {
      logger.warn(
        { name: row.name, builtin },
        "Guardrail names an unregistered built-in; skipping"
      );
    }
  }

  return byStage;
}
