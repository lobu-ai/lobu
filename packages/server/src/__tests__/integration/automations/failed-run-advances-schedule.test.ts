import { describe, expect, it } from "vitest";
import type { DbClient } from "../../../db/client";
import { claimPendingAutomationRun } from "../../../runs/queue-service";
import { ApiResponseRenderer } from "../../../gateway/api/response-renderer";
import { materializeDueAutomationRuns } from "../../../automations/automation";
import { resolveAutomationRunsByMessageIds } from "../../../automations/run-completion";
import { advanceAutomationSchedule } from "../../../automations/schedule-cursor";
import { nextRunAt } from "../../../utils/cron";
import { getTestDb } from "../../setup/test-db";
import { createTestAgent, createTestEntity } from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";

async function createDueAutomationWithDispatchedRun(opts: {
  slug: string;
  messageId: string;
  nudgeCount?: number;
  dispatchSource?: "scheduled" | "event" | "manual";
  skipIfUnchanged?: boolean;
}) {
  const sql = getTestDb();
  const workspace = await TestWorkspace.create({
    name: `Failed Run Advance ${opts.slug}`,
  });
  const entity = await createTestEntity({
    name: "Advance Entity",
    organization_id: workspace.org.id,
    created_by: workspace.users.owner.id,
  });
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
    agentId: `advance-agent-${opts.slug}`,
    name: "Advance Agent",
  });

  const automation = (await workspace.owner.automations.create({
    entity_id: entity.id,
    slug: opts.slug,
    name: "Advance Automation",
    prompt: "Summarize content for {{entities}}.",
    triggers: [
      {
        kind: "schedule",
        cron: "0 * * * *",
        execution: "window",
        active_run: "coalesce",
        skip_if_unchanged: opts.skipIfUnchanged ?? false,
      },
    ],
    managed_agent_id: agent.agentId,
  })) as { automation_id: string };
  const automationId = Number(automation.automation_id);

  // A stale cursor remains due until a terminal run advances it.
  const staleCursor = new Date(Date.now() - 60_000);
  await sql`
    UPDATE automations SET next_run_at = ${staleCursor}::timestamptz
    WHERE id = ${automationId}
  `;

  const [run] = await sql`
    INSERT INTO runs (organization_id, run_type, automation_id, status,
                      dispatched_message_id, approved_input)
    VALUES (${workspace.org.id}, 'automation', ${automationId}, 'running',
            ${opts.messageId},
            ${sql.json({
              finalize_nudge_count: opts.nudgeCount ?? 99,
              dispatch_source: opts.dispatchSource ?? "scheduled",
            })})
    RETURNING id
  `;

  return {
    sql,
    organizationId: workspace.org.id,
    automationId,
    runId: Number(run.id),
    staleCursor,
  };
}

async function cursorOf(automationId: number): Promise<Date> {
  const sql = getTestDb();
  const [row] =
    await sql`SELECT next_run_at FROM automations WHERE id = ${automationId}`;
  return new Date(row.next_run_at as string);
}

/** The cron tick the Automation's own schedule names after `now`. */
async function nextTickOf(automationId: number): Promise<number> {
  const sql = getTestDb();
  const [row] =
    await sql`SELECT schedule, timezone FROM automations WHERE id = ${automationId}`;
  return new Date(
    nextRunAt(row.schedule as string, new Date(), row.timezone as string | null)
  ).getTime();
}

describe("a terminally failed Automation run advances next_run_at", () => {
  // A provider quota failure is not special-cased: Lobu does not infer when the
  // provider resets, so the breaker pauses it like any other repeated failure
  // and the admin resumes it.
  it.each([
    { kind: "executor", errorCode: undefined },
    { kind: "quota", errorCode: "PROVIDER_QUOTA_EXHAUSTED" },
  ])("auto-pauses after five consecutive scheduled $kind failures", async ({ kind, errorCode }) => {
    const { sql, automationId, organizationId } =
      await createDueAutomationWithDispatchedRun({
        slug: `auto-pause-repeated-${kind}-failures`,
        messageId: `msg-repeated-${kind}-failure-1`,
      });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const messageId = `msg-repeated-${kind}-failure-${attempt}`;
      if (attempt > 1) {
        await sql`
          UPDATE automations
          SET next_run_at = current_timestamp - interval '1 minute'
          WHERE id = ${automationId}
        `;
        await sql`
          INSERT INTO runs (
            organization_id, run_type, automation_id, status,
            dispatched_message_id, approved_input
          ) VALUES (
            ${organizationId}, 'automation', ${automationId}, 'running',
            ${messageId},
            ${sql.json({ finalize_nudge_count: 99, dispatch_source: "scheduled" })}
          )
        `;
      }

      await resolveAutomationRunsByMessageIds([messageId], {
        ok: false,
        error:
          kind === "quota"
            ? "429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2099-01-01"
            : `executor timed out on attempt ${attempt}`,
        errorCode,
      });
    }

    const [automation] = await sql`
      SELECT status, next_run_at, consecutive_scheduled_failures,
             schedule_auto_paused_at
      FROM automations WHERE id = ${automationId}
    `;
    expect(automation.status).toBe("active");
    expect(automation.next_run_at).toBeNull();
    expect(Number(automation.consecutive_scheduled_failures)).toBe(5);
    expect(automation.schedule_auto_paused_at).not.toBeNull();
  });

  it("does not double-count a duplicate terminal report", async () => {
    const { sql, automationId } = await createDueAutomationWithDispatchedRun({
      slug: "dedupe-failure-count",
      messageId: "msg-dedupe-failure-count",
    });

    await Promise.all([
      resolveAutomationRunsByMessageIds(["msg-dedupe-failure-count"], {
        ok: false,
        error: "executor timed out",
      }),
      resolveAutomationRunsByMessageIds(["msg-dedupe-failure-count"], {
        ok: false,
        error: "executor timed out",
      }),
    ]);

    const [automation] = await sql`
      SELECT consecutive_scheduled_failures
      FROM automations WHERE id = ${automationId}
    `;
    expect(Number(automation.consecutive_scheduled_failures)).toBe(1);
  });

  it.each([true, false])("ignores an old message after the finalize retry is claimed (ok=%s)", async (ok) => {
    const messageId = `synthetic-stale-reply-${ok}`;
    const { sql, automationId, runId } = await createDueAutomationWithDispatchedRun({
      slug: `stale-reply-${ok}`, messageId, nudgeCount: 0,
    });
    const snapshot = async () => ({
      run: (await sql`SELECT status, claimed_by, claimed_at, dispatched_message_id, approved_input,
        completed_at, error_message FROM runs WHERE id = ${runId}`)[0],
      automation: (await sql`SELECT next_run_at, consecutive_scheduled_failures
        FROM automations WHERE id = ${automationId}`)[0],
    });
    let replacement: Awaited<ReturnType<typeof snapshot>> | undefined;
    const racingSql = new Proxy(sql, {
      apply(target, thisArg, args) {
        const query = Reflect.apply(target, thisArg, args);
        if (!Array.isArray(args[0]) || !args[0].join("").includes("SELECT r.id, r.run_type")) return query;
        return (async () => {
          const selected = await query;
          expect(await resolveAutomationRunsByMessageIds([messageId], { ok: true }, sql)).toMatchObject({ resolved: 1 });
          expect(await sql.begin(tx => claimPendingAutomationRun(tx as unknown as DbClient, {
            runId, automationId, claimedBy: "lobu-dispatcher", status: "claimed",
          }))).toBe(true);
          replacement = await snapshot();
          expect(replacement.run).toMatchObject({ status: "claimed", claimed_by: "lobu-dispatcher",
            dispatched_message_id: null, approved_input: { finalize_nudge_count: 1 } });
          return selected;
        })();
      },
    });
    const result = await resolveAutomationRunsByMessageIds([messageId],
      ok ? { ok: true } : { ok: false, error: "synthetic old turn failure" }, racingSql);
    expect(replacement).toBeDefined();
    expect(result.resolved).toBe(0);
    expect(await snapshot()).toEqual(replacement);
  });

  it("advances the cursor when the agent turn returns an error", async () => {
    const { automationId, runId, staleCursor } =
      await createDueAutomationWithDispatchedRun({
        slug: "advance-on-turn-error",
        messageId: "msg-turn-error",
      });

    await resolveAutomationRunsByMessageIds(
      ["msg-turn-error"],
      {
        ok: false,
        error: "provider returned 429",
      }
    );

    const sql = getTestDb();
    const [run] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");

    const after = await cursorOf(automationId);
    expect(after.getTime()).toBeGreaterThan(staleCursor.getTime());
    expect(after.getTime()).toBeGreaterThan(Date.now());
  });

  it("moves a provider-quota failure to the next cron tick, not the provider's reset", async () => {
    const resetAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const providerReset = resetAt
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    const { sql, automationId, runId } = await createDueAutomationWithDispatchedRun({
      slug: "quota-failure-next-tick",
      messageId: "msg-provider-reset",
    });
    const tickBefore = await nextTickOf(automationId);

    const renderer = new ApiResponseRenderer({
      broadcast() {},
    } as unknown as ConstructorParameters<typeof ApiResponseRenderer>[0]);
    await renderer.handleError(
      {
        messageId: "msg-provider-reset",
        channelId: "api-provider-reset",
        conversationId: "api-provider-reset",
        userId: "automation-test",
        teamId: "api",
        timestamp: Date.now(),
        error: `429 Weekly/Monthly Limit Exhausted. Your limit will reset at ${providerReset}`,
        errorCode: "PROVIDER_QUOTA_EXHAUSTED",
      }
    );

    const [run] = await sql`SELECT status, error_message FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");
    expect(run.error_message).toContain(providerReset);

    const after = (await cursorOf(automationId)).getTime();
    expect([tickBefore, await nextTickOf(automationId)]).toContain(after);
    expect(after).toBeLessThan(resetAt.getTime());
    const [automation] = await sql`
      SELECT consecutive_scheduled_failures, schedule_auto_paused_at
      FROM automations WHERE id = ${automationId}
    `;
    expect(Number(automation.consecutive_scheduled_failures)).toBe(1);
    expect(automation.schedule_auto_paused_at).toBeNull();
  });

  it("advances the cursor when the agent never calls complete_window", async () => {
    const { automationId, runId, staleCursor } =
      await createDueAutomationWithDispatchedRun({
        slug: "advance-on-finalize-miss",
        messageId: "msg-finalize-miss",
        // Past the nudge budget, so this resolves terminally rather than requeuing.
        nudgeCount: 99,
      });

    await resolveAutomationRunsByMessageIds(["msg-finalize-miss"], { ok: true });

    const sql = getTestDb();
    const [run] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");

    const after = await cursorOf(automationId);
    expect(after.getTime()).toBeGreaterThan(staleCursor.getTime());
    expect(after.getTime()).toBeGreaterThan(Date.now());
  });

  it("does NOT advance for an event-dispatched run", async () => {
    // Event delivery is independent of the cron cursor. If a failing event
    // delivery advanced it, that Automation would silently skip its next
    // scheduled activation — a missed run, caused by an unrelated failure.
    // `failAutomationRun` carves this out; without the same carve-out here the two
    // failure paths would disagree about what a failure means.
    const { automationId, runId, staleCursor } =
      await createDueAutomationWithDispatchedRun({
        slug: "no-advance-on-event",
        messageId: "msg-event-dispatch",
        dispatchSource: "event",
      });

    await resolveAutomationRunsByMessageIds(["msg-event-dispatch"], {
      ok: false,
      error: "provider exploded",
    });

    const sql = getTestDb();
    const [run] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");

    const after = await cursorOf(automationId);
    expect(after.getTime()).toBe(staleCursor.getTime());
    const [automation] = await sql`
      SELECT consecutive_scheduled_failures
      FROM automations WHERE id = ${automationId}
    `;
    expect(Number(automation.consecutive_scheduled_failures)).toBe(0);
  });

  it("does not count a failed manual run", async () => {
    const { sql, automationId } = await createDueAutomationWithDispatchedRun({
      slug: "no-count-on-manual",
      messageId: "msg-manual-dispatch",
      dispatchSource: "manual",
    });

    await resolveAutomationRunsByMessageIds(["msg-manual-dispatch"], {
      ok: false,
      error: "manual executor failed",
    });

    const [automation] = await sql`
      SELECT consecutive_scheduled_failures, schedule_auto_paused_at
      FROM automations WHERE id = ${automationId}
    `;
    expect(Number(automation.consecutive_scheduled_failures)).toBe(0);
    expect(automation.schedule_auto_paused_at).toBeNull();
  });

  it("does not count an eval replay failure", async () => {
    const { sql, automationId, runId } =
      await createDueAutomationWithDispatchedRun({
        slug: "no-count-on-eval",
        messageId: "msg-eval-failure",
      });
    await sql`
      UPDATE runs SET run_type = 'automation_eval' WHERE id = ${runId}
    `;

    await resolveAutomationRunsByMessageIds(["msg-eval-failure"], {
      ok: false,
      error: "eval executor failed",
    });

    const [automation] = await sql`
      SELECT consecutive_scheduled_failures
      FROM automations WHERE id = ${automationId}
    `;
    expect(Number(automation.consecutive_scheduled_failures)).toBe(0);
  });

  it("does not move the cursor for a quota-exhausted event dispatch", async () => {
    // A coded quota error is no exception to the event carve-out: there is no
    // provider-reset park for the scheduled side to inherit.
    const { sql, automationId, runId, staleCursor } =
      await createDueAutomationWithDispatchedRun({
        slug: "event-quota-keeps-cursor",
        messageId: "msg-event-provider-reset",
        dispatchSource: "event",
      });

    await resolveAutomationRunsByMessageIds(["msg-event-provider-reset"], {
      ok: false,
      error: "429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2099-01-01",
      errorCode: "PROVIDER_QUOTA_EXHAUSTED",
    });

    const [run] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");
    expect((await cursorOf(automationId)).getTime()).toBe(staleCursor.getTime());
  });

  it("leaves the cursor alone while a finalize nudge requeues the run", async () => {
    const { automationId, staleCursor } = await createDueAutomationWithDispatchedRun({
      slug: "no-advance-on-requeue",
      messageId: "msg-requeue",
      nudgeCount: 0,
    });

    await resolveAutomationRunsByMessageIds(["msg-requeue"], { ok: true });

    const after = await cursorOf(automationId);
    expect(after.getTime()).toBe(staleCursor.getTime());
  });

  it("one Automation with an unparseable cron cannot abort the whole tick", async () => {
    const { sql, automationId, runId } =
      await createDueAutomationWithDispatchedRun({
        slug: "corrupt-cron-tick-isolation",
        messageId: "msg-corrupt-cron",
        skipIfUnchanged: true,
      });
    await sql`UPDATE runs SET status = 'failed' WHERE id = ${runId}`;
    await sql`
      UPDATE automations SET schedule = 'not-a-cron' WHERE id = ${automationId}
    `;

    try {
      await expect(materializeDueAutomationRuns()).resolves.toBeDefined();

      // Asserting the PARK is what makes this bite: without it the tick still
      // resolves (materializeDueItems catches per item), so a bare
      // "resolves" assertion would pass even with the guard removed.
      const [automation] =
        await sql`SELECT next_run_at FROM automations WHERE id = ${automationId}`;
      expect(automation.next_run_at).toBeNull();
    } finally {
      await sql`
        UPDATE automations
        SET schedule = '0 * * * *', next_run_at = NOW() + INTERVAL '1 hour'
        WHERE id = ${automationId}
      `;
    }
  });

  it("parks an Automation whose cron is unparseable instead of throwing", async () => {
    // An unparseable cron is PERMANENT — retrying can never fix it. Throwing
    // would roll the run-failure back forever, and because
    // `dispatchAutomationRun` calls `failAutomationRun` from inside its own `catch`
    // (and `dispatchPendingAutomationRuns` has no per-run guard) the throw would
    // escape both and abort the dispatch tick for every org. So the run must
    // still reach `failed`, and the Automation must be parked.
    const { sql, automationId, runId } = await createDueAutomationWithDispatchedRun({
      slug: "park-on-unparseable-cron",
      messageId: "msg-invalid-schedule",
    });
    await sql`
      UPDATE automations SET schedule = 'not-a-cron'
      WHERE id = ${automationId}
    `;

    try {
      await expect(
        resolveAutomationRunsByMessageIds(["msg-invalid-schedule"], {
          ok: false,
          error: "provider exploded",
        })
      ).resolves.toBeDefined();

      const [run] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
      expect(run.status).toBe("failed");

      // NULL drops out of the `next_run_at <= now()` due predicate, so the
      // broken Automation stops re-selecting every tick.
      const [automation] =
        await sql`SELECT next_run_at FROM automations WHERE id = ${automationId}`;
      expect(automation.next_run_at).toBeNull();
    } finally {
      await sql`
        UPDATE automations
        SET schedule = '0 * * * *', next_run_at = NOW() + INTERVAL '1 hour'
        WHERE id = ${automationId}
      `;
    }
  });

  // The transactional failure path is only meaningful if TRANSIENT errors still
  // surface. Parking must not swallow a dead connection — at EITHER query, so
  // covering only the UPDATE would let a swallowed SELECT through.
  for (const failAtQuery of [1, 2]) {
    const label = failAtQuery === 1 ? "the schedule SELECT" : "the cursor UPDATE";
    it(`propagates a database error from ${label} so the caller can roll back`, async () => {
      let queries = 0;
      const failingSql = (async () => {
        queries++;
        if (queries === failAtQuery) {
          throw new Error("connection terminated unexpectedly");
        }
        return [{ schedule: "0 * * * *", timezone: null }];
      }) as unknown as Parameters<typeof advanceAutomationSchedule>[0];

      await expect(advanceAutomationSchedule(failingSql, 1)).rejects.toThrow(
        /connection terminated/
      );
      expect(queries).toBe(failAtQuery);
    });
  }
});

describe("finalize-miss diagnostics", () => {
  it("reports missing completion without suggesting obsolete MCP grants", async () => {
    const { sql, runId } = await createDueAutomationWithDispatchedRun({
      slug: "finalize-miss-no-approval",
      messageId: "msg-no-approval",
      nudgeCount: 99,
    });

    await resolveAutomationRunsByMessageIds(["msg-no-approval"], { ok: true });

    const [run] =
      await sql`SELECT status, error_message FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");
    expect(run.error_message).toMatch(/finished without calling/);
    expect(run.error_message).toMatch(/query_sdk \/ run_sdk/);
    expect(run.error_message).not.toMatch(/grant|approval/);
  });
});
