/**
 * End-to-end wire coverage for the "undeclared means unmanaged" rule.
 *
 * Every other apply test stubs `ctx.client`, so it proves what the command
 * *intends* to send. This one drives the whole path — a real `lobu.config.ts`
 * on disk, real config loading, diffing, and `ApplyClient` — and asserts on the
 * JSON that actually leaves the process. Only `fetch` is stubbed.
 *
 * The regression it guards: a feed the config declares without a `schedule`
 * used to reach the wire as `schedule: null`, clearing a cron the config had
 * never been told about.
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

// Fixtures live next to this test so the config bundle's externalized
// `@lobu/cli/config` import resolves from node_modules.
function mkProject(config: string): string {
  const dir = mkdtempSync(join(import.meta.dir, "wire-fixture-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "lobu.config.ts"), config);
  mkdirSync(join(dir, "agents", "triage"), { recursive: true });
  return dir;
}

const REMOTE_CONNECTION = {
  id: 42,
  slug: "gmail-main",
  connector_key: "google.gmail",
  name: "gmail-main",
  config: { label: "INBOX" },
};

/** A feed whose cron was set in the UI, not in any config. */
const REMOTE_FEED = {
  id: 367,
  connection_id: 42,
  feed_key: "threads",
  display_name: "threads",
  status: "active",
  schedule: "9,39 * * * *",
  config: { lookback_days: 7 },
};

interface WireCall {
  url: string;
  body: Record<string, unknown>;
}

function makeFetch(remoteFeeds = [REMOTE_FEED]) {
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
    if (urlStr.includes("/manage_catalog")) {
      return json({
        installed: {
          connectors: {
            items: [
              {
                id: "google.gmail",
                name: "Gmail",
                detail: { installed: true, connector_definition_id: 7 },
              },
            ],
          },
        },
      });
    }
    if (urlStr.includes("/manage_feeds")) {
      if (body.action === "list_feeds") {
        const offset = Number(body.offset ?? 0);
        const limit = Number(body.limit ?? 500);
        return json({
          feeds: remoteFeeds.slice(offset, offset + limit),
          has_more: offset + limit < remoteFeeds.length,
        });
      }
      return json({ feed: REMOTE_FEED });
    }
    if (urlStr.includes("/manage_connections")) {
      if (body.action === "update") {
        return json({ connection: REMOTE_CONNECTION });
      }
      return json({ connections: [REMOTE_CONNECTION] });
    }
    if (urlStr.includes("/manage_entity_schema")) {
      return json({ entity_types: [], relationship_types: [] });
    }
    if (urlStr.includes("/manage_automations"))
      return json({ automations: [] });
    if (urlStr.includes("/manage_auth_profiles")) {
      return json({ auth_profiles: [] });
    }
    if (urlStr.includes("/agents")) return json({ agents: [] });
    return json({ success: true });
  };

  return { fetchStub: fetchStub as typeof fetch, calls };
}

function feedWrites(calls: WireCall[]): Record<string, unknown>[] {
  return calls
    .filter((c) => c.url.includes("/manage_feeds"))
    .map((c) => c.body)
    .filter((b) => b.action === "update_feed" || b.action === "create_feed");
}

function connectionWrites(calls: WireCall[]): Record<string, unknown>[] {
  return calls
    .filter((c) => c.url.includes("/manage_connections"))
    .map((c) => c.body)
    .filter((b) => b.action === "update");
}

function configWithFeed(feedLiteral: string, connectionExtra = ""): string {
  return `import { defineAgent, defineConfig, defineConnection } from "@lobu/cli/config";
export default defineConfig({
  agents: [defineAgent({ id: "triage", name: "Triage", dir: "./agents/triage" })],
  connections: [
    defineConnection({
      slug: "gmail-main",
      connector: "google.gmail",${connectionExtra}
      feeds: [${feedLiteral}],
    }),
  ],
});
`;
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

describe("apply wire payloads: undeclared fields are never sent", () => {
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

  test.each([
    "original-first",
    "duplicate-first",
    "across-pages",
  ])("refuses ambiguous feed matching before any write (%s)", async (order) => {
    const dir = mkProject(
      configWithFeed(
        `{ feed: "threads", config: { lookback_days: 30 } }`,
        `name: "Work Gmail",`
      )
    );
    const duplicate = {
      ...REMOTE_FEED,
      id: 368,
      config: { lookback_days: 90 },
    };
    const feeds =
      order === "duplicate-first"
        ? [duplicate, REMOTE_FEED]
        : [REMOTE_FEED, duplicate];
    if (order === "across-pages") {
      feeds.splice(
        1,
        0,
        ...Array.from({ length: 499 }, (_, i) => ({
          ...REMOTE_FEED,
          id: 1000 + i,
          feed_key: `synthetic-other-feed-${i}`,
        }))
      );
    }
    const { fetchStub, calls } = makeFetch(feeds);
    await expect(runApply(dir, fetchStub)).rejects.toThrow(
      /multiple feeds.*threads.*gmail-main/i
    );
    expect(
      calls.filter(
        (call) =>
          ![
            "list",
            "list_installed",
            "list_feeds",
            "list_auth_profiles",
          ].includes(String(call.body.action))
      )
    ).toEqual([]);
  });

  test("an update triggered by another field never carries an undeclared schedule", async () => {
    // `name` differs from the remote display_name, so an update_feed IS sent —
    // without this the assertion below would pass vacuously.
    const dir = mkProject(
      configWithFeed(`{ feed: "threads", name: "Inbox threads" }`)
    );
    const { fetchStub, calls } = makeFetch();

    await runApply(dir, fetchStub);

    const writes = feedWrites(calls);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      action: "update_feed",
      feed_id: 367,
      display_name: "Inbox threads",
    });
    expect(writes[0]).not.toHaveProperty("schedule");
    expect(writes[0]).not.toHaveProperty("config");
    expect(writes[0]).not.toHaveProperty("replace_config");
  });

  test("a feed that declares nothing the remote lacks sends no write at all", async () => {
    const dir = mkProject(configWithFeed(`{ feed: "threads" }`));
    const { fetchStub, calls } = makeFetch();

    await runApply(dir, fetchStub);

    expect(feedWrites(calls)).toEqual([]);
  });

  test("`schedule: null` is an explicit clear and does reach the wire", async () => {
    const dir = mkProject(
      configWithFeed(`{ feed: "threads", schedule: null }`)
    );
    const { fetchStub, calls } = makeFetch();

    await runApply(dir, fetchStub);

    const writes = feedWrites(calls);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      action: "update_feed",
      feed_id: 367,
      schedule: null,
    });
  });

  test("a declared cron reaches the wire verbatim", async () => {
    const dir = mkProject(
      configWithFeed(`{ feed: "threads", schedule: "*/15 * * * *" }`)
    );
    const { fetchStub, calls } = makeFetch();

    await runApply(dir, fetchStub);

    const writes = feedWrites(calls);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      action: "update_feed",
      feed_id: 367,
      schedule: "*/15 * * * *",
    });
  });

  test("a declared feed config replaces the remote one, and only then", async () => {
    const dir = mkProject(
      configWithFeed(`{ feed: "threads", config: { lookback_days: 30 } }`)
    );
    const { fetchStub, calls } = makeFetch();

    await runApply(dir, fetchStub);

    const writes = feedWrites(calls);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      action: "update_feed",
      config: { lookback_days: 30 },
      replace_config: true,
    });
    expect(writes[0]).not.toHaveProperty("schedule");
  });

  test("an update triggered by another field never carries an undeclared connection config", async () => {
    // The remote connection's name is "gmail-main"; declaring a different one
    // forces an update_connection so the assertion is not vacuous.
    const dir = mkProject(
      configWithFeed(`{ feed: "threads" }`, `\n      name: "Gmail (work)",`)
    );
    const { fetchStub, calls } = makeFetch();

    await runApply(dir, fetchStub);

    const writes = connectionWrites(calls);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      action: "update",
      connection_id: 42,
      display_name: "Gmail (work)",
    });
    expect(writes[0]).not.toHaveProperty("config");
    expect(writes[0]).not.toHaveProperty("replace_config");
  });
});

describe("apply --only scopes provider keys to the agents family", () => {
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

  function configWithProviderKey(withEntity: boolean): string {
    return `import { defineAgent, defineConfig, defineEntityType } from "@lobu/cli/config";
export default defineConfig({
  agents: [
    defineAgent({
      id: "triage",
      name: "Triage",
      dir: "./agents/triage",
      providers: [{ id: "synthetic-provider", model: "synthetic-model", key: "synthetic-key" }],
    }),
  ],
  entities: [${withEntity ? `defineEntityType({ key: "synthetic_thing" })` : ""}],
});
`;
  }

  function providerWrites(calls: WireCall[]): WireCall[] {
    return calls.filter((c) => c.url.includes("/inference-providers"));
  }

  async function runScopedApply(
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

  test.each([
    ["an all-noop plan", false],
    ["a plan with memory work", true],
  ])("`--only memory` never pushes a provider key (%s)", async (_label, withEntity) => {
    const dir = mkProject(configWithProviderKey(withEntity));
    const { fetchStub, calls } = makeFetch([]);
    await runScopedApply(dir, fetchStub, "memory");
    expect(providerWrites(calls)).toEqual([]);
    if (withEntity) {
      expect(calls.some((c) => c.url.includes("/manage_entity_schema"))).toBe(
        true
      );
    }
  });

  test.each([
    ["--only agents", "agents" as const],
    ["a full apply", undefined],
  ])("%s still pushes the declared provider key", async (_label, only) => {
    const dir = mkProject(configWithProviderKey(false));
    const { fetchStub, calls } = makeFetch([]);
    await runScopedApply(dir, fetchStub, only);
    expect(providerWrites(calls).map((c) => c.url)).toEqual([
      "https://app.lobu.ai/api/acme/agents/inference-providers/synthetic-provider/key",
    ]);
  });
});
