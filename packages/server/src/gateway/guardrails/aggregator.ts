import {
  type Guardrail,
  type GuardrailRegistry,
  type GuardrailStage,
  createLogger,
} from "@lobu/core";
import { isBuiltinGuardrailConfig } from "@lobu/core/contracts/workspace-guardrails";
import type { ApplyingGuardrail } from "../../guardrails/workspace-guardrails.js";
import { createJudgeGuardrail } from "./judge-factory.js";
import { createRequireToolGuardrail } from "./require-tool.js";

const logger = createLogger("guardrail-aggregator");

const MESSAGE_STAGES = ["input", "output", "pre-tool"] as const;

/**
 * Materialize the message-pipeline guardrails (input, output, pre-tool) from
 * the library rows `resolveGuardrails` returned for a principal.
 *
 * Guardrails accumulate: every row runs, under its own library name, and any
 * trip wins. Nothing is deduplicated or shadowed by name.
 *
 * - A built-in row runs the registered built-in at every stage it implements.
 * - A custom `judge` row runs at its stage; `require-tool` runs at output.
 * - `egress` rows are enforced in the http-proxy plane (the policy store and
 *   EgressJudge), never here.
 *
 * A row that cannot run (an unknown built-in, a judge without a policy, a
 * require-tool without tools or off the output stage) is logged and skipped,
 * the same posture as `GuardrailRegistry.resolve()`.
 */
export function buildGuardrailsByStage(
  guardrails: readonly ApplyingGuardrail[],
  registry: GuardrailRegistry,
  organizationId: string
): Record<GuardrailStage, Guardrail[]> {
  const byStage: Record<GuardrailStage, Guardrail[]> = {
    input: [],
    output: [],
    "pre-tool": [],
    egress: [],
  };

  for (const row of guardrails) {
    const config = row.config;
    if (isBuiltinGuardrailConfig(config)) {
      let found = false;
      for (const stage of MESSAGE_STAGES) {
        const builtin = registry.get(stage, config.builtin);
        if (!builtin) continue;
        found = true;
        byStage[stage].push({ ...builtin, name: row.name });
      }
      if (!found) {
        logger.warn(
          { name: row.name, builtin: config.builtin },
          "Guardrail names an unregistered built-in; skipping"
        );
      }
      continue;
    }

    if (config.stage === "egress") continue;
    if (!(MESSAGE_STAGES as readonly string[]).includes(config.stage)) {
      logger.warn(
        { name: row.name, stage: config.stage },
        "Guardrail has an invalid stage; skipping"
      );
      continue;
    }

    if (config.kind === "require-tool") {
      const tools = config.tools ?? [];
      if (config.stage !== "output" || tools.length === 0) {
        logger.warn(
          { name: row.name, stage: config.stage },
          "require-tool guardrail needs stage output and at least one tool; skipping"
        );
        continue;
      }
      byStage.output.push(createRequireToolGuardrail({ name: row.name, tools }));
      continue;
    }

    const policy = config.policy?.trim();
    if (!policy) {
      logger.warn({ name: row.name }, "Judge guardrail missing policy; skipping");
      continue;
    }
    byStage[config.stage].push(
      createJudgeGuardrail(config.stage, policy, {
        name: row.name,
        model: config.model,
        tools: config.tools,
        orgId: organizationId,
      })
    );
  }

  return byStage;
}
