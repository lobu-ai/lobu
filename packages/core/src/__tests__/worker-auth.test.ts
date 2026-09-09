import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetEncryptionKeyCacheForTests,
  encrypt,
} from "../utils/encryption";
import {
  generateWorkerToken,
  generateWorkerTokenPair,
  looksLikeWorkerToken,
  mintGatewayMcpToken,
  verifyEgressProxyToken,
  verifyGatewayMcpToken,
  verifyWorkerToken,
  type WorkerTokenData,
  type WorkerTokenOptions,
} from "../worker/auth";

// 32-byte key, hex encoded — matches existing encryption.test.ts pattern.
const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const ENV_KEYS = ["ENCRYPTION_KEY", "WORKER_TOKEN_TTL_MS"] as const;

/**
 * Every claim the token can carry, each with a distinct value.
 *
 * The previous round-trip test listed eight claims by hand under the name
 * "all optional fields" and stayed at those eight as the interface grew to 21,
 * so `executionMode`, `automationRunId`, `organizationId`, `runId`, `messageId`,
 * `source`, `allowedDomains` and `deniedDomains` all shipped with no proof they
 * survived the token. Deleting `executionMode` from the generated payload left
 * all 33 tests in this file green, and that claim is what both capture lanes
 * read — the internal-route guard (`gateway/routes/internal/capture-mode.ts`)
 * and the SDK lane via `mcpAuthInfo` — so an eval replay would have performed
 * real side effects against the org it was scoring.
 *
 * Kept as one fixture so the round-trip test and the coverage guard below
 * cannot disagree about what "every claim" means.
 */
const ALL_CLAIMS: Required<WorkerTokenOptions> = {
  channelId: "C-all",
  teamId: "T-all",
  agentId: "agent-all",
  organizationId: "org-all",
  connectionId: "conn-all",
  responseThreadId: "slack:C-all:thread-1",
  platform: "slack",
  source: "automation-run",
  executionMode: "capture",
  automationRunId: 874626,
  sessionKey: "sess-all",
  traceId: "trace-all",
  runId: 4321,
  messageId: "msg-all",
  adminTools: ["manage_automations"],
  adminActorUserId: "user-admin",
  runtimeProviderId: "provider-all",
  sandboxId: "sandbox-all",
  allowedDomains: ["allowed.example"],
  deniedDomains: ["blocked.example"],
  nixPackages: ["ripgrep"],
};

describe("worker auth token", () => {
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
    }
    process.env.ENCRYPTION_KEY = TEST_KEY;
    delete process.env.WORKER_TOKEN_TTL_MS;
    __resetEncryptionKeyCacheForTests();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    __resetEncryptionKeyCacheForTests();
  });

  test("generateWorkerToken returns a non-empty string", () => {
    const token = generateWorkerToken("user-1", "conv-1", "deploy-A", {
      channelId: "C1",
    });
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  test("generated tokens have iv:tag:cipher format", () => {
    const token = generateWorkerToken("user-1", "conv-1", "deploy-A", {
      channelId: "C1",
    });
    const parts = token.split(":");
    expect(parts.length).toBe(3);
    // hex chars only
    for (const p of parts) {
      expect(p).toMatch(/^[0-9a-f]+$/);
    }
  });

  test("recognizes only worker-token ciphertext envelopes", () => {
    const token = generateWorkerToken("user-1", "conv-1", "deploy-A", {
      channelId: "C1",
    });
    expect(looksLikeWorkerToken(token)).toBe(true);
    expect(looksLikeWorkerToken("0a:0B:ff")).toBe(true);

    for (const value of [
      "",
      "aa:bb",
      "aa:bb:cc:dd",
      "aa::cc",
      "aa:gg:cc",
      "owl_pat_not-a-worker-token",
    ]) {
      expect(looksLikeWorkerToken(value)).toBe(false);
    }
  });

  test("verifyWorkerToken round-trips the basic required fields", () => {
    const token = generateWorkerToken("user-1", "conv-1", "deploy-A", {
      channelId: "C1",
    });
    const data = verifyWorkerToken(token);
    expect(data).not.toBeNull();
    const d = data as WorkerTokenData;
    expect(d.userId).toBe("user-1");
    expect(d.conversationId).toBe("conv-1");
    expect(d.deploymentName).toBe("deploy-A");
    expect(d.channelId).toBe("C1");
    expect(typeof d.timestamp).toBe("number");
    expect(d.timestamp).toBeGreaterThan(0);
  });

  test("verifyWorkerToken round-trips EVERY claim", () => {
    const d = verifyWorkerToken(
      generateWorkerToken("user-2", "conv-2", "deploy-B", ALL_CLAIMS)
    ) as WorkerTokenData;
    expect(d).not.toBeNull();
    // Projected off the fixture's own keys rather than a written-out list, so
    // a claim cannot be added to the fixture and then left unasserted. Compared
    // in one shot so a failure names every dropped claim, not just the first.
    const roundTripped = Object.fromEntries(
      Object.keys(ALL_CLAIMS).map((key) => [
        key,
        d[key as keyof typeof ALL_CLAIMS],
      ])
    );
    expect(roundTripped).toEqual(ALL_CLAIMS);
  });

  test("the fixture covers every declared claim", () => {
    // ALL_CLAIMS is hand-written, and hand-written lists drift — that is
    // precisely how the eight claims above reached prod uncovered. The
    // `Required<WorkerTokenOptions>` annotation looks like it prevents that,
    // but it does NOT: both packages/core/tsconfig.json and the root
    // tsconfig.json exclude `__tests__`, so this file is never typechecked and
    // the annotation is documentation. Enforce it at runtime instead.
    //
    // Parsed from source, which fails CLOSED: a reformat the pattern can't read
    // yields no names and fails the comparison below rather than passing empty.
    const src = readFileSync(
      fileURLToPath(new URL("../worker/auth.ts", import.meta.url)),
      "utf8"
    );
    const start = src.indexOf("export interface WorkerTokenOptions {");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}", start));
    const declared = [...body.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)]
      .map((m) => m[1])
      .sort();
    expect(declared).toEqual(Object.keys(ALL_CLAIMS).sort());
  });

  test("a minimal token carries no claim it was not given", () => {
    // The eval claims must be ABSENT on an ordinary token, not merely falsy:
    // `capture-mode.ts` treats absent `executionMode` as live, and the snapshot
    // route compares a present `runId` for equality. An option the caller never
    // passed must not arrive as a defaulted value.
    const d = verifyWorkerToken(
      generateWorkerToken("user-1", "conv-1", "deploy-A", { channelId: "C1" })
    ) as WorkerTokenData;
    expect(d.executionMode).toBeUndefined();
    expect(d.automationRunId).toBeUndefined();
    expect(d.runId).toBeUndefined();
  });

  test.each([
    0, -1, 1.5,
  ])("a token claiming automationRunId=%p is rejected outright", (bad) => {
    // The claim addresses the row an eval writes its capture record onto, so
    // a malformed one must kill the whole token rather than quietly arrive
    // as undefined and route the record nowhere.
    expect(
      verifyWorkerToken(
        generateWorkerToken("user-1", "conv-1", "deploy-A", {
          channelId: "C1",
          executionMode: "capture",
          automationRunId: bad,
        })
      )
    ).toBe(null);
  });

  test.each([
    "banana",
    "",
    "CAPTURE",
    "dry_run",
  ])("a token claiming executionMode=%p is rejected, not read as live", (bad) => {
    // Every consumer tests this claim for equality with "capture", so an
    // unrecognised value reads as LIVE and lets an eval replay perform real
    // side effects. Fail the token instead of defaulting it.
    //
    // Nothing else can reject these: the capture check fires only on
    // `executionMode === "capture"`, so an unrecognised mode never reaches it
    // and this enum check is the only thing between a garbage mode and a token
    // that reads as live. Mutation-verified — dropping the enum check turns
    // these red.
    expect(
      verifyWorkerToken(
        generateWorkerToken("user-1", "conv-1", "deploy-A", {
          channelId: "C1",
          executionMode: bad as unknown as "live" | "capture",
        })
      )
    ).toBe(null);
  });

  test("capture without either run identity is rejected", () => {
    // A capture run that cannot record is the one state evals must never
    // reach: side effects are suppressed but nothing says what was suppressed,
    // so the replay scores as clean while its intent is lost.
    expect(
      verifyWorkerToken(
        generateWorkerToken("user-1", "conv-1", "deploy-A", {
          channelId: "C1",
          executionMode: "capture",
        })
      )
    ).toBe(null);
  });

  test("native capture retains its own run identity through the embedded MCP hop", () => {
    const token = generateWorkerToken("user-1", "conv-1", "native-turn", {
      channelId: "C1",
      organizationId: "capture-org",
      agentId: "capture-agent",
      executionMode: "capture",
      runId: 1234,
    });
    const worker = verifyWorkerToken(token);
    expect(worker).toMatchObject({ executionMode: "capture", runId: 1234 });
    expect(worker?.automationRunId).toBeUndefined();
    const derived = mintGatewayMcpToken(token)!;
    expect(verifyGatewayMcpToken(derived)).toMatchObject({
      executionMode: "capture",
      runId: 1234,
      organizationId: "capture-org",
    });
    expect(verifyWorkerToken(derived)).toBeNull();
  });

  test("live Automation provenance round-trips without capture", () => {
    const verified = verifyWorkerToken(
      generateWorkerToken("user-1", "conv-1", "deploy-A", {
        channelId: "C1",
        executionMode: "live",
        automationRunId: 874626,
      })
    );
    expect(verified?.executionMode).toBe("live");
    expect(verified?.automationRunId).toBe(874626);
  });

  test("round-trips an admin-tools allowlist with its distinct auth actor", () => {
    const token = generateWorkerToken("U_SLACK", "conv", "deploy", {
      channelId: "C1",
      platform: "slack",
      adminTools: ["manage_agents"],
      adminActorUserId: "auth-user-1",
    });
    const d = verifyWorkerToken(token) as WorkerTokenData;
    expect(d.userId).toBe("U_SLACK");
    expect(d.adminTools).toEqual(["manage_agents"]);
    expect(d.adminActorUserId).toBe("auth-user-1");
  });

  test("rejects a partial admin-tools allowlist", () => {
    for (const partial of [
      { adminTools: ["manage_agents"] },
      { adminActorUserId: "auth-user-1" },
      { adminTools: [], adminActorUserId: "auth-user-1" },
    ]) {
      const token = encrypt(
        JSON.stringify({
          userId: "U_SLACK",
          conversationId: "conv",
          channelId: "C1",
          deploymentName: "deploy",
          timestamp: Date.now(),
          ...partial,
        })
      );
      expect(verifyWorkerToken(token)).toBeNull();
    }
  });

  test("two tokens generated for the same input differ (random IV)", () => {
    const t1 = generateWorkerToken("u", "c", "d", { channelId: "ch" });
    const t2 = generateWorkerToken("u", "c", "d", { channelId: "ch" });
    expect(t1).not.toBe(t2);
    // both must still verify
    expect(verifyWorkerToken(t1)).not.toBeNull();
    expect(verifyWorkerToken(t2)).not.toBeNull();
  });

  test("worker, egress-proxy, and gateway-MCP credentials are accepted only on their own surfaces", () => {
    const pair = generateWorkerTokenPair("u", "c", "d", {
      channelId: "ch",
    });
    const gatewayMcpToken = mintGatewayMcpToken(pair.workerToken);

    expect(verifyWorkerToken(pair.workerToken)).not.toBeNull();
    expect(verifyEgressProxyToken(pair.egressProxyToken)).not.toBeNull();
    expect(verifyGatewayMcpToken(gatewayMcpToken ?? "")).not.toBeNull();
    expect(verifyWorkerToken(pair.egressProxyToken)).toBeNull();
    expect(verifyEgressProxyToken(pair.workerToken)).toBeNull();
    expect(verifyWorkerToken(gatewayMcpToken ?? "")).toBeNull();
    expect(verifyEgressProxyToken(gatewayMcpToken ?? "")).toBeNull();
    expect(verifyGatewayMcpToken(pair.workerToken)).toBeNull();
  });

  test("gateway-MCP narrowing preserves every signed claim and its lifetime", () => {
    const workerToken = generateWorkerToken(
      "user-2",
      "conv-2",
      "deploy-B",
      ALL_CLAIMS
    );
    const worker = verifyWorkerToken(workerToken) as WorkerTokenData;
    const gatewayMcpToken = mintGatewayMcpToken(workerToken);
    const narrowed = verifyGatewayMcpToken(gatewayMcpToken ?? "");

    expect(narrowed).toEqual({ ...worker, tokenKind: "gateway-mcp" });
    expect(narrowed?.timestamp).toBe(worker.timestamp);
    expect(narrowed?.jti).toBe(worker.jti);
  });

  test("gateway-MCP narrowing refuses a non-worker credential", () => {
    const pair = generateWorkerTokenPair("u", "c", "d", { channelId: "ch" });
    expect(mintGatewayMcpToken(pair.egressProxyToken)).toBeNull();
  });

  test("a deployment token pair shares one revocation id", () => {
    const pair = generateWorkerTokenPair("u", "c", "d", { channelId: "ch" });
    const worker = verifyWorkerToken(pair.workerToken);
    const egress = verifyEgressProxyToken(pair.egressProxyToken);

    expect(worker?.jti).toBeTruthy();
    expect(egress?.jti).toBe(worker?.jti);
  });

  test("missing channelId throws", () => {
    expect(() => generateWorkerToken("u", "c", "d", { channelId: "" })).toThrow(
      /channelId is required/
    );
  });

  test("verifyWorkerToken returns null for completely invalid token", () => {
    expect(verifyWorkerToken("not-a-valid-token")).toBeNull();
  });

  test("verifyWorkerToken returns null for malformed iv:tag:cipher", () => {
    expect(verifyWorkerToken("aa:bb:cc")).toBeNull();
  });

  test("verifyWorkerToken returns null for empty string", () => {
    expect(verifyWorkerToken("")).toBeNull();
  });

  test("verifyWorkerToken rejects non-object payloads encrypted under the key", () => {
    // An attacker (or a buggy older gateway) that managed to encrypt a
    // non-object payload would otherwise reach the field-presence checks
    // with `parsed` being `null` / a number / an array. The `as` cast would
    // happily hand a primitive to downstream consumers. Verify all of these
    // are rejected before the field checks.
    for (const payload of ["null", "42", '"a string"', "[1,2,3]"]) {
      const token = encrypt(payload);
      expect(verifyWorkerToken(token)).toBeNull();
    }
  });

  test("verifyWorkerToken rejects payload with wrongly-typed required fields", () => {
    // Payload is a valid object but conversationId is a number instead of
    // a string. Without the typeof check, the truthy `data.conversationId`
    // would pass and a downstream consumer would .substring() / .split() on
    // a number and crash.
    const token = encrypt(
      JSON.stringify({
        userId: "u",
        conversationId: 12345,
        deploymentName: "d",
        timestamp: Date.now(),
      })
    );
    expect(verifyWorkerToken(token)).toBeNull();
  });

  test("verifyWorkerToken returns null for tampered ciphertext", () => {
    const token = generateWorkerToken("u", "c", "d", { channelId: "ch" });
    const parts = token.split(":");
    // flip one hex char in the cipher segment
    const cipher = parts[2]!;
    const flipped =
      cipher.slice(0, -1) + (cipher.slice(-1) === "a" ? "b" : "a");
    const tampered = `${parts[0]}:${parts[1]}:${flipped}`;
    expect(verifyWorkerToken(tampered)).toBeNull();
  });

  test("fresh token verifies even with TTL=1ms because of 30s skew window", () => {
    const token = generateWorkerToken("u", "c", "d", { channelId: "ch" });
    process.env.WORKER_TOKEN_TTL_MS = "1";
    // Skew is 30s, so a brand-new token still passes; confirms skew handling.
    expect(verifyWorkerToken(token)).not.toBeNull();
  });

  test("WORKER_TOKEN_TTL_MS=0 falls back to default 2h TTL (token still valid)", () => {
    process.env.WORKER_TOKEN_TTL_MS = "0";
    const token = generateWorkerToken("u", "c", "d", { channelId: "ch" });
    expect(verifyWorkerToken(token)).not.toBeNull();
  });

  test("WORKER_TOKEN_TTL_MS=garbage falls back to default 2h TTL (token still valid)", () => {
    process.env.WORKER_TOKEN_TTL_MS = "not-a-number";
    const token = generateWorkerToken("u", "c", "d", { channelId: "ch" });
    expect(verifyWorkerToken(token)).not.toBeNull();
  });

  test("verifyWorkerToken returns null without ENCRYPTION_KEY", () => {
    const token = generateWorkerToken("u", "c", "d", { channelId: "ch" });
    delete process.env.ENCRYPTION_KEY;
    __resetEncryptionKeyCacheForTests();
    expect(verifyWorkerToken(token)).toBeNull();
  });

  test("generateWorkerToken throws without ENCRYPTION_KEY", () => {
    delete process.env.ENCRYPTION_KEY;
    __resetEncryptionKeyCacheForTests();
    expect(() =>
      generateWorkerToken("u", "c", "d", { channelId: "ch" })
    ).toThrow();
  });

  test("token generated with one key cannot be verified with another", () => {
    const token = generateWorkerToken("u", "c", "d", { channelId: "ch" });
    process.env.ENCRYPTION_KEY =
      "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    __resetEncryptionKeyCacheForTests();
    expect(verifyWorkerToken(token)).toBeNull();
  });
});

describe("worker auth token: explicit expiry", () => {
  // Test the expired-token path by directly encrypting a stale payload.
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
    }
    process.env.ENCRYPTION_KEY = TEST_KEY;
    delete process.env.WORKER_TOKEN_TTL_MS;
    __resetEncryptionKeyCacheForTests();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    __resetEncryptionKeyCacheForTests();
  });

  test("token with ancient timestamp is rejected as expired", async () => {
    const { encrypt } = await import("../utils/encryption");
    const stale: WorkerTokenData = {
      userId: "u",
      conversationId: "c",
      channelId: "ch",
      deploymentName: "d",
      timestamp: 1, // 1970 — well past any reasonable TTL+skew
    };
    const token = encrypt(JSON.stringify(stale));
    expect(verifyWorkerToken(token)).toBeNull();
  });

  test("token missing required field (userId) is rejected", async () => {
    const { encrypt } = await import("../utils/encryption");
    const bad = {
      // userId missing
      conversationId: "c",
      channelId: "ch",
      deploymentName: "d",
      timestamp: Date.now(),
    };
    const token = encrypt(JSON.stringify(bad));
    expect(verifyWorkerToken(token)).toBeNull();
  });

  test("token missing required field (conversationId) is rejected", async () => {
    const { encrypt } = await import("../utils/encryption");
    const bad = {
      userId: "u",
      channelId: "ch",
      deploymentName: "d",
      timestamp: Date.now(),
    };
    const token = encrypt(JSON.stringify(bad));
    expect(verifyWorkerToken(token)).toBeNull();
  });

  test("token missing required field (deploymentName) is rejected", async () => {
    const { encrypt } = await import("../utils/encryption");
    const bad = {
      userId: "u",
      conversationId: "c",
      channelId: "ch",
      timestamp: Date.now(),
    };
    const token = encrypt(JSON.stringify(bad));
    expect(verifyWorkerToken(token)).toBeNull();
  });

  test("token missing required field (timestamp) is rejected", async () => {
    const { encrypt } = await import("../utils/encryption");
    const bad = {
      userId: "u",
      conversationId: "c",
      channelId: "ch",
      deploymentName: "d",
    };
    const token = encrypt(JSON.stringify(bad));
    expect(verifyWorkerToken(token)).toBeNull();
  });

  test("token with non-JSON plaintext is rejected", async () => {
    const { encrypt } = await import("../utils/encryption");
    const token = encrypt("this is not json");
    expect(verifyWorkerToken(token)).toBeNull();
  });

  test("WORKER_TOKEN_TTL_MS custom value is honored", async () => {
    const { encrypt } = await import("../utils/encryption");
    // Set a 1-hour TTL.
    process.env.WORKER_TOKEN_TTL_MS = String(60 * 60 * 1000);
    // Token from 2 hours ago — should be expired even with skew.
    const stale: WorkerTokenData = {
      userId: "u",
      conversationId: "c",
      channelId: "ch",
      deploymentName: "d",
      timestamp: Date.now() - 2 * 60 * 60 * 1000,
    };
    const expiredToken = encrypt(JSON.stringify(stale));
    expect(verifyWorkerToken(expiredToken)).toBeNull();

    // Fresh token under the same custom TTL should still verify.
    const fresh = generateWorkerToken("u", "c", "d", { channelId: "ch" });
    expect(verifyWorkerToken(fresh)).not.toBeNull();
  });

  test("verifyWorkerToken round-trips a sandboxId claim", () => {
    const token = generateWorkerToken("u", "c", "d", {
      channelId: "ch",
      runtimeProviderId: "vercel",
      sandboxId: "env-abc",
    });
    const d = verifyWorkerToken(token) as WorkerTokenData;
    expect(d).not.toBeNull();
    expect(d.runtimeProviderId).toBe("vercel");
    expect(d.sandboxId).toBe("env-abc");
  });

  test("verifyWorkerToken round-trips a nixPackages claim", () => {
    const token = generateWorkerToken("u", "c", "d", {
      channelId: "ch",
      runtimeProviderId: "vercel",
      nixPackages: ["gh", "ripgrep"],
    });
    const d = verifyWorkerToken(token) as WorkerTokenData;
    expect(d).not.toBeNull();
    expect(d.nixPackages).toEqual(["gh", "ripgrep"]);
  });

  test("verifyWorkerToken rejects a nixPackages claim that is not a string[]", () => {
    // Each entry reaches a package-install command line in the remote runtime.
    // The provider validates each NAME, but a non-array (or a nested object)
    // would defeat that per-element check entirely, so reject rather than coerce.
    for (const nixPackages of [
      "gh",
      { 0: "gh" },
      ["gh", 42],
      ["gh", { toString: () => "evil" }],
    ]) {
      const token = encrypt(
        JSON.stringify({
          userId: "u",
          conversationId: "c",
          channelId: "ch",
          deploymentName: "d",
          timestamp: Date.now(),
          nixPackages,
        })
      );
      expect(verifyWorkerToken(token)).toBeNull();
    }
  });

  test("verifyWorkerToken rejects a legacy `environmentId` claim (superseded by sandboxId)", () => {
    // A token minted just before the environments→sandboxes rename carries
    // `environmentId` instead of `sandboxId`. It must FAIL CLOSED (→ queue
    // retry re-resolves the pin fresh) rather than verify with no sandbox
    // binding — otherwise a provider-pinned turn would silently run in the
    // host realm under system-env / OIDC creds.
    const legacy = {
      userId: "u",
      conversationId: "c",
      channelId: "ch",
      deploymentName: "d",
      timestamp: Date.now(),
      runtimeProviderId: "vercel",
      environmentId: "env-abc",
    };
    const token = encrypt(JSON.stringify(legacy));
    expect(verifyWorkerToken(token)).toBeNull();
  });
});
