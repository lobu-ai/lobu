import { describe, expect, test } from "bun:test";
import { ApplyClient } from "../client.js";
import {
  buildDeploymentManifest,
  buildCountsByKind,
  collectGitInfo,
  computeManifestHash,
  loadBaselineFromManifest,
  mintApplyId,
  toBaseline,
} from "../deployment.js";
import type { DesiredState } from "../desired-state.js";
import type { DiffRow } from "../diff.js";

function baseState(overrides: Partial<DesiredState> = {}): DesiredState {
  return {
    agents: [],
    prune: false,
    memorySchema: { entityTypes: [], relationshipTypes: [] },
    automations: [],
    connectors: { definitions: [], authProfiles: [], connections: [] },
    providers: [],
    requiredSecrets: [],
    ...overrides,
  };
}

describe("mintApplyId", () => {
  test("matches the server-side x-lobu-apply-id validation pattern", () => {
    const id = mintApplyId();
    // Must stay in sync with APPLY_ID_RE in packages/server/src/utils/apply-context.ts.
    expect(id).toMatch(/^apl_[A-Za-z0-9-]{1,48}$/);
  });
});

describe("computeManifestHash", () => {
  test("is deterministic and prefixed", () => {
    const a = computeManifestHash(baseState());
    const b = computeManifestHash(baseState());
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("secret VALUES never affect the hash; structure does", () => {
    const withKey = (value: string, slug = "z-ai") =>
      baseState({
        providers: [{ slug, kind: "z-ai", apiKey: value, capabilities: {} }],
      });
    // Rotating a secret is not a config change.
    expect(computeManifestHash(withKey("sk-live-1"))).toBe(
      computeManifestHash(withKey("sk-live-2"))
    );
    // Renaming the provider is.
    expect(computeManifestHash(withKey("sk-live-1"))).not.toBe(
      computeManifestHash(withKey("sk-live-1", "other-provider"))
    );
  });

  test("agent providerKeys are redacted before hashing (rotation is not a change)", () => {
    const agent = {
      agentId: "a1",
      name: "A1",
      settings: { networkConfig: { allowedDomains: ["github.com"] } },
      providerKeys: [{ providerId: "anthropic", value: "sk-ant-real" }],
    } as unknown as DesiredState["agents"][number];

    const one = computeManifestHash(baseState({ agents: [agent] }));
    const two = computeManifestHash(
      baseState({
        agents: [
          {
            ...agent,
            providerKeys: [{ providerId: "anthropic", value: "sk-ant-OTHER" }],
          },
        ],
      })
    );
    expect(one).toBe(two);
  });

  test("a NON-secret agent settings change DOES change the hash", () => {
    const agentWith = (domain: string) =>
      ({
        agentId: "a1",
        name: "A1",
        settings: { networkConfig: { allowedDomains: [domain] } },
        providerKeys: [],
      }) as unknown as DesiredState["agents"][number];
    expect(
      computeManifestHash(baseState({ agents: [agentWith("github.com")] }))
    ).not.toBe(
      computeManifestHash(baseState({ agents: [agentWith("pypi.org")] }))
    );
  });
});

describe("deployment baseline encoding", () => {
  test("large compiled connectors are stored as version pins, without bundle bytes", () => {
    const definitions = ["fixture-one", "fixture-two"].map((key) => ({
      key,
      sourceFile: `${key}.connector.ts`,
      sourceCode: "export default class Fixture {}",
      sourceRoot: "/project",
      compiledArtifact: {
        compiledCode: "x".repeat(600_000),
        sourceFiles: {
          entrypoint: "source.ts",
          files: { "source.ts": "export default class Fixture {}" },
        },
        dependencies: {},
      },
    }));
    const pins = { "fixture-one": "1.0.0", "fixture-two": "2.0.0" };
    const manifest = buildDeploymentManifest(
      baseState({
        connectors: { definitions, authProfiles: [], connections: [] },
      }),
      pins
    );
    const encoded = JSON.stringify(manifest);
    // The server's deployment route rejects snapshots above 1 MB.
    expect(Buffer.byteLength(encoded)).toBeLessThan(1_000_000);
    expect(JSON.parse(encoded).state.connectors.definitions).toEqual(
      definitions.map(({ key, sourceFile }) => ({ key, sourceFile }))
    );
    expect(manifest.connector_versions).toEqual(pins);
    expect(definitions[0]?.compiledArtifact.compiledCode.length).toBe(600_000);
  });

  test("distinguishes absent attribution from a recorded empty baseline", () => {
    const absent = buildDeploymentManifest(baseState(), {});
    expect(toBaseline(loadBaselineFromManifest(absent)).recorded).toBe(false);

    const recorded = buildDeploymentManifest(
      baseState(),
      {},
      {
        attribution: {
          entityTypes: [],
          relationshipTypes: [],
          automations: [],
        },
        owned: [],
      }
    );
    expect(toBaseline(loadBaselineFromManifest(recorded)).recorded).toBe(true);
  });

  test("treats an incomplete attribution schema as an absent baseline", () => {
    const incomplete = {
      attribution: {
        entityTypes: [],
        relationshipTypes: [],
      },
      owned: ["automation:a1"],
    } as unknown as Parameters<typeof loadBaselineFromManifest>[0];

    expect(loadBaselineFromManifest(incomplete)).toBeNull();
    expect(toBaseline(loadBaselineFromManifest(incomplete)).recorded).toBe(
      false
    );
  });
});

describe("buildCountsByKind", () => {
  test("tallies create/update/delete per kind and ignores noop/drift", () => {
    const rows = [
      { kind: "agent", verb: "create" },
      { kind: "agent", verb: "noop" },
      { kind: "automation", verb: "update" },
      { kind: "automation", verb: "update" },
      { kind: "connection", verb: "drift" },
      { kind: "feed", verb: "delete" },
    ] as unknown as DiffRow[];
    expect(buildCountsByKind(rows)).toEqual({
      agent: { create: 1 },
      automation: { update: 2 },
      feed: { delete: 1 },
    });
  });
});

describe("collectGitInfo", () => {
  test("returns nulls outside a git work tree", () => {
    const info = collectGitInfo("/");
    expect(info.sha).toBeNull();
    expect(info.dirty).toBeNull();
  });
});

describe("ApplyClient x-lobu-apply-id threading", () => {
  test("every request carries the header when applyId is configured", async () => {
    const seen: Array<{ url: string; applyId: string | null }> = [];
    const fetchImpl = (async (input: any, init?: RequestInit) => {
      const headers = new Headers(init?.headers as HeadersInit);
      seen.push({
        url: String(input),
        applyId: headers.get("x-lobu-apply-id"),
      });
      return new Response(JSON.stringify({ agents: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const applyId = mintApplyId();
    const client = new ApplyClient(
      { apiBaseUrl: "http://api.test", orgSlug: "acme", token: "t", applyId },
      fetchImpl
    );
    await client.postDeploymentSummary({
      apply_id: applyId,
      status: "succeeded",
      counts: { create: 0, update: 0, noop: 0, drift: 0, delete: 0 },
      counts_by_kind: {},
      manifest_hash: "sha256:0",
      git_sha: null,
      git_dirty: null,
      cli_version: "0.0.0",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("http://api.test/api/acme/deployments");
    expect(seen[0].applyId).toBe(applyId);
  });

  test("no header leaks when applyId is not configured", async () => {
    let sawHeader: string | null = "sentinel";
    const fetchImpl = (async (_input: any, init?: RequestInit) => {
      sawHeader = new Headers(init?.headers as HeadersInit).get(
        "x-lobu-apply-id"
      );
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = new ApplyClient(
      { apiBaseUrl: "http://api.test", orgSlug: "acme", token: "t" },
      fetchImpl
    );
    await client.getAgentSettings("a1").catch(() => undefined);
    expect(sawHeader).toBeNull();
  });

  test("a rollback threads both workflow identifiers through every request", async () => {
    let seen: Headers | null = null;
    const fetchImpl = (async (_input: any, init?: RequestInit) => {
      seen = new Headers(init?.headers as HeadersInit);
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const applyId = mintApplyId();
    const rollbackOf = mintApplyId();
    const client = new ApplyClient(
      {
        apiBaseUrl: "http://api.test",
        orgSlug: "acme",
        token: "t",
        applyId,
        rollbackOf,
      },
      fetchImpl
    );
    await client.patchAgentSettings("a1", {});

    expect(seen?.get("x-lobu-apply-id")).toBe(applyId);
    expect(seen?.get("x-lobu-rollback-of")).toBe(rollbackOf);
  });
});
