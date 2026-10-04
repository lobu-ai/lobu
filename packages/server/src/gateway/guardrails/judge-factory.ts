import { createHash } from "node:crypto";
import type {
  Guardrail,
  GuardrailStage,
  PreToolGuardrailContext,
} from "@lobu/core";
import { getDb } from "../../db/client.js";
import { TextJudge } from "../proxy/egress-judge/text-judge.js";
import { extractStageText } from "./stage-text.js";

/**
 * Lazily-constructed singleton TextJudge so multiple judge guardrails share
 * one cache + circuit breaker. Tests can pass a custom judge via
 * {@link createJudgeGuardrail} `options.judge`.
 */
let sharedJudge: TextJudge | undefined;
function getSharedJudge(): TextJudge {
  if (!sharedJudge) sharedJudge = new TextJudge();
  return sharedJudge;
}


/**
 * The guardrail contexts carry the agent id but not the org id (changing that
 * would change the public `@lobu/core` context types), so the org whose default
 * judge model applies is read from `agents` by primary key. A failed lookup
 * means "no org": a guardrail with no model of its own then fails closed.
 */
async function orgIdForAgent(agentId: string): Promise<string | null> {
  const rows = (await getDb()`
    SELECT organization_id FROM agents WHERE id = ${agentId} LIMIT 1
  `) as Array<{ organization_id?: string }>;
  return rows[0]?.organization_id ?? null;
}

/**
 * Short stable id for an inline judge — first 8 chars of
 * sha256(policy +"\u001F" + sortedTools.join(",")). Used in the generated `inline:<stage>:<hash8>`
 * name so operators can target it via `guardrails_disabled`.
 *
 * `tools` is part of the hash so two inline judges with the same English
 * policy but different tool scopes (e.g. `["fs.write"]` vs `["fs.delete"]`)
 * get distinct names — otherwise the aggregator's name-keyed dedup would
 * silently drop the second narrowing. Tools are sorted so `["a","b"]` and
 * `["b","a"]` collapse to the same name. Empty / undefined `tools` are
 * canonically equivalent.
 */
export function inlineJudgeHash(
  policy: string,
  tools?: readonly string[]
): string {
  const h = createHash("sha256");
  h.update(policy);
  const normalizedTools =
    tools && tools.length > 0 ? [...tools].sort().join(",") : "";
  // U+001F separator (matches TextJudge's cache hash); won't appear in
  // normal policy or tool-name content.
  h.update("\u001F");
  h.update(normalizedTools);
  return h.digest("hex").slice(0, 8);
}

interface JudgeGuardrailOptions {
  /**
   * Override the auto-generated `inline:<stage>:<hash8>` name. The aggregator
   * passes the operator's own name for agent-declared inline judges, so they
   * stay addressable by `guardrails_disabled`.
   */
  name?: string;
  /** Override the shared TextJudge — primarily for tests. */
  judge?: TextJudge;
  /** Override the agent-to-org lookup — primarily for tests. */
  resolveOrgId?: (agentId: string) => Promise<string | null>;
  /** Optional judge model override (per-call). */
  model?: string;
  /**
   * For `pre-tool` only: when set, the guardrail no-ops on tool calls whose
   * `toolName` isn't in this list. Empty / undefined = run on every tool.
   */
  tools?: string[];
}

/**
 * Factory for a {@link Guardrail} backed by the shared {@link TextJudge}.
 *
 * Stage semantics:
 *   - `input`    — judges the user message
 *   - `output`   — judges the worker's text
 *   - `pre-tool` — judges `tool: <name>\narguments: <json>`; optionally
 *                  narrowed by `options.tools`
 *
 * The guardrail trips (`tripped: true`) when the judge returns `allow: false`,
 * with the judge's `reason` surfaced as the trip reason.
 */
export function createJudgeGuardrail<S extends GuardrailStage>(
  stage: S,
  policy: string,
  options: JudgeGuardrailOptions = {}
): Guardrail<S> {
  // See `inlineJudgeHash` for why `tools` factors into the default name.
  // Caller-supplied `options.name` wins (the aggregator passes the operator's
  // name for agent-declared inline judges).
  const name =
    options.name ?? `inline:${stage}:${inlineJudgeHash(policy, options.tools)}`;
  const toolFilter =
    stage === "pre-tool" && options.tools && options.tools.length > 0
      ? new Set(options.tools)
      : null;

  return {
    name,
    stage,
    async run(ctx) {
      if (stage === "pre-tool" && toolFilter) {
        const c = ctx as PreToolGuardrailContext;
        if (!toolFilter.has(c.toolName)) {
          return { tripped: false };
        }
      }
      const judge = options.judge ?? getSharedJudge();
      // Prefix `pre-tool` args with the tool name so the judge can reason
      // about which tool is being called.
      const text = extractStageText(stage, ctx, {
        includeToolName: true,
        throwOnUnknown: true,
      });
      let orgId: string | undefined;
      if (!options.model?.trim()) {
        try {
          orgId =
            (await (options.resolveOrgId ?? orgIdForAgent)(ctx.agentId)) ??
            undefined;
        } catch {
          orgId = undefined;
        }
      }
      const verdict = await judge.decide(policy, text, {
        model: options.model,
        orgId,
      });
      if (verdict.allow) {
        return { tripped: false };
      }
      return {
        tripped: true,
        reason: verdict.reason,
        metadata: { source: "judge", stage },
      };
    },
  };
}
