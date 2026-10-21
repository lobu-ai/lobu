import { describe, expect, test } from "bun:test";
import chalk from "chalk";
import type {
  DiffPlan,
  DiffRow,
  EntityTypeDiffRow,
  AutomationDiffRow,
} from "../diff.js";
import { renderBlockedReport, renderPlan } from "../render.js";

chalk.level = 0;

function planOf(rows: DiffRow[]): DiffPlan {
  return {
    rows,
    counts: { create: 0, update: rows.length, noop: 0, drift: 0, delete: 0 },
    notes: [],
  };
}

function updateRow(
  changedValues?: Array<{ field: string; from: unknown; to: unknown }>
): EntityTypeDiffRow {
  return {
    kind: "entity-type",
    verb: "update",
    id: "task",
    changedFields: ["name", "description"],
    ...(changedValues ? { changedValues } : {}),
  };
}

describe("plan renders the values an update would overwrite", () => {
  test("prints `field: remote → config` instead of a bare field-name list", () => {
    const out = renderPlan(
      planOf([
        updateRow([
          { field: "name", from: "Task", to: "Task Renamed" },
          { field: "description", from: undefined, to: "A unit of work." },
        ]),
      ])
    );
    expect(out).toContain('name: "Task" → "Task Renamed"');
    expect(out).toContain('description: (unset) → "A unit of work."');
    // The trailing "(name, description)" would now repeat the same information.
    expect(out).not.toContain("(name, description)");
  });

  test("falls back to the field-name list when no values were computed", () => {
    // Two-way rows (agents, connections, provider keys) carry no value pair —
    // deliberately, since that path covers the secret-bearing always-update
    // rows. They must keep rendering, just without values.
    const out = renderPlan(planOf([updateRow()]));
    expect(out).toContain("(name, description)");
    expect(out).not.toContain("→");
  });

  test("keeps names for changes whose values are intentionally hidden", () => {
    const row: EntityTypeDiffRow = {
      kind: "entity-type",
      verb: "update",
      id: "task",
      changedFields: ["name", "backing"],
      changedValues: [{ field: "name", from: "Old", to: "New" }],
    };
    const out = renderPlan(planOf([row]));
    expect(out).toContain("(backing)");
    expect(out).toContain('name: "Old" → "New"');
  });

  test("an Automation row renders field names only — no values, by design", () => {
    // Automations carry no `changedValues`; AutomationDiffRow has no such field, so
    // this is enforced by the type system, not just by this assertion.
    const row: AutomationDiffRow = {
      kind: "automation",
      verb: "update",
      id: "digest",
      changedFields: ["prompt", "reaction_script"],
    };
    const out = renderPlan(planOf([row]));
    expect(out).toContain("(prompt, reaction_script)");
    expect(out).not.toContain("→");
  });

  test("truncates a long value instead of flooding the plan", () => {
    const long = "x".repeat(400);
    const out = renderPlan(
      planOf([updateRow([{ field: "description", from: "short", to: long }])])
    );
    expect(out).toContain("…");
    expect(out).not.toContain(long);
    for (const line of out.split("\n")) expect(line.length).toBeLessThan(200);
  });
});

describe("blocked report shows both sides of the disagreement", () => {
  test("prints the config value next to the remote one", () => {
    const out = renderBlockedReport([
      {
        kind: "entity-type",
        verb: "drift",
        blocking: true,
        id: "task",
        field: "name",
        remoteChange: "Task EDITED IN UI",
        desiredChange: "Task",
      },
    ]);
    expect(out).toContain('remote: "Task EDITED IN UI"');
    expect(out).toContain('config: "Task"');
  });

  test("a desired field absent remotely still shows both sides", () => {
    // Gating the pair on `remoteChange` alone would hide this disagreement.
    const out = renderBlockedReport([
      {
        kind: "entity-type",
        verb: "drift",
        blocking: true,
        id: "task",
        field: "properties.status",
        remoteChange: undefined,
        desiredChange: { type: "string" },
      },
    ]);
    expect(out).toContain("remote: (absent)");
    expect(out).toContain('"type": "string"');
  });

  test("a whole-definition block identifies the definition", () => {
    const out = renderBlockedReport([
      {
        kind: "automation",
        verb: "drift",
        blocking: true,
        id: "chat-slack-97",
        remoteChange: {
          name: "Messages in slack:D095U1QV667",
          description: "Chat subscription",
        },
      },
    ]);
    expect(out).toContain("chat-slack-97");
    expect(out).toContain('"name": "Messages in slack:D095U1QV667"');
    expect(out).toContain('"description": "Chat subscription"');
    expect(out).toContain("config: (not declared)");
  });

  test("a field the config does not declare still renders", () => {
    const out = renderBlockedReport([
      {
        kind: "entity-type",
        verb: "drift",
        blocking: true,
        id: "task",
        field: "eventKinds",
        remoteChange: ["ui.created"],
        desiredChange: undefined,
      },
    ]);
    expect(out).toContain('"ui.created"');
    expect(out).toContain("config: (not declared)");
  });
});

describe("plan renders every row kind", () => {
  test("a view row gets its own section, not only a count in the summary", () => {
    const out = renderPlan(
      planOf([{ kind: "view", verb: "update", id: "pipeline" }])
    );
    expect(out).toContain("  views:");
    expect(out).toContain("~ view pipeline");
  });
});
