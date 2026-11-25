import {
  type GuardrailRegistry,
  type GuardrailRunOutcome,
  runGuardrailInstances,
} from "@lobu/core";
import { getDb } from "../../db/client.js";
import {
  type GuardrailPrincipal,
  resolveGuardrails,
} from "../../guardrails/workspace-guardrails.js";
import { buildGuardrailsByStage } from "./aggregator.js";
import { recordGuardrailTrip } from "./audit.js";

export type PreToolTrip = NonNullable<GuardrailRunOutcome["tripped"]>;

/**
 * The pre-tool stage for one tool call: run the guardrails that apply to
 * `principal` in `organizationId` against the call, and audit a trip. Returns
 * the trip, or null when every applying guardrail passes.
 *
 * Shared by both pre-tool enforcement points: the outbound MCP proxy (an
 * agent's calls to its MCP servers) and inbound tool execution (a connected
 * app's calls to Lobu's own MCP server). A lookup error throws, and each
 * caller decides what that means: the proxy fails open, inbound fails closed.
 * The trip reason is audited only; callers answer with a generic block, since
 * the reason would be an evasion oracle.
 */
export async function evaluatePreToolGuardrails(params: {
  registry: GuardrailRegistry | undefined;
  organizationId: string;
  principal: GuardrailPrincipal;
  userId: string;
  conversationId?: string;
  toolName: string;
  arguments: Record<string, unknown>;
}): Promise<PreToolTrip | null> {
  const rows = await resolveGuardrails(
    getDb(),
    params.organizationId,
    params.principal
  );
  if (rows.length === 0) return null;
  if (!params.registry) {
    throw new Error("The guardrail registry is not initialized");
  }
  const list = buildGuardrailsByStage(
    rows,
    params.registry,
    params.organizationId
  )["pre-tool"];
  if (list.length === 0) return null;
  const agentId =
    params.principal.kind === "agent" ? params.principal.id : null;
  const appId = params.principal.kind === "app" ? params.principal.id : null;
  const outcome = await runGuardrailInstances("pre-tool", list, {
    agentId,
    userId: params.userId,
    toolName: params.toolName,
    arguments: params.arguments,
    conversationId: params.conversationId,
  });
  if (!outcome.tripped) return null;
  void recordGuardrailTrip({
    organizationId: params.organizationId,
    agentId,
    appId,
    userId: params.userId,
    conversationId: params.conversationId,
    stage: "pre-tool",
    guardrail: outcome.tripped.guardrail,
    reason: outcome.tripped.reason,
    metadata: outcome.tripped.metadata,
  });
  return outcome.tripped;
}
