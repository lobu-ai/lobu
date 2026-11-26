/**
 * Tests for the guardrails extensions:
 *  - `pii-scan` regex built-in (input, output, pre-tool) + Luhn filter
 *  - `safeStringify` helper (BigInt, circular refs)
 *  - `buildGuardrailsByStage` over workspace guardrail library rows
 */

import { describe, expect, test } from "bun:test";
import { createNoopGuardrail, GuardrailRegistry } from "@lobu/core";
import type { ApplyingGuardrail } from "../../../guardrails/workspace-guardrails.js";
import {
  buildGuardrailsByStage,
  createPiiScanGuardrail,
  luhnValid,
  safeStringify,
} from "../index.js";
import { registerBuiltinGuardrails } from "../builtins.js";

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

// --- buildGuardrailsByStage ------------------------------------------------

describe("buildGuardrailsByStage (aggregator)", () => {
  function setupRegistry(): GuardrailRegistry {
    const reg = new GuardrailRegistry();
    reg.register(createPiiScanGuardrail("input"));
    reg.register(createPiiScanGuardrail("output"));
    reg.register(createPiiScanGuardrail("pre-tool"));
    reg.register(createNoopGuardrail("pre-tool", "secret-scan"));
    return reg;
  }
  let seq = 0;
  function row(
    name: string,
    config: ApplyingGuardrail["config"],
    enabled = true
  ): ApplyingGuardrail {
    seq += 1;
    return { id: `guardrail-${seq}`, name, config, enabled, revision: 1 };
  }
  const names = (list: { name: string }[]) => list.map((g) => g.name);

  test("a built-in row runs at every stage the built-in implements, under the row name", () => {
    const out = buildGuardrailsByStage(
      [row("pii", { builtin: "pii-scan" }), row("secrets", { builtin: "secret-scan" })],
      setupRegistry()
    );
    expect(names(out.input)).toEqual(["pii"]);
    expect(names(out.output)).toEqual(["pii"]);
    expect(names(out["pre-tool"])).toEqual(["pii", "secrets"]);
  });

  test("a row naming a built-in the registry lacks is skipped, not thrown", () => {
    let out!: ReturnType<typeof buildGuardrailsByStage>;
    expect(() => {
      out = buildGuardrailsByStage([row("unknown", { builtin: "forbidden-tools" })], setupRegistry());
    }).not.toThrow();
    expect(out.input).toEqual([]);
    expect(out.output).toEqual([]);
    expect(out["pre-tool"]).toEqual([]);
  });

  test("rows accumulate: the same built-in under two names both run", () => {
    const out = buildGuardrailsByStage(
      [row("pii-a", { builtin: "pii-scan" }), row("pii-b", { builtin: "pii-scan" })],
      setupRegistry()
    );
    expect(names(out["pre-tool"])).toEqual(["pii-a", "pii-b"]);
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
