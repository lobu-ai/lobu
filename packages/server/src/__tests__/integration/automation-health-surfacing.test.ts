/**
 * Automation health surfacing (item 3, #2033).
 *
 * 3.1: manage_automations `list` returns a computed `health` field —
 *   `degraded` for an active automation that missed a firing, has a stale
 *   pending/claimed/running run, or whose latest run failed/timed out;
 *   `healthy` otherwise.
 *
 * 3.2: getSchedulerHealth (the /health/scheduler alarm path) surfaces overdue
 *   active automations and stuck-pending automation runs in `issues[]` — previously
 *   it filtered run_type='sync' ONLY, so automations were invisible to alerting.
 *
 * Automation runs carry run_type='automation' and are linked through
 * runs.automation_id.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { getSchedulerHealth } from "../../scheduled/scheduler-health";
import { manageAutomations } from "../../tools/admin/manage_automations";
import { getAutomation } from "../../tools/get_automation";
import { computeAutomationHealth } from "../../automations/automation-health";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import { createTestAgent, seedOwnerContext } from "../setup/test-fixtures";

async function createScheduledAutomation(): Promise<{
  automationId: number;
  ctx: Awaited<ReturnType<typeof seedOwnerContext>>["ctx"];
}> {
  const { org, user, ctx } = await seedOwnerContext();
  const agent = await createTestAgent({
    organizationId: org.id,
    ownerUserId: user.id,
  });
  const created = await manageAutomations(
    {
      action: "create",
      slug: `health-automation-${Date.now()}`,
      name: "Health automation",
      prompt: "Summarize newly landed content.",
      managed_agent_id: agent.agentId,
      sources: [
        {
          name: "github",
          query: "SELECT id, payload_text FROM events WHERE 1=0",
        },
      ],
      triggers: [
        {
          kind: "schedule",
          cron: "* * * * *",
          execution: "window",
          active_run: "coalesce",
        },
      ],
    },
    {} as Env,
    ctx,
  );
  if (created.action !== "create" || !("automation_id" in created)) {
    throw new Error("Automation creation did not complete");
  }
  return { automationId: Number(created.automation_id), ctx };
}

describe("automation health surfacing (#2033)", () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it("3.1 (unit): computeAutomationHealth is degraded for an active, overdue automation", () => {
    const now = Date.now();
    const degraded = computeAutomationHealth(
      {
        status: "active",
        // Overdue by 30 min — well past the 6-min missed-firing margin.
        nextRunAt: new Date(now - 30 * 60 * 1000).toISOString(),
      },
      now,
    );
    expect(degraded.health).toBe("degraded");
    expect(degraded.reasons.length).toBeGreaterThan(0);

    // An Automation scheduled in the future is healthy.
    const healthy = computeAutomationHealth(
      { status: "active", nextRunAt: new Date(now + 60 * 1000).toISOString() },
      now,
    );
    expect(healthy.health).toBe("healthy");

    // An in-flight run is NOT false-degraded even if next_run_at slipped.
    const inFlight = computeAutomationHealth(
      {
        status: "active",
        nextRunAt: new Date(now - 30 * 60 * 1000).toISOString(),
        latestRunStatus: "running",
      },
      now,
    );
    expect(inFlight.health).toBe("healthy");
  });

  it("3.1 (integration): manage_automations list returns health='degraded' for an overdue active automation", async () => {
    const { automationId, ctx } = await createScheduledAutomation();
    const sql = getTestDb();
    // Push next_run_at well into the past → missed firing.
    await sql`
      UPDATE automations
      SET next_run_at = current_timestamp - interval '30 minutes'
      WHERE id = ${automationId}
    `;

    const result = await manageAutomations({ action: "list" }, {} as Env, ctx);
    if (result.action !== "list") throw new Error("expected list result");
    const row = result.automations.find(
      (b) => String((b as { automation_id?: unknown }).automation_id) === String(automationId),
    ) as { health?: string; health_reasons?: string[] } | undefined;
    expect(row).toBeDefined();
    expect(row?.health).toBe("degraded");
    expect((row?.health_reasons ?? []).length).toBeGreaterThan(0);
  });

  it("3.1 (integration): a future-scheduled automation lists as healthy", async () => {
    const { automationId, ctx } = await createScheduledAutomation();
    const sql = getTestDb();
    await sql`
      UPDATE automations
      SET next_run_at = current_timestamp + interval '5 minutes'
      WHERE id = ${automationId}
    `;

    const result = await manageAutomations({ action: "list" }, {} as Env, ctx);
    if (result.action !== "list") throw new Error("expected list result");
    const row = result.automations.find(
      (b) => String((b as { automation_id?: unknown }).automation_id) === String(automationId),
    ) as { health?: string } | undefined;
    expect(row?.health).toBe("healthy");
  });

  it("3.1 (integration): list and detail surface a durable schedule auto-pause", async () => {
    const { automationId, ctx } = await createScheduledAutomation();
    const sql = getTestDb();
    await sql`
      UPDATE automations
      SET consecutive_scheduled_failures = 5,
          schedule_auto_paused_at = date_trunc('milliseconds', current_timestamp)
      WHERE id = ${automationId}
    `;

    const result = await manageAutomations({ action: "list" }, {} as Env, ctx);
    if (result.action !== "list") throw new Error("expected list result");
    const row = result.automations.find(
      (automation) =>
        String((automation as { automation_id?: unknown }).automation_id) ===
        String(automationId),
    ) as Record<string, unknown> | undefined;
    expect(row?.next_run_at).toBeNull();
    expect(Number(row?.consecutive_scheduled_failures)).toBe(5);
    expect(row?.schedule_auto_paused_at).not.toBeNull();
    expect(row?.health).toBe("degraded");
    expect((row?.health_reasons as string[] | undefined)?.[0]).toBe(
      "schedule auto-paused after 5 consecutive execution failures",
    );

    const detail = await getAutomation(
      { automation_id: String(automationId) },
      {} as Env,
      ctx,
    );
    expect(detail.automation?.next_run_at).toBeNull();
    expect(detail.automation?.consecutive_scheduled_failures).toBe(5);
    expect(detail.automation?.schedule_auto_paused_at).not.toBeNull();
    expect(detail.automation?.health_reasons?.[0]).toBe(
      "schedule auto-paused after 5 consecutive execution failures",
    );
  });

  it("3.1 (integration): a failed latest run degrades an on-schedule automation", async () => {
    const { automationId, ctx } = await createScheduledAutomation();
    const sql = getTestDb();
    // On schedule (future) so the ONLY unhealthy signal is the failed run —
    // proving health reflects the run outcome, not just the scheduler cursor.
    await sql`
      UPDATE automations
      SET next_run_at = current_timestamp + interval '5 minutes'
      WHERE id = ${automationId}
    `;
    await sql`
      INSERT INTO runs
        (organization_id, run_type, automation_id, status, approval_status,
         error_message, created_at, completed_at)
      VALUES
        (${ctx.organizationId}, 'automation', ${automationId}, 'failed', 'auto',
         'No model is configured', current_timestamp - interval '2 minutes',
         current_timestamp - interval '1 minute')
    `;

    const result = await manageAutomations({ action: "list" }, {} as Env, ctx);
    if (result.action !== "list") throw new Error("expected list result");
    const row = result.automations.find(
      (b) => String((b as { automation_id?: unknown }).automation_id) === String(automationId),
    ) as
      | { health?: string; last_scheduling_error?: string | null }
      | undefined;
    expect(row?.health).toBe("degraded");
    expect(row?.last_scheduling_error).toBe("No model is configured");
  });

  it.each(["claimed", "running"])(
    "surfaces an old %s run as degraded in list and detail",
    async (status) => {
      const { automationId, ctx } = await createScheduledAutomation();
      const sql = getTestDb();
      await sql`
        UPDATE automations
        SET execution_config = ${sql.json({ executor: { kind: "external" } })},
            next_run_at = current_timestamp - interval '20 hours'
        WHERE id = ${automationId}
      `;
      const [run] = await sql`
        INSERT INTO runs
          (organization_id, run_type, automation_id, status, approval_status, created_at)
        VALUES
          (${ctx.organizationId}, 'automation', ${automationId}, ${status}, 'auto',
           current_timestamp - interval '20 hours')
        RETURNING id
      `;

      const result = await manageAutomations({ action: "list" }, {} as Env, ctx);
      if (result.action !== "list") throw new Error("expected list result");
      const row = result.automations.find(
        (b) => String((b as { automation_id?: unknown }).automation_id) === String(automationId),
      ) as { health?: string; health_reasons?: string[] } | undefined;
      expect(row?.health).toBe("degraded");
      expect(
        row?.health_reasons?.some((reason) => reason.includes(`stuck ${status} run`)),
      ).toBe(true);

      const detail = await getAutomation({ automation_id: String(automationId) }, {} as Env, ctx);
      expect(detail.automation?.health).toBe("degraded");

      // A newly dispatched run still suppresses the stale schedule cursor.
      await sql`UPDATE runs SET created_at = current_timestamp WHERE id = ${run.id}`;
      const fresh = await getAutomation({ automation_id: String(automationId) }, {} as Env, ctx);
      expect(fresh.automation?.health).toBe("healthy");
    },
  );

  it("3.1 (integration): an unstamped event automation without runs is unverified", async () => {
    const { automationId, ctx } = await createScheduledAutomation();
    await getTestDb()`
      UPDATE automations
      SET triggers = ${getTestDb().json([
        {
          kind: "event",
          connector_key: "slack",
          event_types: ["message.created"],
          execution: "turn",
          active_run: "coalesce",
        },
      ])}, next_run_at = NULL, last_event_activation_at = NULL
      WHERE id = ${automationId}
    `;

    const result = await manageAutomations({ action: "list" }, {} as Env, ctx);
    if (result.action !== "list") throw new Error("expected list result");
    const row = result.automations.find(
      (automation) =>
        String((automation as { automation_id?: unknown }).automation_id) ===
        String(automationId),
    ) as { health?: string; health_reasons?: string[] } | undefined;
    expect(row?.health).toBe("degraded");
    expect(row?.health_reasons).toContain(
      "event trigger configured, but no dispatch observed yet",
    );

    const detail = await getAutomation(
      { automation_id: String(automationId) },
      {} as Env,
      ctx,
    );
    expect(detail.automation?.health).toBe("degraded");
    expect(detail.automation?.health_reasons).toContain(
      "event trigger configured, but no dispatch observed yet",
    );
  });

  it("3.1 (integration): an activation stamp proves an event automation dispatched", async () => {
    const { automationId, ctx } = await createScheduledAutomation();
    await getTestDb()`
      UPDATE automations
      SET triggers = ${getTestDb().json([
        {
          kind: "event",
          connector_key: "slack",
          event_types: ["message.created"],
          execution: "turn",
          active_run: "coalesce",
        },
      ])}, next_run_at = NULL, last_event_activation_at = current_timestamp
      WHERE id = ${automationId}
    `;

    const result = await manageAutomations({ action: "list" }, {} as Env, ctx);
    if (result.action !== "list") throw new Error("expected list result");
    const row = result.automations.find(
      (automation) =>
        String((automation as { automation_id?: unknown }).automation_id) ===
        String(automationId),
    ) as Record<string, unknown> | undefined;
    expect(row?.health).toBe("healthy");
    expect(row).not.toHaveProperty("health_reasons");
    expect(row).not.toHaveProperty("health_last_event_activation_at");

    const detail = await getAutomation(
      { automation_id: String(automationId) },
      {} as Env,
      ctx,
    );
    expect(detail.automation?.health).toBe("healthy");
    expect(detail.automation?.health_reasons).toBeUndefined();
  });

  it("3.1 (integration): a latest success does not hide 44 failures in 74 recent runs", async () => {
    const { automationId, ctx } = await createScheduledAutomation();
    const sql = getTestDb();
    await sql`
      UPDATE automations
      SET next_run_at = current_timestamp + interval '5 minutes'
      WHERE id = ${automationId}
    `;
    await sql`
      INSERT INTO runs (
        organization_id, run_type, automation_id, status, approval_status,
        created_at, completed_at
      )
      SELECT
        ${ctx.organizationId}, 'automation', ${automationId},
        CASE WHEN n <= 44 THEN 'failed' ELSE 'completed' END,
        'auto',
        current_timestamp - ((75 - n) * interval '1 minute'),
        current_timestamp - ((75 - n) * interval '1 minute')
      FROM generate_series(1, 74) AS n
    `;

    const result = await manageAutomations({ action: "list" }, {} as Env, ctx);
    if (result.action !== "list") throw new Error("expected list result");
    const row = result.automations.find(
      (automation) =>
        String((automation as { automation_id?: unknown }).automation_id) ===
        String(automationId),
    ) as { health?: string; health_reasons?: string[] } | undefined;
    expect(row?.health).toBe("degraded");
    expect(row?.health_reasons?.join(" ")).toContain(
      "44 of 74 recent terminal runs failed or timed out",
    );

    const detail = await getAutomation(
      { automation_id: String(automationId) },
      {} as Env,
      ctx,
    );
    expect(detail.automation?.health).toBe("degraded");
    expect(detail.automation?.health_reasons?.join(" ")).toContain(
      "44 of 74 recent terminal runs failed or timed out",
    );
  });

  it("3.3: list emits canonical automation lineage keys", async () => {
    const { automationId, ctx } = await createScheduledAutomation();
    await getTestDb()`
      UPDATE automations
      SET source_automation_id = id
      WHERE id = ${automationId}
    `;
    const result = await manageAutomations({ action: "list" }, {} as Env, ctx);
    if (result.action !== "list") throw new Error("expected list result");
    const row = result.automations.find(
      (b) => String((b as { automation_id?: unknown }).automation_id) === String(automationId),
    ) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.automation_group_id).toBe(String(automationId));
    expect(row?.source_automation_id).toBe(String(automationId));
  });

  it("3.4: list preserves canonical client.automations.* run errors", async () => {
    const { automationId, ctx } = await createScheduledAutomation();
    const sql = getTestDb();
    await sql`
      UPDATE automations
      SET next_run_at = current_timestamp + interval '5 minutes'
      WHERE id = ${automationId}
    `;
    await sql`
      INSERT INTO runs
        (organization_id, run_type, automation_id, status, approval_status,
         error_message, created_at, completed_at)
      VALUES
        (${ctx.organizationId}, 'automation', ${automationId}, 'failed', 'auto',
         'Agent never called client.automations.completeWindow()',
         current_timestamp - interval '2 minutes',
         current_timestamp - interval '1 minute')
    `;

    const result = await manageAutomations({ action: "list" }, {} as Env, ctx);
    if (result.action !== "list") throw new Error("expected list result");
    const row = result.automations.find(
      (b) => String((b as { automation_id?: unknown }).automation_id) === String(automationId),
    ) as
      | { automation_run_error?: string | null; last_scheduling_error?: string | null }
      | undefined;
    // Both the raw error field and the health-echoed error carry the public vocabulary.
    expect(row?.automation_run_error).toBe(
      "Agent never called client.automations.completeWindow()",
    );
    expect(row?.last_scheduling_error).toBe(
      "Agent never called client.automations.completeWindow()",
    );
  });

  it("3.5: get_automation preserves canonical run errors everywhere", async () => {
    const { automationId, ctx } = await createScheduledAutomation();
    await getTestDb()`
      INSERT INTO runs
        (organization_id, run_type, automation_id, status, approval_status,
         error_message, created_at, completed_at)
      VALUES
        (${ctx.organizationId}, 'automation', ${automationId}, 'failed', 'auto',
         'Agent never called client.automations.completeWindow()',
         current_timestamp - interval '2 minutes', current_timestamp - interval '1 minute')
    `;

    const result = await getAutomation({ automation_id: String(automationId) }, {} as Env, ctx);
    expect(result.automation?.automation_run?.error_message).toBe(
      "Agent never called client.automations.completeWindow()"
    );
    expect(result.automation?.last_scheduling_error).toBe(
      "Agent never called client.automations.completeWindow()"
    );
  });

  it("3.2: getSchedulerHealth surfaces an overdue automation in issues[]", async () => {
    const { automationId } = await createScheduledAutomation();
    const sql = getTestDb();
    // Overdue by 2 hours → past the 1-hour automation overdue threshold.
    await sql`
      UPDATE automations
      SET next_run_at = current_timestamp - interval '2 hours'
      WHERE id = ${automationId}
    `;

    const health = await getSchedulerHealth({} as Env);
    expect(health.metrics.overdueAutomations).toBeGreaterThanOrEqual(1);
    expect(health.metrics.automationsOverdueByHours).toBeGreaterThan(1);
    expect(health.healthy).toBe(false);
    expect(health.issues.some((i) => /automations overdue/i.test(i))).toBe(true);
  });

  it("3.2: getSchedulerHealth surfaces a stuck-pending automation run in issues[]", async () => {
    const { automationId, ctx } = await createScheduledAutomation();
    const sql = getTestDb();
    // Keep next_run_at in the future so the ONLY issue is the stuck run.
    await sql`
      UPDATE automations
      SET next_run_at = current_timestamp + interval '5 minutes'
      WHERE id = ${automationId}
    `;
    const orgId = ctx.organizationId;
    // A pending automation run created 3 hours ago — past the 2h stale interval.
    await sql`
      INSERT INTO runs
        (organization_id, run_type, automation_id, status, approval_status, created_at)
      VALUES
        (${orgId}, 'automation', ${automationId}, 'pending', 'auto',
         current_timestamp - interval '3 hours')
    `;

    const health = await getSchedulerHealth({} as Env);
    expect(health.metrics.stalePendingAutomationRuns).toBeGreaterThanOrEqual(1);
    expect(health.issues.some((i) => /stuck pending/i.test(i))).toBe(true);
  });

  it("3.2: reports an offline device deferral without a scheduler failure", async () => {
    const { automationId, ctx } = await createScheduledAutomation();
    const sql = getTestDb();
    const [device] = await sql<{ id: string }>`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label, organization_id,
        agent_kinds, last_seen_at
      ) VALUES (
        ${ctx.userId}, 'health-offline-mac', 'macos', ${sql.json({})}, 'Offline Mac',
        ${ctx.organizationId}, ${"{claude-code}"}::text[],
        current_timestamp - interval '10 minutes'
      )
      RETURNING id
    `;
    await sql`
      UPDATE automations
      SET device_worker_id = ${device.id}::uuid,
          agent_kind = 'claude-code',
          next_run_at = current_timestamp - interval '2 hours'
      WHERE id = ${automationId}
    `;
    await sql`
      INSERT INTO runs (
        organization_id, run_type, automation_id, status, approval_status,
        approved_input, created_at
      ) VALUES (
        ${ctx.organizationId}, 'automation', ${automationId}, 'pending', 'auto',
        ${sql.json({ dispatch_source: "scheduled", device_worker_id: device.id })},
        current_timestamp - interval '3 hours'
      )
    `;

    const health = await getSchedulerHealth({} as Env);
    expect(health.metrics.deferredDeviceAutomations).toBe(1);
    expect(health.metrics.oldestDeviceDeferralHours).toBeGreaterThan(1);
    expect(health.metrics.overdueAutomations).toBe(0);
    expect(health.metrics.stalePendingAutomationRuns).toBe(0);
    expect(health.healthy).toBe(true);
    expect(health.issues).toEqual([]);

    await sql`
      UPDATE device_workers
      SET platform = 'headless', last_seen_at = current_timestamp,
          capabilities = ${sql.json(["os.shell"])}
      WHERE id = ${device.id}::uuid
    `;
    const incapableHealth = await getSchedulerHealth({} as Env);
    expect(incapableHealth.metrics.deferredDeviceAutomations).toBe(1);
    expect(incapableHealth.metrics.overdueAutomations).toBe(0);
    expect(incapableHealth.metrics.stalePendingAutomationRuns).toBe(0);
    expect(incapableHealth.healthy).toBe(true);

    await sql`
      UPDATE device_workers SET platform = NULL, capabilities = ${sql.json({})}
      WHERE id = ${device.id}::uuid
    `;
    const legacyHealth = await getSchedulerHealth({} as Env);
    expect(legacyHealth.metrics.deferredDeviceAutomations).toBe(1);
    expect(legacyHealth.metrics.overdueAutomations).toBe(0);
    expect(legacyHealth.healthy).toBe(true);
  });
});

afterAll(() => {
  // no-op; embedded PG torn down by the global harness.
});
