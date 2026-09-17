/**
 * `lobu rollback` snapshot handling: the stored manifest is redacted and
 * byte-free, and sanitization converts every redaction sentinel into
 * "keep current" — a rollback restores intent and structurally cannot push a
 * secret (or the literal sentinel) anywhere.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { REDACTED_SENTINEL } from "@lobu/core";
import * as clientModule from "../client.js";
import { buildDeploymentManifest } from "../deployment.js";
import type { DesiredState } from "../desired-state.js";
import { rollbackCommand, sanitizeSnapshotState } from "../rollback-cmd.js";

afterEach(() => mock.restore());

function stateWithSecrets(): DesiredState {
  return {
    agents: [
      {
        metadata: { agentId: "a1", name: "A1" },
        settings: null,
        providerKeys: [{ providerId: "anthropic", value: "sk-ant-real" }],
      },
    ],
    prune: false,
    memorySchema: { entityTypes: [], relationshipTypes: [] },
    automations: [],
    connectors: {
      definitions: [
        {
          key: "zz.probe",
          sourceFile: "probe.connector.ts",
          sourceCode: "export default class Probe {}",
        },
      ],
      authProfiles: [
        {
          slug: "gh-main",
          connector: "github",
          credentials: { token: "ghp_real" },
        },
      ],
      connections: [
        {
          slug: "pg-main",
          connector: "postgres",
          config: { api_key: "conn-secret", database: "prod" },
        },
        {
          slug: "team-slack",
          connector: "slack",
          credentialMode: "byo",
          config: { botToken: "xoxb-real", mode: "socket" },
        },
        { slug: "hn-main", connector: "hackernews", config: { top: 10 } },
      ],
    },
    providers: [
      { slug: "z-ai", kind: "z-ai", apiKey: "sk-live-1", capabilities: {} },
    ],
    requiredSecrets: [],
  } as unknown as DesiredState;
}

describe("buildDeploymentManifest", () => {
  test("redacts secrets, drops connector source bytes, keeps version pins", () => {
    const manifest = buildDeploymentManifest(stateWithSecrets(), {
      "zz.probe": "1.2.0",
    });
    expect(manifest.version).toBe(1);
    expect(manifest.connector_versions).toEqual({ "zz.probe": "1.2.0" });

    const raw = JSON.stringify(manifest);
    // No secret VALUE and no source byte survives into the stored snapshot.
    expect(raw).not.toContain("sk-ant-real");
    expect(raw).not.toContain("ghp_real");
    expect(raw).not.toContain("sk-live-1");
    expect(raw).not.toContain("export default class Probe");
    // The declaration shape survives for labels.
    expect(raw).toContain("probe.connector.ts");
    // Non-secret connection config survives (rollback restores it).
    expect(raw).toContain("hackernews");
  });
});

describe("sanitizeSnapshotState", () => {
  function snapshotState() {
    return buildDeploymentManifest(stateWithSecrets(), {}).state;
  }

  test("converts sentinels to keep-current: credentials, provider keys, connector defs", () => {
    const { state } = sanitizeSnapshotState(snapshotState(), new Map());
    // Connector definitions ride the version pins, never the diff.
    expect(state.connectors.definitions).toEqual([]);
    // Credentials undeclared → the diff never re-pushes them.
    expect(
      (state.connectors.authProfiles[0] as { credentials?: unknown })
        .credentials
    ).toBeUndefined();
    // Provider keys: nothing to push.
    expect(state.agents[0]?.providerKeys).toEqual([]);
    // Org provider key empty → keyDeclared=false → no rotate.
    expect(state.providers?.[0]?.apiKey).toBe("");
  });

  test("pins a sentinel-bearing connection config to remote, drops it when none", () => {
    const remoteConnections = new Map([
      ["pg-main", { api_key: "***live", database: "prod" }],
      [
        "team-slack",
        {
          botToken: "secret://connections%2Fteam-slack%2FbotToken",
          mode: "socket",
        },
      ],
    ]);
    const pinned = sanitizeSnapshotState(snapshotState(), remoteConnections);
    const connections = pinned.state.connectors.connections as Array<{
      slug: string;
      config?: Record<string, unknown>;
    }>;
    // pg-main (denylisted api_key redacted in the snapshot) pinned to live…
    expect(connections.find((c) => c.slug === "pg-main")?.config).toEqual({
      api_key: "***live",
      database: "prod",
    });
    // …hn-main (no secrets) restored from the snapshot untouched.
    expect(connections.find((c) => c.slug === "hn-main")?.config).toEqual({
      top: 10,
    });
    // BYO chat config is one secret-aware unit: never submit its stored
    // secret:// ref as a fresh credential during rollback.
    expect(connections.find((c) => c.slug === "team-slack")).toBeUndefined();
    expect(pinned.notes).toContain(
      "connection team-slack: BYO chat config left at current values (rollback never rotates secrets)"
    );

    // No live connection to pin to → dropped with a note.
    const dropped = sanitizeSnapshotState(snapshotState(), new Map());
    const droppedSlugs = (
      dropped.state.connectors.connections as Array<{ slug: string }>
    ).map((c) => c.slug);
    expect(droppedSlugs).toEqual(["hn-main"]);
    expect(JSON.stringify(pinned.state)).not.toContain(REDACTED_SENTINEL);
    expect(JSON.stringify(dropped.state)).not.toContain(REDACTED_SENTINEL);
  });
});

describe("rollback pause ordering", () => {
  function emptyState(): DesiredState {
    return {
      agents: [],
      prune: false,
      memorySchema: { entityTypes: [], relationshipTypes: [] },
      automations: [],
      connectors: { definitions: [], authProfiles: [], connections: [] },
      providers: [],
      requiredSecrets: [],
    };
  }

  function rollbackClient(opts: { pauseFails?: boolean } = {}) {
    const calls: string[] = [];
    const record = (name: string) => calls.push(name);
    const client = {
      getDeployment: mock(async () => ({
        applyId: "apl_11111111-2222-3333-4444-555555555555",
        status: "succeeded",
        createdAt: null,
        gitSha: null,
        manifest: {
          version: 1,
          state: emptyState(),
          connector_versions: { "zz.probe": "1.0.0" },
        },
      })),
      listConnectors: mock(async () => [
        { key: "zz.probe", installed: true, version: "2.0.0" },
      ]),
      listAgents: mock(async () => []),
      listEntityTypes: mock(async () => []),
      listRelationshipTypes: mock(async () => []),
      listAutomations: mock(async () => []),
      listInferenceProviders: mock(async () => []),
      listViews: mock(async () => []),
      setDeploymentPause: mock(async () => {
        record("pause");
        if (opts.pauseFails) throw new Error("pause unavailable");
      }),
      rollbackConnectorVersion: mock(async () => record("mutation")),
      listOrgs: mock(async () => [{ id: "org_1", slug: "acme" }]),
      postDeploymentSummary: mock(async () => record("summary")),
    };
    spyOn(clientModule, "resolveApplyClient").mockResolvedValue({
      client: client as never,
      apiBaseUrl: "http://api.test",
      orgSlug: "acme",
    });
    return { calls, client };
  }

  test("sets the server pause before the first rollback mutation", async () => {
    const { calls } = rollbackClient();

    await rollbackCommand({
      applyId: "apl_11111111-2222-3333-4444-555555555555",
      cwd: "/",
      yes: true,
    });

    expect(calls).toEqual(["pause", "mutation", "summary"]);
  });

  test("fails closed without mutating when the pause cannot be set", async () => {
    const { calls, client } = rollbackClient({ pauseFails: true });

    await expect(
      rollbackCommand({
        applyId: "apl_11111111-2222-3333-4444-555555555555",
        cwd: "/",
        yes: true,
      })
    ).rejects.toThrow("pause unavailable");

    expect(calls).toEqual(["pause"]);
    expect(client.rollbackConnectorVersion).not.toHaveBeenCalled();
    expect(client.postDeploymentSummary).not.toHaveBeenCalled();
  });
});
