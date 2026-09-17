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

function mkProject(): string {
  const dir = mkdtempSync(join(import.meta.dir, "views-wire-fixture-"));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, "lobu.config.ts"),
    `import { defineAgent, defineConfig, viewFromFile } from "@lobu/cli/config";
export default defineConfig({
  agents: [defineAgent({ id: "triage", name: "Triage", dir: "./agents/triage" })],
  views: [viewFromFile("./views/deal/pipeline.tsx")],
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

/** Remote store the stubbed `manage_views` reads/writes against. */
function makeFetch(store: { views: Array<Record<string, unknown>> }) {
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
    if (urlStr.includes("/manage_views")) {
      if (body.action === "list") return json({ views: store.views });
      if (body.action === "set") {
        const row = {
          key: body.key,
          name: body.key,
          description: "",
          content_hash: "aaaaaaaaaaaaaaaa",
          attach: body.attach,
          params: body.params,
          actions: body.actions,
          last_writer: "apply:test",
          updated_at: new Date().toISOString(),
          compiled_bytes: 10,
          source_bytes: 10,
        };
        const i = store.views.findIndex((v) => v.key === body.key);
        if (i >= 0) store.views[i] = row;
        else store.views.push(row);
        return json({ action: "set", view: row, written: true });
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

  test("a new view ships source + bundle + module metadata", async () => {
    const dir = mkProject();
    const { fetchStub, calls } = makeFetch({ views: [] });
    await runApply(dir, fetchStub);
    const sets = calls.filter(
      (c) => c.url.includes("/manage_views") && c.body.action === "set"
    );
    expect(sets).toHaveLength(1);
    expect(sets[0]?.body).toMatchObject({
      key: "pipeline",
      attach: [{ type: "deal" }],
      params: { by: { type: "string", default: "owner" } },
      actions: { markWon: { emits: "deal.won" } },
    });
    const compiled = sets[0]?.body.compiled_code;
    expect(typeof compiled).toBe("string");
    expect((compiled as string).length).toBeGreaterThan(10_000);
    // Portable bytes: the fixture dir leaked nowhere into the bundle.
    expect(compiled as string).not.toContain("views-wire-fixture-");
    expect(typeof sets[0]?.body.source_code).toBe("string");
    expect(sets[0]?.body.source_code as string).toContain("defineView");
  });

  test("an unchanged view sends no set on the second apply", async () => {
    const dir = mkProject();
    const store: { views: Array<Record<string, unknown>> } = { views: [] };
    const first = makeFetch(store);
    await runApply(dir, first.fetchStub);
    expect(
      first.calls.filter(
        (c) => c.url.includes("/manage_views") && c.body.action === "set"
      )
    ).toHaveLength(1);
    // The stubbed remote now reports the same content hash the loader
    // computes (server semantics: source plus declared metadata), so the
    // diff is noop and nothing is sent.
    store.views[0] = {
      ...(store.views[0] as Record<string, unknown>),
    };
    const { contentHash } = await import(
      "@lobu/core/contracts/tools/view-content-hash"
    );
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      join(dir, "views", "deal", "pipeline.tsx"),
      "utf-8"
    );
    const hash = contentHash(source, {
      name: "pipeline",
      description: "",
      attach: [{ type: "deal" }],
      params: { by: { type: "string", default: "owner" } },
      actions: { markWon: { emits: "deal.won" } },
    });
    store.views[0] = {
      ...(store.views[0] as Record<string, unknown>),
      content_hash: hash,
    };
    const second = makeFetch(store);
    await runApply(dir, second.fetchStub);
    expect(
      second.calls.filter(
        (c) => c.url.includes("/manage_views") && c.body.action === "set"
      )
    ).toEqual([]);
  });
});
