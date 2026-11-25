/**
 * Workspace guardrails end to end over the wire: a real `lobu.config.ts` on
 * disk, real config loading, diffing and `ApplyClient` — only `fetch` is
 * stubbed, by a library that enforces the REST compare-and-swap the way the
 * server does. Asserts on the requests that actually leave the process.
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
import type {
  GuardrailInput,
  WorkspaceGuardrail,
} from "@lobu/core/contracts/workspace-guardrails";
import * as context from "../../../../internal/context.js";
import * as credentials from "../../../../internal/credentials.js";
import { applyCommand } from "../apply-cmd.js";
import { rollbackCommand } from "../rollback-cmd.js";

const tempDirs: string[] = [];
const originalWrite = process.stdout.write.bind(process.stdout);

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

afterEach(() => {
  mock.restore();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
  process.stdout.write = originalWrite;
});

/**
 * `guardrails` is the source of the `guardrails` array; null leaves the key
 * out (the library is unmanaged).
 */
function mkProject(
  guardrails: string | null,
  opts: { prune?: boolean } = {}
): string {
  const dir = mkdtempSync(join(import.meta.dir, "guardrails-wire-fixture-"));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, "lobu.config.ts"),
    `import { defineAgent, defineConfig, defineGuardrail } from "@lobu/cli/config";
export default defineConfig({
  ${opts.prune ? "prune: true," : ""}
  agents: [defineAgent({ id: "triage", name: "Triage", dir: "./agents/triage" })],
  ${guardrails === null ? "" : `guardrails: ${guardrails},`}
});
`
  );
  mkdirSync(join(dir, "agents", "triage"), { recursive: true });
  return dir;
}

const judge = (policy: string) =>
  `[defineGuardrail({ name: "no-refunds", judge: { stage: "output", policy: ${JSON.stringify(policy)} }, appliesTo: [{ agent: "triage" }] })]`;

interface WireCall {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

interface Store {
  guardrails: WorkspaceGuardrail[];
  /** Simulate another editor writing between apply's read and its write. */
  concurrentEdit?: boolean;
  /** Answer writes 403, as the server does for a CLI login. */
  denyWrites?: boolean;
  latestManifest?: unknown;
  rollbackManifest?: unknown;
}

function makeFetch(store: Store) {
  const calls: WireCall[] = [];
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const fetchStub = async (
    url: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const urlStr = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body: Record<string, unknown> =
      typeof init?.body === "string" && init.body.length > 0
        ? JSON.parse(init.body)
        : {};
    calls.push({ method, url: urlStr, body });
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
    if (
      urlStr.endsWith("/deployments/apl_11111111-2222-3333-4444-555555555555")
    ) {
      return json({
        deployment: { status: "succeeded", manifest: store.rollbackManifest },
      });
    }
    if (urlStr.endsWith("/deployments") && method === "POST") {
      if (body.status === "succeeded") store.latestManifest = body.manifest;
      return json({ ok: true });
    }
    const path = new URL(urlStr).pathname;
    if (path.startsWith("/api/acme/guardrails")) {
      const id = path.split("/")[4];
      if (method === "GET") {
        const items = structuredClone(store.guardrails);
        if (store.concurrentEdit) {
          for (const guardrail of store.guardrails) guardrail.revision += 1;
        }
        return json({ items, next_cursor: null });
      }
      if (store.denyWrites) {
        return json({ error: "Owner or admin access required." }, 403);
      }
      const current = store.guardrails.find((g) => g.id === id);
      if (method === "DELETE") {
        const revision = Number(
          new URL(urlStr).searchParams.get("expected_revision")
        );
        if (!current || current.revision !== revision) {
          return json({ error: "Guardrail changed" }, 409);
        }
        store.guardrails = store.guardrails.filter((g) => g.id !== id);
        return json({
          guardrail: { ...current, archived: true, revision: revision + 1 },
        });
      }
      const input = body.guardrail as GuardrailInput;
      if (
        (id === undefined &&
          store.guardrails.some((g) => g.name === input.name)) ||
        (id !== undefined && current?.revision !== body.expected_revision)
      ) {
        return json({ error: "Guardrail changed" }, 409);
      }
      const next: WorkspaceGuardrail = {
        id: current?.id ?? `gr_${input.name}`,
        name: input.name,
        config: input.config,
        applies_to: input.applies_to ?? [
          { principal_kind: "agent", principal_id: null },
        ],
        enabled: input.enabled ?? true,
        revision: (current?.revision ?? 0) + 1,
        archived: false,
      };
      store.guardrails = [
        ...store.guardrails.filter((g) => g.id !== next.id),
        next,
      ];
      return json({ guardrail: next });
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

const guardrailCalls = (calls: WireCall[]) =>
  calls.filter((call) => new URL(call.url).pathname.includes("/guardrails"));
const guardrailWrites = (calls: WireCall[]) =>
  guardrailCalls(calls).filter((call) => call.method !== "GET");

async function runApply(
  dir: string,
  fetchImpl: typeof fetch,
  only?: "agents" | "memory"
) {
  await applyCommand({
    cwd: dir,
    yes: true,
    url: "https://app.lobu.ai",
    org: "acme",
    fetchImpl,
    ...(only ? { only } : {}),
  });
}

/** A guardrail someone made in the app, which this config never applied. */
const appGuardrail: WorkspaceGuardrail = {
  id: "gr_app",
  name: "app-made",
  config: { builtin: "pii-scan" },
  applies_to: [{ principal_kind: "agent", principal_id: null }],
  enabled: true,
  revision: 4,
  archived: false,
};

describe("apply workspace guardrails over the wire", () => {
  test("creates each declared guardrail, records only policy digests, then re-applies as a noop", async () => {
    const store: Store = { guardrails: [] };
    const first = makeFetch(store);
    await runApply(
      mkProject(
        `[defineGuardrail({ name: "no-secrets", builtin: "secret-scan" }), ...${judge("Never promise a refund.")}]`
      ),
      first.fetchStub
    );
    expect(
      guardrailWrites(first.calls).map((call) => [
        call.method,
        new URL(call.url).pathname,
        call.body,
      ])
    ).toEqual([
      [
        "PUT",
        "/api/acme/guardrails",
        {
          guardrail: {
            name: "no-secrets",
            config: { builtin: "secret-scan" },
            applies_to: [{ principal_kind: "agent", principal_id: null }],
            enabled: true,
          },
          expected_revision: 0,
        },
      ],
      [
        "PUT",
        "/api/acme/guardrails",
        {
          guardrail: {
            name: "no-refunds",
            config: {
              kind: "judge",
              stage: "output",
              policy: "Never promise a refund.",
            },
            applies_to: [{ principal_kind: "agent", principal_id: "triage" }],
            enabled: true,
          },
          expected_revision: 0,
        },
      ],
    ]);
    const manifest = store.latestManifest as {
      guardrails?: Array<Record<string, unknown>>;
      state?: { guardrails?: Array<Record<string, unknown>> };
    };
    expect(manifest.guardrails).toMatchObject([
      { id: "gr_no-secrets", name: "no-secrets" },
      { id: "gr_no-refunds", name: "no-refunds" },
    ]);
    for (const recorded of [
      manifest.guardrails?.[1],
      manifest.state?.guardrails?.[1],
    ]) {
      expect(recorded?.config).toEqual({
        kind: "judge",
        stage: "output",
        policy_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    }
    expect(JSON.stringify(manifest)).not.toContain("Never promise a refund.");

    const again = makeFetch(store);
    await runApply(
      mkProject(
        `[defineGuardrail({ name: "no-secrets", builtin: "secret-scan" }), ...${judge("Never promise a refund.")}]`
      ),
      again.fetchStub
    );
    expect(guardrailWrites(again.calls)).toEqual([]);
  });

  test("replaces at the revision apply read while the library is as this config left it", async () => {
    const store: Store = { guardrails: [] };
    await runApply(mkProject(judge("v1")), makeFetch(store).fetchStub);
    const edit = makeFetch(store);
    await runApply(mkProject(judge("v2")), edit.fetchStub);
    expect(
      guardrailWrites(edit.calls).map((call) => [
        call.method,
        new URL(call.url).pathname,
        call.body.expected_revision,
      ])
    ).toEqual([["PUT", "/api/acme/guardrails/gr_no-refunds", 1]]);
    expect(store.guardrails).toMatchObject([
      { config: { policy: "v2" }, revision: 2 },
    ]);
  });

  test("blocks a stale config from replacing a guardrail edited in the app since", async () => {
    const store: Store = { guardrails: [] };
    await runApply(mkProject(judge("v1")), makeFetch(store).fetchStub);
    const [guardrail] = store.guardrails;
    if (!guardrail) throw new Error("expected the applied guardrail");
    guardrail.config = { kind: "judge", stage: "output", policy: "Edited." };
    guardrail.revision = 2;

    const stale = makeFetch(store);
    await expect(
      runApply(mkProject(judge("v1")), stale.fetchStub)
    ).rejects.toThrow(/blocked by 1 drift item/);
    expect(guardrailWrites(stale.calls)).toEqual([]);
    expect(store.guardrails).toMatchObject([
      { config: { policy: "Edited." }, revision: 2 },
    ]);
  });

  test("fails instead of overwriting an edit made between read and write", async () => {
    const store: Store = { guardrails: [] };
    await runApply(mkProject(judge("v1")), makeFetch(store).fetchStub);
    store.concurrentEdit = true;
    await expect(
      runApply(mkProject(judge("v2")), makeFetch(store).fetchStub)
    ).rejects.toThrow(
      /Guardrail "no-refunds" changed since this apply read it/
    );
    expect(store.guardrails).toMatchObject([{ config: { policy: "v1" } }]);
  });

  test("archives only guardrails this config created, and only under prune", async () => {
    const store: Store = { guardrails: [structuredClone(appGuardrail)] };
    await runApply(mkProject(judge("v1")), makeFetch(store).fetchStub);

    // Dropped without prune: it stays, and stays owned.
    const kept = makeFetch(store);
    await runApply(mkProject("[]"), kept.fetchStub);
    expect(guardrailWrites(kept.calls)).toEqual([]);
    expect(store.latestManifest).toMatchObject({
      guardrails: [{ id: "gr_no-refunds", created: true }],
    });

    // Under prune the owned row is archived at its revision; the app's is not.
    const pruned = makeFetch(store);
    await runApply(mkProject("[]", { prune: true }), pruned.fetchStub);
    expect(
      guardrailWrites(pruned.calls).map((call) => [
        call.method,
        `${new URL(call.url).pathname}${new URL(call.url).search}`,
      ])
    ).toEqual([
      ["DELETE", "/api/acme/guardrails/gr_no-refunds?expected_revision=1"],
    ]);
    expect(store.guardrails.map((g) => g.name)).toEqual(["app-made"]);
    expect(store.latestManifest).toMatchObject({ guardrails: [] });
  });

  test("never archives an app-made guardrail it adopted by name, even after updating it", async () => {
    const store: Store = { guardrails: [structuredClone(appGuardrail)] };
    // Declared as it stands (a noop), then changed by this config (an update).
    await runApply(
      mkProject(`[defineGuardrail({ name: "app-made", builtin: "pii-scan" })]`),
      makeFetch(store).fetchStub
    );
    const updated = makeFetch(store);
    await runApply(
      mkProject(
        `[defineGuardrail({ name: "app-made", builtin: "pii-scan", enabled: false })]`
      ),
      updated.fetchStub
    );
    expect(guardrailWrites(updated.calls).map((call) => call.method)).toEqual([
      "PUT",
    ]);

    const pruned = makeFetch(store);
    await runApply(mkProject("[]", { prune: true }), pruned.fetchStub);
    expect(guardrailWrites(pruned.calls)).toEqual([]);
    expect(store.guardrails.map((g) => g.name)).toEqual(["app-made"]);
  });

  test("blocks archiving a guardrail edited in the app since this config created it", async () => {
    const store: Store = { guardrails: [] };
    await runApply(mkProject(judge("v1")), makeFetch(store).fetchStub);
    const [guardrail] = store.guardrails;
    if (!guardrail) throw new Error("expected the applied guardrail");
    guardrail.enabled = false;
    guardrail.revision = 2;

    const pruned = makeFetch(store);
    await expect(
      runApply(mkProject("[]", { prune: true }), pruned.fetchStub)
    ).rejects.toThrow(/blocked by 1 drift item/);
    expect(guardrailWrites(pruned.calls)).toEqual([]);
    expect(store.guardrails).toHaveLength(1);
  });

  test("a refused write says a guardrails:write token is needed", async () => {
    const store: Store = { guardrails: [], denyWrites: true };
    await expect(
      runApply(mkProject(judge("v1")), makeFetch(store).fetchStub)
    ).rejects.toThrow(/guardrails:write scope[\s\S]*LOBU_API_TOKEN/);
  });

  test("a config without guardrails, or a memory-only apply, never touches the library", async () => {
    const store: Store = { guardrails: [structuredClone(appGuardrail)] };
    const unmanaged = makeFetch(store);
    await runApply(mkProject(null, { prune: true }), unmanaged.fetchStub);
    expect(guardrailCalls(unmanaged.calls)).toEqual([]);

    const memory = makeFetch(store);
    await runApply(mkProject(judge("v1")), memory.fetchStub, "memory");
    expect(guardrailCalls(memory.calls)).toEqual([]);
    expect(store.guardrails).toEqual([appGuardrail]);
  });

  test("rollback leaves the library alone and keeps its record, so a later edit still blocks", async () => {
    const store: Store = { guardrails: [] };
    const dir = mkProject(judge("v1"));
    await runApply(dir, makeFetch(store).fetchStub);
    store.rollbackManifest = structuredClone(store.latestManifest);
    await runApply(mkProject(judge("v2")), makeFetch(store).fetchStub);

    const rollback = makeFetch(store);
    await rollbackCommand({
      applyId: "apl_11111111-2222-3333-4444-555555555555",
      cwd: dir,
      yes: true,
      url: "https://app.lobu.ai",
      org: "acme",
      fetchImpl: rollback.fetchStub,
    });
    expect(guardrailWrites(rollback.calls)).toEqual([]);
    expect(store.guardrails).toMatchObject([{ config: { policy: "v2" } }]);
    expect(store.latestManifest).toMatchObject({
      guardrails: [{ id: "gr_no-refunds", created: true }],
    });

    const [guardrail] = store.guardrails;
    if (!guardrail) throw new Error("expected the library guardrail");
    guardrail.config = { kind: "judge", stage: "output", policy: "Edited." };
    guardrail.revision += 1;
    await expect(runApply(dir, makeFetch(store).fetchStub)).rejects.toThrow(
      /blocked by 1 drift item/
    );
  });

  test("rejects an invalid declaration before anything reaches the workspace", async () => {
    for (const [declaration, message] of [
      [
        `[defineGuardrail({ name: "both", builtin: "secret-scan", requireTool: { tools: ["x"] } })]`,
        /set exactly one of builtin, judge or requireTool/,
      ],
      [
        `[defineGuardrail({ name: "egress", judge: { stage: "egress", policy: "p" } })]`,
        /config\.domains must not be empty/,
      ],
      [
        `[defineGuardrail({ name: "Bad Name", builtin: "pii-scan" })]`,
        /the name must be lowercase/,
      ],
      [
        `[defineGuardrail({ name: "dup", builtin: "pii-scan" }), defineGuardrail({ name: "dup", builtin: "secret-scan" })]`,
        /guardrail name/,
      ],
    ] as const) {
      const store: Store = { guardrails: [] };
      const run = makeFetch(store);
      await expect(
        runApply(mkProject(declaration), run.fetchStub)
      ).rejects.toThrow(message);
      expect(guardrailCalls(run.calls)).toEqual([]);
    }
  });
});
