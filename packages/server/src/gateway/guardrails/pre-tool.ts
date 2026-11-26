import { evaluateLoopPolicy, type LoopPrincipal, loopToolInput } from "./loop-policy.js";

interface PreToolPolicyContext {
  organizationId: string;
  principal: LoopPrincipal;
  userId?: string;
  conversationId?: string;
  toolName: string;
  namespace?: string;
  arguments: Record<string, unknown>;
}

/** The raw name also matches migrated rules that predate namespace patterns. */
export function evaluatePreToolGuardrails(params: PreToolPolicyContext) {
  const toolNames = params.namespace
    ? [params.toolName, `${params.namespace}__${params.toolName}`]
    : [params.toolName];
  return evaluateLoopPolicy({
    ...params,
    hook: "tool_call",
    toolNames,
    input: loopToolInput(params.toolName, params.arguments),
  });
}
