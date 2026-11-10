/**
 * Views end to end over the wire: a real `lobu.config.ts` on disk, real
 * config loading, diffing, bundling and `ApplyClient` — only `fetch` is
 * stubbed. Asserts on the JSON that actually leaves the process.
 *
 * Fixtures live next to this test so the view bundle's `@lobu/views` +
 * `react` imports resolve from the worktree's node_modules.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readViewDefinition } from "@lobu/core/contracts/tools/view-definition";
import { transform } from "esbuild";
import * as context from "../../../../internal/context.js";
import * as credentials from "../../../../internal/credentials.js";
import { applyCommand } from "../apply-cmd.js";

const tempDirs: string[] = [];
const originalWrite = process.stdout.write.bind(process.stdout);

afterEach(() => {
  mock.restore();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
  process.stdout.write = originalWrite;
});

const VIEW_SOURCE = `import { defineView } from "@lobu/views";
export const view = defineView({
  key: "pipeline",
  attach: [{ collection: "deal" }],
  params: { by: { type: "string", default: "owner" } },
  actions: { markWon: { emits: "deal.won" } },
});
export default function Pipeline() { return null; }
`;

function mkProject(navigation?: string): string {
  const dir = mkdtempSync(join(import.meta.dir, "views-wire-fixture-"));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, "lobu.config.ts"),
    `import { defineAgent, defineConfig, viewFromFile } from "@lobu/cli/config";
export default defineConfig({
  agents: [defineAgent({ id: "triage", name: "Triage", dir: "./agents/triage" })],
  views: [viewFromFile("./views/deal/pipeline.tsx")],${navigation ? `\n  navigation: ${navigation},` : ""}
});
`
  );
  mkdirSync(join(dir, "views", "deal"), { recursive: true });
  writeFileSync(join(dir, "views", "deal", "pipeline.tsx"), VIEW_SOURCE);
  mkdirSync(join(dir, "agents", "triage"), { recursive: true });
  return dir;
}

interface WireCall {
  url: string;
  body: Record<string, unknown>;
}

interface Store {
  views: Array<Record<string, unknown>>;
  navigation?: { revision: number; config: unknown };
  /** Simulate another editor writing between apply's read and its write. */
  concurrentEdit?: boolean;
  /** The manifest of the latest succeeded deployment, as the server keeps it. */
  latestManifest?: unknown;
}

/** Remote store the stubbed `manage_views` reads/writes against. */
function makeFetch(store: Store) {
  const calls: WireCall[] = [];
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const fetchStub = async (
    url: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const urlStr = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string" && init.body.length > 0) {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    if (method !== "GET") calls.push({ url: urlStr, body });
    if (urlStr.includes("/oauth/userinfo")) {
      return json({
        sub: "u1",
        organizations: [{ id: "org_1", slug: "acme", name: "Acme" }],
      });
    }
    if (urlStr.endsWith("/deployments/latest")) {
      return json({
        deployment:
          store.latestManifest === undefined
            ? null
            : { id: 1, status: "succeeded", manifest: store.latestManifest },
      });
    }
    if (urlStr.endsWith("/deployments") && method === "POST") {
      if (body.status === "succeeded") store.latestManifest = body.manifest;
      return json({ ok: true });
    }
    if (urlStr.includes("/manage_views")) {
      if (body.action === "list") return json({ views: store.views });
      if (body.action === "set") {
        // The server reads the declaration out of the module, as here.
        const def = readViewDefinition(
          (
            await transform(body.source_code as string, {
              loader: "tsx",
              jsx: "automatic",
            })
          ).code
        );
        const row = {
          key: def.key,
          name: def.name,
          description: def.description,
          content_hash: "aaaaaaaaaaaaaaaa",
          attach: def.attach,
          params: def.params,
          actions: def.actions,
          last_writer: "apply:test",
          updated_at: new Date().toISOString(),
          compiled_bytes: 10,
          source_bytes: 10,
        };
        const i = store.views.findIndex((v) => v.key === def.key);
        if (i >= 0) store.views[i] = row;
        else store.views.push(row);
        return json({ action: "set", view: row, written: true });
      }
      if (body.action === "get_navigation") {
        const nav = store.navigation ?? { revision: 0, config: null };
        const reply = json({ action: "get_navigation", ...nav, sections: [] });
        if (store.concurrentEdit) {
          store.navigation = { revision: nav.revision + 1, config: null };
        }
        return reply;
      }
      if (body.action === "set_navigation") {
        const current = store.navigation ?? { revision: 0, config: null };
        if (body.expected_revision !== current.revision) {
          return new Response(JSON.stringify({ error: "Navigation changed" }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          });
        }
        store.navigation = {
          revision: current.revision + 1,
          config: body.config,
        };
        return json({ action: "set_navigation", ...store.navigation });
      }
      if (body.action === "remove") {
        store.views = store.views.filter((v) => v.key !== body.key);
        return json({ action: "remove", key: body.key, removed: true });
      }
    }
    if (urlStr.includes("/manage_entity_schema")) {
      return json({ entity_types: [], relationship_types: [] });
    }
    if (urlStr.includes("/manage_automations"))
      return json({ automations: [] });
    if (urlStr.includes("/manage_auth_profiles"))
      return json({ auth_profiles: [] });
    if (urlStr.includes("/manage_catalog"))
      return json({ installed: { connectors: { items: [] } } });
    if (urlStr.includes("/agents")) return json({ agents: [] });
    return json({ success: true });
  };
  return { fetchStub: fetchStub as typeof fetch, calls };
}

async function runApply(dir: string, fetchImpl: typeof fetch) {
  await applyCommand({
    cwd: dir,
    yes: true,
    url: "https://app.lobu.ai",
    org: "acme",
    fetchImpl,
  });
}

describe("apply views over the wire", () => {
  beforeEach(() => {
    spyOn(process.stdout, "write").mockImplementation(() => true);
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://app.lobu.ai/api/v1",
      source: "config",
    });
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(context, "getActiveOrg").mockResolvedValue("acme");
    spyOn(context, "loadContextConfig").mockResolvedValue({
      currentContext: "prod",
      contexts: { prod: { url: "https://app.lobu.ai/api/v1" } },
    });
  });

  test("a new view ships its module and bundle, never a separate declaration", async () => {
    const dir = mkProject();
    const { fetchStub, calls } = makeFetch({ views: [] });
    await runApply(dir, fetchStub);
    const sets = calls.filter(
      (c) => c.url.includes("/manage_views") && c.body.action === "set"
    );
    expect(sets).toHaveLength(1);
    expect(Object.keys(sets[0]?.body ?? {}).sort()).toEqual([
      "action",
      "compiled_code",
      "dependencies",
      "source_code",
      "source_files",
    ]);
    const compiled = sets[0]?.body.compiled_code;
    expect(typeof compiled).toBe("string");
    // A real bundle that reads React and @lobu/views from the shell runtime.
    expect(compiled as string).toContain("__lobuViews");
    expect((compiled as string).length).toBeLessThan(8 * 1024);
    // Portable bytes: the fixture dir leaked nowhere into the bundle.
    expect(compiled as string).not.toContain("views-wire-fixture-");
    expect(typeof sets[0]?.body.source_code).toBe("string");
    expect(sets[0]?.body.source_code as string).toContain("defineView");
  });
});

const NAVIGATION = `{
    schemaVersion: 1,
    sections: [{ id: "work", label: "Work", items: [
      { id: "pipeline", target: { kind: "view", key: "pipeline", scope: { type: "deal" } },
        children: [{ id: "won", label: "Won", target: { kind: "link", href: "deal?stage=won" } }] },
    ] }],
  }`;

describe("apply navigation over the wire", () => {
  beforeEach(() => {
    spyOn(process.stdout, "write").mockImplementation(() => true);
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://app.lobu.ai/api/v1",
      source: "config",
    });
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(context, "getActiveOrg").mockResolvedValue("acme");
    spyOn(context, "loadContextConfig").mockResolvedValue({
      currentContext: "prod",
      contexts: { prod: { url: "https://app.lobu.ai/api/v1" } },
    });
  });

  const actions = (calls: WireCall[]) =>
    calls
      .filter((c) => c.url.includes("/manage_views"))
      .map((c) => c.body.action);

  test("writes the document after its views, at the revision apply read", async () => {
    const store: Store = {
      views: [],
      navigation: { revision: 4, config: null },
    };
    const { fetchStub, calls } = makeFetch(store);
    await runApply(mkProject(NAVIGATION), fetchStub);
    const sequence = actions(calls);
    expect(sequence.indexOf("set")).toBeLessThan(
      sequence.indexOf("set_navigation")
    );
    const write = calls.find((c) => c.body.action === "set_navigation");
    expect(write?.body.expected_revision).toBe(4);
    expect(store.navigation?.revision).toBe(5);
    expect(store.navigation?.config).toMatchObject({
      schemaVersion: 1,
      sections: [{ id: "work", items: [{ id: "pipeline" }] }],
    });

    // Re-applying the same document is a no-op: no second write.
    const again = makeFetch(store);
    await runApply(mkProject(NAVIGATION), again.fetchStub);
    expect(actions(again.calls)).not.toContain("set_navigation");
  });

  test("leaves navigation alone when the config does not manage it", async () => {
    const { fetchStub, calls } = makeFetch({ views: [] });
    await runApply(mkProject(), fetchStub);
    expect(actions(calls)).not.toContain("get_navigation");
    expect(actions(calls)).not.toContain("set_navigation");
  });

  test("fails instead of overwriting a concurrent edit", async () => {
    const store: Store = {
      views: [],
      navigation: { revision: 1, config: null },
      concurrentEdit: true,
    };
    const { fetchStub } = makeFetch(store);
    await expect(runApply(mkProject(NAVIGATION), fetchStub)).rejects.toThrow(
      /navigation changed since this apply read it/i
    );
    expect(store.navigation).toEqual({ revision: 2, config: null });
  });

  // Another editor's document: the same tree with Work renamed.
  const EDITED = {
    schemaVersion: 1,
    sections: [
      {
        id: "work",
        label: "Sales work",
        items: [
          {
            id: "pipeline",
            target: { kind: "view", key: "pipeline", scope: { type: "deal" } },
          },
        ],
      },
    ],
  };
  const LOCAL_EDIT = NAVIGATION.replace('label: "Work"', 'label: "Deals"');

  test("blocks a stale file from replacing a document edited since this config last applied it", async () => {
    const store: Store = {
      views: [],
      navigation: { revision: 0, config: null },
    };
    await runApply(mkProject(NAVIGATION), makeFetch(store).fetchStub);
    expect(store.navigation?.revision).toBe(1);

    // Someone edits the navigation in the app; the config file is unchanged.
    store.navigation = { revision: 2, config: EDITED };
    const stale = makeFetch(store);
    await expect(
      runApply(mkProject(NAVIGATION), stale.fetchStub)
    ).rejects.toThrow(/blocked by 1 drift item/);
    expect(actions(stale.calls)).not.toContain("set_navigation");
    expect(store.navigation).toEqual({ revision: 2, config: EDITED });
  });

  test("applies a config edit while the document is still what this config last applied", async () => {
    const store: Store = {
      views: [],
      navigation: { revision: 0, config: null },
    };
    await runApply(mkProject(NAVIGATION), makeFetch(store).fetchStub);
    await runApply(mkProject(LOCAL_EDIT), makeFetch(store).fetchStub);
    expect(store.navigation?.revision).toBe(2);
    expect(store.navigation?.config).toMatchObject({
      sections: [{ label: "Deals" }],
    });
  });

  test("an exported document is adopted first, then edits apply over it", async () => {
    // Exported from a workspace whose navigation someone set in the app:
    // there is no record of what this config applied, so a changed file
    // cannot tell an older export from a newer one and blocks.
    const store: Store = {
      views: [],
      navigation: { revision: 3, config: EDITED },
    };
    await expect(
      runApply(mkProject(NAVIGATION), makeFetch(store).fetchStub)
    ).rejects.toThrow(/blocked by 1 drift item/);
    expect(store.navigation).toEqual({ revision: 3, config: EDITED });
    // The file as exported applies as a no-op and records the baseline …
    const exported = `{ schemaVersion: 1, sections: [{ id: "work", label: "Sales work", items: [
      { id: "pipeline", target: { kind: "view", key: "pipeline", scope: { type: "deal" } } },
    ] }] }`;
    const adopt = makeFetch(store);
    await runApply(mkProject(exported), adopt.fetchStub);
    expect(actions(adopt.calls)).not.toContain("set_navigation");
    // … after which an edit to it applies.
    await runApply(mkProject(NAVIGATION), makeFetch(store).fetchStub);
    expect(store.navigation?.revision).toBe(4);
  });

  test("rejects an invalid document before any write", async () => {
    const { fetchStub, calls } = makeFetch({ views: [] });
    const duplicate = `{ schemaVersion: 1, sections: [{ id: "a", items: [
      { id: "a", label: "Bad", target: { kind: "link", href: "javascript:alert(1)" } },
    ] }] }`;
    await expect(runApply(mkProject(duplicate), fetchStub)).rejects.toThrow(
      /duplicate id 'a'[\s\S]*target\.href/
    );
    expect(
      actions(calls).filter((a) => a === "set" || a === "set_navigation")
    ).toEqual([]);
  });
});
