import { createHash } from "node:crypto";
import {
  generateWorkerToken,
  generateWorkerTokenPair,
  type WorkerTokenData,
} from "@lobu/core";
import type { ModelProviderModule } from "../modules/module-system.js";
import { buildWorkerTokenClaims } from "./worker-token-claims.js";

/**
 * Detect base-URL env keys claimed by more than one provider with CONFLICTING
 * values. When agents merge every installed provider's proxy base-URL mappings,
 * two providers sharing a key (e.g. the old bug where every sdkCompat provider
 * emitted OPENAI_BASE_URL) means the later-merged one silently clobbers the
 * earlier and a request egresses to the wrong slug. Pure + exported so the guard
 * is testable independently of a full deploy. Order matches the merge:
 * last-write-wins, so `incoming` is what survives.
 */
export function detectProviderBaseUrlCollisions(
  perProvider: Array<{ providerId: string; mappings: Record<string, string> }>
): Array<{ key: string; providerId: string; existing: string; incoming: string }> {
  const seen: Record<string, string> = {};
  const collisions: Array<{
    key: string;
    providerId: string;
    existing: string;
    incoming: string;
  }> = [];
  for (const { providerId, mappings } of perProvider) {
    for (const [key, value] of Object.entries(mappings)) {
      const existing = seen[key];
      if (existing !== undefined && existing !== value) {
        collisions.push({ key, providerId, existing, incoming: value });
      }
      seen[key] = value;
    }
  }
  return collisions;
}

/**
 * Mint the deployment-lifetime WORKER_TOKEN. This is the FALLBACK gateway auth
 * the worker uses when no per-run runJobToken was minted (`session-runner`:
 * `runJobToken || WORKER_TOKEN`). Extracted (mirrors message-consumer's
 * `buildRunJobToken`) so both primary-auth mints share a tested claim-parity
 * surface — the #1274 P0 was an omitted-claim divergence between exactly these
 * two mints. Every claim a downstream consumer reads off the verified worker
 * token MUST be set on BOTH mints, or a worker that lands on this fallback path
 * loses it (e.g. headless `source` → owner-gated card dead-letters).
 */
export function buildDeploymentWorkerToken(args: {
  userId: string;
  conversationId: string;
  deploymentName: string;
  channelId: string;
  teamId?: string;
  agentId?: string;
  organizationId?: string;
  platform?: string;
  platformMetadata?: Record<string, unknown>;
  traceId?: string;
  /** Resolved runtime provider + sandbox, so the deployment-lifetime token
   *  also carries the claim the runtime route reads (parity with the per-run mint). */
  runtimeProviderId?: string;
  sandboxId?: string;
  /** Resolved egress allowlist for a remote runtime sandbox (signed claim). */
  allowedDomains?: string[];
  /** Resolved egress denylist for a remote runtime sandbox (signed claim). */
  deniedDomains?: string[];
  /** Resolved nix package set for a remote runtime sandbox (signed claim). */
  nixPackages?: string[];
}): string {
  return generateWorkerToken(
    args.userId,
    args.conversationId,
    args.deploymentName,
    buildDeploymentTokenOptions(args)
  );
}

function buildDeploymentTokenOptions(
  args: Parameters<typeof buildDeploymentWorkerToken>[0]
) {
  return {
    // Shared routing claims — kept in lockstep with the per-run mint via
    // `buildWorkerTokenClaims` so a worker that falls back to this
    // deployment-lifetime token carries the same connectionId/source and
    // doesn't dead-letter its interaction cards (#1274).
    ...buildWorkerTokenClaims(args),
    // Deployment-token-specific claim.
    traceId: args.traceId,
  };
}

export function buildDeploymentTokenPair(
  args: Parameters<typeof buildDeploymentWorkerToken>[0]
): { workerToken: string; egressProxyToken: string } {
  return generateWorkerTokenPair(
    args.userId,
    args.conversationId,
    args.deploymentName,
    buildDeploymentTokenOptions(args)
  );
}

export interface DeploymentIdentity {
  conversationId: string;
  channelId?: string;
  platform?: string;
  userId?: string;
  agentId: string;
  organizationId: string;
}

/**
 * Build a canonical conversation identity key for runtime routing.
 * Preferred format: organizationId:agentId:platform:channelId:conversationId
 */
export function buildCanonicalConversationKey(
  identity: DeploymentIdentity
): string {
  const { organizationId, agentId, conversationId, channelId, platform } =
    identity;
  const scope = `${organizationId}:${agentId}`;
  if (platform && channelId) {
    return `${scope}:${platform}:${channelId}:${conversationId}`;
  }
  if (channelId) {
    return `${scope}:${channelId}:${conversationId}`;
  }
  return `${scope}:${conversationId}`;
}

/**
 * Generate a consistent worker runtime ID from canonical conversation identity.
 * Runtime IDs stay lowercase alphanumeric with hyphens for filesystem and
 * process-manager compatibility.
 */
export function generateDeploymentName(identity: DeploymentIdentity): string {
  const canonicalKey = buildCanonicalConversationKey(identity);
  const rawHint = (identity.platform || identity.userId || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const hint = (rawHint.slice(0, 8) || "ctx").toLowerCase();
  const hash = createHash("sha256")
    .update(canonicalKey)
    .digest("hex")
    .slice(0, 12);
  return `lobu-worker-${hint}-${hash}`;
}

/**
 * The deployment name a turn-liveness marker is addressable under, derived from
 * a VERIFIED worker token's own routing claims.
 *
 * A worker token carries a `deploymentName` claim, and reading it is the
 * obvious thing to do — but for an agent turn that claim is the credential's
 * per-turn scope (`agent-turn:<messageId>`, minted by `mintTurnToken`), not the
 * conversation deployment `MessageConsumer` armed the marker under. The two are
 * different namespaces, so a lookup keyed on the claim matches no marker at
 * all: it fails silently, and the caller sees "this turn has no marker" rather
 * than an error.
 *
 * So the marker's deployment identity is DERIVED here, through the same
 * `generateDeploymentName` the arming site calls, from claims the token signs.
 * A token-holding caller must go through this rather than read the claim —
 * that is what keeps the two sides from drifting again.
 *
 * Returns undefined when the token carries no turn identity (no agent, org or
 * conversation): there is no marker to address, and a name guessed from a
 * partial identity would address a different conversation's.
 */
export function turnMarkerDeploymentFromClaims(
  claims: Pick<
    WorkerTokenData,
    | "userId"
    | "conversationId"
    | "channelId"
    | "platform"
    | "agentId"
    | "organizationId"
  >
): string | undefined {
  if (!claims.agentId || !claims.organizationId || !claims.conversationId)
    return undefined;
  return generateDeploymentName({
    organizationId: claims.organizationId,
    agentId: claims.agentId,
    userId: claims.userId,
    platform: claims.platform,
    channelId: claims.channelId,
    conversationId: claims.conversationId,
  });
}

/** Check if an env var name looks like a secret (API key / token / secret / password). */
export function isSecretEnvVar(
  name: string,
  providerModules: ModelProviderModule[]
): boolean {
  for (const provider of providerModules) {
    if (provider.getSecretEnvVarNames().includes(name)) return true;
  }
  const upper = name.toUpperCase();
  return (
    upper.includes("_KEY") ||
    upper.includes("_TOKEN") ||
    upper.includes("_SECRET") ||
    upper.includes("_PASSWORD")
  );
}
