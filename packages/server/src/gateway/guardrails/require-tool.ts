/**
 * Generic `require-tool` output guardrail.
 *
 * Looks up this turn's `toolsUsed` (stamped by the worker on the terminal
 * completion row) and trips when any of the operator-listed tool names is
 * missing. Fixed policy (no operator knobs):
 *
 *   - toolsUsed **absent** (not reported) → **pass**
 *   - toolsUsed **present**, required tool missing → **trip**
 *   - toolsUsed **present**, all required present → **pass**
 *   - toolsUsed **[]** counts as present → miss trips
 *
 * Config: `guardrailsInline` with `kind: "require-tool"` and a manual
 * `tools` array (e.g. `["send_message"]`). No model call.
 *
 * Server-side only: materialised by the aggregator per agent.
 */

import type {
  AgentInlineGuardrail,
  Guardrail,
  OutputGuardrailContext,
} from "@lobu/core";

export interface RequireToolOptions {
  name: string;
  /** Tool names that must appear in `ctx.toolsUsed` this turn. */
  tools: readonly string[];
}

export function isRequireToolEntry(
  entry: AgentInlineGuardrail
): entry is AgentInlineGuardrail & { kind: "require-tool" } {
  return entry.kind === "require-tool";
}

/**
 * Materialise a require-tool guardrail. Stage is always `output` — "was this
 * tool called this turn" is only meaningful at the terminal boundary.
 */
export function createRequireToolGuardrail(
  options: RequireToolOptions
): Guardrail<"output"> {
  const required = [
    ...new Set(options.tools.map((t) => t.trim()).filter(Boolean)),
  ];

  return {
    name: options.name,
    stage: "output",
    async run(ctx: OutputGuardrailContext) {
      if (required.length === 0) {
        return { tripped: false, metadata: { requireTool: true, empty: true } };
      }

      // No producer stamp — pass because a missing ledger cannot prove a miss.
      if (ctx.toolsUsed === undefined) {
        return {
          tripped: false,
          metadata: {
            requireTool: true,
            required,
            toolsUsed: null,
            skipped: "unknown",
          },
        };
      }

      const used = new Set(ctx.toolsUsed);
      const missing = required.filter((t) => !used.has(t));
      if (missing.length === 0) {
        return {
          tripped: false,
          metadata: { requireTool: true, required, toolsUsed: [...used] },
        };
      }

      return {
        tripped: true,
        reason: `Required tool(s) not called this turn: ${missing.join(", ")}`,
        metadata: {
          requireTool: true,
          required,
          missing,
          toolsUsed: [...used],
        },
      };
    },
  };
}

/** Build from a validated inline settings entry. */
export function createRequireToolGuardrailFromEntry(
  entry: AgentInlineGuardrail
): Guardrail<"output"> | null {
  if (!isRequireToolEntry(entry)) return null;
  const tools = entry.tools ?? [];
  if (tools.length === 0) return null;
  return createRequireToolGuardrail({
    name: entry.name,
    tools,
  });
}
