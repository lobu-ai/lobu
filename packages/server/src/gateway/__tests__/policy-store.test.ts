import { describe, expect, test } from "bun:test";
import type { AgentInlineGuardrail } from "@lobu/core";
import {
  egressGuardrailsToPolicyBundle,
  findSuppressedJudgedDomains,
  PolicyStore,
} from "../permissions/policy-store.js";

describe("PolicyStore.resolve", () => {
  test("returns undefined when no bundle is set", () => {
    const store = new PolicyStore();
    expect(store.resolve("org-a", "agent-a","api.github.com")).toBeUndefined();
  });

  test("matches an exact domain rule and composes the policy", () => {
    const store = new PolicyStore();
    store.set("org-a", "agent-a", {
      judgedDomains: [{ domain: "api.github.com" }],
      judges: { default: "Only allow read-only GET requests." },
    });
    const resolved = store.resolve("org-a", "agent-a","api.github.com");
    expect(resolved).toBeDefined();
    expect(resolved?.judgeName).toBe("default");
    expect(resolved?.policy).toContain("Only allow read-only GET requests.");
  });

  test("matches a wildcard rule", () => {
    const store = new PolicyStore();
    store.set("org-a", "agent-a", {
      judgedDomains: [{ domain: ".example.com" }],
      judges: { default: "check" },
    });
    expect(store.resolve("org-a", "agent-a","foo.example.com")).toBeDefined();
    expect(store.resolve("org-a", "agent-a","example.com")).toBeDefined();
    expect(store.resolve("org-a", "agent-a","unrelated.com")).toBeUndefined();
    // Suffix match is on a label boundary, not a raw string suffix.
    expect(store.resolve("org-a", "agent-a","notexample.com")).toBeUndefined();
  });

  test("exact match beats wildcard rule", () => {
    const store = new PolicyStore();
    store.set("org-a", "agent-a", {
      judgedDomains: [
        { domain: ".example.com", judge: "wildcard-policy" },
        { domain: "api.example.com", judge: "exact-policy" },
      ],
      judges: {
        "wildcard-policy": "wildcard",
        "exact-policy": "exact",
      },
    });
    const resolved = store.resolve("org-a", "agent-a","api.example.com");
    expect(resolved?.judgeName).toBe("exact-policy");
  });

  test("longer wildcard beats shorter wildcard", () => {
    const store = new PolicyStore();
    store.set("org-a", "agent-a", {
      judgedDomains: [
        { domain: ".example.com", judge: "short" },
        { domain: ".api.example.com", judge: "long" },
      ],
      judges: { short: "short", long: "long" },
    });
    expect(store.resolve("org-a", "agent-a","foo.api.example.com")?.judgeName).toBe(
      "long"
    );
  });

  test("resolves a named judge via the `judge` field", () => {
    const store = new PolicyStore();
    store.set("org-a", "agent-a", {
      judgedDomains: [{ domain: "x.com", judge: "strict" }],
      judges: { strict: "strict policy", default: "default policy" },
    });
    const resolved = store.resolve("org-a", "agent-a","x.com");
    expect(resolved?.judgeName).toBe("strict");
    expect(resolved?.policy).toContain("strict policy");
  });

  test("resolves the per-judge model when present", () => {
    const store = new PolicyStore();
    store.set("org-a", "agent-a", {
      judgedDomains: [{ domain: "x.com" }],
      judges: { default: "skill policy" },
      judgeModels: { default: "model-x" },
    });
    const resolved = store.resolve("org-a", "agent-a","x.com");
    expect(resolved?.policy).toContain("skill policy");
    expect(resolved?.judgeModel).toBe("model-x");
  });

  test("returns undefined (fail closed) when the named judge is missing", () => {
    const store = new PolicyStore();
    store.set("org-a", "agent-a", {
      judgedDomains: [{ domain: "x.com", judge: "strict" }],
      judges: {},
    });
    expect(store.resolve("org-a", "agent-a","x.com")).toBeUndefined();
  });

  test("policyHash is stable across resolve calls", () => {
    const store = new PolicyStore();
    store.set("org-a", "agent-a", {
      judgedDomains: [{ domain: "x.com" }],
      judges: { default: "p" },
    });
    const a = store.resolve("org-a", "agent-a","x.com")?.policyHash;
    const b = store.resolve("org-a", "agent-a","x.com")?.policyHash;
    expect(a).toBe(b!);
  });

  test("policyHash changes when the policy text changes", () => {
    const store = new PolicyStore();
    store.set("org-a", "agent-a", {
      judgedDomains: [{ domain: "x.com" }],
      judges: { default: "first" },
    });
    const a = store.resolve("org-a", "agent-a","x.com")?.policyHash;
    store.set("org-a", "agent-a", {
      judgedDomains: [{ domain: "x.com" }],
      judges: { default: "second" },
    });
    const b = store.resolve("org-a", "agent-a","x.com")?.policyHash;
    expect(a).not.toBe(b);
  });

  test("clear removes the bundle", () => {
    const store = new PolicyStore();
    store.set("org-a", "agent-a", {
      judgedDomains: [{ domain: "x.com" }],
      judges: { default: "p" },
    });
    store.clear("org-a", "agent-a");
    expect(store.resolve("org-a", "agent-a","x.com")).toBeUndefined();
  });
});

describe("egressGuardrailsToPolicyBundle", () => {
  // These ran against `buildPolicyBundle`, an oracle with no production
  // caller, now deleted. The same properties belong to the live builder.
  function guardrail(
    over: Partial<AgentInlineGuardrail> & { name: string }
  ): AgentInlineGuardrail {
    return {
      enabled: true,
      stage: "egress",
      policy: "p",
      ...over,
    } as AgentInlineGuardrail;
  }

  test("returns undefined when no guardrail declares a domain", () => {
    expect(
      egressGuardrailsToPolicyBundle([guardrail({ name: "default" })])
    ).toBeUndefined();
  });

  test("builds a bundle when domains are present", () => {
    const bundle = egressGuardrailsToPolicyBundle([
      guardrail({ name: "default", domains: ["x.com"], model: "openai/m" }),
    ]);
    expect(bundle).toBeDefined();
    expect(bundle?.judgedDomains).toHaveLength(1);
    expect(bundle?.judgeModels?.default).toBe("openai/m");
  });

  test("normalizes domain patterns in rules", () => {
    const bundle = egressGuardrailsToPolicyBundle([
      guardrail({ name: "default", domains: ["*.Example.COM"] }),
    ]);
    expect(bundle?.judgedDomains[0]?.domain).toBe(".example.com");
  });

  test("deduplicates equivalent domain patterns", () => {
    const bundle = egressGuardrailsToPolicyBundle([
      guardrail({ name: "j1", domains: ["*.example.com"] }),
      guardrail({ name: "j2", domains: [".example.com"] }),
    ]);
    expect(bundle?.judgedDomains).toHaveLength(1);
  });

  test("skips empty domain entries", () => {
    const bundle = egressGuardrailsToPolicyBundle([
      guardrail({ name: "j", domains: ["", "api.example.com"] }),
    ]);
    expect(bundle?.judgedDomains.map((rule) => rule.domain)).toEqual([
      "api.example.com",
    ]);
  });
});

describe("findSuppressedJudgedDomains", () => {
  const judge = (
    over: Partial<AgentInlineGuardrail> = {}
  ): AgentInlineGuardrail =>
    ({
      name: "watchdog",
      stage: "egress",
      enabled: true,
      policy: "Allow read-only GETs.",
      domains: ["example.com"],
      ...over,
    }) as AgentInlineGuardrail;

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
        [judge({ stage: "ingress" } as Partial<AgentInlineGuardrail>)],
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
