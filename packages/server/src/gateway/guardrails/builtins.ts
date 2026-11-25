import type {
  Guardrail,
  GuardrailRegistry,
  GuardrailStage,
  OutputGuardrailContext,
  PreToolGuardrailContext,
} from "@lobu/core";
import { scanForPii, scanForSecret } from "../../utils/sensitive-content-scan.js";
import { extractStageText } from "./stage-text.js";

/**
 * Built-in guardrails registered by the gateway at startup:
 *  - `secret-scan`       (output, stage-locked)  — credential-shape regex scan
 *  - `pii-scan`          (any stage)             — emails / phones / Luhn PANs
 *  - `forbidden-tools`   (pre-tool, stage-locked) — destructive-tool deny list
 */

// -- pii-scan ---------------------------------------------------------------

export function createPiiScanGuardrail<S extends GuardrailStage>(
  stage: S,
  name = "pii-scan"
): Guardrail<S> {
  return {
    name,
    stage,
    async run(ctx) {
      // pii-scan scans the tool arguments alone (no tool-name prefix).
      const text = extractStageText(stage, ctx);
      const hit = scanForPii(text);
      if (!hit) return { tripped: false };
      return {
        tripped: true,
        reason: `Potential PII detected (${hit.kind})`,
        metadata: { kind: hit.kind },
      };
    },
  };
}

// -- secret-scan (output, stage-locked) -------------------------------------

const secretScanGuardrail: Guardrail<"output"> = {
  name: "secret-scan",
  stage: "output",
  async run(ctx: OutputGuardrailContext) {
    const text = ctx.text;
    if (!text) return { tripped: false };
    const name = scanForSecret(text);
    if (!name) return { tripped: false };
    return {
      tripped: true,
      reason: `Output contains a value that looks like a ${name}`,
      metadata: { pattern: name },
    };
  },
};

// -- forbidden-tools (pre-tool, stage-locked) -------------------------------

const FORBIDDEN_TOOLS = new Set<string>([
  "delete_repo",
  "delete_branch",
  "drop_table",
]);

const forbiddenToolsGuardrail: Guardrail<"pre-tool"> = {
  name: "forbidden-tools",
  stage: "pre-tool",
  async run(ctx: PreToolGuardrailContext) {
    if (FORBIDDEN_TOOLS.has(ctx.toolName)) {
      return {
        tripped: true,
        // Internal-only reason; proxy MUST surface a generic block message
        // to the worker (leaking specifics is an evasion surface).
        reason: `Tool "${ctx.toolName}" is on the built-in deny list`,
        metadata: { toolName: ctx.toolName },
      };
    }
    return { tripped: false };
  },
};

// -- lookup tables ----------------------------------------------------------

/** Every built-in, once per stage it implements. */
const BUILTIN_GUARDRAILS: readonly Guardrail[] = [
  secretScanGuardrail,
  forbiddenToolsGuardrail,
  createPiiScanGuardrail("input"),
  createPiiScanGuardrail("output"),
  createPiiScanGuardrail("pre-tool"),
];

/**
 * Register all gateway built-ins on the shared registry exactly once at boot.
 * Duplicate registration is a programmer error (the registry throws).
 */
export function registerBuiltinGuardrails(registry: GuardrailRegistry): void {
  for (const guardrail of BUILTIN_GUARDRAILS) registry.register(guardrail);
}

/** The stages the built-in `name` runs at; empty for an unknown name. */
export function builtinGuardrailStages(name: string): GuardrailStage[] {
  return BUILTIN_GUARDRAILS.filter((guardrail) => guardrail.name === name).map(
    (guardrail) => guardrail.stage
  );
}
