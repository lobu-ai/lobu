import { describe, expect, test } from "bun:test";
import chalk from "chalk";
import { buildAttributionAndOwned, toBaseline } from "../deployment.js";
import type { DesiredEntityType, DesiredState } from "../desired-state.js";
import {
  type Baseline,
  type BlockingDriftRow,
  computeDiff,
  ownedKey,
  type RemoteSnapshot,
} from "../diff.js";

chalk.level = 0;

function buildState(entityTypes: DesiredEntityType[]): DesiredState {
  return {
    agents: [],
    prune: false,
    memorySchema: { entityTypes, relationshipTypes: [] },
    automations: [],
    connectors: { definitions: [], authProfiles: [], connections: [] },
    providers: [],
    requiredSecrets: [],
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

function taskType(
  overrides: Partial<DesiredEntityType> = {}
): DesiredEntityType {
  return {
    slug: "task",
    name: "Task",
    required: ["status"],
    properties: {
      status: {
        type: "string",
        enum: ["backlog", "active", "done"],
      },
    },
    ...overrides,
  };
}

function remoteTask(id = 1, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    slug: "task",
    name: "Task",
    required: ["status"],
    properties: {
      status: {
        type: "string",
        enum: ["backlog", "active", "done"],
      },
    },
    organization_id: "org-1",
    ...overrides,
  };
}

function baselineFor(
  attribution: RemoteSnapshot["entityTypes"],
  ownedIds: number[]
): Baseline {
  return {
    recorded: true,
    attribution: {
      entityTypes: attribution,
      relationshipTypes: [],
      automations: [],
    },
    owned: new Set(ownedIds.map((id) => ownedKey("entity-type", id))),
  };
}

describe("three-way attribution (baseline present)", () => {
  test("config moved a field with remote untouched → converges (update)", () => {
    const desired = buildState([
      taskType({
        name: "Task v2",
        properties: {
          status: {
            type: "string",
            enum: ["backlog", "active", "done", "archived"],
          },
        },
      }),
    ]);
    const remote = emptyRemote();
    remote.entityTypes = [remoteTask()];
    const baseline = baselineFor([remoteTask()], [1]);

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
    });
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("update");
    expect(row?.changedFields).toEqual(
      expect.arrayContaining(["name", "properties.status"])
    );
    expect(row?.changedValues).toEqual([
      { field: "name", from: "Task", to: "Task v2" },
      {
        field: "properties.status",
        from: {
          type: "string",
          enum: ["backlog", "active", "done"],
        },
        to: {
          type: "string",
          enum: ["backlog", "active", "done", "archived"],
        },
      },
    ]);
    expect(plan.counts.drift).toBe(0);
  });

  test("remote moved an un-declared annotation (board role) → blocking drift", () => {
    const desired = buildState([
      taskType(), // config does NOT declare x-lobu.role
    ]);
    const remote = emptyRemote();
    remote.entityTypes = [
      remoteTask(1, {
        properties: {
          status: {
            type: "string",
            enum: ["backlog", "active", "done"],
            "x-lobu": { role: "workflowState" },
          },
        },
      }),
    ];
    const baseline = baselineFor([remoteTask(1)], [1]); // baseline lacks the annotation

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
    });
    const drift = plan.rows.filter((r) => r.verb === "drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      kind: "entity-type",
      id: "task",
      field: "properties.status",
      blocking: true,
    });
    expect(plan.counts.drift).toBe(1);
  });

  test("both config and remote moved the same field → blocking drift (never config-wins)", () => {
    const desired = buildState([
      taskType({
        properties: {
          status: {
            type: "string",
            enum: ["backlog", "active", "done", "blocked"],
          },
        },
      }),
    ]);
    const remote = emptyRemote();
    remote.entityTypes = [
      remoteTask(1, {
        properties: {
          status: { type: "string", enum: ["backlog", "active", "someday"] },
        },
      }),
    ];
    const baseline = baselineFor([remoteTask(1)], [1]); // baseline = original enum

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
    });
    const drift = plan.rows.filter((r) => r.verb === "drift");
    expect(drift.some((r) => r.blocking && r.id === "task")).toBe(true);
  });

  test("recorded empty attribution blocks an un-attributed remote mismatch", () => {
    const desired = buildState([taskType({ name: "Task v2" })]);
    const remote = emptyRemote();
    remote.entityTypes = [remoteTask()];
    // A recorded baseline exists but has no entry for this definition.
    const baseline = baselineFor([], []);

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
    });
    expect(plan.rows.some((r) => r.verb === "drift" && r.blocking)).toBe(true);
    expect(plan.rows.some((r) => r.verb === "update")).toBe(false);
  });
});

describe("owned-based delete classification (baseline present)", () => {
  test("remote-only definition IN owned + unchanged + prune → config-expressed delete", () => {
    const desired = buildState([]);
    const remote = emptyRemote();
    remote.entityTypes = [remoteTask(7)];
    const baseline = baselineFor([remoteTask(7)], [7]);

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
      prune: true,
    });
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("delete");
  });

  test("owned + unchanged but prune=false → drift, never delete (default is non-destructive)", () => {
    const desired = buildState([]);
    const remote = emptyRemote();
    remote.entityTypes = [remoteTask(7)];
    const baseline = baselineFor([remoteTask(7)], [7]);

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
      prune: false,
    });
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("drift");
    expect(plan.counts.delete).toBe(0);
  });

  test("unowned + prune=false → informational drift without blocking other updates", () => {
    const desired = buildState([taskType({ name: "Task Renamed" })]);
    const remote = emptyRemote();
    remote.entityTypes = [
      remoteTask(1),
      remoteTask(9, { slug: "ui_made", name: "UI Made" }),
    ];
    const baseline = baselineFor([remoteTask(1)], [1]);

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
      prune: false,
    });
    const row = plan.rows.find((r) => r.id === "ui_made");
    expect(row?.verb).toBe("drift");
    expect((row as { blocking?: boolean }).blocking).toBeUndefined();
    expect(plan.rows.find((r) => r.id === "task")?.verb).toBe("update");
  });

  test("unowned + prune=true → blocking drift, never delete", () => {
    const desired = buildState([]);
    const remote = emptyRemote();
    remote.entityTypes = [remoteTask(9)]; // id 9 never applied by this config
    const baseline = baselineFor([], []);

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
      prune: true,
    });
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("drift");
    expect((row as any).blocking).toBe(true);
    expect(plan.counts.delete).toBe(0);
  });

  test("remote-only blocks expose only display metadata for every definition kind", () => {
    const desired = buildState([]);
    const remote = emptyRemote();
    remote.entityTypes = [
      remoteTask(9, {
        slug: "ui_made",
        name: "UI Made",
        description: "Created from the dashboard",
        properties: { token: { default: "DO_NOT_RENDER" } },
      }),
    ];
    remote.relationshipTypes = [
      {
        id: 10,
        slug: "linked_to",
        name: "Linked to",
        description: "Dashboard relationship",
        rules: [{ source: "DO_NOT_RENDER", target: "task" }],
        organization_id: "org-1",
      },
    ];
    remote.automations = [
      {
        automation_id: "b-11",
        slug: "chat-slack-97",
        name: "Messages in slack:D095U1QV667",
        description: "Chat subscription",
        prompt: "DO_NOT_RENDER",
      },
    ];

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline: baselineFor([], []),
      prune: true,
    });
    const blocked = plan.rows.filter(
      (row): row is BlockingDriftRow =>
        row.verb === "drift" && "blocking" in row && row.blocking === true
    );
    expect(
      blocked.map(({ kind, id, remoteChange }) => ({
        kind,
        id,
        remoteChange,
      }))
    ).toEqual([
      {
        kind: "entity-type",
        id: "ui_made",
        remoteChange: {
          name: "UI Made",
          description: "Created from the dashboard",
        },
      },
      {
        kind: "relationship-type",
        id: "linked_to",
        remoteChange: {
          name: "Linked to",
          description: "Dashboard relationship",
        },
      },
      {
        kind: "automation",
        id: "chat-slack-97",
        remoteChange: {
          name: "Messages in slack:D095U1QV667",
          description: "Chat subscription",
        },
      },
    ]);
    expect(
      JSON.stringify(blocked.map((row) => row.remoteChange))
    ).not.toContain("DO_NOT_RENDER");
  });

  test("remote-only definition IN owned but edited after baseline → blocking drift (never delete)", () => {
    const desired = buildState([]);
    const remote = emptyRemote();
    remote.entityTypes = [
      remoteTask(7, { name: "Task edited in UI" }), // differs from baseline
    ];
    const baseline = baselineFor([remoteTask(7)], [7]);

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
      prune: true,
    });
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("drift");
    expect((row as any).blocking).toBe(true);
    expect(plan.counts.delete).toBe(0);
  });

  test("UI-created connector (unowned) with a baseline → blocking drift, never deleted under prune", () => {
    const desired = buildState([]);
    const remote = emptyRemote();
    remote.connectorDefinitions = [
      { key: "github", id: 42, installed: true } as any,
    ];
    const baseline = baselineFor([], []);

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
      prune: true,
    });
    const row = plan.rows.find((r) => r.kind === "connector-definition");
    expect(row?.verb).toBe("drift");
    expect((row as any).blocking).toBe(true);
    expect(plan.counts.delete).toBe(0);
  });

  test("config-applied connector (owned) + prune → delete", () => {
    const desired = buildState([]);
    const remote = emptyRemote();
    remote.connectorDefinitions = [
      { key: "github", id: 7, installed: true, version: "1.0.0" } as any,
    ];
    const baseline = baselineFor([], [7]);
    baseline.owned.add("connector-definition:7");
    baseline.connectorVersions = { github: "1.0.0" };

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
      prune: true,
    });
    const row = plan.rows.find((r) => r.kind === "connector-definition");
    expect(row?.verb).toBe("delete");
  });

  test("owned connector edited after baseline (version change) → blocking drift, never delete", () => {
    const desired = buildState([]);
    const remote = emptyRemote();
    // Same incarnation id, but version advanced via out-of-band reinstall.
    remote.connectorDefinitions = [
      { key: "github", id: 7, installed: true, version: "2.0.0" } as any,
    ];
    const baseline = baselineFor([], [7]);
    baseline.owned.add("connector-definition:7");
    baseline.connectorVersions = { github: "1.0.0" };

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
      prune: true,
    });
    const row = plan.rows.find((r) => r.kind === "connector-definition");
    expect(row?.verb).toBe("drift");
    expect((row as any).blocking).toBe(true);
    expect(plan.counts.delete).toBe(0);
  });

  test("same-slug recreation (new id) after a delete-with-lost-summary → blocking drift", () => {
    const desired = buildState([]);
    const remote = emptyRemote();
    // User re-created `task` in the UI → NEW incarnation id 99, same slug/value.
    remote.entityTypes = [remoteTask(99)];
    // Stale baseline still lists the OLD id 7 as owned (the delete's summary
    // POST failed, so ownership never advanced).
    const baseline = baselineFor([remoteTask(7)], [7]);

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
      prune: true,
    });
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("drift");
    expect((row as any).blocking).toBe(true);
    expect(plan.counts.delete).toBe(0);
  });
});

describe("three-way edge cases", () => {
  test("in-sync definition missing from a recorded baseline → noop", () => {
    const desired = buildState([taskType()]);
    const remote = emptyRemote();
    remote.entityTypes = [remoteTask()];
    // Baseline exists but has no entry for `task` — and desired == remote.
    const baseline = baselineFor([], []);

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
    });
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("noop");
    expect(plan.counts.drift).toBe(0);
  });

  test("config-omitted unmanaged facet (eventKinds) with remote untouched → noop, never cleared", () => {
    const desired = buildState([
      taskType(), // config does NOT declare eventKinds
    ]);
    const remote = emptyRemote();
    remote.entityTypes = [
      remoteTask(1, { eventKinds: { note: { description: "ui-authored" } } }),
    ];
    const baseline = baselineFor(
      [remoteTask(1, { eventKinds: { note: { description: "ui-authored" } } })],
      [1]
    );

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
    });
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("noop");
    expect(plan.counts.update).toBe(0);
    expect(plan.counts.drift).toBe(0);
  });

  test("under prune, already-empty required stays noop (no perpetual update)", () => {
    // Config omits required; remote/attribution already []. Must not emit
    // config-moved forever from undefined ≠ [].
    const desired = buildState([
      {
        slug: "task",
        name: "Task",
        properties: {
          status: { type: "string", enum: ["backlog", "active", "done"] },
        },
        // required intentionally omitted
      },
    ]);
    const remote = emptyRemote();
    remote.entityTypes = [
      remoteTask(1, { required: [] }), // already cleared
    ];
    const baseline = baselineFor([remoteTask(1, { required: [] })], [1]);

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
      prune: true,
    });
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("noop");
    expect(plan.counts.update).toBe(0);
  });

  test("recorded baseline missing an in-sync relationship → noop", () => {
    // The server defaults/keeps a display name the config never declared.
    // Comparing the omitted name against it blocked `lobu apply` forever on a
    // valid shape — omission is not an operator opinion (upsert never clears).
    const desired = buildState([]);
    desired.memorySchema.relationshipTypes = [
      { slug: "owns", rules: [{ source: "a", target: "b" }] } as any,
    ];
    const remote = emptyRemote();
    remote.relationshipTypes = [
      {
        id: 3,
        slug: "owns",
        name: "Owns",
        description: "server-side blurb",
        rules: [{ source: "a", target: "b" }],
        organization_id: "org-1",
      } as any,
    ];
    // The recorded baseline has no entry for `owns`.
    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline: baselineFor([], []),
    });
    expect(plan.rows.find((r) => r.kind === "relationship-type")?.verb).toBe(
      "noop"
    );
    expect(plan.counts.drift).toBe(0);
  });

  test("recorded baseline missing a changed relationship → block", () => {
    const desired = buildState([]);
    desired.memorySchema.relationshipTypes = [
      { slug: "owns", rules: [{ source: "a", target: "c" }] } as any,
    ];
    const remote = emptyRemote();
    remote.relationshipTypes = [
      {
        id: 3,
        slug: "owns",
        name: "Owns",
        rules: [{ source: "a", target: "b" }],
        organization_id: "org-1",
      } as any,
    ];
    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline: baselineFor([], []),
    });
    expect(plan.counts.drift).toBe(1);
  });

  test("recorded baseline missing an entity blocks prune-cleared facets", () => {
    // Under prune an omitted facet is a REMOVAL. Inheriting it made the gate
    // report noop while the apply would have wiped UI-authored kinds.
    const desired = buildState([taskType()]); // declares no eventKinds
    const remote = emptyRemote();
    remote.entityTypes = [
      remoteTask(1, {
        eventKinds: { note: { description: "ui-authored" } },
      }),
    ];
    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline: baselineFor([], []),
      prune: true,
    });
    expect(plan.counts.drift).toBe(1);
    expect(
      plan.rows.find((r) => r.kind === "entity-type" && r.verb === "drift")
    ).toBeDefined();
  });

  test("recorded baseline missing an entity keeps unmanaged facets outside prune", () => {
    const desired = buildState([taskType()]);
    const remote = emptyRemote();
    remote.entityTypes = [
      remoteTask(1, { eventKinds: { note: { description: "ui-authored" } } }),
    ];
    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline: baselineFor([], []),
    });
    expect(plan.rows.find((r) => r.kind === "entity-type")?.verb).toBe("noop");
    expect(plan.counts.drift).toBe(0);
  });

  test("recorded baseline missing an entity blocks a prune-dropped property", () => {
    const desired = buildState([taskType()]);
    const remote = emptyRemote();
    remote.entityTypes = [
      remoteTask(1, {
        properties: {
          status: { type: "string", enum: ["backlog", "active", "done"] },
          notes: { type: "string" },
        },
      }),
    ];
    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline: baselineFor([], []),
      prune: true,
    });
    expect(plan.counts.drift).toBe(1);
  });

  test("relationship rules omission records [] so a later config rule change converges", () => {
    // Config omits rules; apply clears them to []. Baseline must not keep the
    // pre-apply remote rules or the next rule edit looks like remote drift.
    const desired = buildState([]);
    desired.memorySchema.relationshipTypes = [
      { slug: "owns", name: "Owns" } as any, // no rules
    ];
    const remote = emptyRemote();
    remote.relationshipTypes = [
      {
        id: 3,
        slug: "owns",
        name: "Owns",
        rules: [{ source: "a", target: "b" }],
        organization_id: "org-1",
      } as any,
    ];
    const recorded = buildAttributionAndOwned(desired, remote, "org-1", false);
    const attr = recorded.attribution.relationshipTypes[0] as {
      rules?: unknown;
    };
    expect(attr.rules).toEqual([]);

    const nextDesired = buildState([]);
    nextDesired.memorySchema.relationshipTypes = [
      {
        slug: "owns",
        name: "Owns",
        rules: [{ source: "a", target: "c" }],
      },
    ];
    const afterRemote = emptyRemote();
    afterRemote.relationshipTypes = [
      {
        id: 3,
        slug: "owns",
        name: "Owns",
        rules: [],
        organization_id: "org-1",
      },
    ];
    const baseline: Baseline = {
      recorded: true,
      attribution: {
        entityTypes: [],
        relationshipTypes: recorded.attribution
          .relationshipTypes as Baseline["attribution"]["relationshipTypes"],
        automations: [],
      },
      owned: new Set(recorded.owned),
    };
    const plan = computeDiff(nextDesired, afterRemote, {
      orgId: "org-1",
      baseline,
    });
    const row = plan.rows.find((r) => r.kind === "relationship-type");
    expect(row?.verb).toBe("update");
    expect(row?.changedValues).toEqual([
      {
        field: "rules",
        from: [],
        to: [{ source: "a", target: "c" }],
      },
    ]);
  });

  test("outside prune, omitted description is preserved so a later owned delete stays eligible", () => {
    const desired = buildState([taskType()]); // no description
    const remote = emptyRemote();
    remote.entityTypes = [remoteTask(1, { description: "ui-authored blurb" })];
    const recorded = buildAttributionAndOwned(desired, remote, "org-1", false);
    const attr = recorded.attribution.entityTypes[0] as {
      description?: string;
    };
    expect(attr.description).toBe("ui-authored blurb");

    const afterRemote = emptyRemote();
    afterRemote.entityTypes = [
      remoteTask(1, { description: "ui-authored blurb" }),
    ];
    const baseline: Baseline = {
      recorded: true,
      attribution: {
        entityTypes: recorded.attribution
          .entityTypes as Baseline["attribution"]["entityTypes"],
        relationshipTypes: [],
        automations: [],
      },
      owned: new Set(recorded.owned),
    };
    const plan = computeDiff(buildState([]), afterRemote, {
      orgId: "org-1",
      baseline,
      prune: true,
    });
    expect(plan.rows.find((r) => r.kind === "entity-type")?.verb).toBe(
      "delete"
    );
  });

  test("under prune, recording attribution clears omitted facets so a later delete stays eligible", () => {
    // Config omits eventKinds under prune → apply clears them. The recorded
    // baseline must NOT keep the pre-apply eventKinds, or removing the type
    // next would look like a post-baseline edit and block.
    const desired = buildState([taskType()]); // no eventKinds
    const remote = emptyRemote();
    remote.entityTypes = [
      remoteTask(1, { eventKinds: { note: { description: "ui" } } }),
    ];
    const recorded = buildAttributionAndOwned(desired, remote, "org-1", true);
    const attr = recorded.attribution.entityTypes[0] as {
      eventKinds?: unknown;
    };
    expect(attr.eventKinds).toBeUndefined();

    // After apply the remote matches the cleared attribution.
    const afterRemote = emptyRemote();
    afterRemote.entityTypes = [remoteTask(1)]; // no eventKinds
    const baseline: Baseline = {
      recorded: true,
      attribution: {
        entityTypes: recorded.attribution
          .entityTypes as Baseline["attribution"]["entityTypes"],
        relationshipTypes: [],
        automations: [],
      },
      owned: new Set(recorded.owned),
    };
    // Now remove the type from config — owned + unchanged → delete under prune.
    const emptyDesired = buildState([]);
    const plan = computeDiff(emptyDesired, afterRemote, {
      orgId: "org-1",
      baseline,
      prune: true,
    });
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("delete");
  });

  test("unchanged declared resolutionPolicy round-trips as noop", () => {
    const desired = buildState([
      taskType({
        resolutionPolicy: {
          "x-lobu-resolution": { rules: [{ kind: "email" }] },
        },
      }),
    ]);
    const remote = emptyRemote();
    remote.entityTypes = [
      remoteTask(1, {
        schemaExtras: { "x-lobu-resolution": { rules: [{ kind: "email" }] } },
      }),
    ];
    const baseline = baselineFor(
      [
        remoteTask(1, {
          schemaExtras: { "x-lobu-resolution": { rules: [{ kind: "email" }] } },
        }),
      ],
      [1]
    );

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
    });
    const row = plan.rows.find((r) => r.kind === "entity-type");
    expect(row?.verb).toBe("noop");
    expect(plan.counts.drift).toBe(0);
  });
});

describe("Automation three-way attribution", () => {
  function desiredAutomation(overrides: Record<string, unknown> = {}) {
    return {
      slug: "digest",
      agent: "agent-a",
      name: "Digest",
      prompt: "Summarize",
      ...overrides,
    };
  }
  function remoteAutomation(overrides: Record<string, unknown> = {}) {
    return {
      slug: "digest",
      automation_id: "b-1",
      managed_agent_id: "agent-a",
      name: "Digest",
      prompt: "Summarize",
      ...overrides,
    };
  }

  test("recorded baseline missing an in-sync nameless Automation → noop", () => {
    // projectDesiredAutomation inherits the remote name as `?? null`; the remote
    // projection must normalize the same way, or deepEqual(null, undefined)
    // false-blocks an Automation the server never named.
    const desired = buildState([]);
    desired.automations = [
      { slug: "digest", agent: "agent-a", prompt: "Summarize" } as any,
    ];
    const remote = emptyRemote();
    remote.automations = [
      {
        slug: "digest",
        automation_id: "b-1",
        managed_agent_id: "agent-a",
        prompt: "Summarize",
        // name intentionally absent
      } as any,
    ];
    // The recorded baseline has no entry for `digest`.
    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline: baselineFor([], []),
    });
    expect(plan.rows.find((r) => r.kind === "automation")?.verb).toBe("noop");
    expect(plan.counts.drift).toBe(0);
  });

  test("remote agent reassignment → blocking drift (never silently overwritten)", () => {
    const desired = buildState([]);
    desired.automations = [desiredAutomation() as any];
    const remote = emptyRemote();
    remote.automations = [
      remoteAutomation({ managed_agent_id: "agent-b" }) as any,
    ];
    const baseline = {
      recorded: true,
      attribution: {
        entityTypes: [],
        relationshipTypes: [],
        automations: [remoteAutomation()],
      },
      owned: new Set<string>(["automation:b-1"]),
    };

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
    });
    const drift = plan.rows.filter((r) => r.verb === "drift");
    const row = drift.find(
      (r) =>
        r.kind === "automation" &&
        "blocking" in r &&
        r.blocking &&
        r.id === "digest"
    );
    expect(row).toMatchObject({
      field: "agent",
      remoteChange: "agent-b",
      desiredChange: "agent-a",
    });
  });

  test("unnamed Automation inherits remote name (server slug default) — second apply is noop", () => {
    const desired = buildState([]);
    // Config omits name — server stored name as the slug.
    desired.automations = [
      {
        slug: "digest",
        agent: "agent-a",
        prompt: "Summarize",
      } as any,
    ];
    const remote = emptyRemote();
    remote.automations = [
      remoteAutomation({ name: "digest", prompt: "Summarize" }) as any,
    ];
    const baseline = {
      recorded: true,
      attribution: {
        entityTypes: [],
        relationshipTypes: [],
        automations: [
          remoteAutomation({ name: "digest", prompt: "Summarize" }),
        ],
      },
      owned: new Set<string>(["automation:b-1"]),
    };
    const plan = computeDiff(desired, remote, { orgId: "org-1", baseline });
    expect(plan.rows.some((r) => r.verb === "drift" && r.blocking)).toBe(false);
    expect(
      plan.rows.find((r) => r.kind === "automation" && r.id === "digest")?.verb
    ).toBe("noop");
  });

  test("declared Automation changes carry field names but deliberately no values", () => {
    const desired = buildState([]);
    desired.automations = [
      desiredAutomation({ agent: "agent-b", name: "Daily Digest" }) as any,
    ];
    const remote = emptyRemote();
    remote.automations = [remoteAutomation({ name: "Digest" }) as any];
    const baseline = {
      recorded: true,
      attribution: {
        entityTypes: [],
        relationshipTypes: [],
        automations: [remoteAutomation({ name: "Digest" })],
      },
      owned: new Set<string>(["automation:b-1"]),
    };
    const plan = computeDiff(desired, remote, { orgId: "org-1", baseline });
    const row = plan.rows.find(
      (r) => r.kind === "automation" && r.id === "digest"
    );
    expect(row?.verb).toBe("update");
    expect(row?.changedFields).toEqual(
      expect.arrayContaining(["managed_agent_id", "name"])
    );
    // Automations reach the plan through the two-way `diffAutomation` row, whose
    // field identifiers differ from the projection's (`agent` vs `managed_agent_id`).
    // Rendering values there needed a name-mapping table that was not worth
    // its weight, so Automations keep the bare field-name list on purpose.
    expect(row).not.toHaveProperty("changedValues");
  });

  test("adopted remote agent + config prompt change converges (no whole-object false block)", () => {
    // Remote moved agent to B; config adopts B and also changes prompt.
    // Whole-object three-way would block; per-field must converge the prompt.
    const desired = buildState([]);
    desired.automations = [
      desiredAutomation({ agent: "agent-b", prompt: "new prompt" }) as any,
    ];
    const remote = emptyRemote();
    remote.automations = [
      remoteAutomation({
        managed_agent_id: "agent-b",
        prompt: "old prompt",
      }) as any,
    ];
    const baseline = {
      recorded: true,
      attribution: {
        entityTypes: [],
        relationshipTypes: [],
        automations: [
          remoteAutomation({
            managed_agent_id: "agent-a",
            prompt: "old prompt",
          }),
        ],
      },
      owned: new Set<string>(["automation:b-1"]),
    };

    const plan = computeDiff(desired, remote, {
      orgId: "org-1",
      baseline,
    });
    expect(plan.rows.some((r) => r.verb === "drift" && r.blocking)).toBe(false);
    const row = plan.rows.find(
      (r) => r.kind === "automation" && r.id === "digest"
    );
    expect(row?.verb).toBe("update");
  });

  test("config-omitted sources on an Automation are unmanaged — never false-block re-apply", () => {
    // Config only declares prompt; remote carries UI-authored sources.
    // Updating prompt must converge, and the post-apply attribution must
    // preserve those sources so the next apply is a noop (not remote-moved).
    const desired = buildState([]);
    desired.automations = [
      desiredAutomation({ prompt: "new summary" }) as any, // no sources
    ];
    const sources = [{ id: "s1", kind: "events", query: "select 1" }];
    const remote = emptyRemote();
    remote.automations = [
      remoteAutomation({ prompt: "old summary", sources }) as any,
    ];
    const baseline = {
      recorded: true,
      attribution: {
        entityTypes: [],
        relationshipTypes: [],
        automations: [remoteAutomation({ prompt: "old summary", sources })],
      },
      owned: new Set<string>(["automation:b-1"]),
    };

    const first = computeDiff(desired, remote, { orgId: "org-1", baseline });
    const update = first.rows.find(
      (r) => r.kind === "automation" && r.verb === "update"
    );
    expect(update).toBeTruthy();
    expect(first.rows.some((r) => r.verb === "drift" && r.blocking)).toBe(
      false
    );

    // After apply: remote has the new prompt; sources still live remotely.
    const afterRemote = emptyRemote();
    afterRemote.automations = [
      remoteAutomation({ prompt: "new summary", sources }) as any,
    ];
    const recorded = buildAttributionAndOwned(desired, afterRemote);
    expect(
      (recorded.attribution.automations[0] as { sources?: unknown }).sources
    ).toEqual(sources);

    const second = computeDiff(desired, afterRemote, {
      orgId: "org-1",
      baseline: {
        recorded: true,
        attribution: recorded.attribution as Baseline["attribution"],
        owned: new Set(recorded.owned),
      },
    });
    expect(second.rows.some((r) => r.verb === "drift" && r.blocking)).toBe(
      false
    );
    expect(
      second.rows.find((r) => r.kind === "automation" && r.id === "digest")
        ?.verb
    ).toBe("noop");
  });
});

// A legacy manifest has no attribution/owned. Its next apply may converge
// declared definitions, but cannot delete definitions of unknown provenance.
describe("legacy org — no baseline was ever recorded", () => {
  test("prune off: a UI-created definition the config never mentions is informational drift, not a block", () => {
    const remote = emptyRemote();
    remote.entityTypes = [
      { id: 7, slug: "ui_made", name: "UI Made", organization_id: "org1" },
    ] as RemoteSnapshot["entityTypes"];
    const plan = computeDiff(buildState([]), remote, {
      prune: false,
      baseline: toBaseline(null),
      orgId: "org1",
    });
    const row = plan.rows.find((r) => r.id === "ui_made");
    expect(row?.verb).toBe("drift");
    expect((row as { blocking?: boolean }).blocking).toBeUndefined();
  });

  test("prune off: an ordinary declared config change still applies", () => {
    const remote = emptyRemote();
    remote.entityTypes = [remoteTask(1, { name: "Task" })];
    const plan = computeDiff(
      buildState([taskType({ name: "Task Renamed" })]),
      remote,
      { prune: false, baseline: toBaseline(null), orgId: "org-1" }
    );
    const blocking = plan.rows.filter(
      (r) => r.verb === "drift" && (r as { blocking?: boolean }).blocking
    );
    expect(blocking).toEqual([]);
    expect(plan.rows.find((r) => r.id === "task")?.verb).toBe("update");
  });

  test("prune ON: an un-provable definition BLOCKS rather than being deleted", () => {
    const remote = emptyRemote();
    remote.entityTypes = [
      { id: 7, slug: "ui_made", name: "UI Made", organization_id: "org1" },
    ] as RemoteSnapshot["entityTypes"];
    const plan = computeDiff(buildState([]), remote, {
      prune: true,
      baseline: toBaseline(null),
      orgId: "org1",
    });
    const row = plan.rows.find((r) => r.id === "ui_made");
    expect(row?.verb).toBe("drift");
    expect((row as { blocking?: boolean }).blocking).toBe(true);
    expect(plan.rows.some((r) => r.verb === "delete")).toBe(false);
  });

  test("prune ON: an un-provable connector BLOCKS rather than being uninstalled", () => {
    const remote = emptyRemote();
    remote.connectorDefinitions = [{ id: 8, key: "github", installed: true }];
    const plan = computeDiff(buildState([]), remote, {
      prune: true,
      baseline: toBaseline(null),
      orgId: "org1",
    });
    const row = plan.rows.find((r) => r.kind === "connector-definition");
    expect(row?.verb).toBe("drift");
    expect((row as { blocking?: boolean }).blocking).toBe(true);
    expect(plan.rows.some((r) => r.verb === "delete")).toBe(false);
  });

  test("a second model edit after a recorded baseline is an update, not remote-moved drift", () => {
    const desired = buildState([]);
    desired.automations = [
      {
        slug: "digest",
        agent: "triage",
        name: "Digest",
        prompt: "Produce a digest.",
        triggers: [{ kind: "schedule", cron: "0 9 * * 1" }],
        deviceWorkerId: "dev-1",
        agentKind: "opencode",
        model: "opencode-go/deepseek-v4-flash",
      },
    ];
    const remote = emptyRemote();
    remote.agents = [{ agentId: "triage", name: "triage" }];
    remote.agentSettings = new Map([["triage", null]]);
    remote.automations = [
      {
        slug: "digest",
        automation_id: "1",
        managed_agent_id: "triage",
        name: "Digest",
        prompt: "Produce a digest.",
        triggers: [{ kind: "schedule", cron: "0 9 * * 1" }],
        device_worker_id: "dev-1",
        agent_kind: "opencode",
        execution_config: { model: "opencode-go/deepseek-v4-flash" },
      },
    ];
    // Record the post-apply baseline as buildAttributionAndOwned does.
    const recorded = buildAttributionAndOwned(desired, remote, "org-1", false);
    const baseline: Baseline = {
      recorded: true,
      attribution: {
        ...recorded.attribution,
        automations: recorded.attribution.automations,
      },
      owned: new Set(recorded.owned),
    };

    // Desired model B — the diff must classify this as an update (not a
    // blocking "remote moved" drift on `model`).
    const nextDesired = buildState([]);
    nextDesired.automations = [
      {
        slug: "digest",
        agent: "triage",
        name: "Digest",
        prompt: "Produce a digest.",
        triggers: [{ kind: "schedule", cron: "0 9 * * 1" }],
        deviceWorkerId: "dev-1",
        agentKind: "opencode",
        model: "opencode-go/deepseek-v4-pro",
      },
    ];
    const plan = computeDiff(nextDesired, remote, {
      orgId: "org-1",
      baseline,
    });
    const row = plan.rows.find((r) => r.kind === "automation");
    expect(row?.verb).toBe("update");
    expect(row?.changedFields).toContain("execution_config");
    // No blocking drift mislabeling the model edit as remote-moved.
    const drift = plan.rows.find(
      (r) =>
        r.kind === "automation" &&
        (r as { changedValues?: Array<{ field: string }> }).changedValues?.some(
          (v) => v.field === "model"
        ) &&
        (r as { blocking?: boolean }).blocking === true
    );
    expect(drift).toBeUndefined();
  });
});
