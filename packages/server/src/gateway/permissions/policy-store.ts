import crypto from "node:crypto";
import type { AgentInlineGuardrail } from "@lobu/core";
import { createLogger, normalizeDomainPattern } from "@lobu/core";
import {
  matchesDomainPattern,
  patternReaches,
} from "@lobu/connector-sdk/egress-policy";
import { getDb } from "../../db/client.js";

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
  /** `md5(agents.guardrails_inline::text)` the rules were prepared from. */
  revision: string;
  rules: PreparedRule[];
}

/**
 * The agent's egress judge policy, read from Postgres (`agents.guardrails_inline`,
 * the one copy every replica agrees on) on each judged request.
 *
 * The per-instance Map is a revision-checked cache, never a source of truth:
 * every lookup reads the stored revision of the agent's guardrail column, and
 * a cached entry is reused only while that revision is unchanged. The column
 * itself crosses the wire only when the revision moved, so the steady-state
 * cost is one primary-key read with no JSON transfer and no re-hashing. A
 * policy saved through any replica is visible to every replica on its next
 * judged request, with no deploy-time sync and no warm-up.
 *
 * The revision is a content hash of the stored column rather than
 * `agents.updated_at`: saves stamp `updated_at` with a millisecond JS clock, so
 * two saves inside one millisecond would share a timestamp and a stale entry
 * would survive. A content hash moves exactly when the policy does.
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
    // Two guardrails with the same name and policy are one judge: same
    // verdict-cache key, same answer, so ask it once.
    const matched = new Map<string, ResolvedJudgeRule>();
    for (const rule of rules) {
      if (!matchesDomainPattern(host, rule.domains)) continue;
      matched.set(rule.resolved.policyHash, rule.resolved);
    }
    return [...matched.values()];
  }

  private async load(
    organizationId: string,
    agentId: string
  ): Promise<PreparedRule[]> {
    const key = `${organizationId}|${agentId}`;
    const cached = this.cache.get(key);
    const sql = getDb();
    const rows = (await sql`
      SELECT revision,
             CASE WHEN revision IS DISTINCT FROM ${cached?.revision ?? null}::text
                  THEN guardrails_inline END AS guardrails_inline
      FROM (
        SELECT md5(guardrails_inline::text) AS revision, guardrails_inline
        FROM agents
        WHERE organization_id = ${organizationId} AND id = ${agentId}
      ) agent
    `) as Array<{ revision: string | null; guardrails_inline: unknown }>;

    const row = rows[0];
    if (!row?.revision) {
      this.cache.delete(key);
      return [];
    }
    if (cached && cached.revision === row.revision) return cached.rules;

    const inline = Array.isArray(row.guardrails_inline)
      ? (row.guardrails_inline as AgentInlineGuardrail[])
      : [];
    const rules = egressJudgeRules(inline).map((rule) => ({
      domains: rule.domains,
      resolved: {
        judgeName: rule.judgeName,
        policy: rule.policy,
        policyHash: hashPolicy(
          organizationId,
          agentId,
          rule.judgeName,
          rule.policy
        ),
        ...(rule.model ? { judgeModel: rule.model } : {}),
      },
    }));
    this.cache.set(key, { revision: row.revision, rules });
    logger.debug("Loaded egress judge policy", {
      organizationId,
      agentId,
      judges: rules.length,
    });
    return rules;
  }
}

/**
 * Translate an agent's inline guardrails into the egress judge rules the proxy
 * evaluates: one rule per enabled `egress`-stage guardrail that has a policy and
 * at least one domain. Rules are kept per guardrail and never merged by domain,
 * because every matching judge runs (two guardrails on the same domain are two
 * judges, both of which must allow).
 *
 * The single builder for the runtime, the write-time shadow checks and the grant
 * guards, so they cannot disagree about which domains are judged.
 */
export function egressJudgeRules(
  guardrails: AgentInlineGuardrail[]
): EgressJudgeRule[] {
  const rules: EgressJudgeRule[] = [];
  for (const g of guardrails) {
    if (!g?.enabled || g.stage !== "egress") continue;
    if (typeof g.policy !== "string" || g.policy.trim() === "") continue;
    const domains = new Set<string>();
    for (const domain of g.domains ?? []) {
      if (typeof domain !== "string" || domain === "") continue;
      domains.add(normalizeDomainPattern(domain));
    }
    if (domains.size === 0) continue;
    rules.push({
      judgeName: g.name,
      domains: [...domains],
      policy: g.policy.trim(),
      ...(g.model ? { model: g.model } : {}),
    });
  }
  return rules;
}

/** Every domain pattern at least one egress judge governs, deduplicated. */
export function judgedEgressDomains(
  guardrails: AgentInlineGuardrail[]
): string[] {
  return [
    ...new Set(egressJudgeRules(guardrails).flatMap((rule) => rule.domains)),
  ];
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
  guardrails: AgentInlineGuardrail[],
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

function hashPolicy(
  organizationId: string,
  agentId: string,
  judgeName: string,
  policy: string
): string {
  return crypto
    .createHash("sha256")
    .update(`${organizationId} ${agentId} ${judgeName} ${policy}`)
    .digest("hex")
    .slice(0, 16);
}
