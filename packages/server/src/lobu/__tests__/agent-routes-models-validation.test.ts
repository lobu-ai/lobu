/**
 * Unit coverage for the route's `models` error envelope
 * (`validateModelRefsAgainstOrg` → `modelValidationResponse`) and
 * `LEGACY_MODEL_FIELDS`.
 *
 * Dynamic-import agent-routes AFTER route-test mocks so a static top-level
 * import cannot bind the real `mcpAuth` (and its getWorkspaceProvider call)
 * before mocks are installed.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { validateModelRefsAgainstOrg } from "../model-config.js";
import { orgContext } from "../stores/org-context.js";
import { createInferenceProvider } from "../stores/provider-secrets.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "../../gateway/__tests__/helpers/db-setup.js";
import { installRouteTestMocks } from "./helpers/route-test-mocks";

installRouteTestMocks();
const { LEGACY_MODEL_FIELDS, modelValidationResponse } = await import(
  "../agent-routes.js"
);

const ORG = "test-org-models-validation";
const AGENT = "models-agent";

// A stub Hono context: modelValidationResponse only reads c.req.url +
// c.req.param to build the (informational) setup URLs in an error body.
const stubC = {
  req: {
    url: "https://gw.example.com/api/agents/models-agent/config",
    param: () => undefined,
  },
} as any;

async function validate(models: unknown) {
  return orgContext.run({ organizationId: ORG }, async () => {
    const error = await validateModelRefsAgainstOrg(models, ORG);
    return error
      ? modelValidationResponse(error, { c: stubC, agentId: AGENT })
      : null;
  });
}

describe("models error envelope (exact model refs)", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 60_000);

  beforeEach(async () => {
    await resetTestDatabase();
    await orgContext.run({ organizationId: ORG }, async () => {
      await seedAgentRow(AGENT, { organizationId: ORG });
      // An org provider slug the refs can resolve against.
      await createInferenceProvider({
        organizationId: ORG,
        slug: "myco",
        kind: "openai",
        apiKey: "sk-test",
        capabilities: { text: { model: "myco-large" } },
      });
    });
  });

  test("accepts explicit <slug>/<model> refs whose provider exists in the org", async () => {
    expect(await validate(["myco/myco-large"])).toBeNull();
  });

  test("accepts an empty list (allow-all policy)", async () => {
    expect(await validate([])).toBeNull();
  });

  test("rejects a bare model id (no provider prefix)", async () => {
    const err = await validate(["just-a-model"]);
    expect(err?.error).toBe("invalid_model_ref");
  });

  test("rejects an `auto` model suffix (auto is gone repo-wide)", async () => {
    const err = await validate(["myco/auto"]);
    expect(err?.error).toBe("invalid_model_ref");
    expect(String(err?.error_description)).toContain("auto");
  });

  test("rejects a ref whose provider does not exist in the org", async () => {
    const err = await validate(["ghost/some-model"]);
    expect(err?.error).toBe("model_provider_not_connected");
    expect(err?.provider).toBe("ghost");
  });

  test("rejects a non-array / non-string payload", async () => {
    expect((await validate("myco/myco-large"))?.error).toBe("invalid_models");
    expect((await validate([1, 2]))?.error).toBe("invalid_models");
  });

  test("LEGACY_MODEL_FIELDS names the removed fields the route guard rejects", () => {
    expect([...LEGACY_MODEL_FIELDS]).toEqual([
      "defaultModel",
      "installedProviders",
    ]);
  });
});
