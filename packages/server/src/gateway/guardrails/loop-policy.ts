import type { GuardrailStage } from "@lobu/core";
import { listEntityApprovalPolicies, mutationPrincipalId, type ActingPrincipal } from "../../authz/entity-policy";
import { classifiedFrom, classifyPolicyConditions, type PolicyClassifyRequest } from "../../authz/policy-classify";
import { policyConditionsHold } from "../../authz/policy-conditions";
import { type LoopPolicyHook, policyToolMatches } from "../../authz/policy-hooks";
import { principalMatches } from "../../authz/principal-matches";
import { AUTOMATION_RUN_SOURCE } from "../automation-run-session";
import { parseAutomationRunConversationId } from "../permissions/automation-run-intent";
import { recordGuardrailTrip } from "./audit";
import { safeStringify } from "./safe-stringify";

export type LoopPrincipal = Pick<ActingPrincipal, "id" | "kind" | "ownerAgentId">;

/** These identifiers come from the admitted turn or a signed worker token. */
export function agentLoopPrincipal(
  agentId: string,
  source?: string,
  conversationId?: string,
): LoopPrincipal {
  const intent = source === AUTOMATION_RUN_SOURCE && conversationId
    ? parseAutomationRunConversationId(conversationId)
    : null;
  return intent
    ? { kind: "automation", id: mutationPrincipalId(intent), ownerAgentId: agentId }
    : { kind: "agent", id: agentId, ownerAgentId: null };
}

const AUDIT_STAGE: Record<LoopPolicyHook, GuardrailStage> = {
  message_in: "input",
  reply_out: "output",
  tool_call: "pre-tool",
};

async function loopRules(organizationId: string, principal: LoopPrincipal, hook: LoopPolicyHook) {
  const rules = await listEntityApprovalPolicies(organizationId, "connector_action", undefined, hook);
  return rules.filter(rule => principalMatches(rule, principal) &&
    (rule.effects.execute === "log" || rule.effects.execute === "deny"));
}

/** Blocking reply rules withhold deltas until the complete text has been checked. */
export async function hasBlockingReplyPolicy(organizationId: string, principal: LoopPrincipal) {
  return (await loopRules(organizationId, principal, "reply_out")).some(rule => rule.effects.execute === "deny");
}

/** Keep field pointers usable and preserve the scanner's handling of non-JSON tool values. */
export function loopToolInput(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const serialized = safeStringify(args);
  return {
    tool: toolName,
    arguments: serialized === "<unserializable>" ? serialized : JSON.parse(serialized),
  };
}

interface LoopPolicyContext {
  organizationId: string;
  principal: LoopPrincipal;
  hook: LoopPolicyHook;
  input: Record<string, unknown>;
  toolNames?: readonly string[];
  userId?: string;
  conversationId?: string;
}

export async function evaluateLoopPolicy(ctx: LoopPolicyContext): Promise<{ guardrail: string; reason: string } | null> {
  const rules = (await loopRules(ctx.organizationId, ctx.principal, ctx.hook))
    .filter(rule => ctx.hook !== "tool_call" || policyToolMatches(rule.toolPatterns, ctx.toolNames ?? []));
  const wanted: PolicyClassifyRequest[] = [];
  for (const rule of rules) {
    policyConditionsHold(rule.condition, ctx.input, (index, condition) => {
      wanted.push({ rule, index, condition });
      return "unknown";
    });
  }
  const classified = classifiedFrom(
    wanted.length ? await classifyPolicyConditions(ctx.organizationId, wanted, ctx.input) : [],
    ctx.input,
  );
  let blocked: { guardrail: string; reason: string } | null = null;
  for (const rule of rules) {
    if (policyConditionsHold(rule.condition, ctx.input, (index, condition) => classified(rule, index, condition)) === false) continue;
    const effect = rule.effects.execute === "log" ? "log" : "deny";
    const match = {
      guardrail: `policy-rule-${rule.id}`,
      reason: rule.note ?? (effect === "log" ? "Matched workspace policy." : "Blocked by workspace policy."),
    };
    void recordGuardrailTrip({
      organizationId: ctx.organizationId,
      agentId: ctx.principal.kind === "agent" ? ctx.principal.id : ctx.principal.ownerAgentId,
      appId: ctx.principal.kind === "app" ? ctx.principal.id : null,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      stage: AUDIT_STAGE[ctx.hook],
      ...match,
      metadata: { policy_rule_id: rule.id, effect },
    });
    if (effect === "deny") blocked ??= match;
  }
  return blocked;
}
