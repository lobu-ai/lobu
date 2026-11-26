/**
 * Regression: the output-guardrail scan must resolve the library scoped to the
 * caller's org. A shared agent id (e.g. "lobu-builder") exists in multiple orgs
 * and this runs on the worker path without ambient orgContext, so an unscoped
 * read could resolve another org's guardrails — enforcing (or skipping) the
 * wrong tenant's policy on a reply.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createTestLoopPolicy } from "../../../__tests__/setup/test-fixtures.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "../../__tests__/helpers/db-setup.js";
import { hasOutputGuardrails, runOutputGuardrailScan } from "../output-scan.js";

const SECRET_REPLY = "your key is sk-abcdefghij0123456789AB";

describe("output guardrail scan org scoping", () => {

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 60_000);

  beforeEach(async () => {
    await resetTestDatabase();
    await seedAgentRow("lobu-builder", { organizationId: "org-a" });
    await seedAgentRow("lobu-builder", { organizationId: "org-b" });
    await createTestLoopPolicy("org-a", 'reply_out', {
      principalKind: 'agent', principalId: "lobu-builder", note: 'secret-scan', condition: [{ scan: 'secrets', field: '/text' }],
    });
  });

  test("only the caller's org's library decides the scan", async () => {
    const scan = (organizationId: string) =>
      runOutputGuardrailScan(SECRET_REPLY, {
        agentId: "lobu-builder",
        organizationId,
        userId: "U1",
        platform: "slack",
      });

    expect(await scan("org-a")).toMatchObject({ reason: "secret-scan" });
    expect(await scan("org-b")).toBeNull();
  });

  test("hasOutputGuardrails reads the caller's org", async () => {

    expect(await hasOutputGuardrails({ agentId: "lobu-builder", organizationId: "org-a" })).toBe(true);
    expect(await hasOutputGuardrails({ agentId: "lobu-builder", organizationId: "org-b" })).toBe(false);
  });
});
