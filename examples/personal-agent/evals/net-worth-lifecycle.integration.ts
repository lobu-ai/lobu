import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertEntityApprovalPolicy } from "../../../packages/server/src/authz/entity-policy";
import { dispatchPendingAutomationRuns } from "../../../packages/server/src/automations/automation";
import { runAutomationScriptTask } from "../../../packages/server/src/automations/script-task";
import type { Env } from "../../../packages/server/src/index";
import { createAutomationRun } from "../../../packages/server/src/runs/queue-service";
import { NOTIFICATION_DELIVERY_TASK } from "../../../packages/server/src/scheduled/task-definitions";
import { initWorkspaceProvider } from "../../../packages/server/src/workspace";
import {
  cleanupTestDatabase,
  getTestDb,
} from "../../../packages/server/src/__tests__/setup/test-db";
import {
  createTestAgent,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEvent,
} from "../../../packages/server/src/__tests__/setup/test-fixtures";
import { TestWorkspace } from "../../../packages/server/src/__tests__/setup/test-mcp-client";
import config from "../lobu.config";

const definition = config.automations!.find(
  (item) => item.slug === "midas-net-worth"
)!;
const script = readFileSync(
  new URL("../net-worth.reaction.ts", import.meta.url),
  "utf8"
);
const START = "2026-08-01T00:00:00.000Z";
const END = "2026-08-12T09:00:00.000Z";
const ENV = { ENVIRONMENT: "test" } as Env;

// Real Postgres, SDK authorization, connector execution, script sandbox and
// durable writes. Only the quote provider is synthetic; no network or device.
async function setup(
  options: {
    loseNotificationResponse?: boolean;
    missingFx?: boolean;
    stale?: boolean;
  } = {}
) {
  const sql = getTestDb();
  const workspace = await TestWorkspace.create({ name: "Synthetic Net Worth" });
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
    agentId: "synthetic-net-worth-owner",
  });
  for (const key of ["midas", "market.quotes"]) {
    await createTestConnectorDefinition({
      key,
      name: `Synthetic ${key}`,
      organization_id: workspace.org.id,
    });
  }
  const midas = await createTestConnection({
    organization_id: workspace.org.id,
    connector_key: "midas",
    slug: "synthetic-midas",
  });
  await createTestConnection({
    organization_id: workspace.org.id,
    connector_key: "market.quotes",
    slug: "market-quotes",
  });
  await upsertEntityApprovalPolicy(workspace.org.id, {
    resourceClass: "connector_action",
    connectorKey: "market.quotes",
    effects: { execute: "auto" },
  });
  await sql`UPDATE connector_definitions SET actions_schema = ${sql.json({
    quote: {
      name: "Synthetic quotes",
      kind: "read",
      input_schema: {
        type: "object",
        properties: { symbols: { type: "array" } },
      },
    },
  })} WHERE key = 'market.quotes' AND organization_id = ${workspace.org.id}`;
  const quotes = [
    {
      id: "US:AAPL",
      market: "US",
      symbol: "AAPL",
      price: 125,
      currency: "USD",
    },
    ...(options.missingFx
      ? []
      : [
          {
            id: "FX:USD:DIRECT",
            market: "FX",
            symbol: "USDGBP=X",
            price: 0.8,
            currency: "GBP",
          },
        ]),
  ].map((quote) => ({
    ...quote,
    status: "quoted",
    provider_symbol: quote.symbol,
    provider: "synthetic",
    as_of: END,
    stale: false,
    tier: "fixture",
  }));
  await sql`UPDATE connector_versions SET compiled_code = ${`
    class ConnectorRuntime {
      async sync() { return { items: [] }; }
      async execute() { return { success: true, output: { quotes: ${JSON.stringify(quotes)} } }; }
    }
    module.exports = { ConnectorRuntime };
  `} WHERE connector_key = 'market.quotes'`;
  await createTestEvent({
    organization_id: workspace.org.id,
    connection_id: midas.id,
    connector_key: "midas",
    origin_id: "synthetic-holding-aapl",
    semantic_type: "financial_asset",
    content: "Synthetic holding",
    occurred_at: new Date(options.stale ? START : "2026-08-10T08:00:00Z"),
    metadata: {
      symbol: "AAPL",
      type: "US",
      shares: 2,
      price: 100,
      avg_cost: 80,
      value: 200,
      currency: "USD",
      status: "active",
    },
  });
  // Enough unrelated arrivals in an older week to expose accidental default
  // all-events window capping, even though valuation reads current books.
  for (let index = 0; index < 205; index++) {
    await createTestEvent({
      organization_id: workspace.org.id,
      content: "Unrelated synthetic arrival",
      created_at: new Date(Date.parse(START) + (index + 1) * 1_000),
    });
  }
  const source = options.loseNotificationResponse
    ? script.replace(
        "export default async function runNetWorthSnapshot",
        "async function runNetWorthSnapshot"
      ) +
      `
      export default async function(ctx, client) {
        await runNetWorthSnapshot(ctx, {
          query: (...args) => client.query(...args),
          connections: client.connections,
          operations: client.operations,
          knowledge: client.knowledge,
          notifications: { send: async (input) => {
            const result = await client.notifications.send(input);
            if (result.notified_count > 0) throw new Error("Synthetic response lost after notification commit");
            return result;
          } }
        });
      }`
    : script;
  const created = await workspace.owner.automations.create({
    slug: definition.slug,
    name: definition.name,
    managed_agent_id: agent.agentId,
    triggers: definition.triggers,
    sources: Object.entries(definition.sources ?? {}).map(([name, value]) => ({
      name,
      ...(typeof value === "string" ? { query: value } : value),
    })),
    ...(definition.executor
      ? { execution_config: { executor: { kind: "script" as const, source } } }
      : { prompt: definition.prompt }),
  });
  const automationId = Number(created.automation_id);
  await sql`UPDATE automations SET next_window_start = ${START}::timestamptz,
    next_run_at = now() - interval '1 hour' WHERE id = ${automationId}`;
  const run = await createAutomationRun({
    organizationId: workspace.org.id,
    agentId: agent.agentId,
    automationId,
    windowStart: START,
    windowEnd: END,
    dispatchSource: "scheduled",
    expectedWindowStart: START,
  });
  const [queued] =
    await sql`SELECT approved_input FROM runs WHERE id = ${run.runId}`;
  expect(queued.approved_input.executor?.kind).toBe("script");
  expect(queued.approved_input.window_end).toBe(END);
  expect(queued.approved_input.window_truncated).toBeUndefined();
  expect(
    await dispatchPendingAutomationRuns({ runIds: [run.runId] })
  ).toMatchObject({
    dispatched: 1,
    failed: 0,
  });
  const [task] =
    await sql`SELECT id FROM runs WHERE parent_run_id = ${run.runId} AND action_key = 'automation-script'`;
  expect(task).toBeDefined();
  await sql`UPDATE runs SET status = 'claimed', claimed_by = 'synthetic-net-worth-queue',
    claimed_at = now() WHERE id = ${task.id}`;
  return {
    sql,
    workspace,
    automationId,
    runId: run.runId,
    execute: (attempt = 1) =>
      runAutomationScriptTask(
        {
          organizationId: workspace.org.id,
          automationId,
          sourceRunId: run.runId,
        },
        ENV,
        Number(task.id),
        attempt
      ),
    async status() {
      const [row] =
        await sql`SELECT status, model_used, error_message FROM runs WHERE id = ${run.runId}`;
      return row;
    },
    snapshots:
      () => sql`SELECT id, metadata FROM events WHERE organization_id = ${workspace.org.id}
      AND semantic_type = 'summary' AND metadata->>'schema' = 'net-worth-snapshot/v4'`,
    notifications:
      () => sql`SELECT id, title FROM events WHERE organization_id = ${workspace.org.id}
      AND semantic_type = 'notification' ORDER BY id`,
  };
}

describe("weekly net worth through the native script lifecycle", () => {
  beforeEach(async () => {
    vi.stubEnv("LOBU_CLOUD_MODE", "false");
    await cleanupTestDatabase();
    await initWorkspaceProvider();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("retries uncertain writes without duplicating quotes, the weekly snapshot or its notification", async () => {
    const h = await setup({ loseNotificationResponse: true });
    await expect(h.execute()).rejects.toThrow(
      "Synthetic response lost after notification commit"
    );
    expect(await h.status()).toMatchObject({ status: "running" });
    await h.execute(2);
    expect(await h.status()).toMatchObject({
      status: "completed",
      model_used: "script",
      error_message: null,
    });
    const snapshots = await h.snapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].metadata).toMatchObject({
      week: "2026-W33",
      calculated_at: END,
      net_worth_gbp: 200,
    });
    const notifications = await h.notifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe("Net worth updated");
    const quoteRuns =
      await h.sql`SELECT status, parent_run_id FROM runs WHERE automation_id = ${h.automationId} AND action_key = 'quote'`;
    expect(quoteRuns).toHaveLength(1);
    expect(quoteRuns[0]).toMatchObject({
      status: "completed",
      parent_run_id: h.runId,
    });
    const deliveries =
      await h.sql`SELECT id FROM runs WHERE organization_id = ${h.workspace.org.id}
      AND action_key = ${NOTIFICATION_DELIVERY_TASK} AND (action_input->'payload'->>'eventId')::bigint = ${notifications[0].id}`;
    expect(deliveries).toHaveLength(1);
    const [cursor] =
      await h.sql`SELECT next_window_start, next_run_at > now() AS scheduled,
      consecutive_scheduled_failures FROM automations WHERE id = ${h.automationId}`;
    expect(new Date(cursor.next_window_start).toISOString()).toBe(END);
    expect(cursor).toMatchObject({
      scheduled: true,
      consecutive_scheduled_failures: 0,
    });
    const children =
      await h.sql`SELECT action_key FROM runs WHERE parent_run_id = ${h.runId}`;
    expect(children.map((row) => row.action_key)).not.toContain(
      "automation-reaction"
    );
    await h.execute(3);
    expect(await h.snapshots()).toHaveLength(1);
    expect(await h.notifications()).toHaveLength(1);
  });

  it("fails the run on missing FX, keeps the arrival mark, and sends one needs-attention notice", async () => {
    const h = await setup({ missingFx: true });
    await expect(h.execute()).rejects.toThrow(
      "Missing a defensible USD to GBP FX rate"
    );
    await h.execute(3);
    expect(await h.status()).toMatchObject({
      status: "failed",
      error_message: expect.stringContaining(
        "Missing a defensible USD to GBP FX rate"
      ),
    });
    expect(await h.snapshots()).toHaveLength(0);
    expect(await h.notifications()).toEqual([
      expect.objectContaining({ title: "Net worth needs attention" }),
    ]);
    const [cursor] =
      await h.sql`SELECT next_window_start, next_run_at > now() AS scheduled FROM automations WHERE id = ${h.automationId}`;
    expect(new Date(cursor.next_window_start).toISOString()).toBe(START);
    expect(cursor.scheduled).toBe(true);
  });

  it("preserves the existing explicit stale-source warning in the snapshot", async () => {
    const h = await setup({ stale: true });
    await h.execute();
    expect(await h.status()).toMatchObject({
      status: "completed",
      model_used: "script",
    });
    const [snapshot] = await h.snapshots();
    expect(snapshot.metadata.sources).toContainEqual(
      expect.objectContaining({ source: "midas", status: "stale", stale: true })
    );
  });
});
