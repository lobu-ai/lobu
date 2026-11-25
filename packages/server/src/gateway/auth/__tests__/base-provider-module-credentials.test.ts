import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { __resetEncryptionKeyCacheForTests, encrypt } from "@lobu/core";
import * as orgContext from "../../../lobu/stores/org-context.js";
import * as dbClient from "../../../db/client.js";

const TEST_ENCRYPTION_KEY = Buffer.from(
  "12345678901234567890123456789012"
).toString("base64");

// Controls what the mocked org context and db return per-test.
let mockOrgId: string | null = null;
// One rows array serves both inference_providers reads: the invariant's
// config read (block + ciphertext) and the org-key tier (ciphertext only) —
// post-cutover both resolve through the same row.
let inferenceProviderRows: Array<{
  block: { base_url?: string; model?: string } | null;
  ciphertext: string | null;
}> = [];

const resolveOrgIdSpy = spyOn(orgContext, "resolveOrgId").mockImplementation(
  (explicit?: string | null) => explicit ?? mockOrgId
);
// Both provider-key reads use the postgres tagged template
// (`sql\`SELECT ...\``), so returning the rows array satisfies either read.
const getDbSpy = spyOn(dbClient, "getDb").mockImplementation(
  (() =>
    (_strings: TemplateStringsArray) =>
      Promise.resolve(inferenceProviderRows)) as typeof dbClient.getDb
);

// Import after installing restorable spies so this file cannot replace a
// process-global module for co-running auth suites.
const { ApiKeyProviderModule } = await import("../api-key-provider-module.js");

function makeModule(hasProfile: boolean) {
  return new ApiKeyProviderModule({
    providerId: "z-ai",
    providerDisplayName: "z.ai",
    providerIconUrl: "https://example.com/z.png",
    envVarName: "Z_AI_API_KEY",
    apiKeyInstructions: "Get a key",
    apiKeyPlaceholder: "zai-...",
    sdkCompat: "openai",
    authProfilesManager: {
      hasProviderProfiles: async () => hasProfile,
      getBestProfile: async () => null,
    } as any,
  });
}

describe("BaseProviderModule.hasCredentials org-shared key fallback", () => {
  const previousEncryptionKey = process.env.ENCRYPTION_KEY;
  const previousZKey = process.env.Z_AI_API_KEY;

  afterAll(() => {
    resolveOrgIdSpy.mockRestore();
    getDbSpy.mockRestore();
  });

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    __resetEncryptionKeyCacheForTests();
    // Ensure no system key influences the result — we test the org-shared path.
    delete process.env.Z_AI_API_KEY;
    mockOrgId = null;
    inferenceProviderRows = [];
  });

  afterEach(() => {
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
    if (previousZKey === undefined) delete process.env.Z_AI_API_KEY;
    else process.env.Z_AI_API_KEY = previousZKey;
    __resetEncryptionKeyCacheForTests();
  });

  test("returns true when a per-user auth profile exists", async () => {
    const mod = makeModule(true);
    expect(await mod.hasCredentials("agent-1")).toBe(true);
  });

  test("returns true when only the org provider-row key exists (lobu apply path)", async () => {
    // No auth profile, and no per-modality block (a backfilled / plain row):
    // the invariant declines and the org-key tier reads the row's vault key.
    mockOrgId = "org-1";
    inferenceProviderRows = [{ block: null, ciphertext: encrypt("zai-secret-value") }];

    const mod = makeModule(false);
    // Pass org explicitly (as the worker turn path does) and
    // also via the ALS fallback — both must resolve the org-shared key.
    expect(
      await mod.hasCredentials("agent-1", { organizationId: "org-1" })
    ).toBe(true);
    expect(await mod.hasCredentials("agent-1")).toBe(true);
  });

  test("returns true when the org inference-provider row owns the custom upstream key", async () => {
    mockOrgId = "org-1";
    inferenceProviderRows = [
      {
        block: { base_url: "https://api.z.ai/api/paas/v4" },
        ciphertext: encrypt("zai-inference-provider-key"),
      },
    ];

    const mod = makeModule(false);
    expect(
      await mod.hasCredentials("agent-1", { organizationId: "org-1" })
    ).toBe(true);
  });

  test("uses the org inference-provider key with the catalog upstream", async () => {
    mockOrgId = "org-1";
    inferenceProviderRows = [
      {
        block: { model: "glm-5.2" },
        ciphertext: encrypt("zai-inference-provider-key"),
      },
    ];

    const mod = makeModule(false);
    const context = { organizationId: "org-1" };
    expect(await mod.hasCredentials("agent-1", context)).toBe(true);
    expect(await mod.buildEnvVars("agent-1", {}, context)).toEqual({
      Z_AI_API_KEY: "zai-inference-provider-key",
    });
  });

  test("returns false when a custom upstream has no usable org key, even with a profile", async () => {
    inferenceProviderRows = [
      {
        block: { base_url: "https://custom.example.com/v1" },
        ciphertext: null,
      },
    ];

    const mod = makeModule(true);
    expect(
      await mod.hasCredentials("agent-1", { organizationId: "org-1" })
    ).toBe(false);
  });

  test("credential placeholder uses signed worker token when available", async () => {
    const mod = makeModule(false);

    expect(
      await Promise.resolve(
        mod.buildCredentialPlaceholder("agent-1", { workerToken: "worker-jwt" })
      )
    ).toBe("worker-jwt");
    expect(await Promise.resolve(mod.buildCredentialPlaceholder("agent-1"))).toBe(
      "lobu-proxy"
    );
  });

  test("proxy base URL carries org scope when credential context has organizationId", () => {
    const mod = makeModule(false);

    const mappings = mod.getProxyBaseUrlMappings(
      "http://proxy.internal/api/proxy",
      "agent-1",
      { organizationId: "org-1", userId: "user-1" }
    );

    expect(mappings.Z_AI_API_BASE_URL).toBe(
      "http://proxy.internal/api/proxy/z-ai/a/agent-1/o/org-1/u/user-1"
    );
  });

  test("proxy base URL carries org scope without user segment when userId is absent", () => {
    const mod = makeModule(false);

    const mappings = mod.getProxyBaseUrlMappings(
      "http://proxy.internal/api/proxy",
      "agent-1",
      { organizationId: "org-1" }
    );

    expect(mappings.Z_AI_API_BASE_URL).toBe(
      "http://proxy.internal/api/proxy/z-ai/a/agent-1/o/org-1"
    );
  });

  test("returns false when neither profile nor org provider row exists", async () => {
    mockOrgId = "org-1";
    inferenceProviderRows = [];
    const mod = makeModule(false);
    expect(
      await mod.hasCredentials("agent-1", { organizationId: "org-1" })
    ).toBe(false);
  });

  test("returns false when there is no org context and no profile", async () => {
    // No org id anywhere → org-key lookup short-circuits, no db hit.
    mockOrgId = null;
    inferenceProviderRows = [
      { block: null, ciphertext: encrypt("should-not-be-read") },
    ];
    const mod = makeModule(false);
    expect(await mod.hasCredentials("agent-1")).toBe(false);
  });
});
