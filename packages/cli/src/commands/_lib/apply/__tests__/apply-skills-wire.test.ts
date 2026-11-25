/**
 * Agent skills end to end over the wire: a real `lobu.config.ts` on disk, real
 * config loading, diffing and `ApplyClient` — only `fetch` is stubbed, by a
 * library that enforces `manage_skills put`'s compare-and-set the way the
 * server does. Asserts on the JSON that actually leaves the process.
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
  SkillInput,
  WorkspaceSkill,
} from "@lobu/core/contracts/tools/manage-skills";
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

/** `body: null` declares the agent without any skills. */
function mkProject(body: string | null): string {
  const dir = mkdtempSync(join(import.meta.dir, "skills-wire-fixture-"));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, "lobu.config.ts"),
    `import { defineAgent, defineConfig, defineSkill } from "@lobu/cli/config";
export default defineConfig({
  agents: [
    defineAgent({ id: "triage", name: "Triage", dir: "./agents/triage"${
      body === null
        ? ""
        : `, skills: [
      defineSkill({ name: "ops", description: "Run ops.", content: ${JSON.stringify(body)} }),
    ]`
    } }),
  ],
});
`
  );
  mkdirSync(join(dir, "agents", "triage"), { recursive: true });
  return dir;
}

interface WireCall {
  url: string;
  body: Record<string, unknown>;
}

interface Store {
  skills: WorkspaceSkill[];
  /** Simulate another editor writing between apply's read and its write. */
  concurrentEdit?: boolean;
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
    if (urlStr.includes("/manage_skills")) {
      if (body.action === "list") {
        const items = structuredClone(store.skills);
        if (store.concurrentEdit) {
          for (const skill of store.skills) skill.revision += 1;
        }
        return json({ items, next_cursor: null });
      }
      if (body.action === "put") {
        const input = body.skill as SkillInput;
        const current = store.skills.find((s) =>
          body.id === undefined ? s.name === input.name : s.id === body.id
        );
        if (
          (body.id === undefined && current) ||
          (body.id !== undefined &&
            current?.revision !== body.expected_revision)
        ) {
          return json({ error: "Skill changed" }, 409);
        }
        const next: WorkspaceSkill = {
          id: current?.id ?? `skill_${input.name}`,
          name: input.name,
          description: input.description,
          content: input.content,
          applies_to: input.applies_to ?? [{ principal_kind: null }],
          enabled: input.enabled ?? true,
          sort_order: input.sort_order ?? 0,
          revision: (current?.revision ?? 0) + 1,
          archived: false,
          ...(input.provenance ? { provenance: input.provenance } : {}),
        };
        store.skills = [...store.skills.filter((s) => s.id !== next.id), next];
        return json({ skill: next });
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

const skillActions = (calls: WireCall[]) =>
  calls
    .filter((call) => call.url.includes("/manage_skills"))
    .map((call) => call.body.action);

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

describe("apply agent skills over the wire", () => {
  test("creates the library skill for its agent, then re-applies as a noop", async () => {
    const store: Store = { skills: [] };
    const first = makeFetch(store);
    await runApply(mkProject("Run the ops playbook."), first.fetchStub);
    expect(
      first.calls.find((call) => call.body.action === "put")?.body
    ).toEqual({
      action: "put",
      skill: {
        name: "ops",
        description: "Run ops.",
        content: "Run the ops playbook.",
        applies_to: [{ principal_kind: "agent", principal_id: "triage" }],
      },
      expected_revision: 0,
    });
    expect(store.skills).toMatchObject([{ name: "ops", revision: 1 }]);

    const again = makeFetch(store);
    await runApply(mkProject("Run the ops playbook."), again.fetchStub);
    expect(skillActions(again.calls)).not.toContain("put");
    expect(store.skills).toMatchObject([{ revision: 1 }]);
  });

  test("updates at the revision apply read while the library is as this config left it", async () => {
    const store: Store = { skills: [] };
    await runApply(mkProject("v1"), makeFetch(store).fetchStub);
    const edit = makeFetch(store);
    await runApply(mkProject("v2"), edit.fetchStub);
    expect(
      edit.calls.find((call) => call.body.action === "put")?.body
    ).toMatchObject({
      id: "skill_ops",
      expected_revision: 1,
      skill: { content: "v2" },
    });
    expect(store.skills).toMatchObject([{ content: "v2", revision: 2 }]);
  });

  test("blocks a stale config from replacing a skill edited in the app since", async () => {
    const store: Store = { skills: [] };
    await runApply(mkProject("v1"), makeFetch(store).fetchStub);
    const [skill] = store.skills;
    if (!skill) throw new Error("expected the applied skill");
    skill.content = "Edited in the app.";
    skill.revision = 2;

    const stale = makeFetch(store);
    await expect(runApply(mkProject("v1"), stale.fetchStub)).rejects.toThrow(
      /blocked by 1 drift item/
    );
    expect(skillActions(stale.calls)).not.toContain("put");
    expect(store.skills).toMatchObject([
      { content: "Edited in the app.", revision: 2 },
    ]);
  });

  test("fails instead of overwriting an edit made between read and write", async () => {
    const store: Store = { skills: [] };
    await runApply(mkProject("v1"), makeFetch(store).fetchStub);
    store.concurrentEdit = true;
    await expect(
      runApply(mkProject("v2"), makeFetch(store).fetchStub)
    ).rejects.toThrow(/Skill "ops" changed since this apply read it/);
    expect(store.skills).toMatchObject([{ content: "v1" }]);
  });

  test("rollback leaves library skills alone and keeps their record, so a later human edit still blocks", async () => {
    const store: Store = { skills: [] };
    const dir = mkProject("v1");
    await runApply(dir, makeFetch(store).fetchStub);
    store.rollbackManifest = structuredClone(store.latestManifest);
    await runApply(mkProject("v2"), makeFetch(store).fetchStub);

    const rollback = makeFetch(store);
    await rollbackCommand({
      applyId: "apl_11111111-2222-3333-4444-555555555555",
      cwd: dir,
      yes: true,
      url: "https://app.lobu.ai",
      org: "acme",
      fetchImpl: rollback.fetchStub,
    });
    expect(rollback.calls).toContainEqual(
      expect.objectContaining({
        url: "https://app.lobu.ai/api/acme/deployments",
        body: expect.objectContaining({ status: "succeeded" }),
      })
    );
    // A deployment holds only each body's digest, so there is nothing to restore.
    expect(store.skills).toMatchObject([{ content: "v2", revision: 2 }]);
    const manifest = store.latestManifest as {
      skills?: Array<Record<string, unknown>>;
      state?: { skills?: Array<Record<string, unknown>> };
    };
    for (const recorded of [
      manifest.skills?.[0],
      manifest.state?.skills?.[0],
    ]) {
      expect(recorded).toMatchObject({
        name: "ops",
        content_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(recorded).not.toHaveProperty("content");
    }

    const skill = store.skills[0];
    if (!skill) throw new Error("expected the library skill");
    skill.content = "Edited after rollback.";
    skill.revision += 1;

    const stale = makeFetch(store);
    await expect(runApply(dir, stale.fetchStub)).rejects.toThrow(
      /blocked by 1 drift item/
    );
    expect(skillActions(stale.calls)).not.toContain("put");
    expect(store.skills).toMatchObject([
      { content: "Edited after rollback.", revision: 3 },
    ]);
  });

  test("an agents-only first apply records the skills it wrote, so dropping a declaration detaches it", async () => {
    const store: Store = { skills: [] };
    await runApply(mkProject("v1"), makeFetch(store).fetchStub, "agents");
    expect(store.latestManifest).toMatchObject({ skills: [{ name: "ops" }] });
    expect(store.latestManifest).not.toHaveProperty("attribution");

    await runApply(mkProject(null), makeFetch(store).fetchStub, "agents");
    expect(store.skills).toMatchObject([{ name: "ops" }]);
    expect(store.skills[0]?.applies_to).not.toContainEqual({
      principal_kind: "agent",
      principal_id: "triage",
    });
  });

  test("a memory-only apply never reads or writes the library", async () => {
    const store: Store = { skills: [] };
    const memory = makeFetch(store);
    await runApply(mkProject("v1"), memory.fetchStub, "memory");
    expect(skillActions(memory.calls)).toEqual([]);
  });
});
