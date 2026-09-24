/**
 * Tests for `lobu init --from-org`.
 *
 * The canonical gate: bootstrap a project from stubbed cloud state, then load
 * the generated `lobu.config.ts` back through `loadDesiredStateFromConfig` and
 * assert the resulting DesiredState matches the stubbed cloud input
 * (entities/relationships/automations/connections/authProfiles/agents), modulo
 * write-only secret values (placeholders) and `installedAt` timestamps.
 *
 * Network is stubbed through an injected fetch impl returning the canned
 * responses listAgents / listEntityTypes / etc. produce. The fixture dir lives
 * UNDER `import.meta.dir` so jiti resolves the externalized `@lobu/cli/config`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadDesiredStateFromConfig } from "../../apply/desired-state.js";
import { initFromOrg } from "../bootstrap.js";

const tempDirs: string[] = [];

function mkFixtureDir(): string {
  const dir = mkdtempSync(join(import.meta.dir, "fixture-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Route by URL substring. A handler receives the parsed request body so routes
 * sharing a URL (e.g. `manage_connections` carries `list` alongside other
 * actions) can branch on the body `action`.
 */
function buildFetch(
  routes: Record<string, (body: Record<string, unknown>) => unknown>
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    // Order matters — match the most specific patterns first.
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(handler(body)), { status: 200 });
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

const ORIG_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of [
    "LOBU_API_URL",
    "LOBU_API_TOKEN",
    "LOBU_ORG",
    "LOBU_CONTEXT_DIR",
  ]) {
    ORIG_ENV[key] = process.env[key];
  }
  process.env.LOBU_API_URL = "https://example.test";
  process.env.LOBU_API_TOKEN = "test-token";
  process.env.LOBU_ORG = "acme";
});

afterEach(() => {
  for (const [key, val] of Object.entries(ORIG_ENV)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

/** Stubbed cloud state covering every resource family the bootstrap maps. */
function fullOrgRoutes(): Record<
  string,
  (body: Record<string, unknown>) => unknown
> {
  return {
    "/oauth/userinfo": () => ({
      organizations: [{ id: "org-1", slug: "acme", name: "Acme Inc" }],
    }),
    "/agents/sales/config": () => ({
      models: ["anthropic/claude-sonnet-5"],
      networkConfig: {
        allowedDomains: ["github.com", ".github.com"],
        deniedDomains: ["evil.com"],
      },
      toolsConfig: { allowedTools: ["Read"], strictMode: true },
      preApprovedTools: ["/mcp/gmail/tools/send_email"],
      guardrails: ["secret-scan"],
      nixConfig: { packages: ["jq", "ffmpeg"] },
      skillsConfig: {
        skills: [
          {
            repo: "local/account-brief",
            name: "account-brief",
            description: "Prepare an account brief.",
            content: "Summarize the account.",
            enabled: true,
            nixPackages: ["legacy-skill-package"],
          },
        ],
      },
      soulMd: "Be concise.",
      identityMd: "You are sales.",
      updatedAt: 0,
    }),
    // listAgents
    "/agents": () => ({
      agents: [
        { agentId: "sales", name: "Sales", description: "Revenue agent" },
      ],
    }),
    "automations?automation_id": () => ({
      automation: {
        reaction_script:
          "export default async (ctx, client) => {\n  await client.knowledge.save({ content: 'ok', semantic_type: 'digest' });\n};\n",
        description: null,
      },
    }),
    "automations?include_details": () => ({
      automations: [
        {
          slug: "account-health",
          automation_id: "1",
          name: "Account health",
          managed_agent_id: "sales",
          prompt: "Poll CRM data.",
          skills: [
            {
              name: "account-brief",
              content: "Summarize the account.",
            },
          ],
          schedule: "0 */12 * * *",
          triggers: [
            {
              kind: "event",
              connector_key: "github",
              connection_id: 7,
              event_types: ["pull_request.created"],
              execution: "turn",
              active_run: "queue",
              output: "silent",
            },
            {
              kind: "schedule",
              cron: "0 */12 * * *",
              execution: "window",
              active_run: "coalesce",
              skip_if_unchanged: true,
            },
          ],
          sources: [{ name: "content", query: "SELECT * FROM events" }],
          tags: ["sales", "health"],
          min_cooldown_seconds: 1800,
        },
      ],
    }),
    manage_entity_schema: () => {
      // The mapper uses a single endpoint for both entity_type and
      // relationship_type list actions; return a body carrying both keys.
      return {
        // Real server shape: per-type fields live inside `metadata_schema`
        // (a JSON Schema), not top-level `properties`/`required`. The client
        // hoists them back out for the diff/bootstrap.
        entity_types: [
          {
            slug: "lead",
            name: "Lead",
            description: "A sales lead",
            metadata_schema: {
              type: "object",
              required: ["stage"],
              properties: {
                stage: { type: "string", "x-table-label": "Stage" },
              },
            },
          },
          { slug: "pilot", name: "Pilot" },
        ],
        relationship_types: [
          {
            slug: "converted-to",
            name: "Converted To",
            description: "Lead to pilot",
            rules: [{ source: "lead", target: "pilot" }],
          },
        ],
      };
    },
    manage_auth_profiles: () => ({
      auth_profiles: [
        {
          slug: "github-account",
          display_name: "GitHub account",
          connector_key: "github",
          profile_kind: "oauth_account",
          status: "active",
        },
        {
          slug: "github-app",
          display_name: "GitHub OAuth App",
          connector_key: "github",
          profile_kind: "oauth_app",
          status: "active",
        },
      ],
    }),
    manage_connections: () => ({
      connections: [
        {
          id: 7,
          slug: "github-lobu",
          connector_key: "github",
          display_name: "GitHub — lobu",
          status: "active",
          auth_profile_slug: "github-account",
          app_auth_profile_slug: "github-app",
          config: { repo_owner: "lobu-ai", repo_name: "lobu" },
          device_worker_id: null,
        },
        {
          id: 8,
          slug: "agentconn-team-slack",
          connector_key: "slack",
          display_name: "Team Slack",
          status: "active",
          credential_mode: "byo",
          config: {
            botToken: "secret://connections%2Fteam-slack%2FbotToken",
            mode: "socket",
            platform: "slack",
            settings: { allowGroups: true },
            chatMetadata: { teamId: "T123" },
          },
          device_worker_id: null,
        },
      ],
    }),
    manage_feeds: (body) => ({
      feeds:
        body.connection_id === 7
          ? [
              {
                id: 1,
                connection_id: 7,
                feed_key: "stargazers",
                display_name: "Stars",
                status: "active",
                schedule: "0 */6 * * *",
                config: { repo_owner: "lobu-ai", repo_name: "lobu" },
              },
              {
                id: 2,
                connection_id: 7,
                feed_key: "query",
                display_name: "Churn rollup (live)",
                status: "active",
                schedule: null,
                config: { query: "SELECT 1" },
              },
            ]
          : [],
    }),
  };
}

describe("lobu init --from-org", () => {
  test("bootstraps a project that round-trips through loadDesiredStateFromConfig", async () => {
    const dir = mkFixtureDir();
    await initFromOrg({
      targetDir: dir,
      projectName: "acme-local",
      gatewayPort: "9876",
      workerProxyPort: "9001",
      fetchImpl: buildFetch(fullOrgRoutes()),
    });

    // The config file exists and references the org metadata.
    const source = readFileSync(join(dir, "lobu.config.ts"), "utf-8");
    expect(source).toContain('org: "acme"');
    expect(source).toContain('orgName: "Acme Inc"');
    expect(source).toContain('slug: "team-slack"');
    expect(source).toContain('credentialMode: "byo"');
    expect(source).toContain('botToken: secret("TEAM_SLACK_BOT_TOKEN")');
    expect(source).not.toContain("chatMetadata");
    expect(source).not.toContain("allowGroups");
    expect(source).not.toContain('platform: "slack"');

    // The bootstrap wrote the agent-dir markdown + the reaction script.
    expect(readFileSync(join(dir, "agents", "sales", "SOUL.md"), "utf-8")).toBe(
      "Be concise.\n"
    );
    expect(
      readFileSync(
        join(dir, "reactions", "account-health.reaction.ts"),
        "utf-8"
      )
    ).toContain("client.knowledge.save");
    const skillSource = readFileSync(
      join(dir, "agents", "sales", "skills", "account-brief", "SKILL.md"),
      "utf-8"
    );
    expect(skillSource).toContain("Summarize the account.");
    expect(skillSource).not.toContain("nixPackages");
    expect(readFileSync(join(dir, ".env.example"), "utf-8")).toContain(
      "ANTHROPIC_API_KEY="
    );
    const agentGuidance = readFileSync(join(dir, "AGENTS.md"), "utf-8");
    expect(agentGuidance).toContain("# acme-local — Lobu project guide");
    expect(agentGuidance).toContain("## Onboarding the user");
    expect(agentGuidance).toContain("http://localhost:9876");
    expect(readFileSync(join(dir, "TESTING.md"), "utf-8")).toContain(
      "memory health --context local"
    );
    const localEnv = readFileSync(join(dir, ".env"), "utf-8");
    expect(localEnv).toContain("GATEWAY_PORT=9876");
    expect(localEnv).toContain("WORKER_PROXY_PORT=9001");
    expect(localEnv).toContain("DATABASE_URL=file://.");
    expect(localEnv).toMatch(/ENCRYPTION_KEY=[a-f0-9]{64}/);
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toContain(".env");

    // Round-trip: load the generated config back to DesiredState.
    const env = {
      ANTHROPIC_API_KEY: "sk-test",
      TEAM_SLACK_BOT_TOKEN: "xoxb-test",
    } as NodeJS.ProcessEnv;
    const { state } = await loadDesiredStateFromConfig({ cwd: dir, env });

    // ── agents ───────────────────────────────────────────────────────────
    expect(state.memory).toEqual({ org: "acme", name: "Acme Inc" });
    const agent = state.agents[0];
    expect(agent?.metadata).toEqual({
      agentId: "sales",
      name: "Sales",
      description: "Revenue agent",
    });
    expect(agent?.settings.models).toEqual(["anthropic/claude-sonnet-5"]);
    expect(agent?.settings.networkConfig).toEqual({
      allowedDomains: ["github.com", ".github.com"],
      deniedDomains: ["evil.com"],
    });
    expect(agent?.settings.toolsConfig).toEqual({
      allowedTools: ["Read"],
      strictMode: true,
    });
    expect(agent?.settings.preApprovedTools).toEqual([
      "/mcp/gmail/tools/send_email",
    ]);
    expect(
      state.connectors.connections.find((c) => c.slug === "team-slack")
    ).toMatchObject({
      connector: "slack",
      credentialMode: "byo",
      config: { botToken: "xoxb-test", mode: "socket" },
    });
    expect(agent?.settings.guardrails).toEqual(["secret-scan"]);
    expect(agent?.settings.nixConfig?.packages).toEqual(["jq", "ffmpeg"]);
    expect(agent?.settings.skillsConfig?.skills[0]).not.toHaveProperty(
      "nixPackages"
    );
    expect(agent?.settings.soulMd).toBe("Be concise.");
    expect(agent?.settings.identityMd).toBe("You are sales.");
    // Secret resolves from env to the real value (write-only placeholder filled).
    expect(agent?.providerKeys).toEqual([
      { providerId: "anthropic", value: "sk-test" },
    ]);
    expect(state.requiredSecrets).toContain("ANTHROPIC_API_KEY");

    // ── memory schema ──────────────────────────────────────────────────────
    expect(state.memorySchema.entityTypes.map((e) => e.slug)).toEqual([
      "lead",
      "pilot",
    ]);
    expect(state.memorySchema.entityTypes[0]).toEqual({
      slug: "lead",
      name: "Lead",
      description: "A sales lead",
      required: ["stage"],
      properties: { stage: { type: "string", "x-table-label": "Stage" } },
    });
    expect(state.memorySchema.relationshipTypes[0]).toEqual({
      slug: "converted-to",
      name: "Converted To",
      description: "Lead to pilot",
      rules: [{ source: "lead", target: "pilot" }],
    });

    // ── automations ───────────────────────────────────────────────────────────
    const w = state.automations[0];
    expect(w?.slug).toBe("account-health");
    expect(w?.agent).toBe("sales");
    expect(w?.name).toBe("Account health");
    // The task statement and matching pinned skill both round-trip without
    // rehoming either one into the other.
    expect(w?.prompt).toBe("Poll CRM data.");
    expect(w?.skills).toEqual(["account-brief"]);
    expect(w?.skillSnapshots).toEqual([
      { name: "account-brief", content: "Summarize the account." },
    ]);
    expect(w?.triggers?.[0]).toMatchObject({
      kind: "event",
      connector_key: "github",
      connectionSlug: "github-lobu",
      event_types: ["pull_request.created"],
    });
    expect(w?.triggers?.[0]).not.toHaveProperty("connection_id");
    expect(w?.triggers?.[1]).toMatchObject({
      kind: "schedule",
      cron: "0 */12 * * *",
      execution: "window",
      active_run: "coalesce",
      skip_if_unchanged: true,
    });
    // No outputs means this round-trips as a run-output-only Automation.
    expect(w?.outputs).toBeUndefined();
    expect(w?.sources).toEqual([
      { name: "content", query: "SELECT * FROM events" },
    ]);
    expect(w?.tags).toEqual(["sales", "health"]);
    expect(w?.minCooldownSeconds).toBe(1800);
    expect(w?.reactionScript?.sourceCode).toContain("client.knowledge.save");

    // ── auth profiles ──────────────────────────────────────────────────────
    expect(state.connectors.authProfiles).toHaveLength(2);
    const ghAccount = state.connectors.authProfiles.find(
      (p) => p.slug === "github-account"
    );
    const ghApp = state.connectors.authProfiles.find(
      (p) => p.slug === "github-app"
    );
    expect(ghAccount).toMatchObject({
      slug: "github-account",
      connector: "github",
      kind: "oauth_account",
      name: "GitHub account",
    });
    // Interactive kind → no credentials.
    expect(ghAccount?.credentials).toBeUndefined();
    expect(ghApp).toMatchObject({
      slug: "github-app",
      connector: "github",
      kind: "oauth_app",
    });
    // oauth_app credentials are placeholder env refs (write-only on the server).
    expect(Object.keys(ghApp?.credentials ?? {})).toContain(
      "GITHUB_APP_CLIENT_SECRET"
    );

    // ── connections ────────────────────────────────────────────────────────
    const conn = state.connectors.connections[0];
    expect(conn?.slug).toBe("github-lobu");
    expect(conn?.connector).toBe("github");
    expect(conn?.name).toBe("GitHub — lobu");
    expect(conn?.authProfileSlug).toBe("github-account");
    expect(conn?.appAuthProfileSlug).toBe("github-app");
    expect(conn?.config).toEqual({ repo_owner: "lobu-ai", repo_name: "lobu" });
    // Feeds are emitted sorted by feed_key (query < stargazers). Capabilities
    // belong to connector definitions, so connection config only carries the
    // feed instance settings.
    //
    // `query` has no remote cron, so the generated config omits `schedule`
    // entirely and it round-trips as UNDECLARED rather than an explicit null.
    // That is the point: a later cron set in the UI is then left alone by
    // `lobu apply` instead of being silently wiped.
    expect(conn?.feeds).toEqual([
      {
        feedKey: "query",
        name: "Churn rollup (live)",
        config: { query: "SELECT 1" },
      },
      {
        feedKey: "stargazers",
        name: "Stars",
        schedule: "0 */6 * * *",
        config: { repo_owner: "lobu-ai", repo_name: "lobu" },
      },
    ]);
  });

  test("empty org → minimal config that still round-trips", async () => {
    const dir = mkFixtureDir();
    await initFromOrg({
      targetDir: dir,
      fetchImpl: buildFetch({
        "/oauth/userinfo": () => ({
          organizations: [{ id: "org-1", slug: "acme", name: "Acme Inc" }],
        }),
        "/agents/lone/config": () => ({ updatedAt: 0 }),
        "/agents": () => ({ agents: [{ agentId: "lone", name: "Lone" }] }),
        "automations?include_details": () => ({ automations: [] }),
        manage_entity_schema: () => ({
          entity_types: [],
          relationship_types: [],
        }),
        manage_auth_profiles: () => ({ auth_profiles: [] }),
        manage_connections: () => ({ connections: [] }),
      }),
    });

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    expect(state.agents[0]?.metadata.agentId).toBe("lone");
    expect(state.memorySchema.entityTypes).toHaveLength(0);
    expect(state.automations).toHaveLength(0);
    expect(state.connectors.connections).toHaveLength(0);
  });

  test("#3: a server models[] with an __unresolved__ sentinel round-trips (no crash, no spurious diff)", async () => {
    const dir = mkFixtureDir();
    await initFromOrg({
      targetDir: dir,
      fetchImpl: buildFetch({
        "/oauth/userinfo": () => ({
          organizations: [{ id: "org-1", slug: "acme", name: "Acme Inc" }],
        }),
        // The server represents "provider intended, no model resolved" as a
        // sentinel ref. Bootstrap must emit a provider config with NO model,
        // and re-mapping must reproduce the SAME models[] — a stable no-op.
        "/agents/lone/config": () => ({
          models: ["chatgpt/__unresolved__", "openai/gpt-5"],
          updatedAt: 0,
        }),
        "/agents": () => ({ agents: [{ agentId: "lone", name: "Lone" }] }),
        "automations?include_details": () => ({ automations: [] }),
        manage_entity_schema: () => ({
          entity_types: [],
          relationship_types: [],
        }),
        manage_auth_profiles: () => ({ auth_profiles: [] }),
        manage_connections: () => ({ connections: [] }),
      }),
    });

    const env = {
      CHATGPT_API_KEY: "x",
      OPENAI_API_KEY: "y",
    } as NodeJS.ProcessEnv;
    const { state } = await loadDesiredStateFromConfig({ cwd: dir, env });
    // Re-mapped models EXACTLY equal the server's list — the sentinel round-trips
    // (a diff against the remote would be a no-op).
    expect(state.agents[0]?.settings.models).toEqual([
      "chatgpt/__unresolved__",
      "openai/gpt-5",
    ]);
  });

  test("env auth profile → credentials keyed by the connector's auth-schema field, not <SLUG>_VALUE", async () => {
    const dir = mkFixtureDir();
    await initFromOrg({
      targetDir: dir,
      fetchImpl: buildFetch({
        "/oauth/userinfo": () => ({
          organizations: [{ id: "org-1", slug: "acme", name: "Acme Inc" }],
        }),
        "/agents/lone/config": () => ({ updatedAt: 0 }),
        "/agents": () => ({ agents: [{ agentId: "lone", name: "Lone" }] }),
        "automations?include_details": () => ({ automations: [] }),
        manage_entity_schema: () => ({
          entity_types: [],
          relationship_types: [],
        }),
        manage_auth_profiles: () => ({
          auth_profiles: [
            {
              slug: "stripe-key",
              display_name: "Stripe API key",
              connector_key: "stripe",
              profile_kind: "env",
              status: "active",
            },
          ],
        }),
        manage_connections: () => ({ connections: [] }),
        manage_catalog: (body) => {
          const stripe = {
            id: "stripe",
            name: "Stripe",
            detail: {
              auth_schema: {
                methods: [
                  {
                    type: "env_keys",
                    fields: [{ key: "api_key", required: true, secret: true }],
                  },
                ],
              },
            },
          };
          if (body.action === "list_catalog") {
            return { catalogs: { connectors: { entries: [stripe] } } };
          }
          if (body.action === "list_installed") {
            return { installed: { connectors: { items: [stripe] } } };
          }
          throw new Error(
            `unexpected manage_catalog action: ${String(body.action)}`
          );
        },
      }),
    });

    const source = readFileSync(join(dir, "lobu.config.ts"), "utf-8");
    // The credential KEY is the connector's real auth-schema field (`api_key`),
    // env var derived from slug+field — NOT `STRIPE_KEY_VALUE` as the KEY.
    expect(source).toContain("api_key: secret(");
    expect(source).toContain('secret("STRIPE_KEY_API_KEY")');
    expect(source).not.toContain("STRIPE_KEY_VALUE");
    // The stale "rename credential keys" TODO is gone once real keys are emitted.
    expect(source).not.toContain("rename credential keys");

    // Round-trips: the credential field survives back through DesiredState.
    const env = { STRIPE_KEY_API_KEY: "sk_live_x" } as NodeJS.ProcessEnv;
    const { state } = await loadDesiredStateFromConfig({ cwd: dir, env });
    const profile = state.connectors.authProfiles.find(
      (p) => p.slug === "stripe-key"
    );
    expect(Object.keys(profile?.credentials ?? {})).toEqual(["api_key"]);
    expect(profile?.credentials?.api_key).toBe("sk_live_x");
  });

  test("oauth_app profile → credentials keyed by the connector's oauth method (clientIdKey/clientSecretKey)", async () => {
    const dir = mkFixtureDir();
    await initFromOrg({
      targetDir: dir,
      fetchImpl: buildFetch({
        "/oauth/userinfo": () => ({
          organizations: [{ id: "org-1", slug: "acme", name: "Acme Inc" }],
        }),
        "/agents/lone/config": () => ({ updatedAt: 0 }),
        "/agents": () => ({ agents: [{ agentId: "lone", name: "Lone" }] }),
        "automations?include_details": () => ({ automations: [] }),
        manage_entity_schema: () => ({
          entity_types: [],
          relationship_types: [],
        }),
        manage_auth_profiles: () => ({
          auth_profiles: [
            {
              slug: "slack-app",
              display_name: "Slack OAuth app",
              connector_key: "slack",
              profile_kind: "oauth_app",
              status: "active",
            },
          ],
        }),
        manage_connections: () => ({ connections: [] }),
        manage_catalog: (body) => {
          const slack = {
            id: "slack",
            name: "Slack",
            detail: {
              auth_schema: {
                methods: [
                  {
                    type: "oauth",
                    provider: "slack",
                    requiredScopes: ["chat:write"],
                    clientIdKey: "SLACK_OAUTH_CLIENT_ID",
                    clientSecretKey: "SLACK_OAUTH_CLIENT_SECRET",
                  },
                ],
              },
            },
          };
          if (body.action === "list_catalog") {
            return { catalogs: { connectors: { entries: [slack] } } };
          }
          if (body.action === "list_installed") {
            return { installed: { connectors: { items: [slack] } } };
          }
          throw new Error(
            `unexpected manage_catalog action: ${String(body.action)}`
          );
        },
      }),
    });

    const source = readFileSync(join(dir, "lobu.config.ts"), "utf-8");
    // Both oauth credential keys come from the method (NOT the SLACK_APP_CLIENT_SECRET
    // placeholder), and the stale rename-TODO is gone.
    expect(source).toContain("SLACK_OAUTH_CLIENT_ID: secret(");
    expect(source).toContain("SLACK_OAUTH_CLIENT_SECRET: secret(");
    expect(source).not.toContain("rename credential keys");
  });

  test("managed OAuth connections export as managedBy instead of local OAuth app credentials", async () => {
    const dir = mkFixtureDir();
    await initFromOrg({
      targetDir: dir,
      org: "lobu-team",
      fetchImpl: buildFetch({
        "/oauth/userinfo": () => ({
          organizations: [
            { id: "org-1", slug: "lobu-team", name: "Lobu Team" },
          ],
        }),
        "/agents/lone/config": () => ({ updatedAt: 0 }),
        "/agents": () => ({ agents: [{ agentId: "lone", name: "Lone" }] }),
        "automations?include_details": () => ({ automations: [] }),
        manage_entity_schema: () => ({
          entity_types: [],
          relationship_types: [],
        }),
        manage_auth_profiles: () => ({
          auth_profiles: [
            {
              slug: "gmail-account",
              display_name: "Gmail account",
              connector_key: "google.gmail",
              profile_kind: "oauth_account",
              status: "active",
            },
            {
              slug: "gmail-app",
              display_name: "Gmail OAuth app",
              connector_key: "google.gmail",
              profile_kind: "oauth_app",
              status: "active",
            },
          ],
        }),
        manage_connections: () => ({
          connections: [
            {
              id: 42,
              slug: "gmail",
              connector_key: "google.gmail",
              display_name: "Gmail",
              status: "active",
              auth_profile_slug: "gmail-account",
              app_auth_profile_slug: "gmail-app",
              config: null,
              device_worker_id: null,
              effective_credential_mode: "managed",
            },
          ],
        }),
        manage_feeds: () => ({ feeds: [] }),
        manage_catalog: (body) => {
          const gmail = {
            id: "google.gmail",
            name: "Gmail",
            detail: {
              auth_schema: {
                methods: [
                  {
                    type: "oauth",
                    provider: "google",
                    clientIdKey: "GOOGLE_CLIENT_ID",
                    clientSecretKey: "GOOGLE_CLIENT_SECRET",
                  },
                ],
              },
            },
          };
          if (body.action === "list_catalog") {
            return { catalogs: { connectors: { entries: [gmail] } } };
          }
          if (body.action === "list_installed") {
            return { installed: { connectors: { items: [gmail] } } };
          }
          throw new Error(
            `unexpected manage_catalog action: ${String(body.action)}`
          );
        },
      }),
    });

    const source = readFileSync(join(dir, "lobu.config.ts"), "utf-8");
    expect(source).toContain(
      'managedBy: { org: "lobu-team", connectionSlug: "gmail" }'
    );
    expect(source).not.toContain("defineAuthProfile");
    expect(source).not.toContain("gmailApp");
    expect(source).not.toContain("gmailAccount");
    expect(source).not.toContain("consent_only");
    expect(source).not.toContain("GOOGLE_CLIENT_SECRET");

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    const conn = state.connectors.connections[0];
    expect(conn?.slug).toBe("gmail");
    expect(conn?.authProfileSlug).toBeUndefined();
    expect(conn?.appAuthProfileSlug).toBeUndefined();
    expect(conn?.config).toEqual({
      managedBy: { org: "lobu-team", connectionSlug: "gmail" },
    });
    expect(state.connectors.authProfiles).toEqual([]);
  });

  test("relationship-type rules hydrate via list_rules (real list omits them)", async () => {
    const dir = mkFixtureDir();
    await initFromOrg({
      targetDir: dir,
      fetchImpl: buildFetch({
        "/oauth/userinfo": () => ({
          organizations: [{ id: "org-1", slug: "acme", name: "Acme Inc" }],
        }),
        "/agents/lone/config": () => ({ updatedAt: 0 }),
        "/agents": () => ({ agents: [{ agentId: "lone", name: "Lone" }] }),
        "automations?include_details": () => ({ automations: [] }),
        // The REAL server `list` action omits rules (only `list_rules` returns
        // them). Branch on the action so this mirrors production: list → no
        // rules; list_rules → the rule rows in the server's snake_case shape.
        manage_entity_schema: (body) => {
          if (body.action === "list_rules") {
            return {
              rules: [
                {
                  id: 1,
                  source_entity_type_slug: "contact",
                  target_entity_type_slug: "company",
                },
              ],
            };
          }
          return {
            entity_types: [
              { slug: "contact", name: "Contact" },
              { slug: "company", name: "Company" },
            ],
            relationship_types: [{ slug: "works-at", name: "Works at" }],
          };
        },
        manage_auth_profiles: () => ({ auth_profiles: [] }),
        manage_connections: () => ({ connections: [] }),
      }),
    });

    const source = readFileSync(join(dir, "lobu.config.ts"), "utf-8");
    // The rule was hydrated from list_rules and emitted, using the entity
    // handles (not raw slugs) — proving the round-trip isn't lossy.
    expect(source).toMatch(/rules:\s*\[/);
    expect(source).toContain("source:");
    expect(source).toContain("target:");

    // Round-trips: the rule survives back into DesiredState.
    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    const rel = state.memorySchema.relationshipTypes.find(
      (r) => r.slug === "works-at"
    );
    expect(rel?.rules).toEqual([{ source: "contact", target: "company" }]);
  });

  test("public/cross-org + system types are NOT declared (only owned ones)", async () => {
    // The list endpoint returns the org's own types PLUS public types from
    // OTHER orgs (and the system `$member`). Only the org's own, non-system
    // types belong in a generated config — foreign ones would emit colliding
    // `defineEntityType` keys that don't apply.
    const dir = mkFixtureDir();
    await initFromOrg({
      targetDir: dir,
      fetchImpl: buildFetch({
        "/oauth/userinfo": () => ({
          organizations: [{ id: "org-1", slug: "acme", name: "Acme Inc" }],
        }),
        "/agents/lone/config": () => ({ updatedAt: 0 }),
        "/agents": () => ({ agents: [{ agentId: "lone", name: "Lone" }] }),
        "automations?include_details": () => ({ automations: [] }),
        manage_entity_schema: (body) => {
          if (body.action === "list_rules") {
            // The owned cross-org rel type binds an owned type to a NON-owned
            // (public) one — that target must survive as a string ref.
            if (body.slug === "tracked-via") {
              return {
                rules: [
                  {
                    id: 1,
                    source_entity_type_slug: "lead",
                    target_entity_type_slug: "investor",
                  },
                ],
              };
            }
            return { rules: [] };
          }
          return {
            entity_types: [
              { slug: "lead", name: "Lead", organization_id: "org-1" },
              { slug: "pilot", name: "Pilot", organization_id: "org-1" },
              // System type owned by this org — server-provisioned, rejects create.
              { slug: "$member", name: "Member", organization_id: "org-1" },
              // Public type from another org.
              {
                slug: "investor",
                name: "Investor",
                organization_id: "org-pub",
              },
              // Same key as an owned type, but from a public org (a collision
              // source if both were declared).
              {
                slug: "lead",
                name: "Lead (foreign)",
                organization_id: "org-pub",
              },
            ],
            relationship_types: [
              {
                slug: "converted-to",
                name: "Converted To",
                organization_id: "org-1",
              },
              {
                slug: "tracked-via",
                name: "Tracked Via",
                organization_id: "org-1",
              },
              {
                slug: "invested-in",
                name: "Invested In",
                organization_id: "org-pub",
              },
            ],
          };
        },
        manage_auth_profiles: () => ({ auth_profiles: [] }),
        manage_connections: () => ({ connections: [] }),
      }),
    });

    const source = readFileSync(join(dir, "lobu.config.ts"), "utf-8");
    // Owned, non-system types are declared.
    expect(source).toContain('key: "lead"');
    expect(source).toContain('key: "pilot"');
    expect(source).toContain('key: "converted-to"');
    expect(source).toContain('key: "tracked-via"');
    // Foreign (public-org) and system types are NOT declared.
    expect(source).not.toContain('key: "investor"');
    expect(source).not.toContain('key: "$member"');
    expect(source).not.toContain('key: "invested-in"');
    // The cross-org rule target survives as a string ref (the type isn't declared).
    expect(source).toContain('target: "investor"');

    // Round-trip: only the owned types land in DesiredState, exactly once each.
    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    expect(state.memorySchema.entityTypes.map((e) => e.slug).sort()).toEqual([
      "lead",
      "pilot",
    ]);
    expect(
      state.memorySchema.relationshipTypes.map((r) => r.slug).sort()
    ).toEqual(["converted-to", "tracked-via"]);
  });
});
