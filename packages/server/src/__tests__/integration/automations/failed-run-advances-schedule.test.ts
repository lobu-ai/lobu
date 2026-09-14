import { describe, expect, it } from "vitest";
import { ApiResponseRenderer } from "../../../gateway/api/response-renderer";
import { ChatResponseBridge } from "../../../gateway/connections/chat-response-bridge";
import { materializeDueAutomationRuns } from "../../../automations/automation";
import { resolveAutomationRunsByMessageIds } from "../../../automations/run-completion";
import {
  advanceAutomationSchedule,
  deviceProviderQuotaResetNotBefore,
  parseProviderQuotaResetAt,
  parseProviderRetryAfter,
  providerQuotaResetNotBefore,
} from "../../../automations/schedule-cursor";
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
    agentId: agent.agentId,
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

function chatResponseBridge(organizationId: string): ChatResponseBridge {
  const target = { post: async () => ({ id: "posted" }) };
  const manager = {
    getInstance: () => ({
      connection: {
        platform: "telegram",
        organizationId,
      },
      chat: {
        channel: () => target,
      },
    }),
    getPublicGatewayUrl: () => "",
  };
  return new ChatResponseBridge(
    manager as unknown as ConstructorParameters<typeof ChatResponseBridge>[0]
  );
}

describe("provider quota reset parsing", () => {
  it("treats a date-only reset as UTC and adds boundary grace", () => {
    const reset = parseProviderQuotaResetAt(
      "429 Limit Exhausted. Your limit will reset at 2026-07-31",
      new Date("2026-07-30T12:00:00.000Z")
    );

    expect(reset?.toISOString()).toBe("2026-07-31T00:01:00.000Z");
  });

  it("ignores missing or already-past reset timestamps", () => {
    const now = new Date("2026-07-31T12:00:00.000Z");

    expect(parseProviderQuotaResetAt("429 Limit Exhausted", now)).toBeNull();
    expect(
      parseProviderQuotaResetAt("Your limit will reset at 2026-07-31", now)
    ).toBeNull();
  });

  it("keeps the boundary grace when the reset time just passed", () => {
    const now = new Date("2026-07-31T12:00:30.000Z");

    expect(
      parseProviderQuotaResetAt(
        "Your limit will reset at 2026-07-31 12:00:00",
        now
      )?.toISOString()
    ).toBe("2026-07-31T12:01:00.000Z");
  });

  it.each([
    "2026-02-31",
    "2026-07-31 24:00:00",
    "2026-07-31 12:60:00",
    "2026-07-31 12:00:60",
    "2026-07-31 12:00:00+24:00",
    "2026-07-31 12:00:00+bad",
    "2026-07-31 12:00:000",
    "2026-07-31T12:00:00.1234Z",
    "2026-07-31x",
  ])("rejects invalid reset timestamp %s", (timestamp) => {
    expect(
      parseProviderQuotaResetAt(
        `Your limit will reset at ${timestamp}`,
        new Date("2026-01-01T00:00:00.000Z")
      )
    ).toBeNull();
  });

  it("requires quota evidence for unclassified device stderr", () => {
    const now = new Date("2026-07-31T10:00:00.000Z");
    expect(
      deviceProviderQuotaResetNotBefore(
        "429 Limit Exhausted. Your limit will reset at 2026-07-31 12:00:00",
        now
      )?.toISOString()
    ).toBe("2026-07-31T12:01:00.000Z");
    expect(
      deviceProviderQuotaResetNotBefore(
        "Authentication session resets at 2026-07-31 12:00:00",
        now
      )
    ).toBeNull();
  });

  it("parks a reset-less balance exhaustion for a day", () => {
    const now = new Date("2026-08-05T10:00:00.000Z");

    expect(
      providerQuotaResetNotBefore(
        "z.ai returned an error: 429 Insufficient balance or no resource package",
        "PROVIDER_QUOTA_EXHAUSTED",
        now
      )?.toISOString()
    ).toBe("2026-08-06T10:00:00.000Z");
    expect(
      deviceProviderQuotaResetNotBefore(
        "429 Insufficient balance or no resource package",
        now
      )?.toISOString()
    ).toBe("2026-08-06T10:00:00.000Z");
    // No "429"/rate-limit token: balance wording alone must count as device
    // quota evidence.
    expect(
      deviceProviderQuotaResetNotBefore(
        "Insufficient balance or no resource package",
        now
      )?.toISOString()
    ).toBe("2026-08-06T10:00:00.000Z");
    // Captured verbatim from prod 2026-08-05. This wording reached the parker
    // only because the message list moved into core: it lived here but NOT in
    // the worker's `classifyError`, which assigns the very errorCode this
    // function gates on — so the park could never fire for it in production.
    expect(
      providerQuotaResetNotBefore(
        "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
        "PROVIDER_QUOTA_EXHAUSTED",
        now
      )?.toISOString()
    ).toBe("2026-08-06T10:00:00.000Z");
    // OpenAI's insufficient_quota billing message names no retry horizon.
    expect(
      providerQuotaResetNotBefore(
        "429 You exceeded your current quota, please check your plan and billing details.",
        "PROVIDER_QUOTA_EXHAUSTED",
        now
      )?.toISOString()
    ).toBe("2026-08-06T10:00:00.000Z");
    // Widened by the shared core literal: "insufficient quota" was previously
    // worker-only (classification without a park). Reset-less, it is billing
    // wording (OpenAI/Azure insufficient_quota) and now day-parks; the windowed
    // variant with a named horizon stays unparked (case below).
    expect(
      providerQuotaResetNotBefore(
        "429 You have insufficient quota for this request.",
        "PROVIDER_QUOTA_EXHAUSTED",
        now
      )?.toISOString()
    ).toBe("2026-08-06T10:00:00.000Z");
  });

  it("prefers a named reset over the balance park", () => {
    const now = new Date("2026-08-05T10:00:00.000Z");

    expect(
      providerQuotaResetNotBefore(
        "429 Insufficient balance. Your limit will reset at 2026-08-05 12:00:00",
        "PROVIDER_QUOTA_EXHAUSTED",
        now
      )?.toISOString()
    ).toBe("2026-08-05T12:01:00.000Z");
  });

  it("honors OpenCode Go's relative account-limit reset", () => {
    const now = new Date("2026-08-05T10:00:00.000Z");
    const message =
      "Monthly usage limit reached. Resets in 14 days. " +
      "To continue using this model now, enable usage from your available balance";

    expect(
      deviceProviderQuotaResetNotBefore(message, now)?.toISOString()
    ).toBe("2026-08-19T10:01:00.000Z");
  });

  // Subscription-plan CLIs report an account window in wording neither matcher
  // covered: Codex on a ChatGPT plan says "usage limit (pro plan)" rather than
  // "usage limit reached", and quotes the horizon as "Try again in ~N min"
  // rather than "resets in <hours|days|weeks>". Missing both halves meant no
  // park at all, so every cron tick burned a scheduled failure until the
  // consecutive-failure auto-pause stopped the Automation outright.
  it.each([
    [
      "You have hit your ChatGPT usage limit (pro plan). Try again in ~8700 min.",
      "2026-09-19T05:01:00.000Z",
    ],
    ["Monthly usage limit reached. Resets in 90 minutes.", "2026-09-13T05:31:00.000Z"],
  ])("parks a usage-limit window quoted in minutes (%s)", (message, expected) => {
    const now = new Date("2026-09-13T04:00:00.000Z");

    expect(deviceProviderQuotaResetNotBefore(message, now)?.toISOString()).toBe(
      expected
    );
  });

  // "try again in" alone is not quota evidence — a CLI's own limit must still
  // retry on the normal cadence rather than park a durable schedule.
  it.each([
    "Tool call limit reached. Try again in ~5 min.",
    "Context limit reached. Try again in ~2 hours.",
  ])("does not park a non-quota limit that says try again in (%s)", (message) => {
    const now = new Date("2026-09-13T04:00:00.000Z");

    expect(deviceProviderQuotaResetNotBefore(message, now)).toBeNull();
  });

  // A CLI's own limits reuse the "limit reached" phrasing but are not provider
  // quota, and a relative "resets in" would otherwise park a durable schedule
  // for hours or days on a run that should simply retry next tick.
  it.each([
    "Context limit reached. Please start a new session.",
    "Session limit reached. Resets in 5 hours.",
    "Tool call limit reached after 50 iterations",
    "File size limit reached, resets in 2 days",
  ])("does not park a non-quota CLI limit (%s)", (message) => {
    const now = new Date("2026-08-05T10:00:00.000Z");

    expect(deviceProviderQuotaResetNotBefore(message, now)).toBeNull();
  });

  it.each([
    "Gemini returned an error: 429 status code (no body)",
    "429 Too Many Requests",
    "rate limit exceeded, retry shortly",
  ])("leaves an undated self-healing rate limit on normal cadence (%s)", (message) => {
    const now = new Date("2026-08-05T10:00:00.000Z");

    expect(
      providerQuotaResetNotBefore(message, "PROVIDER_QUOTA_EXHAUSTED", now)
    ).toBeNull();
    expect(deviceProviderQuotaResetNotBefore(message, now)).toBeNull();
  });

  it.each([
    [
      "429 You exceeded your current quota. Please try again in 25.137s.",
      "2026-08-05T10:00:26.137Z",
    ],
    [
      "429 insufficient quota; retryDelay: 26s",
      "2026-08-05T10:00:27.000Z",
    ],
    [
      "429 out of credits (Retry-After: 30)",
      "2026-08-05T10:00:31.000Z",
    ],
    [
      "429 out of credits (Retry-After: Wed, 05 Aug 2026 10:00:30 GMT)",
      "2026-08-05T10:00:31.000Z",
    ],
  ])("honors an explicit transient retry horizon (%s)", (message, expected) => {
    const now = new Date("2026-08-05T10:00:00.000Z");

    expect(parseProviderRetryAfter(message, now)?.toISOString()).toBe(expected);
    expect(
      providerQuotaResetNotBefore(message, "PROVIDER_QUOTA_EXHAUSTED", now)?.toISOString()
    ).toBe(expected);
    expect(deviceProviderQuotaResetNotBefore(message, now)?.toISOString()).toBe(expected);
  });

  it("still requires quota classification for balance wording", () => {
    const now = new Date("2026-08-05T10:00:00.000Z");
    const message = "Insufficient balance";

    expect(
      providerQuotaResetNotBefore(message, "NO_MODEL_CONFIGURED", now)
    ).toBeNull();
    expect(providerQuotaResetNotBefore(message, undefined, now)).toBeNull();
  });

  it("requires the structured quota code", () => {
    const message = "Your limit will reset at 2026-07-31 12:00:00";
    const now = new Date("2026-07-31T10:00:00.000Z");

    expect(
      providerQuotaResetNotBefore(
        message,
        "PROVIDER_QUOTA_EXHAUSTED",
        now
      )?.toISOString()
    ).toBe("2026-07-31T12:01:00.000Z");
    expect(
      providerQuotaResetNotBefore(message, "NO_MODEL_CONFIGURED", now)
    ).toBeNull();
    expect(providerQuotaResetNotBefore(message, undefined, now)).toBeNull();
  });
});

describe("a terminally failed Automation run advances next_run_at", () => {
  it("auto-pauses after five consecutive scheduled execution failures", async () => {
    const { sql, automationId, organizationId } =
      await createDueAutomationWithDispatchedRun({
        slug: "auto-pause-repeated-failures",
        messageId: "msg-repeated-failure-1",
      });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const messageId = `msg-repeated-failure-${attempt}`;
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
        error: `executor timed out on attempt ${attempt}`,
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

  it("parks a quota-exhausted Automation through the provider reset boundary", async () => {
    const resetAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const providerReset = resetAt
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    const { automationId, runId } = await createDueAutomationWithDispatchedRun({
      slug: "park-until-provider-reset",
      messageId: "msg-provider-reset",
    });

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
        error: "Message blocked by guardrail: require-tool",
        bookkeepingError: `429 Weekly/Monthly Limit Exhausted. Your limit will reset at ${providerReset}`,
        errorCode: "PROVIDER_QUOTA_EXHAUSTED",
      }
    );

    const sql = getTestDb();
    const [run] = await sql`SELECT status, error_message FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");
    expect(run.error_message).toBe(
      "Message blocked by guardrail: require-tool"
    );

    const after = await cursorOf(automationId);
    const expectedNotBefore =
      Math.floor(resetAt.getTime() / 1000) * 1000 + 60_000;
    expect(after.getTime()).toBe(expectedNotBefore);
  });

  it("retries a scheduled transient quota failure before the next cron tick", async () => {
    const { automationId, runId } = await createDueAutomationWithDispatchedRun({
      slug: "retry-transient-provider-limit",
      messageId: "msg-provider-retry",
    });
    const before = Date.now();

    const renderer = new ApiResponseRenderer({
      broadcast() {},
    } as unknown as ConstructorParameters<typeof ApiResponseRenderer>[0]);
    await renderer.handleError(
      {
        messageId: "msg-provider-retry",
        channelId: "api-provider-retry",
        conversationId: "api-provider-retry",
        userId: "automation-test",
        teamId: "api",
        timestamp: Date.now(),
        error: "Provider rate limited this turn.",
        bookkeepingError:
          "Rate limit reached for gpt-5.6-luna. Please try again in 25.137s.",
        errorCode: "PROVIDER_QUOTA_EXHAUSTED",
      }
    );

    const sql = getTestDb();
    const [run] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");

    const after = await cursorOf(automationId);
    expect(after.getTime()).toBeGreaterThanOrEqual(before + 26_000);
    expect(after.getTime()).toBeLessThan(before + 60_000);
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

  it("parks a scheduled Automation after a quota-exhausted event dispatch", async () => {
    const resetAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const providerReset = resetAt
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    const { automationId, runId } = await createDueAutomationWithDispatchedRun({
      slug: "park-event-until-provider-reset",
      messageId: "msg-event-provider-reset",
      dispatchSource: "event",
    });

    await resolveAutomationRunsByMessageIds(["msg-event-provider-reset"], {
      ok: false,
      error: `429 Weekly/Monthly Limit Exhausted. Your limit will reset at ${providerReset}`,
      errorCode: "PROVIDER_QUOTA_EXHAUSTED",
    });

    const sql = getTestDb();
    const [run] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");

    const after = await cursorOf(automationId);
    const expectedNotBefore =
      Math.floor(resetAt.getTime() / 1000) * 1000 + 60_000;
    expect(after.getTime()).toBe(expectedNotBefore);
  });

  it("parks an hourly Automation for a day when the provider balance is empty", async () => {
    const { automationId, runId } = await createDueAutomationWithDispatchedRun({
      slug: "park-empty-balance-for-a-day",
      messageId: "msg-empty-balance",
    });
    const before = Date.now();

    await resolveAutomationRunsByMessageIds(["msg-empty-balance"], {
      ok: false,
      error:
        "z.ai returned an error: 429 Insufficient balance or no resource package",
      errorCode: "PROVIDER_QUOTA_EXHAUSTED",
    });

    const sql = getTestDb();
    const [run] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");

    // Without the park this lands on the next hourly tick (< 1h out), which is
    // exactly the one-failed-run-per-tick burn the park exists to stop.
    const after = await cursorOf(automationId);
    expect(after.getTime()).toBeGreaterThanOrEqual(
      before + 24 * 60 * 60 * 1000
    );
    expect(after.getTime()).toBeLessThanOrEqual(
      Date.now() + 24 * 60 * 60 * 1000
    );
  });

  it("does not shorten a quota park when another run finishes later", async () => {
    const resetAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const providerReset = resetAt
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    const { sql, automationId } = await createDueAutomationWithDispatchedRun({
      slug: "preserve-provider-reset",
      messageId: "msg-provider-reset-first",
    });
    await resolveAutomationRunsByMessageIds(["msg-provider-reset-first"], {
      ok: false,
      error: `429 Limit Exhausted. Your limit will reset at ${providerReset}`,
      errorCode: "PROVIDER_QUOTA_EXHAUSTED",
    });
    await sql`
      INSERT INTO runs (organization_id, run_type, automation_id, status,
                        dispatched_message_id, approved_input)
      SELECT organization_id, 'automation', ${automationId}, 'running',
             'msg-ordinary-error-second',
             ${sql.json({ finalize_nudge_count: 99, dispatch_source: "scheduled" })}
      FROM automations
      WHERE id = ${automationId}
    `;
    await resolveAutomationRunsByMessageIds(["msg-ordinary-error-second"], {
      ok: false,
      error: "provider disconnected",
    });

    const expectedNotBefore =
      Math.floor(resetAt.getTime() / 1000) * 1000 + 60_000;
    expect((await cursorOf(automationId)).getTime()).toBe(expectedNotBefore);
  });

  it("parks a reply-to-source Automation on a coded quota error", async () => {
    const resetAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const providerReset = resetAt
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    const { automationId, organizationId, agentId } =
      await createDueAutomationWithDispatchedRun({
        slug: "park-chat-reply-until-provider-reset",
        messageId: "msg-chat-provider-reset",
        dispatchSource: "event",
      });

    await chatResponseBridge(organizationId).parkQuotaExhaustedAutomation({
      messageId: "msg-chat-provider-reset",
      channelId: "chat-provider-reset",
      conversationId: "chat-provider-reset",
      userId: "automation-test",
      teamId: "telegram",
      organizationId,
      platform: "telegram",
      timestamp: Date.now(),
      error: `429 Limit Exhausted. Your limit will reset at ${providerReset}`,
      errorCode: "PROVIDER_QUOTA_EXHAUSTED",
      platformMetadata: {
        connectionId: "chat-test",
        chatId: "chat-provider-reset",
        organizationId,
        agentId,
        automationId: automationId,
      },
    });

    const after = await cursorOf(automationId);
    const expectedNotBefore =
      Math.floor(resetAt.getTime() / 1000) * 1000 + 60_000;
    expect(after.getTime()).toBe(expectedNotBefore);
  });

  it("does not park a reply-to-source Automation from another organization", async () => {
    const resetAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const providerReset = resetAt
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    const { automationId, staleCursor, organizationId, agentId } =
      await createDueAutomationWithDispatchedRun({
        slug: "reject-cross-org-chat-parking",
        messageId: "msg-cross-org-provider-reset",
        dispatchSource: "event",
      });

    await chatResponseBridge(organizationId).parkQuotaExhaustedAutomation({
      messageId: "msg-cross-org-provider-reset",
      channelId: "cross-org-provider-reset",
      conversationId: "cross-org-provider-reset",
      userId: "automation-test",
      teamId: "telegram",
      organizationId: "another-organization",
      platform: "telegram",
      timestamp: Date.now(),
      error: `429 Limit Exhausted. Your limit will reset at ${providerReset}`,
      errorCode: "PROVIDER_QUOTA_EXHAUSTED",
      platformMetadata: {
        connectionId: "chat-test",
        chatId: "cross-org-provider-reset",
        organizationId: "another-organization",
        agentId,
        automationId: automationId,
      },
    });

    expect((await cursorOf(automationId)).getTime()).toBe(staleCursor.getTime());
  });

  it("does not park another agent's Automation in the same organization", async () => {
    const resetAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const providerReset = resetAt
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    const { automationId, staleCursor, organizationId } =
      await createDueAutomationWithDispatchedRun({
        slug: "reject-cross-agent-chat-parking",
        messageId: "msg-cross-agent-provider-reset",
        dispatchSource: "event",
      });

    await chatResponseBridge(organizationId).parkQuotaExhaustedAutomation({
      messageId: "msg-cross-agent-provider-reset",
      channelId: "cross-agent-provider-reset",
      conversationId: "cross-agent-provider-reset",
      userId: "automation-test",
      teamId: "telegram",
      organizationId,
      platform: "telegram",
      timestamp: Date.now(),
      error: `429 Limit Exhausted. Your limit will reset at ${providerReset}`,
      errorCode: "PROVIDER_QUOTA_EXHAUSTED",
      platformMetadata: {
        connectionId: "chat-test",
        chatId: "cross-agent-provider-reset",
        organizationId,
        agentId: "another-agent",
        automationId: automationId,
      },
    });

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
  it("names the pending tool approval instead of blaming the agent", async () => {
    const { sql, organizationId, automationId, runId } =
      await createDueAutomationWithDispatchedRun({
        slug: "finalize-miss-names-approval",
        messageId: "msg-gated-approval",
        nudgeCount: 99,
      });
    await sql`
      INSERT INTO oauth_states (id, scope, payload, expires_at)
      VALUES (
        ${`ta_test_${runId}`},
        'pending-tool',
        ${sql.json({
          mcpId: "lobu-memory",
          toolName: "run_sdk",
          agentId: "advance-agent-finalize-miss-names-approval",
          userId: "u1",
          organizationId,
          args: {},
          conversationId: `personal-agent_automation_${automationId}_run_${runId}`,
        })},
        NOW() + INTERVAL '1 hour'
      )
    `;

    await resolveAutomationRunsByMessageIds(["msg-gated-approval"], { ok: true });

    const [run] =
      await sql`SELECT status, error_message FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");
    expect(run.error_message).toMatch(/blocked on tool approval/);
    expect(run.error_message).toMatch(/lobu-memory\/run_sdk/);
    expect(run.error_message).not.toMatch(/finished without calling/);
  });

  it("ignores approvals outside the run's tenant and conversation", async () => {
    const { sql, organizationId, automationId, runId } =
      await createDueAutomationWithDispatchedRun({
        slug: "finalize-miss-scopes-approval",
        messageId: "msg-scoped-approval",
        nudgeCount: 99,
      });
    const pending = (
      id: string,
      toolName: string,
      org: string,
      automationId: number
    ) => sql`
        INSERT INTO oauth_states (id, scope, payload, expires_at)
        VALUES (
          ${id},
          'pending-tool',
          ${sql.json({
            mcpId: "lobu-memory",
            toolName,
            agentId: "advance-agent-finalize-miss-scopes-approval",
            userId: "u1",
            organizationId: org,
            args: {},
            conversationId:
              `personal-agent_automation_${automationId}_run_${runId}`,
          })},
          NOW() + INTERVAL '1 hour'
        )
      `;
    await pending(`ta_wrong_org_${runId}`, "wrong_org", "other-org", automationId);
    await pending(
      `ta_wrong_automation_${runId}`,
      "wrong_automation",
      organizationId,
      automationId + 1
    );

    await resolveAutomationRunsByMessageIds(["msg-scoped-approval"], { ok: true });

    const [run] =
      await sql`SELECT status, error_message FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");
    expect(run.error_message).toMatch(/No active tool approval was found/);
    expect(run.error_message).not.toMatch(/wrong_org|wrong_automation/);
  });

  it("falls back to the agent-miss message when nothing is pending", async () => {
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
    expect(run.error_message).toMatch(/No active tool approval was found/);
  });
});
