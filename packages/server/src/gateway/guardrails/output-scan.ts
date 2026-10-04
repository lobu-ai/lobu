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
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import {
  enabledInlineGuardrails,
  resolveAgentGuardrails,
} from "./aggregator.js";
import { recordGuardrailTrip } from "./audit.js";
import {
  isEnrichmentGuardrail,
  SUGGEST_FOLLOWUPS_NAME,
} from "./suggest-followups.js";

const logger = createLogger("output-guardrail");

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
 * no agent is resolved, the agent has no output guardrails, or the runner
 * throws — guardrails fail open.
 */
export async function runOutputGuardrailScan(
  registry: GuardrailRegistry | undefined,
  settingsStore: AgentSettingsStore | undefined,
  scanText: string,
  ctx: OutputScanContext
): Promise<OutputGuardrailTrip | null> {
  if (!registry || !settingsStore) return null;
  if (!scanText) return null;
  if (!ctx.agentId) return null;

  try {
    // Org-scope the read (see resolveAgentOptions): a shared agent id lives in
    // multiple orgs and this runs without ambient orgContext, so an unscoped
    // read can resolve another org's guardrails. ctx carries the org already.
    const settings = await settingsStore.getSettings(ctx.agentId, {
      organizationId: ctx.organizationId,
    });
    const resolved = resolveAgentGuardrails(
      settings ?? { guardrails: [] },
      registry,
      {
        inline: enabledInlineGuardrails(settings),
        organizationId: ctx.organizationId,
      }
    );
    // Enrichment guardrails (e.g. suggest-followups) never trip and must not
    // see the reply until blocking scans have passed — exclude them here.
    // Generation is invoked explicitly by the terminal consumer after a pass.
    const list = resolved.byStage.output.filter(
      (g) => !isEnrichmentGuardrail(g)
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
  private settingsStore?: AgentSettingsStore;

  setGuardrails(
    registry?: GuardrailRegistry,
    settingsStore?: AgentSettingsStore
  ): void {
    this.registry = registry;
    this.settingsStore = settingsStore;
  }

  get enabled(): boolean {
    return !!(this.registry && this.settingsStore);
  }

  /**
   * Whether `agentId` has ANY output-stage guardrail configured. When true the
   * consumer withholds streaming deltas and delivers only the scanned
   * `finalText`. Fails open (returns false) on a lookup error — consistent with
   * guardrails never blocking on infra failure. Resolution rides the
   * AgentSettingsStore's own memoization (the chat bridge resolves per-delta the
   * same way), so no extra cache is kept here (avoids config-edit staleness).
   * Pass `organizationId` so the read is org-scoped: a shared agent id exists in
   * multiple orgs and the worker path has no ambient orgContext, so an unscoped
   * read could resolve another org's guardrail config.
   */
  async hasOutputGuardrails(
    agentId: string,
    organizationId?: string
  ): Promise<boolean> {
    if (!this.enabled || !agentId) return false;
    try {
      const settings = await this.settingsStore!.getSettings(agentId, {
        organizationId,
      });
      const resolved = resolveAgentGuardrails(
        settings ?? { guardrails: [] },
        this.registry!,
        { inline: enabledInlineGuardrails(settings) }
      );
      // Only blocking output guardrails force withhold-stream. Enrichment
      // alone (suggest-followups) does not need to suppress token streaming.
      return resolved.byStage.output.some((g) => !isEnrichmentGuardrail(g));
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
    return runOutputGuardrailScan(this.registry, this.settingsStore, text, ctx);
  }

  /**
   * The agent's `suggest-followups` enrichment config, or null when the
   * guardrail is not enabled. Used by the chat bridge after a blocking scan
   * pass. Returns the entry's overrides (rather than a bare boolean) so the
   * generator can honour a per-agent `model`, the same field a judge guardrail
   * already uses — an operator who configures a slow model here would
   * otherwise get silent empty chips with no way to change it.
   */
  async getSuggestFollowupsConfig(
    agentId: string,
    organizationId?: string
  ): Promise<{ model?: string } | null> {
    if (!this.enabled || !agentId) return null;
    try {
      const settings = await this.settingsStore!.getSettings(agentId, {
        organizationId,
      });
      const resolved = resolveAgentGuardrails(
        settings ?? { guardrails: [] },
        this.registry!,
        { inline: enabledInlineGuardrails(settings) }
      );
      if (!resolved.byStage.output.some((g) => isEnrichmentGuardrail(g))) {
        return null;
      }
      // The resolved instance is the built-in stub; per-agent overrides live on
      // the inline settings entry of the same name.
      const entry = enabledInlineGuardrails(settings).find(
        (g) => g.name === SUGGEST_FOLLOWUPS_NAME
      );
      return { model: entry?.model };
    } catch {
      return null;
    }
  }
}
