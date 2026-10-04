import {
  type AgentInlineGuardrail,
  type AgentSettings,
  type Guardrail,
  type GuardrailRegistry,
  type GuardrailStage,
  createLogger,
} from "@lobu/core";
import { createJudgeGuardrail } from "./judge-factory.js";
import {
  createRequireToolGuardrailFromEntry,
  isRequireToolEntry,
} from "./require-tool.js";

const logger = createLogger("guardrail-aggregator");

interface AgentGuardrailExtras {
  /**
   * Operator-authored custom guardrails (`AgentSettings.guardrailsInline`).
   * Each materializes into a judge guardrail under its operator-given `name`.
   * Callers pass only the entries they want active (filter on `enabled`).
   */
  inline?: AgentInlineGuardrail[];
  /**
   * Authenticated org of the caller. Judge guardrails with no model of their
   * own run on this org's default provider model; absent = they fail closed.
   */
  organizationId?: string;
  /**
   * Operator's exclude list — names matched against the resolved guardrails'
   * `.name` (including synthesized inline names). Applied last.
   */
  disabled?: string[];
}

/**
 * The agent's active custom guardrails, shaped for `extras.inline`. Disabled
 * entries are kept in settings (so the operator can flip them back on) but
 * never resolved into a run — every resolve call site filters through here so
 * the input/output/pre-tool paths stay consistent.
 */
export function enabledInlineGuardrails(
  settings: Pick<AgentSettings, "guardrailsInline"> | null | undefined
): AgentInlineGuardrail[] {
  return (settings?.guardrailsInline ?? []).filter((g) => g.enabled);
}

interface ResolvedAgentGuardrails {
  /**
   * Effective per-stage guardrail instances, after merge + dedup + exclude.
   * Inline judges are NOT registered on the shared registry — the aggregator
   * constructs them in-place and returns them already-resolved so the gateway
   * can run them directly.
   */
  byStage: Record<GuardrailStage, Guardrail[]>;
}

function emptyByStage(): Record<GuardrailStage, Guardrail[]> {
  // `egress` is part of the stage taxonomy but is never resolved/run by the
  // message pipeline — enforcement lives in the http-proxy egress plane. The
  // slot stays empty here; the resolution loops below iterate only the three
  // message-pipeline stages so nothing is ever pushed into it.
  return { input: [], output: [], "pre-tool": [], egress: [] };
}
/**
 * Resolve the full set of guardrails to run for an agent. Combines:
 *   1. `agentSettings.guardrails` — built-in / globally-registered names.
 *   2. `extras.inline` — agent-declared inline judges (`guardrails_inline`).
 * Then subtracts `extras.disabled` (matched against the final `.name`).
 *
 * Dedup is name-keyed within a stage: a name that resolves twice runs once.
 *
 * Inline judges are NOT registered on the shared registry — the aggregator
 * constructs them in-place and returns them so the runner can include them
 * alongside registry-resolved entries.
 *
 * Unknown built-in names are logged and skipped — same posture as
 * `GuardrailRegistry.resolve()`.
 */
export function resolveAgentGuardrails(
  agentSettings: Pick<AgentSettings, "guardrails">,
  registry: GuardrailRegistry,
  extras: AgentGuardrailExtras = {}
): ResolvedAgentGuardrails {
  const byStage = emptyByStage();
  // Per-stage name -> Guardrail map, used for dedup.
  const seen: Record<GuardrailStage, Map<string, Guardrail>> = {
    input: new Map(),
    output: new Map(),
    "pre-tool": new Map(),
    // Never populated — egress is enforced in the http-proxy plane, not here.
    egress: new Map(),
  };

  // ── 1. Agent's enabled built-ins (all stages) ──────────────────────────
  const agentEnabled = agentSettings.guardrails ?? [];
  if (agentEnabled.length > 0) {
    for (const stage of ["input", "output", "pre-tool"] as const) {
      const resolved = registry.resolve(stage, agentEnabled);
      for (const g of resolved) {
        if (!seen[stage].has(g.name)) {
          seen[stage].set(g.name, g);
        }
      }
    }
  }

  // ── 2. Agent-declared inline guardrails ────────────────────────────────
  // Built-ins (step 1) are seen first, so a custom guardrail whose name
  // collides with a built-in at the same stage is dropped here — the create/
  // edit UI rejects such names up front so this stays a defensive guard.
  for (const entry of extras.inline ?? []) {
    if (entry.enabled === false) continue;
    // `egress` guardrails are enforced in the http-proxy plane (the policy
    // store + EgressJudge), never the message pipeline — skip them here so
    // they are not materialized into a stage that's never run.
    if (entry.stage === "egress") continue;
    // Defensive: a malformed persisted row can carry an invalid `stage`
    // (the write path validates, but older rows or out-of-band writes might
    // not). Indexing `seen[bad]` would be `undefined` and throw mid-message —
    // skip and log instead of crashing the whole message handler.
    if (!seen[entry.stage]) {
      logger.warn(
        { name: entry.name, stage: entry.stage },
        "Inline guardrail has an invalid stage; skipping"
      );
      continue;
    }

    // require-tool is output-only (turn-scoped toolsUsed). Wrong stage → skip.
    if (isRequireToolEntry(entry)) {
      if (entry.stage !== "output") {
        logger.warn(
          { name: entry.name, stage: entry.stage },
          "require-tool guardrail only runs at output stage; skipping"
        );
        continue;
      }
      const g = createRequireToolGuardrailFromEntry(entry);
      if (!g) {
        logger.warn(
          { name: entry.name },
          "require-tool guardrail has empty tools; skipping"
        );
        continue;
      }
      if (!seen.output.has(g.name)) {
        seen.output.set(g.name, g);
      }
      continue;
    }

    // Default / kind: "judge" — needs a non-empty policy.
    const policy = entry.policy?.trim();
    if (!policy) {
      logger.warn(
        { name: entry.name },
        "Inline judge guardrail missing policy; skipping"
      );
      continue;
    }
    const g = createJudgeGuardrail(entry.stage, policy, {
      name: entry.name,
      model: entry.model,
      tools: entry.tools,
      orgId: extras.organizationId,
    });
    if (!seen[entry.stage].has(g.name)) {
      seen[entry.stage].set(g.name, g);
    }
  }

  // ── 3. Apply operator exclude list ─────────────────────────────────────
  const disabled = new Set(extras.disabled ?? []);
  for (const stage of ["input", "output", "pre-tool"] as const) {
    for (const [name, g] of seen[stage]) {
      if (disabled.has(name)) continue;
      byStage[stage].push(g);
    }
  }

  return { byStage };
}
