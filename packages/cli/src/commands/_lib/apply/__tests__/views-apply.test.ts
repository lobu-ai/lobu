/**
 * Views through load → diff → client.
 *
 * Loader: bundles the module at load (key, metadata, server-semantics hash
 * from the shared function), duplicates and bad paths fail loud. Diff:
 * create/update/noop keyed on the content hash, remote-only drift vs
 * prune-delete. Client: set/list/remove hit `manage_views` with the apply
 * shape.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contentHash } from "@lobu/core/contracts/tools/view-content-hash";
import { buildDeploymentManifest, computeManifestHash } from "../deployment.js";
import { computeDiff, type RemoteSnapshot } from "../diff.js";
import {
  type DesiredState,
  type DesiredView,
  loadDesiredStateFromConfig,
} from "../desired-state.js";
import { ApplyClient } from "../client.js";

const tempDirs: string[] = [];

afterEach(() => {
  mock.restore();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function mkProject(files: Record<string, string>): string {
  // Loader tests bundle real modules (the `@lobu/views` import must
  // resolve), so fixtures live next to this test, not in tmp. Removed in
  // afterEach.
  const dir = mkdtempSync(join(import.meta.dir, "views-apply-fixture-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

const VIEW_SOURCE = `import { defineView, mountView } from "@lobu/views";
export const view = defineView({
  key: "pipeline",
  attach: [{ type: "deal" }],
  params: { by: { type: "string", default: "owner" } },
  actions: { markWon: { emits: "deal.won" } },
});
export default function Pipeline() { return null; }
mountView(view, Pipeline);
`;

function configWithViews(...viewPaths: string[]): string {
  const list = viewPaths
    .map((p) => `viewFromFile(${JSON.stringify(p)})`)
    .join(", ");
  return `import { defineAgent, defineConfig, viewFromFile } from "@lobu/cli/config";
export default defineConfig({
  agents: [defineAgent({ id: "triage", name: "Triage" })],
  views: [${list}],
});
`;
}

function desiredView(key: string, hash: string): DesiredView {
  return {
    key,
    sourceCode: `// ${key}`,
    contentHash: hash,
    sourceFile: `views/${key}.tsx`,
    compiledCode: `// bundle ${key}`,
    attach: [],
    params: {},
    actions: {},
  };
}

function emptyRemote(): RemoteSnapshot {
  return {
    agents: [],
    agentSettings: new Map(),
    entityTypes: [],
    relationshipTypes: [],
    automations: [],
    connectorDefinitions: [],
    authProfiles: [],
    connections: [],
    feedsByConnectionId: new Map(),
    inferenceProviders: [],
    views: [],
  };
}

describe("view desired state", () => {
  test("bundles at load: key, metadata and server-semantics hash", async () => {
    const dir = mkProject({
      "lobu.config.ts": configWithViews("./views/deal/pipeline.tsx"),
      "views/deal/pipeline.tsx": VIEW_SOURCE,
      "agents/triage/SOUL.md": "triage",
    });
    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    expect(state.views).toHaveLength(1);
    const view = state.views[0];
    expect(view?.key).toBe("pipeline");
    expect(view?.sourceFile).toBe("views/deal/pipeline.tsx");
    expect(view?.attach).toEqual([{ type: "deal" }]);
    expect(view?.compiledCode.length).toBeGreaterThan(10_000);
    // The diff key is what the server will compute: same function, same
    // inputs (name defaults to key, description to empty).
    expect(view?.contentHash).toBe(
      contentHash(view?.sourceCode ?? "", {
        name: "pipeline",
        description: "",
        attach: [{ type: "deal" }],
        params: { by: { type: "string", default: "owner" } },
        actions: { markWon: { emits: "deal.won" } },
        compiledCode: view?.compiledCode,
      })
    );
  });

  test("local checkout paths stay out of desired state and deployment artifacts", async () => {
    const files = {
      "lobu.config.ts": configWithViews("./views/deal/pipeline.tsx"),
      "views/deal/pipeline.tsx": VIEW_SOURCE,
      "agents/triage/SOUL.md": "triage",
    };
    const firstDir = mkProject(files);
    const secondDir = mkProject(files);
    const first = (await loadDesiredStateFromConfig({ cwd: firstDir })).state;
    const second = (await loadDesiredStateFromConfig({ cwd: secondDir })).state;

    expect(first.views[0]).not.toHaveProperty("sourcePath");
    expect(computeManifestHash(first)).toBe(computeManifestHash(second));
    const manifest = JSON.stringify(buildDeploymentManifest(first, {}));
    expect(manifest).not.toContain(firstDir);
    expect(manifest).not.toContain(secondDir);
  });

  test("a module without mountView fails loud at load", async () => {
    const dir = mkProject({
      "lobu.config.ts": configWithViews("./views/connection/health.tsx"),
      "views/connection/health.tsx": `export default function H() { return null; }\n`,
    });
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      "must call mountView"
    );
  });

  test("duplicate keys, absolute paths and missing files fail loud", async () => {
    const dup = mkProject({
      "lobu.config.ts": configWithViews("./views/a.tsx", "./views/b.tsx"),
      "views/a.tsx": VIEW_SOURCE,
      "views/b.tsx": VIEW_SOURCE,
    });
    await expect(loadDesiredStateFromConfig({ cwd: dup })).rejects.toThrow(
      'duplicate view key "pipeline"'
    );
    const abs = mkProject({
      "lobu.config.ts": configWithViews("/etc/views/a.tsx"),
    });
    await expect(loadDesiredStateFromConfig({ cwd: abs })).rejects.toThrow(
      "relative POSIX path"
    );
    const missing = mkProject({
      "lobu.config.ts": configWithViews("./views/gone.tsx"),
    });
    await expect(loadDesiredStateFromConfig({ cwd: missing })).rejects.toThrow(
      "does not exist"
    );
  });

  test("a targeted apply skips views", async () => {
    const dir = mkProject({
      "lobu.config.ts": configWithViews("./views/deal/pipeline.tsx"),
      "views/deal/pipeline.tsx": VIEW_SOURCE,
    });
    const { state } = await loadDesiredStateFromConfig({
      cwd: dir,
      only: "agents",
    });
    expect(state.views).toEqual([]);
  });
});

describe("view diff rows", () => {
  function stateWithViews(views: DesiredView[]): DesiredState {
    return {
      agents: [],
      prune: false,
      memorySchema: { entityTypes: [], relationshipTypes: [] },
      automations: [],
      connectors: { definitions: [], authProfiles: [], connections: [] },
      views,
      providers: [],
      requiredSecrets: [],
    };
  }

  test("create / update / noop key on the file hash", () => {
    const desired = stateWithViews([
      desiredView("fresh", "aaaaaaaaaaaaaaaa"),
      desiredView("changed", "bbbbbbbbbbbbbbbb"),
      desiredView("same", "cccccccccccccccc"),
    ]);
    const remote = emptyRemote();
    remote.views = [
      {
        key: "changed",
        name: "changed",
        content_hash: "zzzzzzzzzzzzzzzz",
        attach: [],
        last_writer: "w",
        updated_at: "t",
      },
      {
        key: "same",
        name: "same",
        content_hash: "cccccccccccccccc",
        attach: [],
        last_writer: "w",
        updated_at: "t",
      },
    ];
    const plan = computeDiff(desired, remote, {});
    const byId = new Map(
      plan.rows.filter((r) => r.kind === "view").map((r) => [r.id, r.verb])
    );
    expect(byId.get("fresh")).toBe("create");
    expect(byId.get("changed")).toBe("update");
    expect(byId.get("same")).toBe("noop");
  });

  test("remote-only views drift without prune and delete with it", () => {
    const desired = stateWithViews([]);
    const remote = emptyRemote();
    remote.views = [
      {
        key: "stale",
        name: "stale",
        content_hash: "dddddddddddddddd",
        attach: [],
        last_writer: "w",
        updated_at: "t",
      },
    ];
    const drift = computeDiff(desired, remote, {});
    expect(drift.rows.find((r) => r.kind === "view")?.verb).toBe("drift");
    const pruned = computeDiff({ ...desired, prune: true }, remote, {
      prune: true,
    });
    expect(pruned.rows.find((r) => r.kind === "view")?.verb).toBe("delete");
  });
});

describe("view client", () => {
  function stubClient(
    handler: (path: string, body: Record<string, unknown>) => unknown
  ) {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit
    ) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      calls.push({ path: String(url), body });
      return new Response(JSON.stringify(handler(String(url), body)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = new ApplyClient(
      { apiBaseUrl: "https://app.lobu.ai", orgSlug: "acme", token: "tok" },
      fetchImpl
    );
    return { client, calls };
  }

  test("setView posts action:set with source + bundle + metadata", async () => {
    const { client, calls } = stubClient(() => ({
      written: true,
      view: { content_hash: "aaaaaaaaaaaaaaaa" },
    }));
    const result = await client.setView({
      key: "pipeline",
      source_code: "source",
      compiled_code: "bundle",
      attach: [{ type: "deal" }],
      params: {},
      actions: {},
    });
    expect(result).toEqual({ written: true, content_hash: "aaaaaaaaaaaaaaaa" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toContain("/api/acme/manage_views");
    expect(calls[0]?.body).toMatchObject({
      action: "set",
      key: "pipeline",
      source_code: "source",
      compiled_code: "bundle",
    });
  });

  test("listViews returns metadata rows; removeView posts action:remove", async () => {
    const { client, calls } = stubClient((_, body) => {
      if (body.action === "list") return { views: [{ key: "pipeline" }] };
      return { removed: true };
    });
    expect(await client.listViews()).toEqual([{ key: "pipeline" }]);
    await client.removeView("pipeline");
    expect(calls[1]?.body).toMatchObject({ action: "remove", key: "pipeline" });
  });
});
