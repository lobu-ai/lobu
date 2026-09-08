/**
 * Shared platform helpers.
 * Extracts common logic duplicated across Slack, Telegram, and WhatsApp message handlers.
 */

import {
  createLogger,
  type MessagePayload,
  type NixConfig,
} from "@lobu/core";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import { composeEffectiveModelRef } from "../auth/settings/model-selection.js";
import { getOrgDefaultModel } from "../../lobu/stores/provider-secrets.js";
import type { AutomationSubscriptionService } from "../channels/automation-subscription-service.js";

const logger = createLogger("platform-helpers");

/**
 * Does this string name a provider AND a model, i.e. `<provider>/<model>`?
 *
 * The shape test for whether a per-request override is well-formed enough to
 * win the layered fallback below. Routing itself needs no authorization from
 * this side: the worker's `resolveModelRef` honours any explicit ref whose
 * prefix names an installed provider.
 *
 * `auto` is rejected as the model half: it is gone repo-wide, and a legacy
 * `<provider>/auto` binding names no concrete model to route.
 */
function isQualifiedModelRef(ref: string | undefined): boolean {
  if (!ref) return false;
  const slash = ref.indexOf("/");
  return (
    slash > 0 && slash < ref.length - 1 && ref.slice(slash + 1) !== "auto"
  );
}

/**
 * Resolve agent options by merging base options with per-agent settings.
 * Priority: agent settings > config defaults.
 */
export async function resolveAgentOptions(
  agentId: string,
  baseOptions: Record<string, any>,
	agentSettingsStore?: AgentSettingsStore,
	organizationId?: string,
): Promise<Record<string, any>> {
  if (!agentSettingsStore) {
    return { ...baseOptions };
  }

  // Scope by org: an agent id can exist in multiple orgs, and the
  // worker-dispatch path runs
  // without ambient orgContext, so an unscoped read returns an arbitrary org's
  // row — cross-tenant config bleed that mis-resolved the model to another
  // org's `models` list. Pass the org explicitly so the right row wins.
  const settings = await agentSettingsStore.getSettings(agentId, {
    organizationId,
  });
  if (!settings) {
    return { ...baseOptions };
  }

  const mergedOptions: Record<string, any> = { ...baseOptions };

  // Layered model fallback: automation override → agent default → org default.
  // A per-automation override arrives as baseOptions.model (injected at enqueue)
  // and wins; otherwise resolve agent.models[0], then the org default. Only
  // when all three are empty do we leave model unset (worker surfaces an
  // actionable "no model" error).
  //
  // A malformed override (not a `<slug>/<model>` ref — e.g. a legacy "auto"
  // binding, or a bare model id) is IGNORED here and falls through to the
  // agent default, rather than propagating an unroutable/ungated value. `auto`
  // is gone repo-wide, so it never wins as an override. The exact allow-list
  // gate (deployment-manager backstop) still validates the resulting ref.
  const rawOverride =
    typeof baseOptions.model === "string" ? baseOptions.model.trim() : "";
  const automationOverride = isQualifiedModelRef(rawOverride) ? rawOverride : "";
  if (rawOverride && !automationOverride) {
    logger.warn(
      { agentId, rejectedOverride: rawOverride },
      "Ignoring malformed model override (not a <provider>/<model> ref); falling back to the agent default",
    );
  }
  const effectiveModelRef =
    automationOverride ||
    (await composeEffectiveModelRef(
      settings,
      organizationId,
      getOrgDefaultModel,
    ));
  logger.info(
    { agentId, automationOverride: automationOverride || undefined, effectiveModel: effectiveModelRef },
		"Applying agent settings",
  );

  if (effectiveModelRef) {
    mergedOptions.model = effectiveModelRef;
  } else {
    delete mergedOptions.model;
  }

  if (settings.networkConfig) {
    mergedOptions.networkConfig = settings.networkConfig;
  }
  if (settings.guardrailsInline?.length) {
    mergedOptions.guardrailsInline = settings.guardrailsInline;
  }
  // Nix packages come from two places and both are hard requirements of code
  // that will run in the spawned worker, so union them rather than letting the
  // last writer win:
  //   1. baseOptions.nixConfig  — per-request `nix` (POST /agents supplies it),
  //   2. settings.nixConfig     — the agent's own packages.
  // Legacy skill-level `nixPackages` entries are deliberately ignored.
  // Absent stays absent: with no nix anywhere, `nixConfig` is left unset so the
  // worker spawns without a nix-shell wrap.
  const baseNixConfig = mergedOptions.nixConfig as NixConfig | undefined;
  if (baseNixConfig || settings.nixConfig) {
    const packages = [
      ...new Set([
        ...(baseNixConfig?.packages ?? []),
        ...(settings.nixConfig?.packages ?? []),
      ]),
    ];
    mergedOptions.nixConfig = {
      ...baseNixConfig,
      ...settings.nixConfig,
      ...(packages.length > 0 ? { packages } : {}),
    };
  }
  if (settings.toolsConfig) {
    mergedOptions.toolsConfig = settings.toolsConfig;
  }
  if (settings.preApprovedTools?.length) {
    mergedOptions.preApprovedTools = settings.preApprovedTools;
  }
  if (settings.verboseLogging !== undefined) {
    mergedOptions.verboseLogging = settings.verboseLogging;
  }

  return mergedOptions;
}

/**
 * Build a MessagePayload from common fields.
 * Extracts networkConfig, guardrailsInline, nixConfig, preApprovedTools from
 * agentOptions before constructing the payload.
 */
export function buildMessagePayload(params: {
  platform: string;
  userId: string;
  botId: string;
  conversationId: string;
  // Optional to match the wire `MessagePayload` (the worker reads
  // `payload.teamId ?? platformMetadata.teamId`). Slack always supplies it;
  // teamless platforms (Telegram) and synthetic scheduled wakes omit it
  // rather than stamping a placeholder.
  teamId?: string;
  agentId: string;
  organizationId: string;
  connectionId?: string;
  messageId: string;
  messageText: string;
  ephemeralContext?: string;
  channelId: string;
  platformMetadata: Record<string, any>;
  agentOptions: Record<string, any>;
}): MessagePayload {
  const {
    networkConfig,
    guardrailsInline,
    nixConfig,
    preApprovedTools,
    ...remainingOptions
  } = params.agentOptions;

  return {
    platform: params.platform,
    userId: params.userId,
    botId: params.botId,
    conversationId: params.conversationId,
    teamId: params.teamId,
    agentId: params.agentId,
    organizationId: params.organizationId,
    messageId: params.messageId,
    messageText: params.messageText,
    ephemeralContext: params.ephemeralContext,
    channelId: params.channelId,
    platformMetadata: params.platformMetadata,
    agentOptions: remainingOptions,
    networkConfig,
    guardrailsInline,
    nixConfig,
    preApprovedTools,
  };
}

/**
 * Resolve agent ID for an inbound platform event:
 *   1. an existing channel-subscribed Automation wins;
 *   2. otherwise fall back to the connection's owning `agentId`.
 *
 * Returns `null` when neither resolves — the caller should drop the message.
 * Pure resolution: never writes an Automation.
 *
 * `crossOrg` is for hosted preview connections only: the bot lives in one org
 * but `/lobu link <code>` binds agents from OTHER orgs, so the lookup must be
 * org-agnostic and the binding's own `organizationId` is returned for routing.
 * Leave it false for normal bots, where org-scoping is the multi-tenant guard.
 */
export async function resolveAgentId(params: {
  platform: string;
  channelId: string;
  teamId?: string;
  agentId?: string;
  organizationId?: string;
	connectionId?: string;
  automationSubscriptionService?: AutomationSubscriptionService;
  crossOrg?: boolean;
}): Promise<{
  agentId: string;
  source: "subscription" | "connection";
  organizationId?: string;
  /** Per-binding model override (Listen automation), when routed via a binding. */
  model?: string;
} | null> {
  const {
    platform,
    channelId,
    agentId,
    organizationId,
		connectionId,
    automationSubscriptionService,
    crossOrg,
  } = params;

  if (automationSubscriptionService) {
    // Bind every read to the inbound installation. The subscription service
    // admits its own workspace and authorized cross-workspace chat links;
    // hosted preview installations retain their explicit cross-org routing.
		const subscription =
			connectionId && organizationId
				? await automationSubscriptionService.resolveForConnection(
						connectionId,
          channelId,
						organizationId,
						{ crossOrganization: crossOrg === true, teamId: params.teamId },
					)
				: null;
    if (subscription) {
      logger.info(
        {
          agentId: subscription.agentId,
          platform,
          channelId,
          subscriptionOrg: subscription.organizationId,
        },
				"Routing via message Automation",
      );
      return {
        agentId: subscription.agentId,
        source: "subscription",
        organizationId: subscription.organizationId,
        model: subscription.model,
      };
    }
  }

  if (agentId) {
    logger.info(
      { agentId, platform, channelId },
			"Routing to connection's owning agent",
    );
    return { agentId, source: "connection", organizationId };
  }

  return null;
}
