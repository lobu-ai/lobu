import { describe, expect, mock, test } from "bun:test";
import {
  defineAgent,
  defineAutomation,
  defineConfig,
} from "../../../../config/define.js";
import { executePlan } from "../apply-cmd.js";
import { ApplyClient, type RemoteAutomation } from "../client.js";
import { buildAttributionAndOwned, toBaseline } from "../deployment.js";
import type { DesiredAutomation, DesiredState } from "../desired-state.js";
import { computeDiff, type RemoteSnapshot } from "../diff.js";
import { mapProjectToDesiredState } from "../map-config.js";

function emptyState(): DesiredState {
  return {
    agents: [],
    prune: false,
    memorySchema: { entityTypes: [], relationshipTypes: [] },
    automations: [],
    connectors: { definitions: [], authProfiles: [], connections: [] },
    providers: [],
    requiredSecrets: [],
  };
}

function snapshot(automation: RemoteAutomation): RemoteSnapshot {
  return {
    agents: [],
    agentSettings: new Map(),
    entityTypes: [],
    relationshipTypes: [],
    automations: [automation],
    connectorDefinitions: [],
    authProfiles: [],
    connections: [],
    feedsByConnectionId: new Map(),
    inferenceProviders: [],
  };
}

describe("Automation execution config", () => {
  test("applies script changes and records the executor for a stable second apply", async () => {
    const executor = {
      kind: "script" as const,
      source: "export default async () => ({ ok: true });",
      params: { first: 1, second: 2 },
    };
    const state = emptyState();
    state.automations = [
      { slug: "digest", agent: "worker", prompt: "", executor },
    ];
    const remote = snapshot({
      automation_id: "42",
      slug: "digest",
      managed_agent_id: "worker",
      prompt: "",
      execution_config: { model: "old/model" },
    });
    const plan = computeDiff(state, remote);
    const updateAutomation = mock(async () => undefined);
    await executePlan(
      {
        state,
        remote,
        plan,
        client: { updateAutomation } as unknown as ApplyClient,
      },
      []
    );
    expect(updateAutomation).toHaveBeenCalledWith({
      automation_id: "42",
      execution_config: { executor },
    });
    const recorded = buildAttributionAndOwned(state, remote);
    expect(recorded.attribution.automations[0]?.execution_config).toEqual({
      executor,
    });
    remote.automations[0]!.execution_config = {
      executor: { ...executor, params: { second: 2, first: 1 } },
    };
    expect(
      computeDiff(state, remote, { baseline: toBaseline(recorded) }).rows.every(
        (row) => row.verb === "noop"
      )
    ).toBe(true);
    state.automations[0]!.executor = null;
    const update = computeDiff(state, remote, {
      baseline: toBaseline(recorded),
    });
    expect(
      update.rows.some(
        (row) =>
          row.verb === "update" &&
          row.changedFields?.includes("execution_config")
      )
    ).toBe(true);
  });

  test("maps explicit model removal from declarative config", () => {
    const agent = defineAgent({ id: "worker" });
    const state = mapProjectToDesiredState(
      defineConfig({
        agents: [agent],
        automations: [
          defineAutomation({
            slug: "digest",
            agent,
            prompt: "Summarize.",
            model: null,
          }),
        ],
      }),
      {}
    );
    expect(state.automations[0]?.model).toBeNull();
  });

  test("omitting a model still preserves an existing override", () => {
    const state = emptyState();
    state.automations = [
      { slug: "digest", agent: "worker", prompt: "Summarize." },
    ];
    const remote = snapshot({
      slug: "digest",
      managed_agent_id: "worker",
      prompt: "Summarize.",
      execution_config: { model: "existing/model", timeout_seconds: 300 },
    });
    expect(
      computeDiff(state, remote).rows.every((row) => row.verb === "noop")
    ).toBe(true);
    expect(
      buildAttributionAndOwned(state, remote).attribution.automations[0]
        ?.execution_config
    ).toEqual(remote.automations[0]?.execution_config);
  });

  test.each([
    [
      "new/model",
      { model: "old/model", timeout_seconds: 300 },
      { model: "new/model", timeout_seconds: 300 },
    ],
    [
      null,
      { model: "old/model", timeout_seconds: 300 },
      { timeout_seconds: 300 },
    ],
    [null, { model: "old/model" }, null],
  ])("updates only the model and records a stable second apply: %j", async (model, executionConfig, expected) => {
    const state = emptyState();
    const desiredAutomation = {
      slug: "digest",
      agent: "worker",
      prompt: "Summarize.",
      model,
    } satisfies DesiredAutomation;
    state.automations = [desiredAutomation];
    const remoteAutomation: RemoteAutomation = {
      automation_id: "42",
      slug: "digest",
      managed_agent_id: "worker",
      prompt: "Summarize.",
      triggers: [],
      execution_config: executionConfig,
    };
    const remote = snapshot(remoteAutomation);
    const baseline = toBaseline(
      buildAttributionAndOwned(
        {
          ...state,
          automations: [{ ...desiredAutomation, model: "old/model" }],
        },
        remote
      )
    );
    const plan = computeDiff(state, remote, { baseline });
    expect(plan.rows.some((row) => row.verb === "drift")).toBe(false);
    const updateAutomation = mock(async () => undefined);
    await executePlan(
      {
        state,
        remote,
        plan,
        client: { updateAutomation } as unknown as ApplyClient,
      },
      []
    );
    expect(updateAutomation).toHaveBeenCalledWith({
      automation_id: "42",
      execution_config: expected,
    });

    const recorded = buildAttributionAndOwned(state, remote);
    expect(recorded.attribution.automations[0]?.execution_config).toEqual(
      expected
    );
    remoteAutomation.execution_config = expected;
    const second = computeDiff(state, remote, {
      baseline: toBaseline(recorded),
    });
    expect(second.rows.every((row) => row.verb === "noop")).toBe(true);
  });

  test("creates an Automation with a cleared model on the HTTP wire", async () => {
    const state = emptyState();
    state.automations = [
      {
        slug: "digest",
        agent: "worker",
        prompt: "Summarize.",
        model: null,
        triggers: [],
      },
    ];
    const remote = { ...snapshot({ slug: "unused" }), automations: [] };
    const requests: unknown[] = [];
    const client = new ApplyClient(
      {
        apiBaseUrl: "http://localhost:9999",
        orgSlug: "synthetic-org",
        token: "synthetic-token",
      },
      (async (_url: unknown, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({ automation_id: "42" });
      }) as typeof fetch
    );
    await executePlan(
      { state, remote, plan: computeDiff(state, remote), client },
      []
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      action: "create",
      managed_agent_id: "worker",
      execution_config: null,
      triggers: [],
    });
  });
});
