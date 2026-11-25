import crypto from "node:crypto";
import { createLogger, normalizeDomainPattern } from "@lobu/core";
import { isBuiltinGuardrailConfig } from "@lobu/core/contracts/workspace-guardrails";
import {
  matchesDomainPattern,
  patternReaches,
} from "@lobu/connector-sdk/egress-policy";
import { type DbClient, getDb } from "../../db/client.js";
import {
  type ApplyingGuardrail,
  agentGuardrailPrincipal,
  resolveEgressGuardrails,
} from "../../guardrails/workspace-guardrails.js";

const logger = createLogger("policy-store");

/**
 * One enabled `egress`-stage judge guardrail, as the egress plane evaluates it:
 * the guardrail's own policy and model gating its normalized `domains`.
 */
interface EgressJudgeRule {
  judgeName: string;
  /** Normalized, deduplicated domain patterns (`example.com`, `.example.com`). */
  domains: string[];
  /** Trimmed policy text. */
  policy: string;
  model?: string;
}

/**
 * Resolved judge rule data returned by {@link PolicyStore.resolve}.
 * `policy` is the composed policy text, `policyHash` keys the verdict cache,
 * and `judgeModel` is the per-judge model (undefined falls back to the
 * gateway default in the {@link EgressJudge}/JudgeRunner downstream).
 */
export interface ResolvedJudgeRule {
  judgeName: string;
  policy: string;
  policyHash: string;
  judgeModel?: string;
}

interface PreparedRule {
  domains: string[];
  resolved: ResolvedJudgeRule;
}

interface CachedPolicy {
  /** Content revision of the agent's applying egress guardrails. */
  revision: string;
  rules: PreparedRule[];
}

/**
 * The agent's egress judge policy, read from Postgres (the workspace guardrail
 * library, the one copy every replica agrees on) on each judged request.
 *
 * The per-instance Map is a revision-checked cache, never a source of truth:
 * every lookup reads the content revision of the egress guardrails applying to
 * the agent, and a cached entry is reused only while that revision is
 * unchanged. The guardrail rows cross the wire only when the revision moved,
 * so the steady-state cost is one indexed read with no JSON transfer and no
 * re-hashing. A guardrail saved through any replica is visible to every
 * replica on its next judged request, with no deploy-time sync and no warm-up.
 *
 * The revision is a content hash of the applying set rather than a timestamp:
 * it moves exactly when a guardrail's config, name, enabled flag or subjects
 * change which rules apply.
 *
 * Keyed by `(organizationId, agentId)` and read with an explicit
 * `organization_id` predicate: agent ids are only unique per org, and the raw
 * Node HTTP proxy carries no org context to fall back on.
 */
export class PolicyStore {
  private readonly cache = new Map<string, CachedPolicy>();

  /**
   * Every judge whose domain selector covers `hostname` (D6 accumulation:
   * an exact rule and a covering wildcard both apply; nothing shadows another
   * rule). Empty when no judged rule covers the host. Throws when the policy
   * cannot be read, so the caller can fail closed.
   */
  async resolve(
    organizationId: string,
    agentId: string,
    hostname: string
  ): Promise<ResolvedJudgeRule[]> {
    const rules = await this.load(organizationId, agentId);
    const host = hostname.toLowerCase();
    // One entry per covering guardrail, never collapsed: every judge is
    // evaluated, so dropping one would drop its deny.
    return rules
      .filter((rule) => matchesDomainPattern(host, rule.domains))
      .map((rule) => rule.resolved);
  }

  private async load(
    organizationId: string,
    agentId: string
  ): Promise<PreparedRule[]> {
    const key = `${organizationId}|${agentId}`;
    const cached = this.cache.get(key);
    const { revision, rows } = await resolveEgressGuardrails(
      getDb(),
      organizationId,
      agentGuardrailPrincipal(agentId),
      cached?.revision ?? null
    );
    if (cached && rows === null) return cached.rules;

    const rules = egressJudgeRules(rows ?? []).map((rule) => ({
      domains: rule.domains,
      resolved: {
        judgeName: rule.judgeName,
        policy: rule.policy,
        policyHash: hashPolicy(organizationId, agentId, rule),
        ...(rule.model ? { judgeModel: rule.model } : {}),
      },
    }));
    this.cache.set(key, { revision, rules });
    logger.debug("Loaded egress judge policy", {
      organizationId,
      agentId,
      judges: rules.length,
    });
    return rules;
  }
}

/**
 * Translate library guardrails into the egress judge rules the proxy
 * evaluates: one rule per enabled custom `egress`-stage judge that has a
 * policy and at least one domain. Rules are kept per guardrail and never merged by domain,
 * because every matching judge runs (two guardrails on the same domain are two
 * judges, both of which must allow).
 *
 * The single builder for the runtime, the write-time shadow checks and the grant
 * guards, so they cannot disagree about which domains are judged.
 */
export function egressJudgeRules(
  guardrails: readonly ApplyingGuardrail[]
): EgressJudgeRule[] {
  const rules: EgressJudgeRule[] = [];
  for (const guardrail of guardrails) {
    const g = guardrail.config;
    if (!guardrail.enabled || isBuiltinGuardrailConfig(g)) continue;
    if (g.kind !== "judge" || g.stage !== "egress") continue;
    if (typeof g.policy !== "string" || g.policy.trim() === "") continue;
    const domains = new Set<string>();
    for (const domain of g.domains ?? []) {
      if (typeof domain !== "string" || domain === "") continue;
      domains.add(normalizeDomainPattern(domain));
    }
    if (domains.size === 0) continue;
    rules.push({
      judgeName: guardrail.name,
      domains: [...domains],
      policy: g.policy.trim(),
      ...(g.model ? { model: g.model } : {}),
    });
  }
  return rules;
}

/** Every domain pattern at least one egress judge governs, deduplicated. */
export function judgedEgressDomains(
  guardrails: readonly ApplyingGuardrail[]
): string[] {
  return [
    ...new Set(egressJudgeRules(guardrails).flatMap((rule) => rule.domains)),
  ];
}

/**
 * The agent's judged egress domains, read from the workspace guardrail library
 * (the one source every replica agrees on, and the one {@link PolicyStore}
 * reads too) through {@link judgedEgressDomains}, so the grant guards, the
 * dispatch reconcile and the write-time shadow check filter and normalize
 * exactly like the runtime.
 *
 * Errors PROPAGATE. If a caller cannot tell whether a domain is judged,
 * granting it risks silently disabling a policy control.
 */
/**
 * Serialize an organization's egress-judge decisions: a guardrail library
 * write and an allow-grant write each hold this for their whole transaction.
 * The grant writer skips a domain a judge governs and the guardrail writer
 * revokes allow grants its judge would be shadowed by; each reads the other's
 * table, so without one exclusive lock an allow grant can commit just after a
 * judge's grant cleanup and bypass that judge. Transaction-scoped: released on
 * commit or rollback.
 */
export async function lockEgressJudgeDecisions(
  tx: DbClient,
  organizationId: string
): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["egress-judge", organizationId])}, 0))`;
}

export async function readJudgedEgressDomains(
  organizationId: string,
  agentId: string,
  sql: DbClient = getDb()
): Promise<string[]> {
  const { rows } = await resolveEgressGuardrails(
    sql,
    organizationId,
    agentGuardrailPrincipal(agentId),
    null
  );
  return judgedEgressDomains(rows ?? []);
}

/**
 * One judged domain whose judge can never run because an allow grant covers it.
 *
 * `checkDomainAccess` (proxy/http-proxy.ts) consults per-agent allow grants
 * BEFORE the egress judge, so a domain that is both judged and allow-granted
 * returns `allowed: true, source: "grant"` and its judge policy is dead config.
 * The request looks permitted for a reason that has nothing to do with the
 * policy the operator wrote, which is exactly the shape of failure the operator
 * will not notice: the traffic flows.
 */
interface SuppressedJudgedDomain {
  /** Normalized judged pattern from the guardrail's `domains` selector. */
  domain: string;
  /** The guardrail whose judge is suppressed. */
  judge: string;
  /** The normalized allow pattern that shadows it. */
  grant: string;
}

interface SuppressedJudgedDomainOptions {
  /**
   * Whether a `.suffix` allow pattern also covers its root host. The proxy's
   * global allowlist matcher does (`matchesDomainPattern` in
   * `@lobu/connector-sdk/egress-policy`); the per-agent
   * `GrantStore.hasGrant` does not — it expands a hostname into its exact form
   * plus its wildcard PARENTS, so the root never sees its own wildcard row.
   * Defaults to grant semantics. Passed straight through to `patternReaches`
   * in `@lobu/connector-sdk/egress-policy`, the one overlap predicate shared
   * with the grant store's write guard, the deployment manager's grant
   * reconcile, and the remote runtime's deny subtraction.
   */
  wildcardCoversRoot?: boolean;
}

/**
 * Find judged domains that an allow list shadows, one entry per (judge,
 * domain) pair.
 *
 * Derives the judged set through {@link egressJudgeRules} — the same builder
 * the runtime uses — so write-time validation and runtime enforcement cannot
 * disagree about which domains are judged. Because every matching judge runs,
 * an allow that covers a domain silences EVERY judge on it, and each one is
 * reported (not just the last declaration).
 *
 * Reports PARTIAL shadowing too: an exact allow for `example.com` against a
 * judged `.example.com` leaves the root ungoverned while subdomains stay
 * judged, and an allow for `api.example.com` under that same judge carves one
 * host out of it. Each is a narrower hole, but still a hole.
 */
export function findSuppressedJudgedDomains(
  guardrails: readonly ApplyingGuardrail[],
  allowedDomains: string[] | undefined,
  options: SuppressedJudgedDomainOptions = {}
): SuppressedJudgedDomain[] {
  const rules = egressJudgeRules(guardrails);
  if (rules.length === 0) return [];

  const allowPatterns = (allowedDomains ?? [])
    .filter((d): d is string => typeof d === "string" && d.trim() !== "")
    .map((d) => normalizeDomainPattern(d));
  if (allowPatterns.length === 0) return [];

  const wildcardCoversRoot = options.wildcardCoversRoot ?? false;
  const suppressed: SuppressedJudgedDomain[] = [];
  for (const rule of rules) {
    for (const domain of rule.domains) {
      const covering = allowPatterns.find((allow) =>
        patternReaches(domain, allow, { wildcardCoversRoot })
      );
      if (covering) {
        suppressed.push({ domain, judge: rule.judgeName, grant: covering });
      }
    }
  }
  return suppressed;
}

/**
 * Verdict-cache and circuit-breaker key for one judge. Every field that can
 * change the verdict is hashed as one JSON tuple, so no two distinct judges can
 * share a key: a delimiter-joined string let a name/policy split that reads the
 * same once joined ("owner check" + "Only…" vs "owner" + "check Only…") collide,
 * and two judges sharing a key share one cached verdict.
 */
function hashPolicy(
  organizationId: string,
  agentId: string,
  rule: EgressJudgeRule
): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        organizationId,
        agentId,
        rule.judgeName,
        rule.policy,
        rule.model ?? null,
      ])
    )
    .digest("hex");
}
