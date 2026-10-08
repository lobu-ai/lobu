import { describe, expect, test } from "bun:test";
import { defineAgent, defineAutomation, defineConfig } from "@lobu/cli/config";
import type { AgentSettings } from "@lobu/core";
import chalk from "chalk";
import type { DesiredAgent, DesiredState } from "../desired-state.js";
import {
  type Baseline,
  computeDiff,
  type DiffPlan,
  ownedKey,
  type RemoteSnapshot,
} from "../diff.js";
import { mapProjectToDesiredState } from "../map-config.js";
import { renderPlan, renderProgress, renderSummary } from "../render.js";

// Force chalk to render plain text in snapshots regardless of TTY detection.
// `chalk.level = 0` strips colors so snapshot diffs aren't TTY-dependent.
chalk.level = 0;

function buildDesiredAgent(
  agentId: string,
  overrides: Partial<DesiredAgent> = {}
): DesiredAgent {
  return {
    metadata: { agentId, name: agentId, description: undefined },
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

describe("apply diff — agents", () => {
  test("collection config converges, preserves omitted configuration, and supports explicit pruning", () => {
    const collection = {
      presets: [{ key: "large", label: "Large", selection: {} }],
    };
    const remote = {
      ...emptyRemote(),
      entityTypes: [
        { slug: "account", schemaExtras: { "x-lobu-collection": collection } },
      ],
    };
    const state = buildState([], {
      memorySchema: {
        entityTypes: [{ slug: "account", collection }],
        relationshipTypes: [],
      },
    });
    expect(
      computeDiff(state, remote).rows.find((row) => row.id === "account")?.verb
    ).toBe("noop");
    const omitted = buildState([], {
      memorySchema: {
        entityTypes: [{ slug: "account" }],
        relationshipTypes: [],
      },
    });
    expect(
      computeDiff(omitted, remote).rows.find((row) => row.id === "account")
        ?.verb
    ).toBe("noop");
    expect(
      computeDiff(omitted, remote, { prune: true }).rows.find(
        (row) => row.id === "account"
      )?.changedFields
    ).toContain("collection");
  });
  test("create from empty remote", () => {
    const desired = buildState([
      buildDesiredAgent("triage", {
        metadata: {
          agentId: "triage",
          name: "Triage",
          description: "Triage bot",
        },
      }),
    ]);
    const plan = computeDiff(desired, emptyRemote());

    expect(plan.counts).toEqual({
      create: 2,
      update: 0,
      noop: 0,
      drift: 0,
      delete: 0,
    });
    expect(renderPlan(plan)).toMatchSnapshot();
  });

  test("noop when remote matches desired", () => {
    const desired = buildState([
      buildDesiredAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
      }),
    ]);
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "Triage" }],
      agentSettings: new Map([["triage", null]]),
    };
    const plan = computeDiff(desired, remote);
    expect(plan.counts.noop).toBeGreaterThan(0);
    expect(plan.counts.create).toBe(0);
    expect(plan.counts.update).toBe(0);
    expect(renderPlan(plan)).toMatchSnapshot();
  });

  test("update when name differs", () => {
    const desired = buildState([
      buildDesiredAgent("triage", {
        metadata: { agentId: "triage", name: "Renamed" },
      }),
    ]);
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "Original" }],
      agentSettings: new Map([["triage", null]]),
    };
    const plan = computeDiff(desired, remote);
    expect(plan.counts.update).toBeGreaterThan(0);
    expect(renderPlan(plan)).toMatchSnapshot();
  });

  test("drift when remote has agent not in desired", () => {
    const desired = buildState([]);
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "stale", name: "Stale Agent" }],
    };
    const plan = computeDiff(desired, remote);
    expect(plan.counts.drift).toBe(1);
    expect(renderPlan(plan)).toMatchSnapshot();
  });
});

describe("apply diff — settings", () => {
  test("update on networkConfig change", () => {
    const desired = buildState([
      buildDesiredAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
        settings: {
          networkConfig: { allowedDomains: ["github.com"] },
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
            networkConfig: { allowedDomains: ["pypi.org"] },
            updatedAt: 0,
          },
        ],
      ]),
    };
    const plan = computeDiff(desired, remote);
    const settingsRow = plan.rows.find((r) => r.kind === "settings");
    expect(settingsRow?.verb).toBe("update");
    if (settingsRow?.kind === "settings") {
      expect(settingsRow.changedFields).toContain("networkConfig");
    }
    expect(renderPlan(plan)).toMatchSnapshot();
  });

  test("#5: updates when the models list changes; noop when it matches", () => {
    const desired = buildState([
      buildDesiredAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
        settings: {
          models: ["anthropic/claude-sonnet-5", "openai/gpt-5"],
        },
      }),
    ]);
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "Triage" }],
      agentSettings: new Map<string, AgentSettings | null>([
        ["triage", { models: ["anthropic/claude-sonnet-5"], updatedAt: 0 }],
      ]),
    };
    const plan = computeDiff(desired, remote);
    const settingsRow = plan.rows.find((r) => r.kind === "settings");
    expect(settingsRow?.verb).toBe("update");
    if (settingsRow?.kind === "settings") {
      expect(settingsRow.changedFields).toContain("models");
    }

    // Same ordered list ⇒ noop.
    const unchanged = computeDiff(desired, {
      ...remote,
      agentSettings: new Map<string, AgentSettings | null>([
        [
          "triage",
          {
            models: ["anthropic/claude-sonnet-5", "openai/gpt-5"],
            updatedAt: 0,
          },
        ],
      ]),
    });
    const unchangedSettingsRow = unchanged.rows.find(
      (r) => r.kind === "settings"
    );
    expect(unchangedSettingsRow?.verb).toBe("noop");
  });

  test("#5: models is order-sensitive — reordering is a change (index 0 = default)", () => {
    const desired = buildState([
      buildDesiredAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
        settings: { models: ["openai/gpt-5", "anthropic/claude-sonnet-5"] },
      }),
    ]);
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "Triage" }],
      agentSettings: new Map<string, AgentSettings | null>([
        [
          "triage",
          {
            models: ["anthropic/claude-sonnet-5", "openai/gpt-5"],
            updatedAt: 0,
          },
        ],
      ]),
    };
    const settingsRow = computeDiff(desired, remote).rows.find(
      (r) => r.kind === "settings"
    );
    expect(settingsRow?.verb).toBe("update");
    if (settingsRow?.kind === "settings") {
      expect(settingsRow.changedFields).toContain("models");
    }
  });
});

describe("apply diff — memory schema", () => {
  test("detects purpose activation and leaves omitted purpose unmanaged", () => {
    const desired = buildState([], {
      memorySchema: {
        entityTypes: [],
        relationshipTypes: [{ slug: "same_record", purpose: "identity" }],
      },
    });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      relationshipTypes: [{ slug: "same_record" }],
    };
    expect(computeDiff(desired, remote).counts.update).toBe(1);
    remote.relationshipTypes = [{ slug: "same_record", purpose: "identity" }];
    expect(computeDiff(desired, remote).counts.noop).toBe(1);
    desired.memorySchema.relationshipTypes = [{ slug: "same_record" }];
    expect(computeDiff(desired, remote).counts.noop).toBe(1);
  });

  test("creates entity + relationship types", () => {
    const desired: DesiredState = {
      agents: [],
      memorySchema: {
        entityTypes: [{ slug: "company", name: "Company", required: ["name"] }],
        relationshipTypes: [
          {
            slug: "works_at",
            name: "Works At",
            rules: [{ source: "person", target: "company" }],
          },
        ],
      },
      automations: [],
      requiredSecrets: [],
    };
    const plan = computeDiff(desired, emptyRemote());
    expect(plan.counts.create).toBe(2);
    expect(renderPlan(plan)).toMatchSnapshot();
  });

  test("noop when remote matches", () => {
    const desired: DesiredState = {
      agents: [],
      memorySchema: {
        entityTypes: [{ slug: "company", name: "Company" }],
        relationshipTypes: [],
      },
      automations: [],
      requiredSecrets: [],
    };
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      entityTypes: [{ slug: "company", name: "Company" }],
    };
    const plan = computeDiff(desired, remote);
    expect(plan.counts.noop).toBe(1);
    expect(plan.counts.update).toBe(0);
  });

  test("declared resolutionPolicy diffs against the remote x-lobu-resolution", () => {
    const declared = {
      "x-lobu-resolution": {
        rules: [
          { fields: ["email"], normalizer: "email", onMatch: "auto_link" },
        ],
      },
    };
    const desired: DesiredState = {
      agents: [],
      memorySchema: {
        entityTypes: [{ slug: "person", resolutionPolicy: declared }],
        relationshipTypes: [],
      },
      automations: [],
      requiredSecrets: [],
    };

    // Match → noop.
    const match = computeDiff(desired, {
      ...emptyRemote(),
      entityTypes: [{ slug: "person", schemaExtras: declared }],
    });
    expect(match.rows.find((r) => r.id === "person")?.verb).toBe("noop");

    // Differs → update, flagged.
    const mismatch = computeDiff(desired, {
      ...emptyRemote(),
      entityTypes: [
        {
          slug: "person",
          schemaExtras: { "x-lobu-resolution": { rules: [] } },
        },
      ],
    });
    const row = mismatch.rows.find((r) => r.id === "person");
    expect(row?.verb).toBe("update");
    expect(row?.changedFields).toContain("resolutionPolicy");
  });

  test("omitted resolutionPolicy never churns an out-of-band policy", () => {
    const desired: DesiredState = {
      agents: [],
      memorySchema: {
        entityTypes: [{ slug: "person", name: "Person" }],
        relationshipTypes: [],
      },
      automations: [],
      requiredSecrets: [],
    };
    const plan = computeDiff(desired, {
      ...emptyRemote(),
      entityTypes: [
        {
          slug: "person",
          name: "Person",
          schemaExtras: {
            "x-lobu-resolution": {
              rules: [
                {
                  fields: ["email"],
                  normalizer: "email",
                  onMatch: "auto_link",
                },
              ],
            },
          },
        },
      ],
    });
    const row = plan.rows.find((r) => r.id === "person");
    expect(row?.verb).toBe("noop");
    expect(plan.counts.update).toBe(0);
  });

  test("under prune, omitting resolutionPolicy flags a removal, then converges to noop", () => {
    const live = {
      "x-lobu-resolution": {
        rules: [
          { fields: ["email"], normalizer: "email", onMatch: "auto_link" },
        ],
      },
    };
    const desired: DesiredState = {
      agents: [],
      memorySchema: {
        entityTypes: [{ slug: "person", name: "Person" }],
        relationshipTypes: [],
      },
      automations: [],
      requiredSecrets: [],
    };

    // First apply: remote policy present + prune → removal.
    const removal = computeDiff(
      desired,
      {
        ...emptyRemote(),
        entityTypes: [{ slug: "person", name: "Person", schemaExtras: live }],
      },
      { prune: true }
    );
    const removalRow = removal.rows.find((r) => r.id === "person");
    expect(removalRow?.verb).toBe("update");
    expect(removalRow?.changedFields).toContain("resolutionPolicy");

    // Second apply: policy already cleared → noop.
    const converged = computeDiff(
      desired,
      {
        ...emptyRemote(),
        entityTypes: [{ slug: "person", name: "Person", properties: {} }],
      },
      { prune: true }
    );
    expect(converged.rows.find((r) => r.id === "person")?.verb).toBe("noop");
    expect(converged.counts.update).toBe(0);
  });

  test("a policy-only declaration with a populated remote schema is noop on repeat apply", () => {
    const declared = {
      "x-lobu-resolution": {
        rules: [
          { fields: ["email"], normalizer: "email", onMatch: "auto_link" },
        ],
      },
    };
    const desired: DesiredState = {
      agents: [],
      memorySchema: {
        entityTypes: [{ slug: "person", resolutionPolicy: declared }],
        relationshipTypes: [],
      },
      automations: [],
      requiredSecrets: [],
    };
    // The live type has a full schema + the same policy. Omitted properties/
    // required must be treated as unmanaged (never churn), so a second apply
    // is a noop rather than a perpetual properties update.
    const plan = computeDiff(desired, {
      ...emptyRemote(),
      entityTypes: [
        {
          slug: "person",
          properties: { email: { type: "string" }, handle: { type: "string" } },
          required: ["email"],
          schemaExtras: declared,
        },
      ],
    });
    const row = plan.rows.find((r) => r.id === "person");
    expect(row?.verb).toBe("noop");
    expect(plan.counts.update).toBe(0);
  });

  test("under prune, omitting properties/required flags a removal (declarative fields stay pruneable)", async () => {
    const desired: DesiredState = {
      agents: [],
      memorySchema: {
        entityTypes: [
          {
            slug: "person",
            name: "Person",
            resolutionPolicy: {
              "x-lobu-resolution": {
                rules: [
                  {
                    fields: ["email"],
                    normalizer: "email",
                    onMatch: "auto_link",
                  },
                ],
              },
            },
          },
        ],
        relationshipTypes: [],
      },
      automations: [],
      requiredSecrets: [],
    };
    // Prune treats the config as the source of truth: a live `required` schema
    // the config no longer declares must be removed, not silently kept.
    const plan = computeDiff(
      desired,
      {
        ...emptyRemote(),
        entityTypes: [
          {
            slug: "person",
            name: "Person",
            properties: { email: { type: "string" } },
            required: ["email"],
            schemaExtras: {
              "x-lobu-resolution": {
                rules: [
                  {
                    fields: ["email"],
                    normalizer: "email",
                    onMatch: "auto_link",
                  },
                ],
              },
            },
          },
        ],
      },
      { prune: true }
    );
    const row = plan.rows.find((r) => r.id === "person");
    expect(row?.verb).toBe("update");
    expect(row?.changedFields).toContain("properties");
    expect(row?.changedFields).toContain("required");
  });

  test("under prune, an already-cleared empty schema is a noop (converges on repeat apply)", async () => {
    const desired: DesiredState = {
      agents: [],
      memorySchema: {
        entityTypes: [
          {
            slug: "person",
            name: "Person",
            resolutionPolicy: {
              "x-lobu-resolution": {
                rules: [
                  {
                    fields: ["email"],
                    normalizer: "email",
                    onMatch: "auto_link",
                  },
                ],
              },
            },
          },
        ],
        relationshipTypes: [],
      },
      automations: [],
      requiredSecrets: [],
    };
    // After the first prune apply cleared the live schema, a second apply sees
    // `properties: {}` — that is not a removal, so it must be a noop.
    const plan = computeDiff(
      desired,
      {
        ...emptyRemote(),
        entityTypes: [
          {
            slug: "person",
            name: "Person",
            properties: {},
            schemaExtras: {
              "x-lobu-resolution": {
                rules: [
                  {
                    fields: ["email"],
                    normalizer: "email",
                    onMatch: "auto_link",
                  },
                ],
              },
            },
          },
        ],
      },
      { prune: true }
    );
    const row = plan.rows.find((r) => r.id === "person");
    expect(row?.verb).toBe("noop");
    expect(plan.counts.update).toBe(0);
  });

  test("relationship-type rules are a noop when remote rules match (idempotency)", () => {
    // Regression: the rel-type `list` action omits rules, so apply hydrates
    // them (listRelationshipTypeRules) into the snapshot. When the hydrated
    // remote rules equal desired, the diff must be a noop — otherwise every
    // re-apply churns a perpetual "rules changed" update.
    const desired: DesiredState = {
      agents: [],
      memorySchema: {
        entityTypes: [],
        relationshipTypes: [
          {
            slug: "works-at",
            name: "Works at",
            rules: [{ source: "contact", target: "company" }],
          },
        ],
      },
      automations: [],
      requiredSecrets: [],
    };
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      relationshipTypes: [
        {
          slug: "works-at",
          name: "Works at",
          rules: [{ source: "contact", target: "company" }],
        },
      ],
    };
    const plan = computeDiff(desired, remote);
    expect(plan.counts.noop).toBe(1);
    expect(plan.counts.update).toBe(0);
  });

  test("member_of is a noop when the config declares it", () => {
    // The config must declare it (an undeclared remote type is blocking drift
    // under prune), but apply must not try to manage it: once the server
    // classifies member_of as authorization-bearing, create/update are refused
    // and every apply of such a config would fail.
    const desired: DesiredState = {
      agents: [],
      memorySchema: {
        entityTypes: [],
        relationshipTypes: [
          { slug: "member_of", name: "Member of", description: "declared" },
        ],
      },
      automations: [],
      requiredSecrets: [],
    };
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      relationshipTypes: [
        { slug: "member_of", name: "Member of", description: "platform" },
      ],
    };
    const plan = computeDiff(desired, remote);
    expect(plan.counts.noop).toBe(1);
    expect(plan.counts.update).toBe(0);
    expect(plan.counts.create).toBe(0);
  });

  test("member_of stays a noop against a RECORDED baseline", () => {
    // The path a repeat apply actually takes. With a recorded baseline the
    // desired-side diff never reaches the field-level helper, so a guard placed
    // only there is dead code here: the platform row has no attribution entry,
    // its facets differ from the config's, and that combination is blocking
    // drift — which aborts the whole apply.
    const desired: DesiredState = {
      agents: [],
      memorySchema: {
        entityTypes: [],
        relationshipTypes: [
          { slug: "member_of", name: "Member of", description: "declared" },
        ],
      },
      automations: [],
      requiredSecrets: [],
    };
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      relationshipTypes: [
        { slug: "member_of", name: "Membership", description: "platform" },
      ],
    };
    const plan = computeDiff(desired, remote, {
      baseline: {
        recorded: true,
        attribution: {
          entityTypes: [],
          relationshipTypes: [],
          automations: [],
        },
        owned: new Set<string>(),
      },
    });
    expect(plan.rows.some((r) => r.blocking)).toBe(false);
    expect(plan.counts.update).toBe(0);
    expect(plan.counts.create).toBe(0);
  });

  test("member_of is neither pruned nor blocking when the config omits it", () => {
    // The platform mints it, so it is absent from config by design. Blocking
    // would stall every apply; deleting would revoke access wholesale.
    const desired: DesiredState = {
      agents: [],
      memorySchema: { entityTypes: [], relationshipTypes: [] },
      automations: [],
      requiredSecrets: [],
    };
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      relationshipTypes: [{ slug: "member_of", name: "Member of" }],
    };
    const plan = computeDiff(desired, remote, { prune: true });
    expect(plan.counts.delete).toBe(0);
    expect(plan.rows.some((r) => r.blocking)).toBe(false);
  });

  test("an ordinary undeclared type still drifts under prune", () => {
    // Guards the scope of the exemption: it must key on the reserved slug, not
    // relax pruning for relationship types generally.
    const desired: DesiredState = {
      agents: [],
      memorySchema: { entityTypes: [], relationshipTypes: [] },
      automations: [],
      requiredSecrets: [],
    };
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      relationshipTypes: [{ slug: "billed_to", name: "Billed to" }],
    };
    const plan = computeDiff(desired, remote, { prune: true });
    expect(
      plan.rows.some((r) => r.id === "billed_to" && r.verb !== "noop")
    ).toBe(true);
  });

  test("relationship-type rules update when remote rules differ", () => {
    const desired: DesiredState = {
      agents: [],
      memorySchema: {
        entityTypes: [],
        relationshipTypes: [
          {
            slug: "works-at",
            name: "Works at",
            rules: [{ source: "contact", target: "company" }],
          },
        ],
      },
      automations: [],
      requiredSecrets: [],
    };
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      relationshipTypes: [{ slug: "works-at", name: "Works at", rules: [] }],
    };
    const plan = computeDiff(desired, remote);
    expect(plan.counts.update).toBe(1);
  });
});

describe("apply diff — empty container preservation", () => {
  // Bug fix: previously canonical() collapsed [] and {} to null, which
  // meant clearing a remote allowlist by setting it to [] silently
  // round-tripped as a noop instead of an update.
  test("clearing networkConfig.allowedDomains from non-empty to [] is an update", () => {
    const desired = buildState([
      buildDesiredAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
        settings: {
          networkConfig: { allowedDomains: [] },
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
            networkConfig: { allowedDomains: ["foo.com"] },
            updatedAt: 0,
          },
        ],
      ]),
    };
    const plan = computeDiff(desired, remote);
    const settingsRow = plan.rows.find((r) => r.kind === "settings");
    expect(settingsRow?.verb).toBe("update");
    if (settingsRow?.kind === "settings") {
      expect(settingsRow.changedFields).toContain("networkConfig");
    }
  });

  test("[] is not equal to null (preserved as distinct values)", () => {
    // When desired sets allowedDomains: [] and remote has the field
    // missing entirely, the diff should still treat them as equivalent
    // for the case where remote literally doesn't have the field — but
    // [] vs the explicit array ["foo"] must differ.
    const desiredEmpty = buildState([
      buildDesiredAgent("triage", {
        metadata: { agentId: "triage", name: "Triage" },
        settings: {
          networkConfig: { allowedDomains: [] },
        },
      }),
    ]);
    const remoteWithItems: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "Triage" }],
      agentSettings: new Map<string, AgentSettings | null>([
        [
          "triage",
          {
            networkConfig: { allowedDomains: ["x.com"] },
            updatedAt: 0,
          },
        ],
      ]),
    };
    const plan = computeDiff(desiredEmpty, remoteWithItems);
    expect(plan.counts.update).toBeGreaterThan(0);
  });
});

describe("apply diff — automations", () => {
  const desiredAutomation = {
    slug: "weekly-digest",
    agent: "triage",
    name: "Weekly digest",
    prompt: "Produce a digest.",
    triggers: [{ kind: "schedule" as const, cron: "0 9 * * 1" }],
  };

  test("create when automation missing remotely", () => {
    const desired = buildState([], { automations: [desiredAutomation] });
    const plan = computeDiff(desired, emptyRemote());
    const row = plan.rows.find((r) => r.kind === "automation");
    expect(row?.verb).toBe("create");
    expect(row?.id).toBe("weekly-digest");
  });

  test("noop when remote matches every field the diff covers", () => {
    const desired = buildState([], { automations: [desiredAutomation] });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      automations: [
        {
          slug: "weekly-digest",
          name: "Weekly digest",
          managed_agent_id: "triage",
          prompt: "Produce a digest.",
          triggers: [{ kind: "schedule", cron: "0 9 * * 1" }],
        },
      ],
    };
    const plan = computeDiff(desired, remote);
    const row = plan.rows.find((r) => r.kind === "automation");
    expect(row?.verb).toBe("noop");
    expect(plan.counts.create).toBe(0);
  });

  test("noop after the server expands minimally authored trigger defaults", () => {
    const agent = defineAgent({ id: "triage" });
    const desired = mapProjectToDesiredState(
      defineConfig({
        agents: [agent],
        automations: [
          defineAutomation({
            agent,
            slug: "minimal-schedule",
            skills: ["digest"],
            triggers: [{ kind: "schedule", cron: "0 9 * * 1" }],
          }),
        ],
      })
    );
    // The loader compiles skills[] into prompt before diffing; this test maps
    // directly, so stand in for the compile step.
    if (desired.automations[0])
      desired.automations[0].prompt = "Produce a digest.";
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      agents: [{ agentId: "triage", name: "triage" }],
      agentSettings: new Map([["triage", null]]),
      automations: [
        {
          slug: "minimal-schedule",
          managed_agent_id: "triage",
          prompt: "Produce a digest.",
          triggers: [
            {
              kind: "schedule",
              cron: "0 9 * * 1",
              timezone: null,
              execution: "window",
              active_run: "coalesce",
              skip_if_unchanged: true,
            },
          ],
        },
      ],
    };

    const row = computeDiff(desired, remote).rows.find(
      (candidate) => candidate.kind === "automation"
    );
    expect(row?.verb).toBe("noop");
  });

  test("noop when desired model matches the remote execution_config model", () => {
    const desired = buildState([], {
      automations: [
        {
          ...desiredAutomation,
          deviceWorkerId: "dev-1",
          agentKind: "opencode",
          model: "opencode-go/deepseek-v4-flash",
        },
      ],
    });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      automations: [
        {
          slug: "weekly-digest",
          name: "Weekly digest",
          managed_agent_id: "triage",
          prompt: "Produce a digest.",
          triggers: [{ kind: "schedule", cron: "0 9 * * 1" }],
          device_worker_id: "dev-1",
          agent_kind: "opencode",
          execution_config: { model: "opencode-go/deepseek-v4-flash" },
        },
      ],
    };
    const row = computeDiff(desired, remote).rows.find(
      (r) => r.kind === "automation"
    );
    expect(row?.verb).toBe("noop");
  });

  test("noop when the config omits a model but the remote has one (unmanaged)", () => {
    const desired = buildState([], { automations: [desiredAutomation] });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      automations: [
        {
          slug: "weekly-digest",
          name: "Weekly digest",
          managed_agent_id: "triage",
          prompt: "Produce a digest.",
          triggers: [{ kind: "schedule", cron: "0 9 * * 1" }],
          execution_config: { model: "opencode-go/deepseek-v4-flash" },
        },
      ],
    };
    const row = computeDiff(desired, remote).rows.find(
      (r) => r.kind === "automation"
    );
    expect(row?.verb).toBe("noop");
  });

  test("update with execution_config scalar drift when the model differs", () => {
    const desired = buildState([], {
      automations: [
        {
          ...desiredAutomation,
          deviceWorkerId: "dev-1",
          agentKind: "opencode",
          model: "opencode-go/deepseek-v4-flash",
        },
      ],
    });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      automations: [
        {
          slug: "weekly-digest",
          name: "Weekly digest",
          managed_agent_id: "triage",
          prompt: "Produce a digest.",
          triggers: [{ kind: "schedule", cron: "0 9 * * 1" }],
          device_worker_id: "dev-1",
          agent_kind: "opencode",
          execution_config: { model: "openai/gpt-5.6-luna" },
        },
      ],
    };
    const row = computeDiff(desired, remote).rows.find(
      (r) => r.kind === "automation"
    );
    expect(row?.verb).toBe("update");
    expect(row?.changedFields).toContain("execution_config");
  });

  test("update when a schedule trigger changes remotely", () => {
    const desired = buildState([], { automations: [desiredAutomation] });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      automations: [
        {
          slug: "weekly-digest",
          name: "Weekly digest",
          managed_agent_id: "triage",
          prompt: "Produce a digest.",
          triggers: [{ kind: "schedule", cron: "0 10 * * 1" }],
        },
      ],
    };
    const plan = computeDiff(desired, remote);
    const row = plan.rows.find((r) => r.kind === "automation");
    expect(row?.verb).toBe("update");
    expect(row?.changedFields).toContain("triggers");
    expect(
      (row as { versionBoundFields?: string[] }).versionBoundFields
    ).toBeUndefined();
  });

  test("update with version-bound drift when prompt changes remotely", () => {
    const desired = buildState([], { automations: [desiredAutomation] });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      automations: [
        {
          slug: "weekly-digest",
          name: "Weekly digest",
          managed_agent_id: "triage",
          prompt: "Old prompt",
          triggers: [{ kind: "schedule", cron: "0 9 * * 1" }],
        },
      ],
    };
    const plan = computeDiff(desired, remote);
    const row = plan.rows.find((r) => r.kind === "automation");
    expect(row?.verb).toBe("update");
    expect(
      (row as { versionBoundFields?: string[] }).versionBoundFields
    ).toEqual(["prompt"]);
  });

  test("explicit null outputs clears remote declarations", () => {
    const desired = buildState([], {
      automations: [{ ...desiredAutomation, outputs: null }],
    });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      automations: [
        {
          slug: "weekly-digest",
          name: "Weekly digest",
          managed_agent_id: "triage",
          prompt: "Produce a digest.",
          triggers: [{ kind: "schedule", cron: "0 9 * * 1" }],
          outputs: {
            items: { entity: "social-signal", key: ["source_origin_id"] },
          },
        },
      ],
    };

    const row = computeDiff(desired, remote).rows.find(
      (candidate) => candidate.kind === "automation"
    );
    expect(row?.verb).toBe("update");
    expect(row?.changedFields).toContain("outputs");
    expect(
      (row as { versionBoundFields?: string[] }).versionBoundFields
    ).toContain("outputs");
  });

  test("removing outputs from the declaration clears remote declarations", () => {
    const desired = buildState([], { automations: [desiredAutomation] });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      automations: [
        {
          slug: "weekly-digest",
          name: "Weekly digest",
          managed_agent_id: "triage",
          prompt: "Produce a digest.",
          triggers: [{ kind: "schedule", cron: "0 9 * * 1" }],
          outputs: {
            items: { entity: "social-signal", key: ["source_origin_id"] },
          },
        },
      ],
    };

    const row = computeDiff(desired, remote).rows.find(
      (candidate) => candidate.kind === "automation"
    );
    expect(row?.verb).toBe("update");
    expect(
      (row as { versionBoundFields?: string[] }).versionBoundFields
    ).toContain("outputs");
  });

  test("reaction_script declared → always re-pushed (idempotent)", () => {
    const desired = buildState([], {
      automations: [
        {
          ...desiredAutomation,
          reactionScript: {
            sourcePath: "/abs/path/r.ts",
            sourceCode: "export default async () => {};",
          },
        },
      ],
    });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      automations: [
        {
          slug: "weekly-digest",
          name: "Weekly digest",
          managed_agent_id: "triage",
          prompt: "Produce a digest.",
          triggers: [{ kind: "schedule", cron: "0 9 * * 1" }],
        },
      ],
    };
    const plan = computeDiff(desired, remote);
    const row = plan.rows.find((r) => r.kind === "automation");
    expect(row?.verb).toBe("update");
    expect(row?.changedFields).toEqual(["reaction_script"]);
    expect(
      (row as { reactionScriptDeclared?: boolean }).reactionScriptDeclared
    ).toBe(true);
  });

  test("drift when remote automation not declared in models", () => {
    const desired = buildState([], { automations: [] });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      automations: [{ slug: "orphan-automation" }],
    };
    const plan = computeDiff(desired, remote);
    const row = plan.rows.find((r) => r.kind === "automation");
    expect(row?.verb).toBe("drift");
    expect(plan.counts.drift).toBe(1);
  });
});

describe("renderSummary", () => {
  test("renders zero-row plan", () => {
    const desired = buildState([]);
    const plan = computeDiff(desired, emptyRemote());
    expect(renderSummary(plan)).toMatchSnapshot();
  });
});

describe("renderPlan — automation labels", () => {
  test("plan create/update/drift rows print automation", () => {
    const plan: DiffPlan = {
      rows: [
        { kind: "automation", verb: "update", id: "weekly-digest" },
        { kind: "automation", verb: "create", id: "new-digest" },
        { kind: "automation", verb: "drift", id: "orphaned-digest" },
      ],
      counts: { create: 1, update: 1, noop: 0, drift: 1, delete: 0 },
      notes: [],
    };

    const text = renderPlan(plan);
    expect(text).toContain("automations:");
    expect(text).toContain("automation new-digest");
    expect(text).toContain("automation weekly-digest");
    expect(text).toContain("automation orphaned-digest");
    expect(text).toMatchSnapshot();
  });

  test("renderProgress uses the automation label for automation-kind rows", () => {
    const line = renderProgress("create", "automation", "weekly-digest");
    expect(line).toContain("automation weekly-digest");
  });
});

describe("apply diff — connectors", () => {
  const builtinConnectorDef = {
    key: "hackernews",
    name: "Hacker News",
    installed: false,
    installable: true,
  };

  function connectorState() {
    return buildState([], {
      connectors: {
        definitions: [
          {
            key: "acme",
            sourcePath: "/proj/connectors/acme.connector.ts",
            sourceCode: "export default class {}",
            sourceFile: "connectors/acme.connector.ts",
          },
        ],
        authProfiles: [
          {
            slug: "hn-token",
            connector: "hackernews",
            kind: "env" as const,
            name: "HN token",
            credentials: { HN_TOKEN: "$HN_TOKEN" },
            sourceFile: "connectors/hackernews.yaml",
          },
          {
            slug: "x-account",
            connector: "x",
            kind: "oauth_account" as const,
            sourceFile: "connectors/x.yaml",
          },
        ],
        connections: [
          {
            slug: "hn-frontpage",
            connector: "hackernews",
            name: "HN front page",
            authProfileSlug: "hn-token",
            feeds: [{ feedKey: "stories", schedule: "0 * * * *" }],
            sourceFile: "connectors/hackernews.yaml",
          },
        ],
      },
    });
  }

  function remoteWithFeedCron(schedule: string | null): RemoteSnapshot {
    return {
      ...emptyRemote(),
      connectorDefinitions: [builtinConnectorDef],
      authProfiles: [
        {
          slug: "hn-token",
          display_name: "HN token",
          connector_key: "hackernews",
          profile_kind: "env",
          status: "active",
        },
      ],
      connections: [
        {
          id: 7,
          slug: "hn-frontpage",
          connector_key: "hackernews",
          display_name: "HN front page",
          status: "active",
          auth_profile_slug: "hn-token",
          app_auth_profile_slug: null,
          config: {},
        },
      ],
      feedsByConnectionId: new Map([
        [
          7,
          [
            {
              id: 11,
              connection_id: 7,
              feed_key: "stories",
              status: "active",
              schedule,
              config: {},
            },
          ],
        ],
      ]),
    };
  }

  test("create verbs for new connector def, auth profile, connection, feed", () => {
    const plan = computeDiff(connectorState(), {
      ...emptyRemote(),
      connectorDefinitions: [builtinConnectorDef],
    });
    const def = plan.rows.find((r) => r.kind === "connector-definition");
    expect(def?.verb).toBe("create");
    const authEnv = plan.rows.find(
      (r) => r.kind === "auth-profile" && r.id === "hn-token"
    );
    expect(authEnv?.verb).toBe("create");
    const authOauth = plan.rows.find(
      (r) => r.kind === "auth-profile" && r.id === "x-account"
    );
    expect(authOauth?.verb).toBe("create");
    expect(
      authOauth && "needsAuth" in authOauth ? authOauth.needsAuth : undefined
    ).toBe(true);
    const conn = plan.rows.find((r) => r.kind === "connection");
    expect(conn?.verb).toBe("create");
    const feed = plan.rows.find((r) => r.kind === "feed");
    expect(feed?.verb).toBe("create");
    expect(feed?.id).toBe("hn-frontpage/stories");
  });

  test("noop when connection + feed already match remotely", () => {
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      connectorDefinitions: [builtinConnectorDef],
      authProfiles: [
        {
          slug: "hn-token",
          display_name: "HN token",
          connector_key: "hackernews",
          profile_kind: "env",
          status: "active",
        },
        {
          slug: "x-account",
          connector_key: "x",
          profile_kind: "oauth_account",
          status: "active",
        },
      ],
      connections: [
        {
          id: 7,
          slug: "hn-frontpage",
          connector_key: "hackernews",
          display_name: "HN front page",
          status: "active",
          auth_profile_slug: "hn-token",
          app_auth_profile_slug: null,
          config: {},
        },
      ],
      feedsByConnectionId: new Map([
        [
          7,
          [
            {
              id: 11,
              connection_id: 7,
              feed_key: "stories",
              status: "active",
              schedule: "0 * * * *",
              config: {},
            },
          ],
        ],
      ]),
    };
    const plan = computeDiff(connectorState(), remote);
    expect(plan.rows.find((r) => r.kind === "connection")?.verb).toBe("noop");
    expect(plan.rows.find((r) => r.kind === "feed")?.verb).toBe("noop");
    expect(
      plan.rows.find((r) => r.kind === "auth-profile" && r.id === "x-account")
        ?.verb
    ).toBe("noop");
  });

  // The config declares the feed but not its cadence. A cron set in the UI is
  // not drift the config gets to overwrite — apply must leave it alone, which
  // means the row is a noop, not an update that writes null.
  test("an undeclared schedule does not diff against a remote cron", () => {
    const state = connectorState();
    const feed = state.connectors.connections[0]?.feeds[0];
    if (feed) delete (feed as { schedule?: unknown }).schedule;

    const plan = computeDiff(state, remoteWithFeedCron("0 0 * * *"));
    expect(plan.rows.find((r) => r.kind === "feed")?.verb).toBe("noop");
  });

  test("an explicitly null schedule still diffs as a deliberate clear", () => {
    const state = connectorState();
    const feed = state.connectors.connections[0]?.feeds[0];
    if (feed) (feed as { schedule?: string | null }).schedule = null;

    const plan = computeDiff(state, remoteWithFeedCron("0 0 * * *"));
    const row = plan.rows.find((r) => r.kind === "feed");
    expect(row?.verb).toBe("update");
    expect(row && "changedFields" in row ? row.changedFields : []).toEqual([
      "schedule",
    ]);
  });

  // A connection block with no `config` key does not manage the connection's
  // settings. Sending `{}` with replace_config wiped UI-set settings.
  test("an undeclared connection config does not diff against a remote config", () => {
    const state = connectorState();
    const conn = state.connectors.connections[0];
    if (conn) delete (conn as { config?: unknown }).config;

    const remote = remoteWithFeedCron("0 * * * *");
    const remoteConn = remote.connections[0];
    if (remoteConn) {
      remoteConn.config = { fetch_limit: 25 };
    }

    const plan = computeDiff(state, remote);
    expect(plan.rows.find((r) => r.kind === "connection")?.verb).toBe("noop");
  });

  // Same class: an undeclared config must not diff against a remote one.
  test("an undeclared feed config does not diff against a remote config", () => {
    const state = connectorState();
    const feed = state.connectors.connections[0]?.feeds[0];
    if (feed) delete (feed as { config?: unknown }).config;

    const remote = remoteWithFeedCron("0 * * * *");
    const feeds = remote.feedsByConnectionId.get(7);
    if (feeds?.[0]) feeds[0].config = { depth: 3 };

    const plan = computeDiff(state, remote);
    expect(plan.rows.find((r) => r.kind === "feed")?.verb).toBe("noop");
  });

  test("update when feed schedule changes; needs-auth when oauth profile inactive", () => {
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      connectorDefinitions: [builtinConnectorDef],
      authProfiles: [
        {
          slug: "hn-token",
          display_name: "HN token",
          connector_key: "hackernews",
          profile_kind: "env",
          status: "active",
        },
        {
          slug: "x-account",
          connector_key: "x",
          profile_kind: "oauth_account",
          status: "pending_auth",
        },
      ],
      connections: [
        {
          id: 7,
          slug: "hn-frontpage",
          connector_key: "hackernews",
          display_name: "HN front page",
          status: "active",
          auth_profile_slug: "hn-token",
          app_auth_profile_slug: null,
          config: {},
        },
      ],
      feedsByConnectionId: new Map([
        [
          7,
          [
            {
              id: 11,
              connection_id: 7,
              feed_key: "stories",
              status: "active",
              schedule: "0 0 * * *",
              config: {},
            },
          ],
        ],
      ]),
    };
    const plan = computeDiff(connectorState(), remote);
    const feed = plan.rows.find((r) => r.kind === "feed");
    expect(feed?.verb).toBe("update");
    expect(feed && "changedFields" in feed ? feed.changedFields : []).toEqual([
      "schedule",
    ]);
    const authOauth = plan.rows.find(
      (r) => r.kind === "auth-profile" && r.id === "x-account"
    );
    expect(
      authOauth && "needsAuth" in authOauth ? authOauth.needsAuth : undefined
    ).toBe(true);
  });

  test("undeclared remote connector becomes an informational note (no uninstall)", () => {
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      connectorDefinitions: [
        builtinConnectorDef,
        {
          key: "legacy",
          name: "Legacy",
          installed: true,
          installable: false,
        },
      ],
    };
    const plan = computeDiff(connectorState(), remote);
    expect(plan.notes.some((n) => n.includes('"legacy"'))).toBe(true);
    expect(
      plan.rows.some(
        (r) => r.kind === "connector-definition" && r.id === "legacy"
      )
    ).toBe(false);
  });

  test("connectors are skipped when --only is set", () => {
    const plan = computeDiff(connectorState(), emptyRemote(), {
      only: "agents",
    });
    expect(plan.rows.some((r) => r.kind === "connection")).toBe(false);
    expect(plan.rows.some((r) => r.kind === "connector-definition")).toBe(
      false
    );
  });

  test("render includes the connectors sections", () => {
    const plan = computeDiff(connectorState(), {
      ...emptyRemote(),
      connectorDefinitions: [builtinConnectorDef],
    });
    expect(renderPlan(plan)).toMatchSnapshot();
  });

  // ── round-2 ──────────────────────────────────────────────────────────────

  test("connection slug bound to a different connector remotely is a hard error", () => {
    expect(() =>
      computeDiff(connectorState(), {
        ...emptyRemote(),
        connectorDefinitions: [builtinConnectorDef],
        connections: [
          {
            id: 9,
            slug: "hn-frontpage",
            connector_key: "rss",
            status: "active",
            auth_profile_slug: null,
            app_auth_profile_slug: null,
            config: {},
          },
        ],
      })
    ).toThrow(/bound to connector "rss" remotely.*declares "hackernews"/);
  });

  test("auth-profile slug bound to a different kind remotely is a hard error", () => {
    expect(() =>
      computeDiff(connectorState(), {
        ...emptyRemote(),
        connectorDefinitions: [builtinConnectorDef],
        authProfiles: [
          {
            slug: "hn-token",
            connector_key: "hackernews",
            profile_kind: "oauth_app",
            status: "active",
          },
        ],
      })
    ).toThrow(/auth_profile "hn-token" is bound to hackernews\/oauth_app/);
  });

  test("credential rotation re-pushes: env profile shows update (credentials)", () => {
    const plan = computeDiff(connectorState(), {
      ...emptyRemote(),
      connectorDefinitions: [builtinConnectorDef],
      authProfiles: [
        {
          slug: "hn-token",
          display_name: "HN token",
          connector_key: "hackernews",
          profile_kind: "env",
          status: "active",
        },
      ],
    });
    const row = plan.rows.find(
      (r) => r.kind === "auth-profile" && r.id === "hn-token"
    );
    expect(row?.verb).toBe("update");
    expect(row && "changedFields" in row ? row.changedFields : []).toContain(
      "credentials"
    );
  });

  test("a fully-converged remote state produces no connector create/update (except idempotent connector-def re-push)", () => {
    // Build a remote snapshot that exactly mirrors connectorState(): the env
    // auth profile has no declared-credential drift suppression, so it would
    // re-push (update credentials). The acme connector def is installed, so it
    // shows as a (no-op-on-server) "update". Everything else is noop.
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      connectorDefinitions: [
        { key: "hackernews", installed: false, installable: true },
        { key: "x", installed: false, installable: true },
        { key: "acme", installed: true, installable: false },
      ],
      authProfiles: [
        {
          slug: "hn-token",
          display_name: "HN token",
          connector_key: "hackernews",
          profile_kind: "env",
          status: "active",
        },
        {
          slug: "x-account",
          connector_key: "x",
          profile_kind: "oauth_account",
          status: "active",
        },
      ],
      connections: [
        {
          id: 7,
          slug: "hn-frontpage",
          connector_key: "hackernews",
          display_name: "HN front page",
          status: "active",
          auth_profile_slug: "hn-token",
          app_auth_profile_slug: null,
          config: {},
        },
      ],
      feedsByConnectionId: new Map([
        [
          7,
          [
            {
              id: 11,
              connection_id: 7,
              feed_key: "stories",
              status: "active",
              schedule: "0 * * * *",
              config: {},
            },
          ],
        ],
      ]),
    };
    const plan = computeDiff(connectorState(), remote);
    // Only "update" rows allowed: the connector-def re-push and the
    // env-credential re-push — both idempotent on the server.
    const nonIdempotentChurn = plan.rows.filter(
      (r) =>
        (r.verb === "create" || r.verb === "update") &&
        !(r.kind === "connector-definition") &&
        !(r.kind === "auth-profile" && r.id === "hn-token")
    );
    expect(nonIdempotentChurn).toEqual([]);
    expect(plan.notes).toEqual([]);
  });

  test("connector-definition with an already-installed key renders as update, not create", () => {
    const installedAcme = { key: "acme", installed: true, installable: false };
    const plan = computeDiff(connectorState(), {
      ...emptyRemote(),
      connectorDefinitions: [builtinConnectorDef, installedAcme],
    });
    // connectorState()'s acme def has key:"acme"; it is installed remotely.
    const row = plan.rows.find(
      (r) => r.kind === "connector-definition" && r.id?.startsWith("acme")
    );
    expect(row?.verb).toBe("update");
  });

  // ── round-4 ──────────────────────────────────────────────────────────────

  test("referenced-but-not-installed bundled connector becomes a connector-definition create row", () => {
    const plan = computeDiff(connectorState(), {
      ...emptyRemote(),
      connectorDefinitions: [
        // hackernews: installable + has a server-side source_uri, not installed
        {
          key: "hackernews",
          installed: false,
          installable: true,
          source_uri: "file:///app/connectors/hackernews.ts",
        },
        // x: same
        {
          key: "x",
          installed: false,
          installable: true,
          source_uri: "file:///app/connectors/x.ts",
        },
      ],
    });
    const hn = plan.rows.find(
      (r) => r.kind === "connector-definition" && r.id === "hackernews"
    );
    expect(hn?.verb).toBe("create");
    const x = plan.rows.find(
      (r) => r.kind === "connector-definition" && r.id === "x"
    );
    expect(x?.verb).toBe("create");
    // acme is locally declared (sourcePath) — it still gets its own row.
    expect(
      plan.rows.some(
        (r) => r.kind === "connector-definition" && r.id?.startsWith("acme")
      )
    ).toBe(true);
  });

  test("referenced managed MCP connector becomes an install row without project source", () => {
    const state = buildState([]);
    state.connectors.connections.push({
      slug: "atlassian",
      connector: "mcp.atlassian",
      config: {
        managedBy: {
          org: "lobu-managed",
          connectionSlug: "atlassian-burak",
        },
      },
      feeds: [],
      sourceFile: "lobu.config.ts",
    });
    const plan = computeDiff(state, {
      ...emptyRemote(),
      connectorDefinitions: [
        {
          key: "mcp.atlassian",
          installed: false,
          installable: true,
          mcp_config: {
            upstream_url: "https://mcp.atlassian.com/v1/mcp/authv2",
            tool_prefix: "atlassian",
          },
          managed_mcp_source: "export default class ManagedAtlassian {}",
        },
      ],
    });

    expect(
      plan.rows.find(
        (row) =>
          row.kind === "connector-definition" && row.id === "mcp.atlassian"
      )?.verb
    ).toBe("create");
  });

  test("installed managed MCP connector becomes a refresh row", () => {
    const state = buildState([]);
    state.connectors.connections.push({
      slug: "atlassian",
      connector: "mcp.atlassian",
      config: {
        managedBy: {
          org: "lobu-managed",
          connectionSlug: "atlassian-burak",
        },
      },
      feeds: [],
      sourceFile: "lobu.config.ts",
    });
    const plan = computeDiff(state, {
      ...emptyRemote(),
      connectorDefinitions: [
        {
          key: "mcp.atlassian",
          installed: true,
          installable: true,
          managed_mcp_source: "export default class ManagedAtlassian {}",
        },
      ],
    });

    expect(
      plan.rows.find(
        (row) =>
          row.kind === "connector-definition" && row.id === "mcp.atlassian"
      )?.verb
    ).toBe("update");
  });

  test("a locally-supplied connector key is NOT also a bundled-install row (no double mutation)", () => {
    // Pretend "acme" is *also* in the bundled catalog with a source_uri; the
    // local .connector.ts should win — no bundled row for "acme".
    const state = connectorState();
    // Make a connection reference "acme" so it's in referencedConnectorKeys.
    state.connectors.connections.push({
      slug: "acme-conn",
      connector: "acme",
      feeds: [],
      sourceFile: "connectors/acme.yaml",
    });
    const plan = computeDiff(state, {
      ...emptyRemote(),
      connectorDefinitions: [
        {
          key: "acme",
          installed: false,
          installable: true,
          source_uri: "file:///app/connectors/acme.ts",
        },
      ],
    });
    const acmeRows = plan.rows.filter(
      (r) => r.kind === "connector-definition" && r.id?.startsWith("acme")
    );
    // Exactly one row — the locally-declared def — never a bundled duplicate.
    expect(acmeRows).toHaveLength(1);
  });

  test("BYO chat connection always reaches the chat upsert (rotation-safe)", () => {
    // Desired config holds a resolved token (plaintext); the server stores it as
    // a `secret://` ref, so the CLI can't compare them or detect a rotation. The
    // row must always be an `update` (never noop) so it reaches the idempotent
    // apply_chat_connection, which compares secrets server-side and no-ops when
    // nothing changed. A noop here would silently drop credential rotations.
    const desired = buildState([], {
      connectors: {
        definitions: [],
        authProfiles: [],
        connections: [
          {
            slug: "team-slack",
            connector: "slack",
            credentialMode: "byo" as const,
            config: { botToken: "xoxb-real-token" },
            feeds: [],
            sourceFile: "lobu.config.ts",
          },
        ],
      },
    });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      // listConnections strips the `agentconn-` slug namespace back to the slug.
      connections: [
        {
          id: 9,
          slug: "team-slack",
          connector_key: "slack",
          display_name: "Stored workspace name",
          status: "active",
          auth_profile_slug: null,
          app_auth_profile_slug: null,
          credential_mode: "byo",
          config: { botToken: "secret://slack/team-slack/botToken" },
        },
      ],
    };
    const conn = computeDiff(desired, remote).rows.find(
      (r) => r.kind === "connection" && r.id === "team-slack"
    );
    expect(conn?.verb).toBe("update");
    // Optional names use "omitted = no opinion" semantics. The row updates
    // only because BYO credentials are always re-pushed for rotation safety.
    expect(conn?.changedFields).toEqual(["config"]);
  });

  test("BYO chat connection ignores auth/app_auth/device_worker drift", () => {
    // A BYO chat row applies through `apply_chat_connection`, which only
    // persists slug/connector/name/config. If the remote row carries a stray
    // auth profile, app-auth profile, or device pin, the diff must NOT report
    // those as changed — apply can't clear them, so they'd resurface as a
    // perpetual "update" every run. Only `config` (rotation-safe) may change.
    const desired = buildState([], {
      connectors: {
        definitions: [],
        authProfiles: [],
        connections: [
          {
            slug: "team-slack",
            connector: "slack",
            credentialMode: "byo" as const,
            config: { botToken: "xoxb-real-token" },
            feeds: [],
            sourceFile: "lobu.config.ts",
          },
        ],
      },
    });
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      connections: [
        {
          id: 9,
          slug: "team-slack",
          connector_key: "slack",
          display_name: null,
          status: "active",
          auth_profile_slug: "stray-auth",
          app_auth_profile_slug: "stray-app-auth",
          device_worker_id: "11111111-1111-1111-1111-111111111111",
          credential_mode: "byo",
          config: { botToken: "secret://slack/team-slack/botToken" },
        },
      ],
    };
    const conn = computeDiff(desired, remote).rows.find(
      (r) => r.kind === "connection" && r.id === "team-slack"
    );
    expect(conn?.verb).toBe("update");
    // Only the rotation-safe `config` field — never the unappliable ones.
    expect(
      conn?.kind === "connection" ? conn.changedFields : undefined
    ).toEqual(["config"]);
  });
});

describe("apply diff — prune", () => {
  // Remote state that has definitions + a connection the desired config drops.
  function remoteWithExtras(): RemoteSnapshot {
    return {
      ...emptyRemote(),
      entityTypes: [
        { id: 1, slug: "lead", properties: {} },
        { id: 2, slug: "stale-entity" },
      ],
      relationshipTypes: [{ id: 3, slug: "stale-rel" }],
      automations: [{ slug: "stale-automation", automation_id: "42" }],
      // stale-conn is dropped from config but exempt (drift); the connector "x"
      // it still uses must therefore be spared from prune.
      connections: [
        { id: 7, slug: "stale-conn", connector_key: "x", status: "ok" },
      ],
      connectorDefinitions: [
        { id: 10, key: "x", installed: true },
        { id: 11, key: "orphan-connector", installed: true },
      ],
    };
  }

  // A prune-on apply only deletes definitions a previous apply recorded as its
  // own. Without a recorded baseline the gate blocks, so every prune
  // delete assertion below runs against a baseline that owns the fixture.
  function baselineForRemote(
    remote: RemoteSnapshot,
    owned: string[]
  ): Baseline {
    return {
      recorded: true,
      attribution: {
        entityTypes:
          remote.entityTypes as Baseline["attribution"]["entityTypes"],
        relationshipTypes:
          remote.relationshipTypes as Baseline["attribution"]["relationshipTypes"],
        automations:
          remote.automations as Baseline["attribution"]["automations"],
      },
      owned: new Set(owned),
    };
  }

  function baselineOwningExtras(): Baseline {
    return baselineForRemote(remoteWithExtras(), [
      ownedKey("entity-type", 1),
      ownedKey("entity-type", 2),
      ownedKey("relationship-type", 3),
      ownedKey("automation", "42"),
      ownedKey("connector-definition", 11),
    ]);
  }

  function desiredKeepingLead(): DesiredState {
    return buildState([], {
      memorySchema: {
        entityTypes: [{ slug: "lead", properties: {} }],
        relationshipTypes: [],
      },
    });
  }

  test("default (prune off) reports removed definitions as drift, never delete", () => {
    const plan = computeDiff(desiredKeepingLead(), remoteWithExtras());
    expect(plan.counts.delete).toBe(0);
    expect(plan.rows.some((r) => r.verb === "delete")).toBe(false);
    expect(
      plan.rows.find((r) => r.kind === "entity-type" && r.id === "stale-entity")
        ?.verb
    ).toBe("drift");
  });

  test("prune deletes removed entity/relationship/automation/connector definitions", () => {
    const plan = computeDiff(desiredKeepingLead(), remoteWithExtras(), {
      prune: true,
      baseline: baselineOwningExtras(),
    });
    const deletes = plan.rows.filter((r) => r.verb === "delete");
    const deletedIds = deletes.map((r) => `${r.kind}:${r.id}`).sort();
    expect(deletedIds).toEqual([
      "automation:stale-automation",
      "connector-definition:orphan-connector",
      "entity-type:stale-entity",
      "relationship-type:stale-rel",
    ]);
    expect(plan.counts.delete).toBe(4);
    // The kept entity type is a noop, not a delete.
    expect(
      plan.rows.find((r) => r.kind === "entity-type" && r.id === "lead")?.verb
    ).toBe("noop");
  });

  test("prune never deletes data, connections, or agents", () => {
    const desired = buildState(
      [
        buildDesiredAgent("kept", {
          metadata: { agentId: "kept", name: "Kept" },
        }),
      ],
      {
        memorySchema: { entityTypes: [], relationshipTypes: [] },
      }
    );
    const remote: RemoteSnapshot = {
      ...remoteWithExtras(),
      agents: [{ agentId: "gone-agent", name: "Gone" }],
      agentSettings: new Map([["kept", null]]),
    };
    const plan = computeDiff(desired, remote, { prune: true });
    // Connection removed from config is drift (exempt), not delete.
    expect(
      plan.rows.find((r) => r.kind === "connection" && r.id === "stale-conn")
        ?.verb
    ).toBe("drift");
    // Remote agent absent from desired is drift (exempt), not delete.
    expect(
      plan.rows.find((r) => r.kind === "agent" && r.id === "gone-agent")?.verb
    ).toBe("drift");
  });

  test("prune never deletes public types owned by another org", () => {
    // The list endpoint returns this org's types PLUS public types from other
    // orgs. With orgId set, a foreign-org type must not be pruned even if it's
    // absent from the config.
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      entityTypes: [
        { id: 1, slug: "lead", properties: {}, organization_id: "org_self" },
        { id: 2, slug: "stale-mine", organization_id: "org_self" },
        { id: 3, slug: "public-other", organization_id: "org_other" },
      ],
      relationshipTypes: [
        { id: 4, slug: "stale-rel-mine", organization_id: "org_self" },
        { id: 5, slug: "public-rel-other", organization_id: "org_other" },
      ],
    };
    const plan = computeDiff(desiredKeepingLead(), remote, {
      prune: true,
      orgId: "org_self",
      baseline: baselineForRemote(remote, [
        ownedKey("entity-type", 2),
        ownedKey("relationship-type", 4),
      ]),
    });
    const deletedIds = plan.rows
      .filter((r) => r.verb === "delete")
      .map((r) => `${r.kind}:${r.id}`)
      .sort();
    // Only the org's own removed types — never the foreign public ones.
    expect(deletedIds).toEqual([
      "entity-type:stale-mine",
      "relationship-type:stale-rel-mine",
    ]);
    expect(deletedIds.some((id) => id.includes("other"))).toBe(false);
  });

  test("prune never deletes $ system entity types; domain still prune", () => {
    // Sole signal is $ slug prefix.
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      entityTypes: [
        { id: 1, slug: "lead", properties: {}, organization_id: "org_self" },
        { id: 2, slug: "$member", organization_id: "org_self" },
        { id: 3, slug: "$resource", organization_id: "org_self" },
        { id: 4, slug: "goal", organization_id: "org_self" },
        // bare channel/repo are not system (legacy names; pruneable)
        { id: 5, slug: "channel", organization_id: "org_self" },
      ],
      relationshipTypes: [
        { id: 6, slug: "$system-rel", organization_id: "org_self" },
      ],
      automations: [{ slug: "$system-automation", automation_id: "b-sys" }],
    };
    const plan = computeDiff(desiredKeepingLead(), remote, {
      prune: true,
      orgId: "org_self",
      baseline: baselineForRemote(remote, [
        ownedKey("entity-type", 4),
        ownedKey("entity-type", 5),
      ]),
    });
    const verbOf = (kind: string, id: string) =>
      plan.rows.find((r) => r.kind === kind && r.id === id)?.verb;
    expect(verbOf("entity-type", "$member")).toBe("drift");
    expect(verbOf("entity-type", "$resource")).toBe("drift");
    expect(verbOf("entity-type", "goal")).toBe("delete");
    expect(verbOf("entity-type", "channel")).toBe("delete");
    // $ on rel/automation still uses slug heuristic
    expect(verbOf("relationship-type", "$system-rel")).toBe("drift");
    expect(verbOf("automation", "$system-automation")).toBe("drift");
  });

  test("prune never deletes or blocks a system-tagged (non-$ slug) Automation", () => {
    // chat-link bindings (e.g. chat-slack-97) are system-created with a
    // `system:chat-link` tag and a plain slug — they are NOT config-owned, so
    // they must be ignored (drift), not pruned or made to block the apply.
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      automations: [
        {
          slug: "chat-slack-97",
          automation_id: "97",
          tags: ["system:chat-link"],
        },
      ],
    };
    const plan = computeDiff(desiredKeepingLead(), remote, {
      prune: true,
      orgId: "org_self",
    });
    const row = plan.rows.find(
      (r) => r.kind === "automation" && r.id === "chat-slack-97"
    );
    expect(row?.verb).toBe("drift");
    expect(plan.counts.delete).toBe(0);
    // No blocking drift rows → the apply is not stalled by it.
    expect(
      plan.rows.some(
        (r) =>
          r.verb === "drift" &&
          "blocking" in r &&
          (r as { blocking: boolean }).blocking
      )
    ).toBe(false);
  });

  test("matching prefers the org's own type over a foreign public type with the same slug", () => {
    // Server returns the org's own row first, then a public row with the same
    // slug. Matching must compare desired against the org-owned row (noop), not
    // the foreign public one (which would falsely look like an update).
    const remote: RemoteSnapshot = {
      ...emptyRemote(),
      entityTypes: [
        { slug: "lead", properties: {}, organization_id: "org_self" },
        {
          slug: "lead",
          properties: { foreign: { type: "string" } },
          organization_id: "org_other",
        },
      ],
    };
    const plan = computeDiff(desiredKeepingLead(), remote, {
      prune: true,
      orgId: "org_self",
    });
    const leadRow = plan.rows.find(
      (r) => r.kind === "entity-type" && r.id === "lead"
    );
    expect(leadRow?.verb).toBe("noop");
    expect(plan.rows.some((r) => r.verb === "delete")).toBe(false);
  });

  test("connector prune suppressed when a local def has an unresolved (null) key", () => {
    const desired = buildState([], {
      connectors: {
        definitions: [
          {
            key: null,
            sourcePath: "/proj/connectors/local.connector.ts",
            sourceCode: "export default class {}",
            sourceFile: "connectors/local.connector.ts",
          },
        ],
        authProfiles: [],
        connections: [],
      },
    });
    const plan = computeDiff(desired, remoteWithExtras(), {
      prune: true,
    });
    // Can't map remote connectors to the unnamed local def → never delete them.
    expect(
      plan.rows.some(
        (r) => r.kind === "connector-definition" && r.verb === "delete"
      )
    ).toBe(false);
  });

  test("delete rows render with a removed-from-config note + summary count", () => {
    const plan = computeDiff(desiredKeepingLead(), remoteWithExtras(), {
      prune: true,
      baseline: baselineOwningExtras(),
    });
    expect(renderPlan(plan)).toContain("will be deleted");
    expect(renderSummary(plan)).toContain("4 delete");
    // Prune-off summary stays clean (no delete part).
    expect(
      renderSummary(computeDiff(desiredKeepingLead(), emptyRemote()))
    ).not.toContain("delete");
  });
});
