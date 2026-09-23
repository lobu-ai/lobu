import { describe, expect, test } from "bun:test";
import {
  defineAgent,
  defineAuthProfile,
  defineAutomation,
  defineConfig,
  defineConnection,
  defineConnector,
  defineEntityType,
  defineRelationshipType,
  reactionFromFile,
  secret,
} from "@lobu/cli/config";
import type { AgentSettings } from "@lobu/core";
import { resolveAutomationConnectionRefs } from "../apply-cmd.js";
import {
  mapProjectToDesiredState,
  mergeAgentDirArtifacts,
} from "../map-config.js";

const env: NodeJS.ProcessEnv = {
  ANTHROPIC_API_KEY: "sk-test",
  GH_SECRET: "ghs_test",
};

describe("mapProjectToDesiredState", () => {
  test("maps agents: providers, network (deduped), resolved provider keys", () => {
    const crm = defineAgent({
      id: "crm",
      providers: [
        {
          id: "anthropic",
          model: "claude-sonnet-4-6",
          key: secret("ANTHROPIC_API_KEY"),
        },
      ],
      network: { allowed: ["github.com", "github.com"], denied: ["evil.com"] },
    });
    const state = mapProjectToDesiredState(
      defineConfig({ org: "o", agents: [crm] }),
      env
    );
    const agent = state.agents[0];
    expect(agent?.metadata.agentId).toBe("crm");
    expect(agent?.metadata.name).toBe("crm"); // defaults to id
    // The provider collapses to a single ordered `models` list entry
    // (`<provider>/<model>`) — no separate installedProviders/defaultModel.
    expect(agent?.settings.models).toEqual(["anthropic/claude-sonnet-4-6"]);
    expect(agent?.settings.networkConfig?.allowedDomains).toEqual([
      "github.com",
    ]);
    expect(agent?.settings.networkConfig?.deniedDomains).toEqual(["evil.com"]);
    expect(agent?.providerKeys).toEqual([
      { providerId: "anthropic", value: "sk-test" },
    ]);
    expect(state.requiredSecrets).toContain("ANTHROPIC_API_KEY");
    expect(state.memory).toEqual({ org: "o" });
  });

  test("#5: multiple providers → ordered models list; already-qualified model not double-prefixed", () => {
    const multi = defineAgent({
      id: "multi",
      providers: [
        { id: "openai", model: "gpt-5", key: secret("ANTHROPIC_API_KEY") },
        // Already `<slug>/…`-qualified (provider-native id with a slash).
        {
          id: "openrouter",
          model: "openrouter/anthropic/claude-sonnet-5",
          key: secret("ANTHROPIC_API_KEY"),
        },
      ],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ org: "o", agents: [multi] }),
      env
    );
    const agent = state.agents[0];
    // Order preserved (index 0 = primary); no `<slug>/<slug>/…` double-prefix.
    expect(agent?.settings.models).toEqual([
      "openai/gpt-5",
      "openrouter/anthropic/claude-sonnet-5",
    ]);
  });

  test("#3: a provider with NO model maps to the sentinel ref (no crash)", () => {
    // `lobu init --provider chatgpt` emits a provider with no model (ChatGPT has
    // no catalog default). map-config must NOT crash on p.model.trim() — it maps
    // to the `<slug>/__unresolved__` restriction sentinel so the agent stays
    // gated (never allow-all).
    const chat = defineAgent({
      id: "chat",
      providers: [{ id: "chatgpt", key: secret("ANTHROPIC_API_KEY") }],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ org: "o", agents: [chat] }),
      env
    );
    expect(state.agents[0]?.settings.models).toEqual([
      "chatgpt/__unresolved__",
    ]);
  });

  test("#3: mixed — a model-less provider (sentinel) alongside a concrete one", () => {
    const mixed = defineAgent({
      id: "mixed",
      providers: [
        { id: "chatgpt", key: secret("ANTHROPIC_API_KEY") },
        { id: "openai", model: "gpt-5", key: secret("ANTHROPIC_API_KEY") },
      ],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ org: "o", agents: [mixed] }),
      env
    );
    expect(state.agents[0]?.settings.models).toEqual([
      "chatgpt/__unresolved__",
      "openai/gpt-5",
    ]);
  });

  test("#5: a provider with NO id is a config error (never emits '/__unresolved__')", () => {
    const bad = defineAgent({
      id: "bad",
      // A provider entry with no id is meaningless — must throw at map time,
      // not silently emit a bogus "/__unresolved__" ref the server rejects.
      providers: [{} as any],
    });
    expect(() =>
      mapProjectToDesiredState(defineConfig({ org: "o", agents: [bad] }), env)
    ).toThrow(/provider with no "id"/);
  });

  test("rejects duplicate slugs across declarative collections (config parity)", () => {
    const a = defineAgent({ id: "a" });
    const e1 = defineEntityType({ key: "company", name: "C1" });
    const e2 = defineEntityType({ key: "company", name: "C2" });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ org: "o", agents: [a], entities: [e1, e2] }),
        env
      )
    ).toThrow(/duplicate entity type key "company"/i);

    const c1 = defineConnection({ slug: "gh", connector: "github" });
    const c2 = defineConnection({ slug: "gh", connector: "github" });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ org: "o", agents: [a], connections: [c1, c2] }),
        env
      )
    ).toThrow(/duplicate connection slug "gh"/i);

    const w1 = defineAutomation({
      slug: "w",
      agent: a,
      skills: ["s"],
    });
    const w2 = defineAutomation({
      slug: "w",
      agent: a,
      skills: ["s"],
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ org: "o", agents: [a], automations: [w1, w2] }),
        env
      )
    ).toThrow(/duplicate Automation slug "w"/i);
  });

  test("maps entities + relationships with typed-handle slugs", () => {
    const person = defineEntityType({ key: "person", name: "Person" });
    const org = defineEntityType({ key: "org" });
    const worksAt = defineRelationshipType({
      key: "works_at",
      rules: [{ source: person, target: org }],
    });
    const state = mapProjectToDesiredState(
      defineConfig({
        agents: [],
        entities: [person, org],
        relationships: [worksAt],
      })
    );
    expect(state.memorySchema.entityTypes.map((e) => e.slug)).toEqual([
      "person",
      "org",
    ]);
    expect(state.memorySchema.relationshipTypes[0]?.rules).toEqual([
      { source: "person", target: "org" },
    ]);
  });

  test("maps normalized and system entity-type references to stored slugs", () => {
    const agent = defineAgent({ id: "inventory" });
    const movement = defineEntityType({ key: "stock_movement" });
    const tracks = defineRelationshipType({
      key: "tracks",
      rules: [{ source: movement, target: "$member" }],
    });
    const automation = defineAutomation({
      agent,
      slug: "record-movement",
      skills: ["inventory"],
      outputs: { movements: { entity: movement, key: ["sku"] } },
      triggers: [
        {
          kind: "event",
          source: "workspace",
          entity_type: "stock_movement",
          event_types: ["movement-recorded"],
        },
      ],
    });

    const state = mapProjectToDesiredState(
      defineConfig({
        agents: [agent],
        entities: [movement],
        relationships: [tracks],
        automations: [automation],
      })
    );

    expect(state.memorySchema.entityTypes[0]?.slug).toBe("stock-movement");
    expect(state.memorySchema.relationshipTypes[0]?.rules).toEqual([
      { source: "stock-movement", target: "$member" },
    ]);
    expect(state.automations[0]?.outputs).toEqual({
      movements: { entity: "stock-movement", key: ["sku"] },
    });
    expect(state.automations[0]?.triggers[0]).toMatchObject({
      entity_type: "stock-movement",
    });
  });

  test("preserves explicit null outputs so apply can clear an Automation", () => {
    const agent = defineAgent({ id: "radar" });
    const automation = defineAutomation({
      agent,
      slug: "social-radar",
      prompt: "Rank social posts.",
      outputs: null,
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [agent], automations: [automation] })
    );

    expect(state.automations[0]?.outputs).toBeNull();
  });

  test("BYO chat connection carries credentialMode + resolves secret config", () => {
    const slack = defineConnection({
      slug: "team-slack",
      connector: "slack",
      credentialMode: "byo",
      config: {
        botToken: secret("SLACK_BOT_TOKEN"),
        reconnect: true,
      },
    });
    const state = mapProjectToDesiredState(
      defineConfig({ org: "o", agents: [], connections: [slack] }),
      { ...env, SLACK_BOT_TOKEN: "xoxb-real-token" }
    );
    const conn = state.connectors.connections.find(
      (c) => c.slug === "team-slack"
    );
    // BYO chat connection must be persisted as a chat connection: it needs a
    // non-null credential_mode (the gateway only treats non-null rows as chat)
    // and its secret() config resolved to the real token (not the SecretRef).
    expect(conn).toBeDefined();
    expect(conn?.credentialMode).toBe("byo");
    expect(conn?.config).toEqual({
      botToken: "xoxb-real-token",
      reconnect: true,
    });
    // the secret ref is collected so the apply secrets gate fails loud if unset
    expect(state.requiredSecrets).toContain("SLACK_BOT_TOKEN");
  });

  test("rejects BYO chat fields the chat upsert cannot apply", () => {
    const auth = defineAuthProfile({
      slug: "slack-auth",
      connector: "slack",
      authKind: "env",
    });
    const cases = [
      { authProfile: auth },
      { appAuthProfile: auth },
      { deviceWorkerId: "00000000-0000-0000-0000-000000000001" },
      { feeds: [{ feed: "channels" }] },
    ];

    for (const unsupported of cases) {
      expect(() =>
        mapProjectToDesiredState(
          defineConfig({
            org: "o",
            agents: [],
            authProfiles: [auth],
            connections: [
              defineConnection({
                slug: "team-slack",
                connector: "slack",
                credentialMode: "byo",
                config: { botToken: "xoxb-test" },
                ...unsupported,
              }),
            ],
          }),
          env
        )
      ).toThrow(/BYO chat connection.*cannot declare/);
    }
  });

  test("hosted chat connection is filtered out of apply (never persisted)", () => {
    const slack = defineConnection({
      slug: "team-slack",
      connector: "slack",
      credentialMode: "hosted",
      surfaces: ["dm", "channel"],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ org: "o", agents: [], connections: [slack] }),
      env
    );
    // hosted bots are reached via /lobu link, never a persisted connection row
    expect(
      state.connectors.connections.find((c) => c.slug === "team-slack")
    ).toBeUndefined();
  });

  test("rejects hosted chat fields that would be silently ignored", () => {
    const cases = [
      { authProfile: "slack-auth" },
      { appAuthProfile: "slack-app" },
      { deviceWorkerId: "00000000-0000-0000-0000-000000000001" },
      { feeds: [{ feed: "channels" }] },
    ];

    for (const unsupported of cases) {
      expect(() =>
        mapProjectToDesiredState(
          defineConfig({
            org: "o",
            agents: [],
            connections: [
              defineConnection({
                slug: "team-slack",
                connector: "slack",
                credentialMode: "hosted",
                ...unsupported,
              }),
            ],
          }),
          env
        )
      ).toThrow(/hosted chat connection.*cannot declare/);
    }
  });

  test("rejects hosted mode for a connector without hosted-bot support", () => {
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({
          org: "o",
          agents: [],
          connections: [
            defineConnection({
              slug: "hosted-github",
              connector: "github",
              credentialMode: "hosted",
            }),
          ],
        }),
        env
      )
    ).toThrow(/is not a chat platform/);
  });

  test("accepts a hosted connection on ANY chat platform", () => {
    // The client's job is only to reject a non-chat connector. Whether Lobu runs
    // a hosted bot for a given chat platform depends on the deployment, which
    // the server answers when the link code is minted. Checking it here used to
    // reject Google Chat outright with "expected slack or telegram".
    for (const connector of ["gchat", "discord", "teams", "whatsapp"]) {
      expect(() =>
        mapProjectToDesiredState(
          defineConfig({
            org: "o",
            agents: [],
            connections: [
              defineConnection({
                slug: `hosted-${connector}`,
                connector,
                credentialMode: "hosted",
              }),
            ],
          }),
          env
        )
      ).not.toThrow();
    }
  });

  test("rejects contradictory chat credential modes", () => {
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({
          org: "o",
          agents: [],
          connections: [
            defineConnection({
              slug: "managed-slack",
              connector: "slack",
              credentialMode: "byo",
              managedBy: { org: "cloud" },
            }),
          ],
        }),
        env
      )
    ).toThrow(/cannot combine credentialMode "byo" with managedBy/);
  });

  test("maps a derived entity's backing ({ sql }); stored entities carry none", () => {
    const subscription = defineEntityType({
      key: "subscription",
      name: "Subscription",
      backing: {
        sql: "SELECT company_id, SUM(amount) AS spend FROM revolut GROUP BY company_id",
      },
    });
    const company = defineEntityType({ key: "company", name: "Company" });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [], entities: [subscription, company] })
    );
    const byKey = Object.fromEntries(
      state.memorySchema.entityTypes.map((e) => [e.slug, e])
    );
    expect(byKey.subscription?.backing).toEqual({
      sql: "SELECT company_id, SUM(amount) AS spend FROM revolut GROUP BY company_id",
    });
    // stored (default) entities never carry backing — keeps the diff churn-free
    expect(byKey.company?.backing).toBeUndefined();
  });

  test("maps a declared entity's metrics; non-metric entities carry none", () => {
    const company = defineEntityType({
      key: "company",
      name: "Company",
      properties: { aliases: { type: "array" } },
      eventSets: {
        charges: {
          by: "alias",
          field: "metadata->>'description'",
          against: "aliases",
          where: "semantic_type='transaction'",
          dedupeKey: ["metadata->>'date'", "metadata->>'amount'"],
        },
      },
      segments: {
        outflow: {
          description: "Money out.",
          where: "metadata->>'direction'='out'",
          on: "event",
          appliedBefore: "dedupe",
        },
      },
      measures: {
        spend: {
          eventSet: "charges",
          agg: "sum",
          expr: "(metadata->>'amount')::numeric",
          segments: ["outflow"],
          description: "Total outflow.",
        },
      },
      dimensions: {
        currency: { expr: "metadata->>'currency'", description: "Currency." },
      },
    });
    const person = defineEntityType({ key: "person", name: "Person" });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [], entities: [company, person] })
    );
    const byKey = Object.fromEntries(
      state.memorySchema.entityTypes.map((e) => [e.slug, e])
    );
    // The four metric fields round-trip verbatim under `metrics`.
    expect(byKey.company?.metrics?.measures?.spend?.agg).toBe("sum");
    expect(byKey.company?.metrics?.eventSets?.charges?.by).toBe("alias");
    expect(byKey.company?.metrics?.segments?.outflow?.on).toBe("event");
    expect(byKey.company?.metrics?.dimensions?.currency?.expr).toBe(
      "metadata->>'currency'"
    );
    // A non-metric entity carries no `metrics` — keeps the diff churn-free.
    expect(byKey.person?.metrics).toBeUndefined();
  });

  test("lowers a declared resolution policy to the raw x-lobu-resolution key; absent stays undefined", () => {
    const person = defineEntityType({
      key: "person",
      name: "Person",
      resolutionPolicy: {
        rules: [
          { fields: ["email"], normalizer: "email", onMatch: "auto_merge" },
          { fields: ["phone"], normalizer: "phone", onMatch: "review" },
        ],
      },
    });
    const company = defineEntityType({ key: "company", name: "Company" });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [], entities: [person, company] })
    );
    const byKey = Object.fromEntries(
      state.memorySchema.entityTypes.map((e) => [e.slug, e])
    );
    expect(byKey.person?.resolutionPolicy).toEqual({
      "x-lobu-resolution": {
        rules: [
          { fields: ["email"], normalizer: "email", onMatch: "auto_merge" },
          { fields: ["phone"], normalizer: "phone", onMatch: "review" },
        ],
      },
    });
    // A type without a policy carries none — keeps the diff churn-free.
    expect(byKey.company?.resolutionPolicy).toBeUndefined();
  });

  test("rejects malformed resolutionPolicy rules at load time", () => {
    const bad = defineEntityType({
      key: "person",
      name: "Person",
      resolutionPolicy: {
        rules: [
          {
            fields: [],
            normalizer: "email",
            onMatch: "auto_merge",
          },
        ],
      },
    });
    expect(() =>
      mapProjectToDesiredState(defineConfig({ agents: [], entities: [bad] }))
    ).toThrow(/invalid resolutionPolicy/i);
  });

  test("rejects a resolutionPolicy without a rules array", () => {
    const bad = defineEntityType({
      key: "person",
      name: "Person",
      resolutionPolicy: {} as never,
    });
    expect(() =>
      mapProjectToDesiredState(defineConfig({ agents: [], entities: [bad] }))
    ).toThrow(/expected rules to be an array/i);
  });

  test("rejects invalid metrics at load time (measure naming a missing eventSet)", () => {
    const bad = defineEntityType({
      key: "company",
      name: "Company",
      measures: {
        spend: {
          eventSet: "charges", // not declared
          agg: "sum",
          expr: "x",
          description: "Spend.",
        },
      },
    });
    expect(() =>
      mapProjectToDesiredState(defineConfig({ agents: [], entities: [bad] }))
    ).toThrow(/invalid metrics.*eventSet "charges"/i);
  });

  test("rejects an empty backing.sql at load time (before any remote mutation)", () => {
    const bad = defineEntityType({
      key: "bad",
      name: "Bad",
      backing: { sql: "   " },
    });
    expect(() =>
      mapProjectToDesiredState(defineConfig({ agents: [], entities: [bad] }))
    ).toThrow(/empty backing\.sql/i);
  });

  test("carries prune into DesiredState (defaults false when unset)", () => {
    expect(mapProjectToDesiredState(defineConfig({ agents: [] })).prune).toBe(
      false
    );
    expect(
      mapProjectToDesiredState(defineConfig({ agents: [], prune: true })).prune
    ).toBe(true);
    expect(
      mapProjectToDesiredState(defineConfig({ agents: [], prune: false })).prune
    ).toBe(false);
  });

  test("maps automations: agent handle, sources record, notification", () => {
    const crm = defineAgent({ id: "crm" });
    const github = defineConnection({
      slug: "github-main",
      connector: "github",
    });
    const automation = defineAutomation({
      agent: crm,
      slug: "health",
      skills: ["s"],
      sources: {
        accounts: "SELECT 1",
        ctx: { query: "SELECT 2", context: true },
      },
      minCooldownSeconds: 1800,
      triggers: [
        {
          kind: "event",
          connector_key: "github",
          connection: github,
          event_types: ["pull_request.opened"],
        },
        { kind: "schedule", cron: "0 */12 * * *" },
      ],
    });
    const state = mapProjectToDesiredState(
      defineConfig({
        agents: [crm],
        automations: [automation],
        connections: [github],
      })
    );
    const dw = state.automations[0];
    expect(dw?.agent).toBe("crm");
    expect(dw?.sources).toEqual([
      { name: "accounts", query: "SELECT 1" },
      { name: "ctx", query: "SELECT 2", context: true },
    ]);
    expect(dw?.minCooldownSeconds).toBe(1800);
    expect(dw?.triggers?.[1]).toEqual({
      kind: "schedule",
      cron: "0 */12 * * *",
      timezone: null,
      execution: "window",
      active_run: "coalesce",
      skip_if_unchanged: true,
    });
    expect(dw?.triggers?.[0]).toMatchObject({
      kind: "event",
      source: "connector",
      connector_key: "github",
      connectionSlug: "github-main",
      execution: "turn",
      active_run: "queue",
      output: "silent",
      skip_if_unchanged: true,
    });

    resolveAutomationConnectionRefs(
      state.automations,
      new Map([["github-main", 91]]),
      true
    );
    expect(state.automations[0]?.triggers?.[0]).toMatchObject({
      source: "connector",
      connector_key: "github",
      connection_id: 91,
    });
    expect(state.automations[0]?.triggers?.[0]).not.toHaveProperty(
      "connectionSlug"
    );
  });

  test("rejects missing and connector-mismatched Automation connections", () => {
    const crm = defineAgent({ id: "crm" });
    const slack = defineConnection({ slug: "chat", connector: "slack" });
    const automation = (connection: string) =>
      defineAutomation({
        agent: crm,
        slug: "review-pr",
        triggers: [
          {
            kind: "event",
            connector_key: "github",
            connection,
            event_types: ["pull_request.created"],
            execution: "turn",
            active_run: "queue",
            output: "silent",
          },
        ],
      });

    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [crm], automations: [automation("missing")] })
      )
    ).toThrow(/connection "missing".*not declared/i);
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({
          agents: [crm],
          connections: [slack],
          automations: [automation("chat")],
        })
      )
    ).toThrow(/trigger is github.*uses slack/i);
  });

  test("maps workspace event triggers without connector fields", () => {
    const crm = defineAgent({ id: "crm" });
    const automation = defineAutomation({
      agent: crm,
      slug: "risk-follow-up",
      prompt: "Investigate the account risk.",
      triggers: [
        {
          kind: "event",
          source: "workspace",
          entity_type: "account",
          event_types: ["risk_detected", "risk_detected"],
          match: { severity: "high" },
        },
      ],
    });

    const state = mapProjectToDesiredState(
      defineConfig({ agents: [crm], automations: [automation] })
    );
    expect(state.automations[0]?.triggers).toEqual([
      {
        kind: "event",
        source: "workspace",
        entity_type: "account",
        event_types: ["risk_detected"],
        match: { severity: "high" },
        execution: "window",
        active_run: "coalesce",
      },
    ]);
  });

  test("rejects an Automation trigger with both connection forms", () => {
    const crm = defineAgent({ id: "crm" });
    const github = defineConnection({
      slug: "github-main",
      connector: "github",
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({
          agents: [crm],
          connections: [github],
          automations: [
            defineAutomation({
              agent: crm,
              slug: "review-pr",
              triggers: [
                {
                  kind: "event",
                  connector_key: "github",
                  connection: github,
                  connection_id: 12,
                  event_types: ["pull_request.created"],
                  execution: "turn",
                  active_run: "queue",
                  output: "silent",
                },
              ],
            }),
          ],
        })
      )
    ).toThrow(/either connection or connection_id/i);
  });

  test("maps automation reactionsGuidance + agentKind", () => {
    const crm = defineAgent({ id: "crm" });
    const automation = defineAutomation({
      agent: crm,
      slug: "w",
      skills: ["s"],
      reactionsGuidance: "Notify the account owner.",
      agentKind: "notifier",
    });
    const dw = mapProjectToDesiredState(
      defineConfig({ agents: [crm], automations: [automation] })
    ).automations[0];
    expect(dw?.reactionsGuidance).toBe("Notify the account owner.");
    expect(dw?.agentKind).toBe("notifier");
  });

  test("maps automation deviceWorkerId + model for device-pinned runs", () => {
    const crm = defineAgent({ id: "crm" });
    const automation = defineAutomation({
      agent: crm,
      slug: "w",
      prompt: "do the thing",
      deviceWorkerId: "11111111-1111-1111-1111-111111111111",
      agentKind: "opencode",
      model: "opencode-go/deepseek-v4-flash",
    });
    const dw = mapProjectToDesiredState(
      defineConfig({ agents: [crm], automations: [automation] })
    ).automations[0];
    expect(dw?.deviceWorkerId).toBe("11111111-1111-1111-1111-111111111111");
    expect(dw?.agentKind).toBe("opencode");
    expect(dw?.model).toBe("opencode-go/deepseek-v4-flash");
  });

  test("maps entity handles and event outputs to the server contract", () => {
    const crm = defineAgent({ id: "crm" });
    const price = defineEntityType({ key: "price" });
    const automation = defineAutomation({
      agent: crm,
      slug: "pricing",
      skills: ["s"],
      outputs: {
        prices: { entity: price, key: ["sku"] },
        alerts: { event: "price_changed" },
      },
    });
    const dw = mapProjectToDesiredState(
      defineConfig({
        agents: [crm],
        entities: [price],
        automations: [automation],
      })
    ).automations[0];
    expect(dw?.outputs).toEqual({
      prices: { entity: "price", key: ["sku"] },
      alerts: { event: "price_changed" },
    });
  });

  test("rejects declared outputs on conversational turn triggers", () => {
    const crm = defineAgent({ id: "crm" });
    const automation = defineAutomation({
      agent: crm,
      slug: "reply-and-persist",
      outputs: { alerts: { event: "observation" } },
      triggers: [
        {
          kind: "event",
          connector_key: "slack",
          event_types: ["message.created"],
          execution: "turn",
        },
      ],
    });

    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [crm], automations: [automation] })
      )
    ).toThrow(/outputs require execution "window"/i);
  });

  test("throws when an automation names an unknown agent", () => {
    const automation = defineAutomation({
      agent: "ghost",
      slug: "x",
      skills: ["s"],
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [], automations: [automation] })
      )
    ).toThrow(/ghost/);
  });

  test("maps connections + auth profiles; resolves connector class + secret creds", () => {
    const github = defineConnector({
      key: "github",
      name: "GitHub",
      version: "1.0.0",
      feeds: {
        stars: {
          name: "Stars",
          sync: async (ctx) => {
            await ctx.commit([], null);
            return { status: "complete" };
          },
        },
      },
    });
    const auth = defineAuthProfile({
      slug: "gh-app",
      connector: github,
      authKind: "oauth_app",
      credentials: { clientSecret: secret("GH_SECRET") },
    });
    const conn = defineConnection({
      slug: "gh",
      connector: github,
      authProfile: auth,
      feeds: [{ feed: "stars", schedule: "0 */6 * * *" }],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [], authProfiles: [auth], connections: [conn] }),
      env
    );
    const ap = state.connectors.authProfiles[0];
    expect(ap?.connector).toBe("github"); // class resolved to its key
    expect(ap?.kind).toBe("oauth_app");
    // Non-interactive auth-profile creds resolve to the REAL env value (apply
    // pushes the value to the DB), matching the TOML loader — not the $VAR.
    expect(ap?.credentials).toEqual({ clientSecret: "ghs_test" });
    expect(state.requiredSecrets).toContain("GH_SECRET");
    const dc = state.connectors.connections[0];
    expect(dc?.connector).toBe("github");
    expect(dc?.authProfileSlug).toBe("gh-app");
    expect(dc?.feeds).toEqual([{ feedKey: "stars", schedule: "0 */6 * * *" }]);
  });

  test("folds `managedBy` (exact grant — no url) into the connection config", () => {
    const conn = defineConnection({
      slug: "gh-managed",
      connector: "github",
      config: { existing: true },
      managedBy: { org: "lobu-managed", connectionSlug: "github-burak" },
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [], connections: [conn] })
    );
    const dc = state.connectors.connections[0];
    // No connection-supplied URL: a connection can never redirect where the
    // cloud PAT is sent (it always targets the instance's LOBU_CLOUD_URL).
    expect(dc?.config).toEqual({
      existing: true,
      managedBy: { org: "lobu-managed", connectionSlug: "github-burak" },
    });
  });

  test("a managedBy connection KEEPS its feeds (local data syncs)", () => {
    // Stage 5: the LOCAL managedBy connection is NOT consent-only, so it keeps
    // its feeds — `lobu apply` creates them locally and the connection syncs.
    const conn = defineConnection({
      slug: "gh-managed-feeds",
      connector: "github",
      managedBy: { org: "lobu-managed" },
      feeds: [{ feed: "stars", schedule: "0 */6 * * *" }],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [], connections: [conn] })
    );
    const dc = state.connectors.connections[0];
    expect(dc?.config).toEqual({ managedBy: { org: "lobu-managed" } });
    // consent_only is NOT set — the local managed connection can have feeds.
    expect(dc?.config?.consent_only).toBeUndefined();
    expect(dc?.feeds).toEqual([{ feedKey: "stars", schedule: "0 */6 * * *" }]);
  });

  test("a connection without `managedBy` carries no managedBy in config", () => {
    const conn = defineConnection({
      slug: "gh-plain",
      connector: "github",
      config: { existing: true },
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [], connections: [conn] })
    );
    const dc = state.connectors.connections[0];
    expect(dc?.config).toEqual({ existing: true });
    expect(dc?.config?.managedBy).toBeUndefined();
  });

  test("rejects an invalid connection slug", () => {
    const conn = defineConnection({ slug: "Bad_Slug", connector: "github" });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [], connections: [conn] })
      )
    ).toThrow(/connection slug/);
  });

  // Three states, not two. Omitting `schedule` means "this config does not
  // manage the cadence" — apply must leave whatever the feed already has. Only
  // an explicit `null` clears it. Collapsing omitted to null made every apply
  // silently wipe crons set in the UI, and a DB-side backfill could never
  // survive the next run.
  //
  // Measured in prod from the config audit trail (`events` rows with
  // metadata.category='config', resource_kind='feed', changed_fields ?
  // 'schedule', actor_source='cli'): 41 feed-schedule writes across 2026-08-11
  // and 2026-08-12, and the 08-11 batch of 23 all carry ONE apply_id — a single
  // `lobu apply` rewrote 23 feeds' cadence in one run. 29 of the 31 feeds that
  // batch touched are still manual-only today.
  test("an omitted feed schedule is left undeclared, not collapsed to null", () => {
    const conn = defineConnection({
      slug: "gh",
      connector: "github",
      feeds: [{ feed: "stars" }],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [], connections: [conn] })
    );
    const feed = state.connectors.connections[0]?.feeds[0];
    expect(feed).toEqual({ feedKey: "stars" });
    expect("schedule" in (feed ?? {})).toBe(false);
  });

  // `schedule: process.env.FEED_CRON` with the var unset is the same bug
  // through a different door: the key is present but the value is undefined,
  // which is a config that declared nothing, not a clear.
  test("an undefined schedule value is undeclared, not a clear", () => {
    const conn = defineConnection({
      slug: "gh",
      connector: "github",
      feeds: [{ feed: "stars", schedule: undefined }],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [], connections: [conn] })
    );
    const feed = state.connectors.connections[0]?.feeds[0];
    expect("schedule" in (feed ?? {})).toBe(false);
  });

  test("an explicit null schedule stays expressible as a deliberate clear", () => {
    const conn = defineConnection({
      slug: "gh",
      connector: "github",
      feeds: [{ feed: "stars", schedule: null }],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [], connections: [conn] })
    );
    expect(state.connectors.connections[0]?.feeds).toEqual([
      { feedKey: "stars", schedule: null },
    ]);
  });

  // Same class as schedule: an omitted `config` must not wipe the remote one.
  test("an omitted feed config is left undeclared", () => {
    const conn = defineConnection({
      slug: "gh",
      connector: "github",
      feeds: [{ feed: "stars" }],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [], connections: [conn] })
    );
    expect("config" in (state.connectors.connections[0]?.feeds[0] ?? {})).toBe(
      false
    );
  });

  test("rejects an invalid cron schedule", () => {
    const crm = defineAgent({ id: "crm" });
    const automation = defineAutomation({
      agent: crm,
      slug: "w",
      skills: ["s"],
      triggers: [{ kind: "schedule", cron: "not-a-cron" }],
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [crm], automations: [automation] })
      )
    ).toThrow(/invalid schedule/);
  });

  test("rejects a sub-minute cron schedule (parity with TOML/server)", () => {
    const crm = defineAgent({ id: "crm" });
    const automation = defineAutomation({
      agent: crm,
      slug: "w",
      skills: ["s"],
      triggers: [{ kind: "schedule", cron: "*/30 * * * * *" }],
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [crm], automations: [automation] })
      )
    ).toThrow(/too frequent/);
  });

  test("rejects multiple schedule triggers before apply", () => {
    const crm = defineAgent({ id: "crm" });
    const automation = defineAutomation({
      agent: crm,
      slug: "w",
      skills: ["s"],
      triggers: [
        { kind: "schedule", cron: "0 8 * * *" },
        { kind: "schedule", cron: "0 9 * * *" },
      ],
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [crm], automations: [automation] })
      )
    ).toThrow(/more than one schedule trigger/i);
  });

  test("requires prompt, >=1 skill, or a reaction script for schedule, window-event, and manual Automations", () => {
    const crm = defineAgent({ id: "crm" });
    const map = (automation: ReturnType<typeof defineAutomation>) => () =>
      mapProjectToDesiredState(
        defineConfig({ agents: [crm], automations: [automation] })
      );
    // Schedule trigger, no skills → rejected.
    expect(
      map(
        defineAutomation({
          agent: crm,
          slug: "sched",
          triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
        })
      )
    ).toThrow(/needs instructions/i);
    // Event trigger with execution "window", no skills → rejected.
    expect(
      map(
        defineAutomation({
          agent: crm,
          slug: "win",
          triggers: [
            {
              kind: "event",
              connector_key: "github",
              event_types: ["pull_request.created"],
              execution: "window",
            },
          ],
        })
      )
    ).toThrow(/needs instructions/i);
    // Workspace events default to window execution even when execution is
    // omitted, so the same instruction requirement applies.
    expect(
      map(
        defineAutomation({
          agent: crm,
          slug: "workspace-default-window",
          triggers: [
            {
              kind: "event",
              source: "workspace",
              event_types: ["risk_detected"],
            },
          ],
        })
      )
    ).toThrow(/needs instructions/i);
    // No triggers (manual-only), no skills → rejected.
    expect(map(defineAutomation({ agent: crm, slug: "manual" }))).toThrow(
      /needs instructions/i
    );
    // EITHER source satisfies the rule on its own: a prompt with no skills is a
    // valid schedule Automation, and demanding both would reject configs the
    // server accepts.
    expect(
      map(
        defineAutomation({
          agent: crm,
          slug: "prompt-only",
          prompt: "Summarise yesterday's signups.",
          triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
        })
      )
    ).not.toThrow();
    // A reaction script is the third instruction source: a schedule Automation
    // with a reaction and no prompt/skills is valid (the loader resolves the
    // file; the server enforces the final rule on its source).
    expect(
      map(
        defineAutomation({
          agent: crm,
          slug: "reaction-only",
          reaction: reactionFromFile("./reactions/dedupe.reaction.ts"),
          triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
        })
      )
    ).not.toThrow();
  });

  test("event-turn Automations may omit skills; mapper carries skills + empty prompt", () => {
    const crm = defineAgent({ id: "crm" });
    const listen = defineAutomation({
      agent: crm,
      slug: "listen",
      triggers: [
        {
          kind: "event",
          connector_key: "slack",
          event_types: ["message.created"],
          // execution omitted → defaults to "turn"
        },
      ],
    });
    const packs = defineAutomation({
      agent: crm,
      slug: "packs",
      skills: ["triage", "sql-style"],
      triggers: [
        {
          kind: "event",
          connector_key: "slack",
          event_types: ["message.created"],
          execution: "turn",
        },
      ],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [crm], automations: [listen, packs] })
    );
    // The mapper cannot read skill files — the loader resolves their snapshots.
    expect(state.automations[0]?.prompt).toBe("");
    expect(state.automations[0]?.skills).toBeUndefined();
    expect(state.automations[1]?.skills).toEqual(["triage", "sql-style"]);
  });

  test("rejects duplicate and over-cap Automation skills", () => {
    const crm = defineAgent({ id: "crm" });
    const map = (skills: string[]) => () =>
      mapProjectToDesiredState(
        defineConfig({
          agents: [crm],
          automations: [defineAutomation({ agent: crm, slug: "w", skills })],
        })
      );
    expect(map(["a", "b", "a"])).toThrow(/duplicate skill/i);
    expect(map(["a", "b", "c", "d", "e", "f"])).toThrow(/maximum is 5/i);
  });

  test("rejects credentials on an interactive auth profile", () => {
    const auth = defineAuthProfile({
      slug: "gh-acct",
      connector: "github",
      authKind: "oauth_account",
      credentials: { token: secret("X") },
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [], authProfiles: [auth] })
      )
    ).toThrow(/credentials must not be set/);
  });

  test("rejects duplicate feed keys in a connection", () => {
    const conn = defineConnection({
      slug: "gh",
      connector: "github",
      feeds: [{ feed: "stars" }, { feed: "stars" }],
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [], connections: [conn] })
      )
    ).toThrow(/more than once/);
  });

  test("--only skips connectors and their secrets", () => {
    const auth = defineAuthProfile({
      slug: "gh-app",
      connector: "github",
      authKind: "oauth_app",
      credentials: { clientSecret: secret("GH_SECRET") },
    });
    const conn = defineConnection({
      slug: "gh",
      connector: "github",
      authProfile: auth,
    });
    const state = mapProjectToDesiredState(
      defineConfig({
        agents: [defineAgent({ id: "crm" })],
        authProfiles: [auth],
        connections: [conn],
      }),
      env,
      "agents"
    );
    expect(state.connectors.authProfiles).toEqual([]);
    expect(state.connectors.connections).toEqual([]);
    expect(state.requiredSecrets).not.toContain("GH_SECRET");
    expect(state.agents).toHaveLength(1);
  });

  test("--only agents excludes Automations before validating their connections", () => {
    const crm = defineAgent({ id: "crm" });
    const automation = defineAutomation({
      agent: crm,
      slug: "review-pr",
      triggers: [
        {
          kind: "event",
          connector_key: "github",
          connection: "github-main",
          event_types: ["pull_request.created"],
          execution: "turn",
          active_run: "queue",
          output: "silent",
        },
      ],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [crm], automations: [automation] }),
      env,
      "agents"
    );
    expect(state.automations).toEqual([]);
  });

  test("--only memory validates Automation handles without reconciling connections", () => {
    const crm = defineAgent({ id: "crm" });
    const github = defineConnection({
      slug: "github-main",
      connector: "github",
    });
    const automation = defineAutomation({
      agent: crm,
      slug: "review-pr",
      triggers: [
        {
          kind: "event",
          connector_key: "github",
          connection: github,
          event_types: ["pull_request.created"],
          execution: "turn",
          active_run: "queue",
          output: "silent",
        },
      ],
    });
    const state = mapProjectToDesiredState(
      defineConfig({
        agents: [crm],
        automations: [automation],
        connections: [github],
      }),
      env,
      "memory"
    );
    expect(state.automations[0]?.triggers?.[0]).toMatchObject({
      connectionSlug: "github-main",
    });
    expect(state.connectors.connections).toEqual([]);
  });

  test("maps network allow/deny domains", () => {
    const agent = defineAgent({
      id: "ofc",
      network: {
        allowed: ["api.z.ai"],
        denied: ["evil.example.com"],
      },
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [agent] }),
      env
    );
    const net = state.agents[0]?.settings.networkConfig;
    expect(net?.allowedDomains).toEqual(["api.z.ai"]);
    expect(net?.deniedDomains).toEqual(["evil.example.com"]);
  });

  test("maps tools, guardrails, nix packages", () => {
    const agent = defineAgent({
      id: "a",
      tools: {
        preApproved: ["/mcp/gmail/tools/send_email"],
        allowed: ["Bash", "Bash"],
        denied: ["Delete"],
        strict: true,
      },
      guardrails: ["secret-scan", "secret-scan", "pii-scan"],
      nixPackages: ["ffmpeg", "ffmpeg", "python311"],
    });
    const settings = mapProjectToDesiredState(
      defineConfig({ agents: [agent] }),
      env
    ).agents[0]?.settings;
    expect(settings?.preApprovedTools).toEqual(["/mcp/gmail/tools/send_email"]);
    expect(settings?.toolsConfig).toEqual({
      allowedTools: ["Bash"],
      deniedTools: ["Delete"],
      strictMode: true,
    });
    expect(settings?.guardrails).toEqual(["secret-scan", "pii-scan"]);
    expect(settings?.nixConfig).toEqual({ packages: ["ffmpeg", "python311"] });
  });

  test("maps org metadata into memory", () => {
    const state = mapProjectToDesiredState(
      defineConfig({
        org: "lobu-team",
        orgName: "Lobu Team",
        orgDescription: "Office-ops agents",
        organizationId: "org_123",
        agents: [defineAgent({ id: "a" })],
      })
    );
    expect(state.memory).toEqual({
      org: "lobu-team",
      name: "Lobu Team",
      description: "Office-ops agents",
      organizationId: "org_123",
    });
  });

  test("omits absent agent settings (no empty config objects)", () => {
    const settings = mapProjectToDesiredState(
      defineConfig({ agents: [defineAgent({ id: "a" })] }),
      env
    ).agents[0]?.settings;
    expect(settings).not.toHaveProperty("networkConfig");
    expect(settings).not.toHaveProperty("toolsConfig");
    expect(settings).not.toHaveProperty("preApprovedTools");
    expect(settings).not.toHaveProperty("guardrails");
    expect(settings).not.toHaveProperty("nixConfig");
  });

  test("maps org providers: slug/kind/displayName, RESOLVED key, capabilities", () => {
    const providerEnv: NodeJS.ProcessEnv = {
      ...env,
      ACME_VLLM_KEY: "vllm-real-key",
    };
    const state = mapProjectToDesiredState(
      defineConfig({
        agents: [],
        providers: [
          {
            slug: "openai-vllm",
            kind: "openai",
            key: secret("ACME_VLLM_KEY"),
            displayName: "ACME vLLM",
            capabilities: {
              text: {
                base_url: "https://vllm.acme.internal/v1",
                model: "llama-3.3-70b",
                models_endpoint: "/models",
              },
              image: {
                base_url: "https://img.acme.internal/v1",
                model: "sdxl",
              },
            },
          },
        ],
      }),
      providerEnv
    );
    const p = state.providers[0];
    expect(p?.slug).toBe("openai-vllm");
    expect(p?.kind).toBe("openai");
    expect(p?.displayName).toBe("ACME vLLM");
    // secret() resolves to the REAL env value (apply pushes it to the server).
    expect(p?.apiKey).toBe("vllm-real-key");
    expect(p?.capabilities).toEqual({
      text: {
        base_url: "https://vllm.acme.internal/v1",
        model: "llama-3.3-70b",
        models_endpoint: "/models",
      },
      image: { base_url: "https://img.acme.internal/v1", model: "sdxl" },
    });
    // The env-ref is collected so the secrets gate fails loud when unset.
    expect(state.requiredSecrets).toContain("ACME_VLLM_KEY");
  });

  test("resolves a $VAR provider key literal to the env value", () => {
    const state = mapProjectToDesiredState(
      defineConfig({
        agents: [],
        providers: [{ slug: "p", kind: "openai", key: "$ACME_VLLM_KEY" }],
      }),
      { ...env, ACME_VLLM_KEY: "from-var" }
    );
    expect(state.providers[0]?.apiKey).toBe("from-var");
    expect(state.requiredSecrets).toContain("ACME_VLLM_KEY");
  });

  test("omits capabilities/displayName when not declared", () => {
    const state = mapProjectToDesiredState(
      defineConfig({
        agents: [],
        providers: [{ slug: "p", kind: "openai", key: "literal-key" }],
      }),
      env
    );
    const p = state.providers[0];
    expect(p?.apiKey).toBe("literal-key");
    expect(p?.capabilities).toEqual({});
    expect(p).not.toHaveProperty("displayName");
  });

  test("rejects an invalid provider slug", () => {
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({
          agents: [],
          providers: [{ slug: "Bad_Slug", kind: "openai", key: "k" }],
        }),
        env
      )
    ).toThrow(/provider slug/);
  });

  test("rejects a trailing-hyphen slug (DB CHECK parity)", () => {
    // The DB CHECK rejects a trailing hyphen; the CLI regex MUST match so apply
    // fails up front instead of the server 500ing on the constraint.
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({
          agents: [],
          providers: [{ slug: "myvllm-", kind: "openai", key: "k" }],
        }),
        env
      )
    ).toThrow(/provider slug/);
  });

  test("accepts a single-character slug (DB CHECK parity)", () => {
    const state = mapProjectToDesiredState(
      defineConfig({
        agents: [],
        providers: [{ slug: "p", kind: "openai", key: "k" }],
      }),
      env
    );
    expect(state.providers.map((p) => p.slug)).toContain("p");
  });

  test("rejects an unknown modality", () => {
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({
          agents: [],
          providers: [
            {
              slug: "p",
              kind: "openai",
              key: "k",
              capabilities: {
                // @ts-expect-error — exercising the runtime guard for a bad modality
                video: { base_url: "https://x.example/v1" },
              },
            },
          ],
        }),
        env
      )
    ).toThrow(/unknown modality/i);
  });

  test("rejects duplicate provider slugs", () => {
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({
          agents: [],
          providers: [
            { slug: "dup", kind: "openai", key: "a" },
            { slug: "dup", kind: "openai", key: "b" },
          ],
        }),
        env
      )
    ).toThrow(/duplicate provider slug "dup"/i);
  });

  test("skips org providers under --only (no secrets demanded)", () => {
    const state = mapProjectToDesiredState(
      defineConfig({
        agents: [defineAgent({ id: "a" })],
        providers: [
          { slug: "p", kind: "openai", key: secret("ACME_VLLM_KEY") },
        ],
      }),
      env,
      "agents"
    );
    expect(state.providers).toEqual([]);
    expect(state.requiredSecrets).not.toContain("ACME_VLLM_KEY");
  });
});

describe("mergeAgentDirArtifacts", () => {
  test("sets prompt markdown and skillsConfig", () => {
    const settings: Partial<AgentSettings> = {};
    mergeAgentDirArtifacts(
      settings,
      { soulMd: "soul", identityMd: "id", userMd: "user" },
      [{ repo: "local/s", name: "s", content: "body", enabled: true }]
    );
    expect(settings.soulMd).toBe("soul");
    expect(settings.identityMd).toBe("id");
    expect(settings.userMd).toBe("user");
    expect(settings.skillsConfig?.skills).toHaveLength(1);
    expect(settings.skillsConfig?.skills[0]?.name).toBe("s");
  });

  test("preserves agent network and nix when merging skills", () => {
    const settings: Partial<AgentSettings> = {
      networkConfig: {
        allowedDomains: ["agent.com"],
        deniedDomains: ["blocked.com"],
      },
      nixConfig: { packages: ["ffmpeg"] },
    };
    mergeAgentDirArtifacts(settings, {}, [
      {
        repo: "local/s",
        name: "s",
        content: "b",
        enabled: true,
      },
    ]);
    expect(settings.networkConfig?.allowedDomains).toEqual(["agent.com"]);
    expect(settings.networkConfig?.deniedDomains).toEqual(["blocked.com"]);
    expect(settings.nixConfig?.packages).toEqual(["ffmpeg"]);
  });

  test("no markdown / no skills leaves settings untouched", () => {
    const settings: Partial<AgentSettings> = {};
    mergeAgentDirArtifacts(settings, {}, []);
    expect(settings).toEqual({});
  });
});
