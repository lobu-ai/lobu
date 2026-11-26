import { createLogger, getErrorMessage } from "@lobu/core";
import { resolveOrgId } from "../../lobu/stores/org-context.js";
import { agentLoopPrincipal, evaluateLoopPolicy, hasBlockingReplyPolicy } from "./loop-policy.js";

const logger = createLogger("output-guardrail");

interface ReplyPolicyScope {
  agentId: string;
  organizationId?: string;
  source?: string;
  conversationId?: string;
}

export interface OutputGuardrailTrip {
  guardrail: string;
  reason: string;
}

/** Block rules withhold streaming deltas until the authoritative reply is scanned. */
export async function hasOutputGuardrails(ctx: ReplyPolicyScope): Promise<boolean> {
  const organizationId = resolveOrgId(ctx.organizationId);
  if (!ctx.agentId || !organizationId) return false;

  try {
    return await hasBlockingReplyPolicy(
      organizationId,
      agentLoopPrincipal(ctx.agentId, ctx.source, ctx.conversationId),
    );
  } catch (error) {
    logger.warn({ err: getErrorMessage(error) }, "Could not check reply policies");
    return false;
  }
}

/** Scan the complete reply or error before any terminal renderer delivers it. */
export async function runOutputGuardrailScan(
  text: string,
  ctx: ReplyPolicyScope & { userId: string; platform: string; toolsUsed?: string[] },
): Promise<OutputGuardrailTrip | null> {
  const organizationId = resolveOrgId(ctx.organizationId);
  if (!ctx.agentId || !organizationId) return null;

  try {
    return await evaluateLoopPolicy({
      organizationId,
      principal: agentLoopPrincipal(ctx.agentId, ctx.source, ctx.conversationId),
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      hook: "reply_out",
      input: { text, platform: ctx.platform, tools_used: ctx.toolsUsed },
    });
  } catch (error) {
    logger.warn({ err: getErrorMessage(error) }, "Reply policy check failed");
    return null;
  }
}
