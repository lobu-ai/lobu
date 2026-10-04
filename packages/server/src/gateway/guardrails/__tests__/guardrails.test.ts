/**
 * Tests for the guardrails extensions:
 *  - `pii-scan` regex built-in (input, output, pre-tool) + Luhn filter
 *  - `safeStringify` helper (BigInt, circular refs)
 *  - `TextJudge` with a fake LLM client (cache hit, fail closed)
 *  - `createJudgeGuardrail` factory across stages + tool narrowing
 *  - `resolveAgentGuardrails` merge / dedup / exclude semantics
 */

import { describe, expect, test } from "bun:test";
import {
  createNoopGuardrail,
  GuardrailRegistry,
  type GuardrailStage,
} from "@lobu/core";
import {
  createJudgeGuardrail,
  createPiiScanGuardrail,
  inlineJudgeHash,
  luhnValid,
  resolveAgentGuardrails,
  safeStringify,
  TextJudge,
} from "../index.js";
import type { JudgeClient, JudgeVerdict } from "../../proxy/egress-judge/types.js";
import { registerBuiltinGuardrails } from "../builtins.js";

// --- Helpers ---------------------------------------------------------------

class FakeJudgeClient implements JudgeClient {
  public calls: Array<{ model: string; userPrompt: string }> = [];
  constructor(private impl: (userPrompt: string) => JudgeVerdict) {}
  async judge(args: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<JudgeVerdict> {
    this.calls.push({ model: args.model, userPrompt: args.userPrompt });
    return this.impl(args.userPrompt);
  }
}

class ThrowingJudgeClient implements JudgeClient {
  public calls = 0;
  async judge(): Promise<JudgeVerdict> {
    this.calls += 1;
    throw new Error("simulated transport failure");
  }
}

// --- luhnValid -------------------------------------------------------------

describe("luhnValid", () => {
  test("accepts known Luhn-valid test PANs (Visa, MasterCard, Amex)", () => {
    expect(luhnValid("4111111111111111")).toBe(true); // Visa
    expect(luhnValid("4111 1111 1111 1111")).toBe(true); // spaced
    expect(luhnValid("4111-1111-1111-1111")).toBe(true); // hyphenated
    expect(luhnValid("5500000000000004")).toBe(true); // MasterCard
    expect(luhnValid("340000000000009")).toBe(true); // Amex (15 digits)
    expect(luhnValid("6011000000000004")).toBe(true); // Discover
  });

  test("rejects random / sequential 13-19 digit runs", () => {
    expect(luhnValid("1234567890123456")).toBe(false);
    expect(luhnValid("9876543210987654")).toBe(false);
    expect(luhnValid("4111111111111112")).toBe(false); // one digit off
  });

  test("rejects out-of-range lengths", () => {
    expect(luhnValid("1234567890")).toBe(false); // too short
    expect(luhnValid("12345678901234567890")).toBe(false); // 20 digits
  });

  test("rejects non-digit content", () => {
    expect(luhnValid("4111-aaaa-1111-1111")).toBe(false);
  });
});

// --- safeStringify ---------------------------------------------------------

describe("safeStringify", () => {
  test("serializes plain objects normally", () => {
    expect(safeStringify({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
  });

  test("handles BigInt without throwing", () => {
    const out = safeStringify({ id: 10n });
    expect(out).toContain('"10"');
  });

  test("handles circular references without throwing", () => {
    const node: { name: string; self?: unknown } = { name: "root" };
    node.self = node;
    const out = safeStringify(node);
    expect(out).toContain("<circular>");
  });

  test("returns <unserializable> if even JSON.stringify with replacer throws", () => {
    // A getter that throws -- JSON.stringify will surface it.
    const bad = {
      get boom() {
        throw new Error("nope");
      },
    };
    expect(safeStringify(bad)).toBe("<unserializable>");
  });

  // JSON.stringify returns `undefined` (not a string) for top-level
  // non-serializable primitives. Downstream callers `.match()` the result,
  // so safeStringify must hand back a string regardless.
  test("always returns a string for top-level undefined", () => {
    expect(safeStringify(undefined)).toBe("<unserializable>");
  });

  test("always returns a string for top-level function", () => {
    expect(safeStringify(() => 42)).toBe("<unserializable>");
  });

  test("always returns a string for top-level symbol", () => {
    expect(safeStringify(Symbol("x"))).toBe("<unserializable>");
  });

  test("always returns a string for top-level bigint", () => {
    expect(typeof safeStringify(10n)).toBe("string");
  });
});

// --- secret-scan -----------------------------------------------------------

describe("secret-scan builtin", () => {
  function secretScan() {
    const reg = new GuardrailRegistry();
    registerBuiltinGuardrails(reg);
    const g = reg.get("output", "secret-scan");
    if (!g) throw new Error("secret-scan not registered");
    return g;
  }

  async function tripped(text: string): Promise<boolean> {
    const r = await secretScan().run({
      agentId: "a",
      userId: "u",
      platform: "slack",
      text,
    });
    return r.tripped === true;
  }

  // A canonical HS256 JWT: header is base64url({"alg":"HS256","typ":"JWT"}) =
  // 36 chars (only 33 after `eyJ`), which the old `{40,}` floor missed.
  const HS256_JWT =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
    ".eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ" +
    ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

  test("trips on a standard HS256 JWT (regression: 33-char header < old {40,} floor)", async () => {
    expect(await tripped(`token: ${HS256_JWT}`)).toBe(true);
  });

  test("trips on a JWT longer than the per-delta scan window", async () => {
    // A realistic OIDC access token with a large payload — well over 512 chars.
    const bigPayload = "A".repeat(900);
    const longJwt = `eyJhbGciOiJSUzI1NiJ9.eyJ${bigPayload}.${"S".repeat(342)}`;
    expect(longJwt.length).toBeGreaterThan(512);
    expect(await tripped(longJwt)).toBe(true);
  });

  test("trips on GitHub OAuth/app tokens (gho_/ghu_/ghs_/ghr_) and fine-grained PATs", async () => {
    expect(await tripped(`gho_${"A".repeat(36)}`)).toBe(true);
    expect(await tripped(`ghs_${"b".repeat(36)}`)).toBe(true);
    expect(await tripped(`github_pat_${"1aB2".repeat(8)}`)).toBe(true);
    // Classic PAT still caught.
    expect(await tripped(`ghp_${"c".repeat(36)}`)).toBe(true);
  });

  test("trips on AWS temporary (STS / ASIA) and other principal-id access keys", async () => {
    expect(await tripped("ASIAY34FZKBOKMUTVV7A")).toBe(true);
    expect(await tripped("AROAEXAMPLEID1234567")).toBe(true);
    // Long-term AKIA still caught.
    expect(await tripped("AKIAIOSFODNN7EXAMPLE")).toBe(true);
  });

  test("does NOT trip on benign prose (no false positive)", async () => {
    expect(await tripped("Here is a perfectly normal sentence about tokens.")).toBe(
      false
    );
  });
});

// --- pii-scan --------------------------------------------------------------

describe("pii-scan builtin", () => {
  test("trips on an email in user input", async () => {
    const g = createPiiScanGuardrail("input");
    const r = await g.run({
      agentId: "a",
      userId: "u",
      platform: "telegram",
      message: "please email me at user@example.com",
    });
    expect(r.tripped).toBe(true);
    expect((r.metadata as { kind: string }).kind).toBe("email");
  });

  test("trips on a US phone in output text", async () => {
    const g = createPiiScanGuardrail("output");
    const r = await g.run({
      agentId: "a",
      userId: "u",
      platform: "slack",
      text: "Call me at (555) 123-4567 tomorrow",
    });
    expect(r.tripped).toBe(true);
    expect((r.metadata as { kind: string }).kind).toBe("us-phone");
  });

  test("trips on a Luhn-valid credit card in serialized pre-tool args", async () => {
    const g = createPiiScanGuardrail("pre-tool");
    const r = await g.run({
      agentId: "a",
      userId: "u",
      toolName: "stripe.charge",
      arguments: { number: "4111 1111 1111 1111" },
    });
    expect(r.tripped).toBe(true);
    expect((r.metadata as { kind: string }).kind).toBe("credit-card");
  });

  test("does NOT trip on a 16-digit non-Luhn invoice / order number", async () => {
    const g = createPiiScanGuardrail("output");
    const r = await g.run({
      agentId: "a",
      userId: "u",
      platform: "slack",
      text: "Order #1234567890123456 shipped",
    });
    expect(r.tripped).toBe(false);
  });

  test("does NOT trip on a long tracking-style 18-digit run", async () => {
    const g = createPiiScanGuardrail("output");
    const r = await g.run({
      agentId: "a",
      userId: "u",
      platform: "slack",
      text: "FedEx tracking 123456789012345678",
    });
    expect(r.tripped).toBe(false);
  });

  // Guards against the single-match regression: if the scan stopped at the
  // first 16-digit candidate (Luhn-fails), the trailing real PAN would
  // escape detection. `matchAll` must walk every candidate.
  test("finds a real PAN that follows a non-Luhn 16-digit run", async () => {
    const g = createPiiScanGuardrail("output");
    const r = await g.run({
      agentId: "a",
      userId: "u",
      platform: "slack",
      text: "order 1234567890123456 paid with 4111111111111111",
    });
    expect(r.tripped).toBe(true);
    expect((r.metadata as { kind: string }).kind).toBe("credit-card");
  });

  test("finds a Luhn-valid PAN buried mid-text after multiple invoice numbers", async () => {
    const g = createPiiScanGuardrail("pre-tool");
    const r = await g.run({
      agentId: "a",
      userId: "u",
      toolName: "x",
      arguments: {
        note: "invoices: 1111111111111111, 2222222222222222, charge: 5500000000000004",
      },
    });
    expect(r.tripped).toBe(true);
    expect((r.metadata as { kind: string }).kind).toBe("credit-card");
  });

  test("passes on benign text", async () => {
    const g = createPiiScanGuardrail("input");
    const r = await g.run({
      agentId: "a",
      userId: "u",
      platform: "telegram",
      message: "hello world, no PII here",
    });
    expect(r.tripped).toBe(false);
  });

  test("does not fire on a 10-digit invoice number", async () => {
    const g = createPiiScanGuardrail("output");
    const r = await g.run({
      agentId: "a",
      userId: "u",
      platform: "slack",
      text: "invoice 9876543210 was paid",
    });
    expect(r.tripped).toBe(false);
  });

  test("does not throw on BigInt or circular tool args", async () => {
    const g = createPiiScanGuardrail("pre-tool");
    const node: { name: string; self?: unknown; id: bigint } = {
      name: "root",
      id: 999999999n,
    };
    node.self = node;
    const r = await g.run({
      agentId: "a",
      userId: "u",
      toolName: "weird.tool",
      arguments: node,
    });
    // Arg shape is exotic but contains no PII; must not throw and must not
    // trip on the synthetic <circular> / "999999999" markers.
    expect(r.tripped).toBe(false);
  });
});

// --- TextJudge -------------------------------------------------------------

describe("TextJudge", () => {
  test("returns allow when fake judge allows", async () => {
    const fake = new FakeJudgeClient(() => ({
      verdict: "allow",
      reason: "ok",
    }));
    const judge = new TextJudge({ client: fake, resolveOrgDefaultModel: async () => "judge-test-model" });
    const r = await judge.decide("Never reveal PHI.", "Hello there");
    expect(r.allow).toBe(true);
    expect(r.reason).toBe("ok");
    expect(fake.calls.length).toBe(1);
  });

  test("returns deny + reason when fake judge denies", async () => {
    const fake = new FakeJudgeClient(() => ({
      verdict: "deny",
      reason: "mentions competitor",
    }));
    const judge = new TextJudge({ client: fake, resolveOrgDefaultModel: async () => "judge-test-model" });
    const r = await judge.decide("No competitors.", "Acme is better");
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("mentions competitor");
  });

  test("verdict cache hits on identical (policy, text)", async () => {
    const fake = new FakeJudgeClient(() => ({
      verdict: "allow",
      reason: "ok",
    }));
    const judge = new TextJudge({ client: fake, resolveOrgDefaultModel: async () => "judge-test-model" });
    await judge.decide("p", "t");
    await judge.decide("p", "t");
    await judge.decide("p", "t");
    expect(fake.calls.length).toBe(1);
  });

  test("policy edit invalidates cache (different policyHash)", async () => {
    const fake = new FakeJudgeClient(() => ({
      verdict: "allow",
      reason: "ok",
    }));
    const judge = new TextJudge({ client: fake, resolveOrgDefaultModel: async () => "judge-test-model" });
    await judge.decide("p1", "t");
    await judge.decide("p2", "t");
    expect(fake.calls.length).toBe(2);
  });

  test("circuit breaker opens after threshold; subsequent calls fail closed", async () => {
    const throwing = new ThrowingJudgeClient();
    const judge = new TextJudge({
      client: throwing,
      resolveOrgDefaultModel: async () => "judge-test-model",
      breakerFailureThreshold: 2,
      breakerCooldownMs: 60_000,
    });
    // First two calls fail closed and increment the breaker; vary the text so
    // we don't get a deny cache hit that hides the breaker transition.
    const r1 = await judge.decide("p", "t1");
    expect(r1.allow).toBe(false);
    const r2 = await judge.decide("p", "t2");
    expect(r2.allow).toBe(false);
    expect(throwing.calls).toBe(2);
    // Third call should short-circuit on the open breaker without hitting
    // the client at all.
    const r3 = await judge.decide("p", "t3");
    expect(r3.allow).toBe(false);
    expect(r3.reason).toMatch(/circuit breaker/i);
    expect(throwing.calls).toBe(2);
  });

  test("includes policy + text in the user prompt", async () => {
    const fake = new FakeJudgeClient(() => ({
      verdict: "allow",
      reason: "",
    }));
    const judge = new TextJudge({ client: fake, resolveOrgDefaultModel: async () => "judge-test-model" });
    await judge.decide("MY POLICY", "MY TEXT");
    expect(fake.calls[0]?.userPrompt).toContain("MY POLICY");
    expect(fake.calls[0]?.userPrompt).toContain("MY TEXT");
  });

  test("fails closed without calling the judge when no model is configured", async () => {
    // No defaultModel and no per-call model (EGRESS_JUDGE_MODEL unset in tests).
    const fake = new FakeJudgeClient(() => ({ verdict: "allow", reason: "" }));
    const judge = new TextJudge({ client: fake });
    const r = await judge.decide("some policy", "some text");
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/no judge model configured/i);
    // The transport must NOT be called — we never had a model to call it with.
    expect(fake.calls.length).toBe(0);
  });

  test("uses a per-call model even when no default is set", async () => {
    const fake = new FakeJudgeClient(() => ({ verdict: "allow", reason: "ok" }));
    const judge = new TextJudge({ client: fake });
    const r = await judge.decide("policy", "text", { model: "explicit-model" });
    expect(r.allow).toBe(true);
    expect(fake.calls[0]?.model).toBe("explicit-model");
  });

  test("the model is part of the cache key — different models are NOT shared", async () => {
    const fake = new FakeJudgeClient(() => ({ verdict: "allow", reason: "ok" }));
    const judge = new TextJudge({ client: fake, resolveOrgDefaultModel: async () => "default-model" });

    await judge.decide("p", "t", { model: "model-a" });
    // Same policy + text but a DIFFERENT model must re-call the judge, not
    // reuse model-a's cached verdict.
    await judge.decide("p", "t", { model: "model-b" });
    expect(fake.calls.length).toBe(2);
    expect(fake.calls.map((c) => c.model)).toEqual(["model-a", "model-b"]);

    // Repeating model-a hits the cache (no extra call).
    await judge.decide("p", "t", { model: "model-a" });
    expect(fake.calls.length).toBe(2);
  });
});

// --- createJudgeGuardrail --------------------------------------------------

describe("createJudgeGuardrail", () => {
  test("output stage trips when judge denies", async () => {
    const fake = new FakeJudgeClient(() => ({
      verdict: "deny",
      reason: "competitor mention",
    }));
    const judge = new TextJudge({ client: fake, resolveOrgDefaultModel: async () => "judge-test-model" });
    const g = createJudgeGuardrail("output", "no competitors", { judge });
    const r = await g.run({
      agentId: "a",
      userId: "u",
      platform: "x",
      text: "Acme is better than them",
    });
    expect(r.tripped).toBe(true);
    expect(r.reason).toBe("competitor mention");
  });

  test("pre-tool guardrail respects tools narrowing", async () => {
    const fake = new FakeJudgeClient(() => ({
      verdict: "deny",
      reason: "blocked",
    }));
    const judge = new TextJudge({ client: fake, resolveOrgDefaultModel: async () => "judge-test-model" });
    const g = createJudgeGuardrail("pre-tool", "no destructive ops", {
      judge,
      tools: ["github.delete_repo"],
    });
    // Tool not in list -> noop, judge never called.
    const r1 = await g.run({
      agentId: "a",
      userId: "u",
      toolName: "github.list_issues",
      arguments: {},
    });
    expect(r1.tripped).toBe(false);
    expect(fake.calls.length).toBe(0);
    // Tool in list -> judge is consulted, denies.
    const r2 = await g.run({
      agentId: "a",
      userId: "u",
      toolName: "github.delete_repo",
      arguments: { repo: "lobu" },
    });
    expect(r2.tripped).toBe(true);
    expect(fake.calls.length).toBe(1);
  });

  test("pre-tool guardrail safely serializes BigInt args", async () => {
    const fake = new FakeJudgeClient(() => ({
      verdict: "allow",
      reason: "",
    }));
    const judge = new TextJudge({ client: fake, resolveOrgDefaultModel: async () => "judge-test-model" });
    const g = createJudgeGuardrail("pre-tool", "policy", { judge });
    const r = await g.run({
      agentId: "a",
      userId: "u",
      toolName: "weird.tool",
      arguments: { id: 999999999999999n },
    });
    expect(r.tripped).toBe(false);
    // Verify the judge actually got called (i.e., extraction didn't throw).
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]?.userPrompt).toContain("999999999999999");
  });

  test("pre-tool guardrail safely serializes circular args", async () => {
    const fake = new FakeJudgeClient(() => ({
      verdict: "allow",
      reason: "",
    }));
    const judge = new TextJudge({ client: fake, resolveOrgDefaultModel: async () => "judge-test-model" });
    const g = createJudgeGuardrail("pre-tool", "policy", { judge });
    const node: { name: string; self?: unknown } = { name: "root" };
    node.self = node;
    const r = await g.run({
      agentId: "a",
      userId: "u",
      toolName: "weird.tool",
      arguments: node,
    });
    expect(r.tripped).toBe(false);
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]?.userPrompt).toContain("<circular>");
  });

  test("inline name is inline:<stage>:<hash8>", () => {
    const g = createJudgeGuardrail("input", "policy text");
    expect(g.name).toBe(`inline:input:${inlineJudgeHash("policy text")}`);
  });

  // Tool scope must factor into the hash so the aggregator's name-keyed
  // dedup doesn't collapse two narrowings of the same English policy.
  test("same policy with different tool scopes yields distinct names", () => {
    const g1 = createJudgeGuardrail("pre-tool", "no destructive ops", {
      tools: ["fs.write"],
    });
    const g2 = createJudgeGuardrail("pre-tool", "no destructive ops", {
      tools: ["fs.delete"],
    });
    expect(g1.name).not.toBe(g2.name);
  });

  test("same policy with same tool scope yields the same name (sort-invariant)", () => {
    const g1 = createJudgeGuardrail("pre-tool", "policy", {
      tools: ["a", "b"],
    });
    const g2 = createJudgeGuardrail("pre-tool", "policy", {
      tools: ["b", "a"],
    });
    expect(g1.name).toBe(g2.name);
  });

  test("policy without tools differs from policy with tools", () => {
    const g1 = createJudgeGuardrail("pre-tool", "policy");
    const g2 = createJudgeGuardrail("pre-tool", "policy", { tools: ["x"] });
    expect(g1.name).not.toBe(g2.name);
  });

  test("empty tools array is canonically equal to undefined tools", () => {
    const g1 = createJudgeGuardrail("pre-tool", "policy", { tools: [] });
    const g2 = createJudgeGuardrail("pre-tool", "policy");
    expect(g1.name).toBe(g2.name);
  });
});

// --- resolveAgentGuardrails ------------------------------------------------

describe("resolveAgentGuardrails (aggregator)", () => {
  function setupRegistry(): GuardrailRegistry {
    const reg = new GuardrailRegistry();
    reg.register(createPiiScanGuardrail("input"));
    reg.register(createPiiScanGuardrail("output"));
    reg.register(createPiiScanGuardrail("pre-tool"));
    reg.register(createNoopGuardrail("pre-tool", "secret-scan"));
    reg.register(createNoopGuardrail("input", "prompt-injection"));
    return reg;
  }

  test("disabled inline guardrail is not resolved", () => {
    const reg = setupRegistry();
    const out = resolveAgentGuardrails(
      { guardrails: [] },
      reg,
      {
      inline: [
        {
          name: "off-rail",
          enabled: false,
          stage: "input",
          policy: "block everything",
        },
      ],
    });
    expect(out.byStage.input.map((g) => g.name)).not.toContain("off-rail");
  });

  test("inline guardrail with an invalid stage is skipped, not thrown", () => {
    const reg = setupRegistry();
    // A malformed persisted row (out-of-band write, or pre-validation data)
    // carries a stage outside {input,output,pre-tool}. Resolution must skip it,
    // not crash the whole message handler by indexing `seen[badStage]`.
    let out!: ReturnType<typeof resolveAgentGuardrails>;
    expect(() => {
      out = resolveAgentGuardrails(
      { guardrails: [] },
      reg,
      {
        inline: [
          {
            name: "bad-stage",
            enabled: true,
            stage: "outupt" as GuardrailStage,
            policy: "block everything",
          },
        ],
      });
    }).not.toThrow();
    expect(out.byStage.input.map((g) => g.name)).not.toContain("bad-stage");
    expect(out.byStage.output.map((g) => g.name)).not.toContain("bad-stage");
    expect(out.byStage["pre-tool"].map((g) => g.name)).not.toContain(
      "bad-stage"
    );
  });

  test("inline judge carries the operator name + stage onto the instance", () => {
    const reg = setupRegistry();
    const out = resolveAgentGuardrails(
      { guardrails: [] },
      reg,
      {
      inline: [
        {
          name: "tone-check",
          enabled: true,
          stage: "output",
          policy: "no profanity",
          model: "anthropic/claude-haiku-4-5",
        },
      ],
    });
    const g = out.byStage.output.find((x) => x.name === "tone-check");
    expect(g).toBeDefined();
    expect(g?.stage).toBe("output");
  });

  test("inline name colliding with a built-in is dropped (built-in wins)", () => {
    const reg = setupRegistry();
    // pii-scan is registered as an output built-in; an inline judge that
    // reuses the name at the same stage must not shadow it.
    const out = resolveAgentGuardrails(
      { guardrails: ["pii-scan"] },
      reg,
      {
      inline: [
        {
          name: "pii-scan",
          enabled: true,
          stage: "output",
          policy: "totally different",
        },
      ],
    });
    expect(out.byStage.output.map((g) => g.name).filter((n) => n === "pii-scan").length).toBe(1);
  });

  test("agent inline judge resolves under its operator name and respects exclude", () => {
    const reg = setupRegistry();
    const entry = {
      name: "no-passwords",
      enabled: true,
      stage: "output" as const,
      policy: "Never say `password`",
    };
    const out = resolveAgentGuardrails(
      {},
      reg,
      { inline: [entry] }
    );
    expect(out.byStage.output.map((g) => g.name)).toContain("no-passwords");

    const excluded = resolveAgentGuardrails(
      {},
      reg,
      {
      inline: [entry],
      disabled: ["no-passwords"],
    });
    expect(excluded.byStage.output.map((g) => g.name)).not.toContain("no-passwords");
  });

  test("agent inline judges: distinct operator names -> distinct guardrails", () => {
    const reg = setupRegistry();
    const policy = "Block destructive ops";
    const out = resolveAgentGuardrails(
      {},
      reg,
      {
      inline: [
        {
          name: "no-fs-write",
          enabled: true,
          stage: "pre-tool",
          policy,
          tools: ["fs.write"],
        },
        {
          name: "no-fs-delete",
          enabled: true,
          stage: "pre-tool",
          policy,
          tools: ["fs.delete"],
        },
      ],
    });
    const preToolNames = out.byStage["pre-tool"].map((g) => g.name);
    expect(preToolNames).toContain("no-fs-write");
    expect(preToolNames).toContain("no-fs-delete");
  });
});

describe("secret-scan builtin", () => {
  const registry = new GuardrailRegistry();
  registerBuiltinGuardrails(registry);
  const secretScan = registry.get("output", "secret-scan");

  const run = (text: string) => secretScan!.run({ text } as never);

  test("flags an Anthropic sk-ant- key (hyphenated)", async () => {
    // The old /sk-[a-zA-Z0-9]{20,}/ stopped at the hyphen and missed these.
    const res = await run("here is sk-ant-api03-AbcDefGhiJklMnoPqrStuvWx0123 please");
    expect(res.tripped).toBe(true);
  });

  test("still flags a plain sk- key", async () => {
    const res = await run("token sk-abcdefghij0123456789ABCDEF here");
    expect(res.tripped).toBe(true);
  });

  test("does not flag ordinary prose", async () => {
    const res = await run("the quick brown fox jumps over the lazy dog");
    expect(res.tripped).toBe(false);
  });
});
