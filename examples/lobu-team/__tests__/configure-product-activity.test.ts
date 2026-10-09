import { describe, expect, mock, test } from "bun:test";
import { configureProductActivityDigest } from "../scripts/configure-product-activity";

function harness(pendingAt?: number, status = "completed") {
  const calls: string[] = [];
  const pending = { status: "pending_approval", run_id: 123 };
  const mutation = (name: string) =>
    mock(async () => {
      calls.push(name);
      return calls.length === pendingAt ? pending : { action: name };
    });
  const automations = {
    get: mock(async () => ({
      automation: {
        slug: "product-activity-digest",
        automation_run: { status },
      },
    })),
    update: mutation("update"),
    setReactionScript: mutation("set_reaction_script"),
    createVersion: mutation("create_version"),
  };
  return {
    calls,
    pending,
    automations,
    run: () =>
      configureProductActivityDigest(
        { automations } as unknown as Parameters<
          typeof configureProductActivityDigest
        >[0],
        "42",
        "export default async () => {};"
      ),
  };
}

describe("external production digest configuration", () => {
  test("stops at each approval before attempting dependent mutations", async () => {
    for (const pendingAt of [1, 2, 3, 4, 5]) {
      const h = harness(pendingAt);
      expect(await h.run()).toEqual(h.pending);
      expect(h.calls).toHaveLength(pendingAt);
    }
  });

  test("waits for existing work after stopping the schedule", async () => {
    for (const status of ["pending", "claimed", "running"]) {
      const h = harness(undefined, status);
      await expect(h.run()).rejects.toThrow("wait for the active digest run");
      expect(h.calls).toEqual(["update"]);
    }
  });

  test("installs analysis before enabling the external schedule", async () => {
    const h = harness();
    await h.run();
    expect(h.calls).toEqual([
      "update",
      "set_reaction_script",
      "update",
      "create_version",
      "update",
    ]);
    expect(h.automations.update).toHaveBeenNthCalledWith(2, {
      automation_id: "42",
      triggers: [],
      device_worker_id: null,
      agent_kind: null,
      execution_config: { executor: { kind: "external" } },
    });
    expect(h.automations.update).toHaveBeenLastCalledWith({
      automation_id: "42",
      triggers: [
        {
          kind: "schedule",
          cron: "*/20 * * * *",
          timezone: "UTC",
          skip_if_unchanged: false,
        },
      ],
    });
  });
});
