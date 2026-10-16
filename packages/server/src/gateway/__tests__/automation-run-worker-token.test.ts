import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { verifyWorkerToken } from "@lobu/core";
import { AUTOMATION_RUN_SOURCE } from "../automation-run-session.js";
import { buildAutomationRunWorkerAccess } from "../services/run-worker-access.js";

// Minting encrypts with ENCRYPTION_KEY. The gateway lane runs many files in one
// bun process and its peers set/restore the key per file, so this suite cannot
// inherit one — set our own, as `agent-session-create.test.ts` does.
const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
let savedKey: string | undefined;

beforeAll(() => {
  savedKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_KEY;
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = savedKey;
});

describe("Automation run WorkerToken parity", () => {
  test("packs the canonical Automation conversation and tenant claims", () => {
    const access = buildAutomationRunWorkerAccess({
      agentId: "developer",
      automationId: 120,
      runId: 456,
      organizationId: "org-team",
    });
    expect(access.conversationId).toBe("developer_automation_120_run_456");
    const claims = verifyWorkerToken(access.token);
    // `verifyWorkerToken` returns null for a token it cannot decrypt/verify;
    // assert it here so a broken mint fails as a claim mismatch, not a TypeError.
    expect(claims).not.toBeNull();
    if (!claims) throw new Error("worker token did not verify");
    expect(claims.agentId).toBe("developer");
    expect(claims.userId).toBe("developer");
    expect(claims.organizationId).toBe("org-team");
    expect(claims.conversationId).toBe(access.conversationId);
    expect(claims.runId).toBe(456);
    expect(claims.channelId).toBe("api_automation_120");
    expect(claims.platform).toBe("api");
    expect(claims.source).toBe(AUTOMATION_RUN_SOURCE);
  });

  test("rejects a non-canonical conversation id", () => {
    expect(() =>
      buildAutomationRunWorkerAccess({
        agentId: "developer",
        automationId: 120,
        runId: 456,
        organizationId: "org-team",
        conversationId: "developer_other",
      })
    ).toThrow(/Automation conversation mismatch/);
  });

});
