import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { CustomGuardrailConfig } from "@lobu/core/contracts/workspace-guardrails";
import { createTestWorkspaceGuardrail } from "../../__tests__/setup/test-fixtures.js";
import { getDb } from "../../db/client.js";
import type { ApplyingGuardrail } from "../../guardrails/workspace-guardrails.js";
import {
  egressJudgeRules,
  findSuppressedJudgedDomains,
  judgedEgressDomains,
  PolicyStore,
} from "../permissions/policy-store.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

type EgressOver = Partial<CustomGuardrailConfig> & {
  name: string;
  enabled?: boolean;
};

/** A library row as `resolveEgressGuardrails` returns it. */
function guardrail({ name, enabled = true, ...config }: EgressOver): ApplyingGuardrail {
  return {
    id: `id-${name}`,
    name,
    enabled,
    revision: 1,
    config: { kind: "judge", stage: "egress", policy: "p", ...config },
  };
}

describe("PolicyStore.resolve (reads the workspace guardrail library)", () => {
  async function storeGuardrail(
    over: EgressOver,
    options: {
      organizationId?: string;
      appliesTo?: Array<{ kind: "agent" | "app"; id: string | null }> | "everyone";
    } = {}
  ): Promise<string> {
    const { config, enabled } = guardrail(over);
    const { id } = await createTestWorkspaceGuardrail({
      organizationId: options.organizationId ?? "org-a",
      name: over.name,
      config,
      enabled,
      appliesTo: options.appliesTo ?? [{ kind: "agent", id: "agent-a" }],
    });
    return id;
  }

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 60_000);

  beforeEach(async () => {
    await resetTestDatabase();
    await seedAgentRow("agent-a", { organizationId: "org-a" });
  });

  test("returns [] for an agent with no judged rule, or no row at all", async () => {
    const store = new PolicyStore();
    expect(await store.resolve("org-a", "agent-a", "api.github.com")).toEqual([]);
    expect(await store.resolve("org-a", "no-such-agent", "x.com")).toEqual([]);
  });

  test("matches an exact domain rule and carries its policy and model", async () => {
    await storeGuardrail({
      name: "default",
      policy: "  Only allow read-only GET requests.  ",
      model: "model-x",
      domains: ["api.github.com"],
    });
    const [rule, ...rest] = await new PolicyStore().resolve(
      "org-a",
      "agent-a",
      "API.github.com"
    );
    expect(rest).toEqual([]);
    expect(rule?.judgeName).toBe("default");
    expect(rule?.policy).toBe("Only allow read-only GET requests.");
    expect(rule?.judgeModel).toBe("model-x");
  });

  test("a wildcard covers its subdomains and apex, on a label boundary", async () => {
    await storeGuardrail({ name: "j", domains: ["*.example.com"] });
    const store = new PolicyStore();
    expect(await store.resolve("org-a", "agent-a", "foo.example.com")).toHaveLength(1);
    expect(await store.resolve("org-a", "agent-a", "example.com")).toHaveLength(1);
    expect(await store.resolve("org-a", "agent-a", "unrelated.com")).toEqual([]);
    expect(await store.resolve("org-a", "agent-a", "notexample.com")).toEqual([]);
  });

  test("returns EVERY covering rule: exact, longer and shorter wildcards all apply", async () => {
    await storeGuardrail({ name: "short", policy: "short", domains: [".example.com"] });
    await storeGuardrail({ name: "long", policy: "long", domains: [".api.example.com"] });
    await storeGuardrail({ name: "exact", policy: "exact", domains: ["v1.api.example.com"] });
    await storeGuardrail({ name: "other", policy: "other", domains: ["example.org"] });
    const rules = await new PolicyStore().resolve(
      "org-a",
      "agent-a",
      "v1.api.example.com"
    );
    expect(rules.map((r) => r.judgeName).sort()).toEqual(["exact", "long", "short"]);
  });

  test("guardrails accumulate across subjects: everyone, every agent, and this agent", async () => {
    await seedAgentRow("agent-b", { organizationId: "org-a" });
    await storeGuardrail({ name: "everyone", domains: ["x.com"] }, { appliesTo: "everyone" });
    await storeGuardrail({ name: "all-agents", domains: ["x.com"] }, { appliesTo: [{ kind: "agent", id: null }] });
    await storeGuardrail({ name: "mine", domains: ["x.com"] });
    await storeGuardrail({ name: "other-agent", domains: ["x.com"] }, { appliesTo: [{ kind: "agent", id: "agent-b" }] });
    await storeGuardrail({ name: "apps-only", domains: ["x.com"] }, { appliesTo: [{ kind: "app", id: null }] });
    const rules = await new PolicyStore().resolve("org-a", "agent-a", "x.com");
    expect(rules.map((r) => r.judgeName)).toEqual(["all-agents", "everyone", "mine"]);
  });

  test("distinct judges never share a verdict-cache key", async () => {
    await storeGuardrail({ name: "owner-check", policy: "Only allow reads.", domains: ["x.com"] });
    // Reads the same as the previous one once name and policy are space-joined.
    await storeGuardrail({ name: "owner", policy: "-check Only allow reads.", domains: ["x.com"] });
    // Same policy, different model: the verdict can differ.
    await storeGuardrail({ name: "m1", policy: "Only allow reads.", model: "m-1", domains: ["x.com"] });
    await storeGuardrail({ name: "m2", policy: "Only allow reads.", model: "m-2", domains: ["x.com"] });
    const rules = await new PolicyStore().resolve("org-a", "agent-a", "x.com");
    expect(rules).toHaveLength(4);
    expect(new Set(rules.map((r) => r.policyHash)).size).toBe(4);
  });

  test("ignores disabled, non-egress, policy-less and built-in guardrails", async () => {
    await storeGuardrail({ name: "off", enabled: false, domains: ["x.com"] });
    await storeGuardrail({ name: "in", stage: "input", domains: ["x.com"] });
    await storeGuardrail({ name: "blank", policy: "  ", domains: ["x.com"] });
    await createTestWorkspaceGuardrail({
      organizationId: "org-a",
      name: "secrets",
      config: { builtin: "secret-scan" },
    });
    expect(await new PolicyStore().resolve("org-a", "agent-a", "x.com")).toEqual([]);
  });

  test("a warm store follows every change to the library", async () => {
    const sql = getDb();
    const store = new PolicyStore();
    const id = await storeGuardrail({ name: "j", policy: "first", domains: ["x.com"] });
    const first = await store.resolve("org-a", "agent-a", "x.com");
    const again = await store.resolve("org-a", "agent-a", "x.com");
    expect(again[0]?.policyHash).toBe(first[0]?.policyHash as string);

    await sql`
      UPDATE workspace_guardrails
      SET config = jsonb_set(config, '{policy}', '"second"'), revision = revision + 1
      WHERE id = ${id}
    `;
    const changed = await store.resolve("org-a", "agent-a", "x.com");
    expect(changed[0]?.policy).toBe("second");
    expect(changed[0]?.policyHash).not.toBe(first[0]?.policyHash as string);

    await sql`UPDATE workspace_guardrails SET enabled = false WHERE id = ${id}`;
    expect(await store.resolve("org-a", "agent-a", "x.com")).toEqual([]);

    await sql`UPDATE workspace_guardrails SET enabled = true WHERE id = ${id}`;
    expect(await store.resolve("org-a", "agent-a", "x.com")).toHaveLength(1);
    await sql`DELETE FROM workspace_guardrail_subjects WHERE guardrail_id = ${id}`;
    expect(await store.resolve("org-a", "agent-a", "x.com")).toEqual([]);

    await sql`
      INSERT INTO workspace_guardrail_subjects (guardrail_id, organization_id, principal_kind, principal_id)
      VALUES (${id}, 'org-a', 'agent', 'agent-a')
    `;
    expect(await store.resolve("org-a", "agent-a", "x.com")).toHaveLength(1);
    await sql`UPDATE workspace_guardrails SET archived_at = now() WHERE id = ${id}`;
    expect(await store.resolve("org-a", "agent-a", "x.com")).toEqual([]);
  });

  test("is scoped by organization: the same agent id elsewhere owns nothing here", async () => {
    await seedAgentRow("agent-a", { organizationId: "org-b" });
    await storeGuardrail({ name: "a-only", domains: ["x.com"] });
    await storeGuardrail(
      { name: "everyone-in-a", domains: ["x.com"] },
      { appliesTo: "everyone" }
    );
    const store = new PolicyStore();
    expect(await store.resolve("org-a", "agent-a", "x.com")).toHaveLength(2);
    expect(await store.resolve("org-b", "agent-a", "x.com")).toEqual([]);
  });

  test("the verdict-cache key differs across orgs and agents for an identical policy", async () => {
    await seedAgentRow("agent-a", { organizationId: "org-b" });
    await seedAgentRow("agent-b", { organizationId: "org-a" });
    const same = { name: "j", policy: "same", domains: ["x.com"] };
    await storeGuardrail(same, { appliesTo: [{ kind: "agent", id: null }] });
    await storeGuardrail(same, { organizationId: "org-b" });
    const store = new PolicyStore();
    const hashes = await Promise.all(
      [
        ["org-a", "agent-a"],
        ["org-b", "agent-a"],
        ["org-a", "agent-b"],
      ].map(async ([org, agent]) => {
        const [rule] = await store.resolve(org!, agent!, "x.com");
        return rule?.policyHash;
      })
    );
    expect(hashes.every(Boolean)).toBe(true);
    expect(new Set(hashes).size).toBe(3);
  });
});

describe("egressJudgeRules / judgedEgressDomains", () => {
  test("yields nothing when no guardrail declares a domain", () => {
    expect(egressJudgeRules([guardrail({ name: "default" })])).toEqual([]);
    expect(judgedEgressDomains([guardrail({ name: "default" })])).toEqual([]);
  });

  test("normalizes domain patterns and skips empty entries", () => {
    const [rule] = egressJudgeRules([
      guardrail({ name: "j", domains: ["", "*.Example.COM"], model: "openai/m" }),
    ]);
    expect(rule?.domains).toEqual([".example.com"]);
    expect(rule?.model).toBe("openai/m");
  });

  test("keeps one rule per guardrail: a shared domain is judged by both", () => {
    const rules = egressJudgeRules([
      guardrail({ name: "j1", domains: ["*.example.com"] }),
      guardrail({ name: "j2", domains: [".example.com"] }),
    ]);
    expect(rules.map((r) => r.judgeName)).toEqual(["j1", "j2"]);
    // ...while the judged-domain set the grant guards use stays deduplicated.
    expect(
      judgedEgressDomains([
        guardrail({ name: "j1", domains: ["*.example.com"] }),
        guardrail({ name: "j2", domains: [".example.com"] }),
      ])
    ).toEqual([".example.com"]);
  });

  test("skips built-in rows", () => {
    expect(
      egressJudgeRules([
        { id: "b", name: "secrets", enabled: true, revision: 1, config: { builtin: "secret-scan" } },
      ])
    ).toEqual([]);
  });
});

describe("findSuppressedJudgedDomains", () => {
  const judge = (over: Partial<EgressOver> = {}): ApplyingGuardrail =>
    guardrail({
      name: "watchdog",
      policy: "Allow read-only GETs.",
      domains: ["example.com"],
      ...over,
    });

  test("reports an exact judged domain shadowed by an exact grant", () => {
    const found = findSuppressedJudgedDomains([judge()], ["example.com"]);
    expect(found).toEqual([
      { domain: "example.com", judge: "watchdog", grant: "example.com" },
    ]);
  });

  test("reports a judged domain shadowed by a WILDCARD grant", () => {
    // The whole point of reusing the runtime matcher: string equality would
    // miss this, and the judge would silently never run.
    const found = findSuppressedJudgedDomains(
      [judge({ domains: ["api.example.com"] })],
      ["*.example.com"]
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.grant).toBe(".example.com");
  });

  test("reports PARTIAL shadowing: exact grant against a wildcard judge", () => {
    // `example.com` itself becomes grant-allowed while subdomains stay judged.
    // A narrower hole is still a hole.
    const found = findSuppressedJudgedDomains(
      [judge({ domains: ["*.example.com"] })],
      ["example.com"]
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.domain).toBe(".example.com");
  });

  test("reports a grant NARROWER than the judged wildcard — one host carved out", () => {
    // `api.example.com` is granted, so its judge never runs, while the rest of
    // `*.example.com` stays judged. Testing only the judged root would miss it.
    const found = findSuppressedJudgedDomains(
      [judge({ domains: ["*.example.com"] })],
      ["api.example.com"]
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.grant).toBe("api.example.com");
  });

  test("reports two wildcards whose subdomain sets intersect", () => {
    expect(
      findSuppressedJudgedDomains(
        [judge({ domains: ["*.example.com"] })],
        ["*.api.example.com"]
      )
    ).toHaveLength(1);
    expect(
      findSuppressedJudgedDomains(
        [judge({ domains: ["*.api.example.com"] })],
        ["*.example.com"]
      )
    ).toHaveLength(1);
  });

  test("normalizes both sides, so spelling variants still collide", () => {
    const found = findSuppressedJudgedDomains(
      [judge({ domains: [".EXAMPLE.com"] })],
      ["*.example.com"]
    );
    expect(found).toHaveLength(1);
  });

  // ── negative controls: the guard must not fire on a healthy config ──
  test("returns [] when the grant names an unrelated domain", () => {
    expect(findSuppressedJudgedDomains([judge()], ["example.org"])).toEqual([]);
  });

  test("returns [] when a narrower grant does not cover the judged domain", () => {
    // Grant is a strict subdomain of the judged host — it cannot shadow it.
    expect(
      findSuppressedJudgedDomains([judge()], ["api.example.com"])
    ).toEqual([]);
  });

  test("returns [] for an exact judged ROOT beside a wildcard grant of the same suffix", () => {
    // `GrantStore.hasGrant` expands a host into its wildcard PARENTS only, so a
    // `*.example.com` grant never covers `example.com` itself — the judge still
    // runs for the root. Rejecting this would be a false positive.
    expect(
      findSuppressedJudgedDomains([judge()], ["*.example.com"])
    ).toEqual([]);
  });

  test("wildcardCoversRoot: the GLOBAL allowlist's `.suffix` DOES cover the root", () => {
    // The shared `matchesDomainPattern` the proxy's global lists use treats
    // `.example.com` as matching `example.com` too, so for
    // WORKER_ALLOWED_DOMAINS the same pair is a hit.
    expect(
      findSuppressedJudgedDomains([judge()], ["*.example.com"], {
        wildcardCoversRoot: true,
      })
    ).toHaveLength(1);
  });

  test("returns [] when there is no allow list at all", () => {
    expect(findSuppressedJudgedDomains([judge()], [])).toEqual([]);
    expect(findSuppressedJudgedDomains([judge()], undefined)).toEqual([]);
  });

  test("ignores a DISABLED guardrail — it has no judge to suppress", () => {
    expect(
      findSuppressedJudgedDomains([judge({ enabled: false })], ["example.com"])
    ).toEqual([]);
  });

  test("ignores a non-egress guardrail", () => {
    expect(
      findSuppressedJudgedDomains(
        [judge({ stage: "input" })],
        ["example.com"]
      )
    ).toEqual([]);
  });

  test("ignores blank and non-string allow entries", () => {
    expect(
      findSuppressedJudgedDomains([judge()], [
        "",
        "   ",
        null as unknown as string,
      ])
    ).toEqual([]);
  });

  test("reports EVERY judge a grant silences on a shared domain", () => {
    // Every judge covering a host runs, so an allow over the domain hides each
    // of them — the last declaration does not stand in for the others.
    const found = findSuppressedJudgedDomains(
      [
        judge({ name: "a", policy: "first" }),
        judge({ name: "b", policy: "second" }),
      ],
      ["example.com"]
    );
    expect(found.map((f) => f.judge)).toEqual(["a", "b"]);
  });

  test("attributes each hit to the guardrail that owns the domain", () => {
    const found = findSuppressedJudgedDomains(
      [
        judge({ name: "a", domains: ["a.test"] }),
        judge({ name: "b", domains: ["b.test"] }),
      ],
      ["b.test"]
    );
    expect(found).toEqual([
      { domain: "b.test", judge: "b", grant: "b.test" },
    ]);
  });
});
