/**
 * Tests that focus on diff correctness edge-cases not covered in diff.test.ts:
 *  - Idempotency: applying the same desired state twice produces all-noop on
 *    the second diff (after the first apply's creates have landed remotely).
 *  - `--only` flag: agents-only skips memory types; memory-only skips agents.
 *  - Multi-agent desired state: each agent gets its own diff rows.
 *  - Object-key ordering does NOT affect diff (canonical() sorts keys).
 */

import { describe, expect, test } from "bun:test";
import type { AgentSettings } from "@lobu/core";
import type { DesiredAgent, DesiredState } from "../desired-state.js";
import { computeDiff, type RemoteSnapshot } from "../diff.js";

// ── Builders ─────────────────────────────────────────────────────────────────

function buildAgent(
  agentId: string,
  overrides: Partial<DesiredAgent> = {}
): DesiredAgent {
  return {
    metadata: { agentId, name: agentId },
    settings: {},
    ...overrides,
  };
}

function buildState(
  agents: DesiredAgent[],
  overrides: Partial<DesiredState> = {}
): DesiredState {
  return {
    agents,
    prune: false,
    memorySchema: { entityTypes: [], relationshipTypes: [] },
    automations: [],
    connectors: { definitions: [], authProfiles: [], connections: [] },
    providers: [],
    requiredSecrets: [],
    ...overrides,
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
  };
}

// ── Idempotency ───────────────────────────────────────────────────────────────

describe("computeDiff — idempotency (applying twice is a no-op)", () => {
  test("agent: first plan has creates; second plan with same desired+remote state is all-noop", () => {
    const desired = buildState([
      buildAgent("triage", {
        metadata: { agentId: "triage", name: "Triage", description: "Bot" },
      }),
    ]);

    // First diff: remote is empty → creates.
    const firstPlan = computeDiff(desired, emptyRemote());
    expect(firstPlan.counts.create).toBeGreaterThan(0);
    expect(firstPlan.counts.update).toBe(0);

    // Simulate what remote looks like after apply: agent exists, settings noop.
    const afterFirstApply: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "Triage", description: "Bot" }],
      agentSettings: new Map<string, AgentSettings | null>([["triage", null]]),
    };

    const secondPlan = computeDiff(desired, afterFirstApply);
    // No creates, no updates — only noops (and possibly drift if there were
    // extra remote resources, but there aren't here).
    expect(secondPlan.counts.create).toBe(0);
    expect(secondPlan.counts.update).toBe(0);
    expect(secondPlan.counts.drift).toBe(0);
  });

  test("entity type: same desired+remote is noop", () => {
    const desired = buildState([], {
      memorySchema: {
        entityTypes: [
          {
            slug: "company",
            name: "Company",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
        ],
        relationshipTypes: [],
      },
    });

    const afterFirstApply: RemoteSnapshot = {
      ...emptyRemote(),
      entityTypes: [
        {
          slug: "company",
          name: "Company",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
      ],
    };

    const secondPlan = computeDiff(desired, afterFirstApply);
    expect(secondPlan.counts.create).toBe(0);
    expect(secondPlan.counts.update).toBe(0);
  });

  test("derived entity type: same backing_sql is a noop (no persisted inference)", () => {
    // A derived type stores only backing.sql — measure roles are classified on
    // read, never persisted — so a re-apply is a plain, churn-free noop.
    const sql =
      "SELECT company_id, SUM(amount) AS spend FROM events GROUP BY company_id";
    const desired = buildState([], {
      memorySchema: {
        entityTypes: [
          { slug: "subscription", name: "Subscription", backing: { sql } },
        ],
        relationshipTypes: [],
      },
    });

    const afterFirstApply: RemoteSnapshot = {
      ...emptyRemote(),
      entityTypes: [
        { slug: "subscription", name: "Subscription", backing: { sql } },
      ],
    };

    const plan = computeDiff(desired, afterFirstApply);
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("noop");
    expect(plan.counts.update).toBe(0);
  });

  test("derived entity type: a changed backing_sql is an update", () => {
    const desired = buildState([], {
      memorySchema: {
        entityTypes: [
          {
            slug: "subscription",
            name: "Subscription",
            backing: { sql: "SELECT 2 AS x FROM events" },
          },
        ],
        relationshipTypes: [],
      },
    });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      entityTypes: [
        {
          slug: "subscription",
          name: "Subscription",
          backing: { sql: "SELECT 1 AS x FROM events" },
        },
      ],
    };
    const plan = computeDiff(desired, remote);
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("update");
    if (row?.kind === "entity-type")
      expect(row.changedFields).toContain("backing");
  });

  test("entity type: same declared metrics is a noop (round-trips verbatim)", () => {
    const metrics = {
      eventSets: { charges: { by: "alias" as const, field: "metadata->>'d'" } },
      measures: {
        spend: {
          eventSet: "charges",
          agg: "sum" as const,
          expr: "(metadata->>'a')::numeric",
          description: "Spend.",
        },
      },
    };
    const desired = buildState([], {
      memorySchema: {
        entityTypes: [{ slug: "company", name: "Company", metrics }],
        relationshipTypes: [],
      },
    });
    const afterFirstApply: RemoteSnapshot = {
      ...emptyRemote(),
      // Remote hoists metrics_config verbatim — structurally identical to desired.
      entityTypes: [{ slug: "company", name: "Company", metrics }],
    };
    const plan = computeDiff(desired, afterFirstApply);
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("noop");
    expect(plan.counts.update).toBe(0);
  });

  test("entity type: a changed measure is an update (metrics diffed)", () => {
    const desired = buildState([], {
      memorySchema: {
        entityTypes: [
          {
            slug: "company",
            name: "Company",
            metrics: {
              measures: {
                spend: {
                  eventSet: "charges",
                  agg: "sum",
                  expr: "x",
                  description: "v2",
                },
              },
            },
          },
        ],
        relationshipTypes: [],
      },
    });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      entityTypes: [
        {
          slug: "company",
          name: "Company",
          metrics: {
            measures: {
              spend: { eventSet: "charges", agg: "count", description: "v1" },
            },
          },
        },
      ],
    };
    const plan = computeDiff(desired, remote);
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("update");
    if (row?.kind === "entity-type")
      expect(row.changedFields).toContain("metrics");
  });

  test("entity type: same declared eventKinds is a noop (round-trips verbatim)", () => {
    const eventKinds = {
      valuation: {
        description: "A valuation snapshot",
        metadataSchema: {
          type: "object",
          properties: { amount: { "x-table-column": 1 } },
        },
      },
    };
    const desired = buildState([], {
      memorySchema: {
        entityTypes: [{ slug: "deal", name: "Deal", eventKinds }],
        relationshipTypes: [],
      },
    });
    const afterFirstApply: RemoteSnapshot = {
      ...emptyRemote(),
      // Remote hoists event_kinds verbatim — structurally identical to desired.
      entityTypes: [{ slug: "deal", name: "Deal", eventKinds }],
    };
    const plan = computeDiff(desired, afterFirstApply);
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("noop");
    expect(plan.counts.update).toBe(0);
  });

  test("entity type: a changed eventKind is an update (eventKinds diffed)", () => {
    const desired = buildState([], {
      memorySchema: {
        entityTypes: [
          {
            slug: "deal",
            name: "Deal",
            eventKinds: { note: { description: "v2" } },
          },
        ],
        relationshipTypes: [],
      },
    });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      entityTypes: [
        {
          slug: "deal",
          name: "Deal",
          eventKinds: { note: { description: "v1" } },
        },
      ],
    };
    const plan = computeDiff(desired, remote);
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("update");
    if (row?.kind === "entity-type")
      expect(row.changedFields).toContain("eventKinds");
  });

  test("entity type: omitted eventKinds is unmanaged WITHOUT prune (no churn)", () => {
    const desired = buildState([], {
      memorySchema: {
        entityTypes: [{ slug: "deal", name: "Deal" }],
        relationshipTypes: [],
      },
    });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      // Kinds authored out-of-band (manage_entity_schema / a connector feed)
      // the config doesn't declare — must not be pruned by a partial config.
      entityTypes: [
        {
          slug: "deal",
          name: "Deal",
          eventKinds: { note: { description: "x" } },
        },
      ],
    };
    const plan = computeDiff(desired, remote);
    expect(plan.rows.find((r) => r.kind === "entity-type")?.verb).toBe("noop");
  });

  test("entity type: omitted eventKinds WITH prune clears a present remote set", () => {
    const desired = buildState([], {
      memorySchema: {
        entityTypes: [{ slug: "deal", name: "Deal" }],
        relationshipTypes: [],
      },
    });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      entityTypes: [
        {
          slug: "deal",
          name: "Deal",
          eventKinds: { note: { description: "x" } },
        },
      ],
    };
    const plan = computeDiff(desired, remote, { prune: true });
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("update");
    if (row?.kind === "entity-type")
      expect(row.changedFields).toContain("eventKinds");
  });

  test("entity type: no metrics on either side is a noop (no churn)", () => {
    const desired = buildState([], {
      memorySchema: {
        entityTypes: [{ slug: "person", name: "Person" }],
        relationshipTypes: [],
      },
    });
    const afterFirstApply: RemoteSnapshot = {
      ...emptyRemote(),
      entityTypes: [{ slug: "person", name: "Person" }],
    };
    const plan = computeDiff(desired, afterFirstApply);
    expect(plan.counts.update).toBe(0);
  });

  test("derived entity type: same backing.connection is a noop (external-backed)", () => {
    const sql = "SELECT org, count(*) AS n FROM customers GROUP BY org";
    const desired = buildState([], {
      memorySchema: {
        entityTypes: [
          {
            slug: "ext",
            name: "Ext",
            backing: { sql, connection: "warehouse" },
          },
        ],
        relationshipTypes: [],
      },
    });
    const afterFirstApply: RemoteSnapshot = {
      ...emptyRemote(),
      entityTypes: [
        { slug: "ext", name: "Ext", backing: { sql, connection: "warehouse" } },
      ],
    };
    const plan = computeDiff(desired, afterFirstApply);
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("noop");
    expect(plan.counts.update).toBe(0);
  });

  test("derived entity type: adding backing.connection (internal → external) is an update", () => {
    const sql = "SELECT 1 AS x FROM events";
    const desired = buildState([], {
      memorySchema: {
        entityTypes: [
          {
            slug: "ext",
            name: "Ext",
            backing: { sql, connection: "warehouse" },
          },
        ],
        relationshipTypes: [],
      },
    });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      entityTypes: [{ slug: "ext", name: "Ext", backing: { sql } }],
    };
    const plan = computeDiff(desired, remote);
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("update");
    if (row?.kind === "entity-type")
      expect(row.changedFields).toContain("backing");
  });

  test("relationship type: same desired+remote is noop", () => {
    const desired = buildState([], {
      memorySchema: {
        entityTypes: [],
        relationshipTypes: [
          {
            slug: "works_at",
            name: "Works At",
            rules: [{ source: "person", target: "company" }],
          },
        ],
      },
    });

    const afterFirstApply: RemoteSnapshot = {
      ...emptyRemote(),
      relationshipTypes: [
        {
          slug: "works_at",
          name: "Works At",
          rules: [{ source: "person", target: "company" }],
        },
      ],
    };

    const secondPlan = computeDiff(desired, afterFirstApply);
    expect(secondPlan.counts.create).toBe(0);
    expect(secondPlan.counts.update).toBe(0);
  });
});

// ── --only flag ───────────────────────────────────────────────────────────────

describe("computeDiff — --only flag", () => {
  const agentDesired = buildState(
    [buildAgent("triage", { metadata: { agentId: "triage", name: "Triage" } })],
    {
      memorySchema: {
        entityTypes: [{ slug: "company", name: "Company" }],
        relationshipTypes: [{ slug: "works_at", name: "Works At" }],
      },
    }
  );

  test("only=agents: agent rows included, entity-type and relationship-type rows excluded", () => {
    const plan = computeDiff(agentDesired, emptyRemote(), { only: "agents" });
    expect(plan.rows.some((r) => r.kind === "agent")).toBe(true);
    expect(plan.rows.some((r) => r.kind === "entity-type")).toBe(false);
    expect(plan.rows.some((r) => r.kind === "relationship-type")).toBe(false);
    expect(plan.rows.some((r) => r.kind === "automation")).toBe(false);
  });

  test("only=memory: entity-type rows included, agent rows excluded", () => {
    const plan = computeDiff(agentDesired, emptyRemote(), { only: "memory" });
    expect(plan.rows.some((r) => r.kind === "entity-type")).toBe(true);
    expect(plan.rows.some((r) => r.kind === "relationship-type")).toBe(true);
    expect(plan.rows.some((r) => r.kind === "agent")).toBe(false);
    expect(plan.rows.some((r) => r.kind === "settings")).toBe(false);
  });

  test("only=agents: connector rows excluded too", () => {
    const stateWithConnectors = buildState(
      [
        buildAgent("triage", {
          metadata: { agentId: "triage", name: "Triage" },
        }),
      ],
      {
        connectors: {
          definitions: [
            {
              key: "hackernews",
              sourcePath: "/proj/connectors/hackernews.connector.ts",
              sourceCode: "export default class {}",
              sourceFile: "connectors/hackernews.connector.ts",
            },
          ],
          authProfiles: [],
          connections: [],
        },
      }
    );
    const plan = computeDiff(stateWithConnectors, emptyRemote(), {
      only: "agents",
    });
    expect(plan.rows.some((r) => r.kind === "connector-definition")).toBe(
      false
    );
  });

  test("only=memory: connector rows excluded too", () => {
    const stateWithConnectors = buildState([], {
      memorySchema: {
        entityTypes: [{ slug: "company", name: "Company" }],
        relationshipTypes: [],
      },
      connectors: {
        definitions: [
          {
            key: "hackernews",
            sourcePath: "/proj/connectors/hackernews.connector.ts",
            sourceCode: "export default class {}",
            sourceFile: "connectors/hackernews.connector.ts",
          },
        ],
        authProfiles: [],
        connections: [],
      },
    });
    const plan = computeDiff(stateWithConnectors, emptyRemote(), {
      only: "memory",
    });
    expect(plan.rows.some((r) => r.kind === "connector-definition")).toBe(
      false
    );
  });
});

// ── Multi-agent desired state ─────────────────────────────────────────────────

describe("computeDiff — multiple agents", () => {
  test("each agent gets its own create rows", () => {
    const desired = buildState([buildAgent("alpha"), buildAgent("beta")]);

    const plan = computeDiff(desired, emptyRemote());
    const agentRows = plan.rows.filter((r) => r.kind === "agent");
    expect(agentRows.map((r) => r.id).sort()).toEqual(["alpha", "beta"]);
    // 2 agents + 2 settings = 4 creates minimum
    expect(plan.counts.create).toBeGreaterThanOrEqual(4);
  });

  test("drift for a remote agent not in desired, while another is present", () => {
    // Name must match exactly so the alpha row is noop (not update).
    const desired = buildState([
      buildAgent("alpha", { metadata: { agentId: "alpha", name: "Alpha" } }),
    ]);
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [
        { agentId: "alpha", name: "Alpha" },
        { agentId: "orphan", name: "Orphan" },
      ],
      agentSettings: new Map<string, AgentSettings | null>([["alpha", null]]),
    };

    const plan = computeDiff(desired, remote);
    const driftRow = plan.rows.find(
      (r) => r.kind === "agent" && r.verb === "drift"
    );
    expect(driftRow?.id).toBe("orphan");
    // alpha itself should be noop (names match exactly)
    const alphaRow = plan.rows.find(
      (r) => r.kind === "agent" && r.id === "alpha"
    );
    expect(alphaRow?.verb).toBe("noop");
  });
});

// ── Canonical key-ordering in deepEqual ───────────────────────────────────────

describe("computeDiff — deepEqual is key-order agnostic", () => {
  test("settings with different key ordering produce noop, not update", () => {
    const desired = buildState([
      buildAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
        settings: {
          networkConfig: { allowedDomains: ["a.com", "b.com"] },
        },
      }),
    ]);

    // Same values, different key order in the remote response.
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "Triage" }],
      agentSettings: new Map<string, AgentSettings | null>([
        [
          "triage",
          {
            // Same domains, but in a different object-key order — canonical()
            // must normalise both sides to the same string.
            networkConfig: { allowedDomains: ["a.com", "b.com"] },
            updatedAt: 0,
          },
        ],
      ]),
    };

    const plan = computeDiff(desired, remote);
    const settingsRow = plan.rows.find((r) => r.kind === "settings");
    expect(settingsRow?.verb).toBe("noop");
  });

  test("settings with nested object key-order difference produce noop", () => {
    const desired = buildState([
      buildAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
        settings: {
          toolsConfig: {
            allowedTools: ["bash"],
            deniedTools: ["delete"],
          },
        },
      }),
    ]);

    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "Triage" }],
      agentSettings: new Map<string, AgentSettings | null>([
        [
          "triage",
          {
            // Same values, different object-key order.
            toolsConfig: {
              deniedTools: ["delete"],
              allowedTools: ["bash"],
            },
            updatedAt: 0,
          },
        ],
      ]),
    };

    const plan = computeDiff(desired, remote);
    const settingsRow = plan.rows.find((r) => r.kind === "settings");
    expect(settingsRow?.verb).toBe("noop");
  });
});

// ── Counts aggregate correctly ────────────────────────────────────────────────

describe("computeDiff — counts", () => {
  test("counts exactly match the rows", () => {
    const desired = buildState([buildAgent("triage")], {
      memorySchema: {
        entityTypes: [{ slug: "company" }, { slug: "person" }],
        relationshipTypes: [{ slug: "works_at" }],
      },
    });

    const plan = computeDiff(desired, emptyRemote());
    let expectedCreate = 0;
    for (const row of plan.rows) {
      if (row.verb === "create") expectedCreate++;
    }
    expect(plan.counts.create).toBe(expectedCreate);
    expect(plan.counts.update).toBe(0);
    expect(plan.counts.drift).toBe(0);
  });

  test("counts update rows correctly", () => {
    const desired = buildState([
      buildAgent("triage", {
        metadata: { agentId: "triage", name: "Renamed" },
        settings: { networkConfig: { allowedDomains: ["new.com"] } },
      }),
    ]);

    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "Original" }],
      agentSettings: new Map<string, AgentSettings | null>([
        [
          "triage",
          { networkConfig: { allowedDomains: ["old.com"] }, updatedAt: 0 },
        ],
      ]),
    };

    const plan = computeDiff(desired, remote);
    // agent name changed → update; settings changed → update
    expect(plan.counts.update).toBeGreaterThanOrEqual(2);
    expect(plan.counts.create).toBe(0);
  });
});

// ── Settings: noop when no fields differ ─────────────────────────────────────

describe("computeDiff — settings noop edge cases", () => {
  test("empty desired settings + null remote settings is noop (no churn)", () => {
    // When desired.settings = {} and remote settings is null, the diff
    // should still emit the settings row but as 'create' (agent is new)
    // or 'noop' (agent exists and there are no desired-side fields).
    const desired = buildState([
      buildAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
        settings: {},
      }),
    ]);

    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "Triage" }],
      agentSettings: new Map<string, AgentSettings | null>([["triage", null]]),
    };

    const plan = computeDiff(desired, remote);
    const settingsRow = plan.rows.find((r) => r.kind === "settings");
    // No desired fields to push → noop
    expect(settingsRow?.verb).toBe("noop");
    expect(plan.counts.create).toBe(0);
    expect(plan.counts.update).toBe(0);
  });

  test("soulMd change is detected as a settings update", () => {
    const desired = buildState([
      buildAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
        settings: { soulMd: "You are helpful." },
      }),
    ]);

    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "Triage" }],
      agentSettings: new Map<string, AgentSettings | null>([
        ["triage", { soulMd: "Old soul content.", updatedAt: 0 }],
      ]),
    };

    const plan = computeDiff(desired, remote);
    const settingsRow = plan.rows.find((r) => r.kind === "settings");
    expect(settingsRow?.verb).toBe("update");
    if (settingsRow?.kind === "settings") {
      expect(settingsRow.changedFields).toContain("soulMd");
    }
  });
});
