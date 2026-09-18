/**
 * Tests `applyCommand` orchestration around dry-run mutation safety, scoped
 * baseline recording, and org-resolution errors.
 *
 * All HTTP is stubbed via `fetchImpl` — no real network.
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
import { ValidationError } from "../../../memory/_lib/errors.js";
import { applyCommand } from "../apply-cmd.js";

// Silence printText / printError during tests.
const silentWrite = (): boolean => true;

// ── helpers ─────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

afterEach(() => {
  mock.restore();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
  // restore stdout
  process.stdout.write = originalWrite;
});

const originalWrite = process.stdout.write.bind(process.stdout);

function silenceOutput() {
  spyOn(process.stdout, "write").mockImplementation(silentWrite);
}

// Fixtures live under the worktree (next to this test) so the externalized
// `@lobu/cli/config` import in the generated config bundle resolves from node_modules.
function mkProject(config: string): string {
  const dir = mkdtempSync(join(import.meta.dir, "fixture-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "lobu.config.ts"), config);
  return dir;
}

function minimalConfig(
  agentId = "triage",
  opts: { org?: string; organizationId?: string } = {}
) {
  const extra = [
    opts.org ? `  org: ${JSON.stringify(opts.org)},` : "",
    opts.organizationId
      ? `  organizationId: ${JSON.stringify(opts.organizationId)},`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `import { defineAgent, defineConfig } from "@lobu/cli/config";
export default defineConfig({
${extra ? `${extra}\n` : ""}  agents: [defineAgent({ id: ${JSON.stringify(agentId)}, name: "Triage", dir: "./agents/${agentId}" })],
});
`;
}

function makeAuthFetch(
  orgs: Array<{ id: string; slug: string; name?: string }>,
  connections: Array<{
    id: number;
    slug: string;
    connector_key: string;
  }> = []
) {
  /**
   * A minimal fetch stub that handles the OAuth userinfo endpoint (for org
   * resolution) and returns empty lists for every GET (agents, entity-types,
   * automations, etc.) and a success body for POSTs.
   *
   * MUTATING calls (POST that creates/patches, PATCH) are tracked in
   * `mutateCalls` so tests can assert no writes happen in dry-run mode.
   */
  const mutateCalls: Array<{ url: string; method: string; body?: string }> = [];

  const fetchStub = async (
    url: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const urlStr = String(url);
    const method = (init?.method ?? "GET").toUpperCase();

    if (urlStr.includes("/oauth/userinfo")) {
      return new Response(JSON.stringify({ sub: "u1", organizations: orgs }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Track mutations
    if (method !== "GET") {
      mutateCalls.push({
        url: urlStr,
        method,
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
    }

    // Default: return empty lists for GET, success for everything else.
    if (method === "GET") {
      if (urlStr.includes("/agents")) {
        return new Response(JSON.stringify({ agents: [] }), { status: 200 });
      }
    }
    if (method === "POST") {
      if (urlStr.includes("/manage_connections")) {
        return new Response(JSON.stringify({ connections }), { status: 200 });
      }
      if (urlStr.includes("/manage_entity_schema")) {
        return new Response(
          JSON.stringify({ entity_types: [], relationship_types: [] }),
          { status: 200 }
        );
      }
      if (urlStr.includes("/automations")) {
        return new Response(JSON.stringify({ automations: [] }), {
          status: 200,
        });
      }
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  return { fetchStub: fetchStub as typeof fetch, mutateCalls };
}

// ── Apply orchestration ──────────────────────────────────────────────────────

describe("applyCommand orchestration", () => {
  beforeEach(() => {
    silenceOutput();
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

  test("dry-run with one agent: no resource-creating/mutating API calls are made", async () => {
    const dir = mkProject(minimalConfig());
    mkdirSync(join(dir, "agents", "triage"), { recursive: true });

    const { fetchStub, mutateCalls } = makeAuthFetch([
      { id: "org_1", slug: "acme", name: "Acme" },
    ]);

    await applyCommand({
      cwd: dir,
      dryRun: true,
      yes: true,
      url: "https://app.lobu.ai",
      org: "acme",
      fetchImpl: fetchStub,
    });

    // The snapshot phase uses POST for manage_entity_schema (list), manage_automations,
    // manage_connections (list) — these are read-only POSTs. The key invariant is:
    // no agent-create (POST /agents), no agent-patch (PATCH /agents/*), no settings
    // patch, no automation create, and no connection/feed creates.
    const writingCalls = mutateCalls.filter((c) => {
      // PATCH always writes
      if (c.method === "PATCH") return true;
      // PUT always writes
      if (c.method === "PUT") return true;
      // POST to agent-creation or entity-schema action=create/update
      if (c.method === "POST") {
        // List-action POSTs are OK (snapshot)
        if (c.url.includes("manage_entity_schema")) return false;
        if (c.url.includes("manage_automations")) return false;
        if (c.url.includes("manage_connections")) return false;
        if (c.url.includes("manage_feeds")) return false;
        if (c.url.includes("manage_auth_profiles")) return false;
        if (c.url.includes("manage_views")) return false;
        // POST to /agents (create) is a write
        return true;
      }
      return false;
    });

    expect(writingCalls).toEqual([]);
  });

  test("--only memory fetches connection IDs for Automations without reconciling connectors", async () => {
    const dir =
      mkProject(`import { defineAgent, defineAutomation, defineConfig, defineConnection } from "@lobu/cli/config";
const agent = defineAgent({ id: "triage", dir: "./agents/triage" });
const github = defineConnection({ slug: "github-main", connector: "github" });
export default defineConfig({
  agents: [agent],
  connections: [github],
  automations: [defineAutomation({
    agent,
    slug: "review-pr",
    triggers: [{
      kind: "event",
      connector_key: "github",
      connection: github,
      event_types: ["pull_request.created"],
      execution: "turn",
      active_run: "queue",
      output: "silent",
    }],
  })],
});
`);
    mkdirSync(join(dir, "agents", "triage"), { recursive: true });
    const { fetchStub, mutateCalls } = makeAuthFetch(
      [{ id: "org_1", slug: "acme", name: "Acme" }],
      [{ id: 91, slug: "github-main", connector_key: "github" }]
    );

    await applyCommand({
      cwd: dir,
      dryRun: true,
      yes: true,
      only: "memory",
      url: "https://app.lobu.ai",
      org: "acme",
      fetchImpl: fetchStub,
    });

    expect(
      mutateCalls.filter((call) => call.url.includes("/manage_connections"))
    ).toHaveLength(1);
    expect(
      mutateCalls.some((call) => call.url.includes("/manage_catalog"))
    ).toBe(false);
    expect(
      mutateCalls.some((call) => call.url.includes("/manage_auth_profiles"))
    ).toBe(false);
  });

  test("a first --only agents apply leaves the unexecuted baseline absent", async () => {
    const dir = mkProject(`import { defineConfig } from "@lobu/cli/config";
export default defineConfig({ agents: [] });
`);
    const { fetchStub, mutateCalls } = makeAuthFetch([
      { id: "org_1", slug: "acme", name: "Acme" },
    ]);

    await applyCommand({
      cwd: dir,
      only: "agents",
      yes: true,
      url: "https://app.lobu.ai",
      org: "acme",
      fetchImpl: fetchStub,
    });

    const summary = mutateCalls.find((call) =>
      call.url.endsWith("/api/acme/deployments")
    );
    expect(summary?.body).toBeDefined();
    const manifest = JSON.parse(summary?.body ?? "{}").manifest;
    expect(manifest.attribution).toBeUndefined();
    expect(manifest.owned).toBeUndefined();
  });
});

// ── Test: org not found → ValidationError with create-url ───────────────────

describe("applyCommand org resolution", () => {
  beforeEach(() => {
    silenceOutput();
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://app.lobu.ai/api/v1",
      source: "config",
    });
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(context, "getActiveOrg").mockResolvedValue(undefined);
    spyOn(context, "loadContextConfig").mockResolvedValue({
      currentContext: "prod",
      contexts: { prod: { url: "https://app.lobu.ai/api/v1" } },
    });
  });

  test("throws ValidationError when the target org is not in the user's org list", async () => {
    const dir = mkProject(minimalConfig());
    mkdirSync(join(dir, "agents", "triage"), { recursive: true });

    // User belongs to a different org
    const { fetchStub } = makeAuthFetch([
      { id: "org_other", slug: "other-org", name: "Other" },
    ]);

    await expect(
      applyCommand({
        cwd: dir,
        dryRun: true,
        yes: true,
        url: "https://app.lobu.ai",
        org: "acme",
        fetchImpl: fetchStub,
      })
    ).rejects.toThrow(/organization "acme" not found/);
  });

  test("throws ValidationError when user belongs to 0 orgs", async () => {
    const dir = mkProject(minimalConfig());
    mkdirSync(join(dir, "agents", "triage"), { recursive: true });

    const { fetchStub } = makeAuthFetch([]);

    await expect(
      applyCommand({
        cwd: dir,
        dryRun: true,
        yes: true,
        url: "https://app.lobu.ai",
        org: "acme",
        fetchImpl: fetchStub,
      })
    ).rejects.toThrow(/organization "acme" not found/);
  });

  test("succeeds (dry-run) when the user belongs to exactly 1 org that matches", async () => {
    const dir = mkProject(minimalConfig());
    mkdirSync(join(dir, "agents", "triage"), { recursive: true });

    const { fetchStub } = makeAuthFetch([
      { id: "org_1", slug: "acme", name: "Acme Corp" },
    ]);

    // Should resolve without throwing.
    await expect(
      applyCommand({
        cwd: dir,
        dryRun: true,
        yes: true,
        url: "https://app.lobu.ai",
        org: "acme",
        fetchImpl: fetchStub,
      })
    ).resolves.toBeUndefined();
  });

  test("refuses when the slug doesn't resolve, even if a renamed org shares the organizationId", async () => {
    const dir = mkProject(
      minimalConfig("triage", { org: "acme", organizationId: "org_id_42" })
    );
    mkdirSync(join(dir, "agents", "triage"), { recursive: true });

    // The pinned id matches a renamed org, but its slug differs from the one we
    // apply to. The client targets the SLUG in every URL, so resolving by id
    // would read provenance from / mutate the wrong org (or 404 mid-apply).
    const { fetchStub } = makeAuthFetch([
      { id: "org_id_42", slug: "acme-renamed", name: "Acme Renamed" },
    ]);

    await expect(
      applyCommand({
        cwd: dir,
        dryRun: true,
        yes: true,
        url: "https://app.lobu.ai",
        org: "acme",
        fetchImpl: fetchStub,
      })
    ).rejects.toThrow(/not found/i);
  });

  test("refuses when the resolved slug's org id mismatches the pinned organizationId", async () => {
    const dir = mkProject(
      minimalConfig("triage", { org: "acme", organizationId: "org_id_42" })
    );
    mkdirSync(join(dir, "agents", "triage"), { recursive: true });

    // Slug "acme" resolves, but to a DIFFERENT org id than pinned — a stale or
    // copied config pointed at someone else's org. Must hard-stop before apply.
    const { fetchStub } = makeAuthFetch([
      { id: "org_different", slug: "acme", name: "Acme" },
    ]);

    await expect(
      applyCommand({
        cwd: dir,
        dryRun: true,
        yes: true,
        url: "https://app.lobu.ai",
        org: "acme",
        fetchImpl: fetchStub,
      })
    ).rejects.toThrow(/organizationId/i);
  });
});

// ── Test: missing lobu.config.ts ─────────────────────────────────────────────

describe("applyCommand — missing lobu.config.ts", () => {
  beforeEach(() => {
    silenceOutput();
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

  test("throws a ValidationError when lobu.config.ts is absent", async () => {
    const dir = mkdtempSync(join(import.meta.dir, "no-config-"));
    tempDirs.push(dir);
    // No lobu.config.ts created

    const { fetchStub } = makeAuthFetch([{ id: "o1", slug: "acme" }]);

    await expect(
      applyCommand({
        cwd: dir,
        dryRun: true,
        yes: true,
        url: "https://app.lobu.ai",
        org: "acme",
        fetchImpl: fetchStub,
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
