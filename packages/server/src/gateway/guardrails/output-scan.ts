/**
 * Shared output-stage guardrail enforcement.
 *
 * Output guardrails (secret-scan, pii-scan, …) must run on EVERY response
 * surface, not just Chat SDK platforms. This module is the single place the
 * stage is resolved + run + audited so the two renderer-agnostic call sites —
 * `ChatResponseBridge` (chat platforms) and `UnifiedThreadResponseConsumer`
 * (the API/SSE/web path via `ApiResponseRenderer`) — share identical, vetted
 * logic instead of one of them silently lacking enforcement.
 *
 * Like all guardrails it fails OPEN: a runner/lookup error logs and returns
 * `null` (no block) rather than dropping a legitimate reply.
 */

import {
	createLogger,
	getErrorMessage,
	type GuardrailRegistry,
	runGuardrailInstances,
} from "@lobu/core";
import { getDb } from "../../db/client.js";
import { resolveOrgId } from "../../lobu/stores/org-context.js";
import {
  agentGuardrailPrincipal,
  resolveGuardrails,
} from "../../guardrails/workspace-guardrails.js";
import { buildGuardrailsByStage } from "./aggregator.js";
import { recordGuardrailTrip } from "./audit.js";

const logger = createLogger("output-guardrail");

/** The output-stage guardrails the library applies to this agent. */
async function outputGuardrailsFor(
  registry: GuardrailRegistry,
  agentId: string,
  organizationId: string
) {
  const guardrails = await resolveGuardrails(
    getDb(),
    organizationId,
    agentGuardrailPrincipal(agentId)
  );
  return buildGuardrailsByStage(guardrails, registry, organizationId).output;
}

export interface OutputScanContext {
  agentId: string;
  organizationId?: string;
  userId: string;
  conversationId?: string;
  platform: string;
  /** Tool names this turn (from the worker's terminal `toolsUsed` stamp). */
  toolsUsed?: string[];
}

export interface OutputGuardrailTrip {
  guardrail: string;
  reason?: string;
}

/**
 * Run output-stage guardrails for `scanText`. Returns the trip outcome
 * (already audited via `recordGuardrailTrip`) on block, or `null` when safe to
 * send. Returns `null` (pass) when guardrails aren't wired, the text is empty,
 * no agent or organization (explicit or ambient) is resolved, the agent has no output guardrails,
 * or the runner throws — guardrails fail open.
 */
export async function runOutputGuardrailScan(
  registry: GuardrailRegistry | undefined,
  scanText: string,
  ctx: OutputScanContext
): Promise<OutputGuardrailTrip | null> {
  if (!registry) return null;
  if (!scanText) return null;
  // A payload without an organization (the agent-threads/messaging-api
  // dispatch paths) still resolves through the ambient org context.
  const organizationId = resolveOrgId(ctx.organizationId);
  if (!ctx.agentId || !organizationId) return null;

  try {
    const list = await outputGuardrailsFor(
      registry,
      ctx.agentId,
      organizationId
    );
    if (list.length === 0) return null;

    const outcome = await runGuardrailInstances("output", list, {
      agentId: ctx.agentId,
      userId: ctx.userId,
      text: scanText,
      platform: ctx.platform,
      conversationId: ctx.conversationId,
      toolsUsed: ctx.toolsUsed,
    });
    if (!outcome.tripped) return null;

    // Fire-and-forget — the block decision must not wait on the audit write.
    void recordGuardrailTrip({
      organizationId: ctx.organizationId,
      agentId: ctx.agentId,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      stage: "output",
      guardrail: outcome.tripped.guardrail,
      reason: outcome.tripped.reason,
      metadata: outcome.tripped.metadata,
    });
    return {
      guardrail: outcome.tripped.guardrail,
      reason: outcome.tripped.reason,
    };
  } catch (err) {
    logger.warn(
      { err: getErrorMessage(err) },
      "Output guardrail check failed — proceeding without guardrails"
    );
    return null;
  }
}

/**
 * Output-guardrail scanner for renderers that lack their own stream state (the
 * API/SSE path). Enforcement is the terminal `scanFinal` on the worker's full,
 * authoritative `finalText` — owner-gated, so it runs on the SSE-owning pod and
 * is replica-safe regardless of how delta rows scattered.
 *
 * Per-delta scanning is deliberately NOT done here: deltas are not owner-gated
 * under N>1, so a secret split across deltas claimed on different pods would
 * trip no per-pod scan and could reach a streaming client before the terminal
 * scan. Instead, `hasOutputGuardrails` lets the consumer WITHHOLD streaming
 * deltas entirely for an agent that configured output guardrails and deliver
 * only the scanned `finalText` at completion — a hard guarantee that no
 * unscanned token reaches the client, at the cost of token-by-token streaming
 * for those agents. Agents without output guardrails stream unaffected.
 */
export class OutputGuardrailScanner {
  private registry?: GuardrailRegistry;

  setGuardrails(registry?: GuardrailRegistry): void {
    this.registry = registry;
  }

  get enabled(): boolean {
    return !!this.registry;
  }

  /**
   * Whether `agentId` has ANY output-stage guardrail configured. When true the
   * consumer withholds streaming deltas and delivers only the scanned
   * `finalText`. Fails open (returns false) on a lookup error — consistent with
   * guardrails never blocking on infra failure. Each call reads the library,
   * so no cache is kept here (avoids config-edit staleness). The read is
   * org-scoped: agent ids are only unique per org.
   */
  async hasOutputGuardrails(
    agentId: string,
    organizationId?: string
  ): Promise<boolean> {
    const orgId = resolveOrgId(organizationId);
    if (!this.registry || !agentId || !orgId) return false;
    try {
      const list = await outputGuardrailsFor(this.registry, agentId, orgId);
      return list.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Scan the authoritative final text at terminal time. Returns the trip
   * (already audited) or `null`. Scans the full text, so it blocks correctly
   * even when delta rows landed on other replicas.
   */
  async scanFinal(
    text: string,
    ctx: OutputScanContext
  ): Promise<OutputGuardrailTrip | null> {
    return runOutputGuardrailScan(this.registry, text, ctx);
  }
}
