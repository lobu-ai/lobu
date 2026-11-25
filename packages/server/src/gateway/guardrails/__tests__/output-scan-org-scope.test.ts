/**
 * Regression: the output-guardrail scan must resolve the library scoped to the
 * caller's org. A shared agent id (e.g. "lobu-builder") exists in multiple orgs
 * and this runs on the worker path without ambient orgContext, so an unscoped
 * read could resolve another org's guardrails — enforcing (or skipping) the
 * wrong tenant's policy on a reply.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GuardrailRegistry } from "@lobu/core";
import { createTestWorkspaceGuardrail } from "../../../__tests__/setup/test-fixtures.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "../../__tests__/helpers/db-setup.js";
import { registerBuiltinGuardrails } from "../builtins.js";
import { OutputGuardrailScanner, runOutputGuardrailScan } from "../output-scan.js";

const SECRET_REPLY = "your key is sk-abcdefghij0123456789AB";

describe("output guardrail scan org scoping", () => {
  const registry = new GuardrailRegistry();
  registerBuiltinGuardrails(registry);

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 60_000);

  beforeEach(async () => {
    await resetTestDatabase();
    await seedAgentRow("lobu-builder", { organizationId: "org-a" });
    await seedAgentRow("lobu-builder", { organizationId: "org-b" });
    await createTestWorkspaceGuardrail({
      organizationId: "org-a",
      name: "secret-scan",
      config: { builtin: "secret-scan" },
      appliesTo: [{ kind: "agent", id: "lobu-builder" }],
    });
  });

  test("only the caller's org's library decides the scan", async () => {
    const scan = (organizationId: string) =>
      runOutputGuardrailScan(registry, SECRET_REPLY, {
        agentId: "lobu-builder",
        organizationId,
        userId: "U1",
        platform: "slack",
      });

    expect(await scan("org-a")).toMatchObject({ guardrail: "secret-scan" });
    expect(await scan("org-b")).toBeNull();
  });

  test("hasOutputGuardrails reads the caller's org", async () => {
    const scanner = new OutputGuardrailScanner();
    scanner.setGuardrails(registry);

    expect(await scanner.hasOutputGuardrails("lobu-builder", "org-a")).toBe(true);
    expect(await scanner.hasOutputGuardrails("lobu-builder", "org-b")).toBe(false);
  });
});
