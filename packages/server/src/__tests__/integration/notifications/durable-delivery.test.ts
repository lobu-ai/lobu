import { Actions, Button, Card } from "chat";
import { Value } from "@sinclair/typebox/value";
import { ManageOperationsResultSchema } from "@lobu/core/contracts/tools/manage-operations";
import { listOrgActivity } from "../../../tools/admin/manage_operations/activity-feed";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { __setChatInstanceManagerForTests } from "../../../lobu/gateway";
import {
  createNotificationForUsers,
  deliverNotificationTask,
  listNotifications,
} from "../../../notifications/service";
import {
  NOTIFICATION_DELIVERY_TASK,
  NOTIFICATION_DELIVERY_TASK_QUEUE,
} from "../../../scheduled/task-definitions";
import { createTestAutomationSubscription } from "../../setup/automation-subscriptions";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
  addUserToOrganization,
  createTestAgent,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  insertChatConnectionRow,
  linkChatIdentityInGraph,
} from "../../setup/test-fixtures";

describe("durable notification delivery", () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });
  afterEach(() => {
    __setChatInstanceManagerForTests(null);
  });
  afterAll(async () => {
    await cleanupTestDatabase();
  });

  async function setup() {
    const org = await createTestOrganization();
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, "owner");
    const agent = await createTestAgent({
      organizationId: org.id,
      agentId: "delivery-test",
    });
    await insertChatConnectionRow({
      id: "delivery-test",
      organizationId: org.id,
      agentId: agent.agentId,
      platform: "slack",
      status: "active",
      settings: {},
    });
    for (const channelId of ["slack:C_FIRST", "slack:C_SECOND"]) {
      await createTestAutomationSubscription({
        organizationId: org.id,
        agentId: agent.agentId,
        connectionSlug: "agentconn-delivery-test",
        platform: "slack",
        channelId,
        teamId: "T_TEST",
        configuredBy: user.id,
      });
    }
    const post = vi.fn(
      async (_connection: string, channel: string, _content: unknown) => ({
        messageId: `message-${channel}`,
        threadId: channel,
      }),
    );
    __setChatInstanceManagerForTests({ postMessageToChannel: post });
    const params = {
      organizationId: org.id,
      type: "agent_message" as const,
      title: "Useful task",
      idempotencyKey: "synthetic-notification",
    };
    return { org, user, post, params };
  }

  it("#3665 records provider acceptance and its timestamp in the durable receipt", async () => {
    const h = await setup();
    const event = await createNotificationForUsers([h.user.id], h.params);
    await deliverNotificationTask({ organizationId: h.org.id, eventId: Number(event.eventId) });
    const [saved] = await getTestDb()`SELECT metadata FROM events WHERE id = ${Number(event.eventId)}`;
    expect(saved.metadata.delivery).toHaveLength(2);
    expect(saved.metadata.delivery[0].attempts).toEqual([expect.objectContaining({
      status: "provider_accepted",
      observed_at: expect.any(String),
      provider_timestamp: null,
      provider_message_id: "message-slack:C_FIRST",
      attempt: 1,
      error: null,
    })]);
  });

  it("#3665 retains rejection evidence separately from the frozen delivery request", async () => {
    const h = await setup();
    const event = await createNotificationForUsers([h.user.id], h.params);
    h.post.mockRejectedValue(Object.assign(new Error("synthetic provider rejection"), { status: 403 }));
    const [before] = await getTestDb()`SELECT metadata FROM events WHERE id = ${Number(event.eventId)}`;
    await deliverNotificationTask({ organizationId: h.org.id, eventId: Number(event.eventId) });
    expect(h.post).toHaveBeenCalledTimes(2);
    const [after] = await getTestDb()`SELECT metadata FROM events WHERE id = ${Number(event.eventId)}`;
    expect(after.metadata).not.toEqual(before.metadata);
    expect(after.metadata.delivery[0].attempts[0]).toMatchObject({
      status: "failed", error: { code: "provider_permission", retryable: false },
    });
    await deliverNotificationTask({ organizationId: h.org.id, eventId: Number(event.eventId) });
    expect(h.post).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(after.metadata)).not.toContain("synthetic provider rejection");
  });

  it("#3665 retains unavailable-binding evidence when a frozen destination disappears", async () => {
    const h = await setup();
    const event = await createNotificationForUsers([h.user.id], h.params);
    const sql = getTestDb();
    const [before] = await sql`SELECT metadata FROM events WHERE id = ${Number(event.eventId)}`;
    await sql`UPDATE connections SET status = 'paused' WHERE organization_id = ${h.org.id}`;
    await expect(deliverNotificationTask({ organizationId: h.org.id, eventId: Number(event.eventId) }))
      .rejects.toThrow();
    expect(h.post).not.toHaveBeenCalled();
    const [after] = await sql`SELECT metadata FROM events WHERE id = ${Number(event.eventId)}`;
    expect(after.metadata).not.toEqual(before.metadata);
  });

  it("#3665 exposes provider receipt state on the notification read path used by the UI", async () => {
    const h = await setup();
    const event = await createNotificationForUsers([h.user.id], h.params);
    await deliverNotificationTask({ organizationId: h.org.id, eventId: Number(event.eventId) });
    const { notifications } = await listNotifications({ organizationId: h.org.id, userId: h.user.id });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toHaveProperty("delivery");
  });

  it("exposes queued, dispatched, then accepted evidence without changing existing inbox/activity meanings", async () => {
    const h = await setup();
    const sql = getTestDb();
    const [sourceRun] = await sql`
      INSERT INTO runs (organization_id, run_type, action_key, status)
      VALUES (${h.org.id}, 'internal', 'synthetic-notification-source', 'completed') RETURNING id
    `;
    const event = await createNotificationForUsers([h.user.id], {
      ...h.params, runId: Number(sourceRun.id), channelId: "slack:C_FIRST", deliveryScope: "targeted",
    });
    const read = async () => (await listNotifications({ organizationId: h.org.id, userId: h.user.id })).notifications[0];
    const queued = await read();
    expect(queued.delivery).toMatchObject({
      event_id: event.eventId, run_id: Number(sourceRun.id), automation_id: null, outcome: "queued",
      targets: [{ connection_id: "delivery-test", channel: "slack:C_FIRST", platform: "slack", attempts: [
        { attempt: 1, status: "queued", provider_message_id: null, provider_timestamp: null },
      ] }],
    });
    h.post.mockImplementation(async (_connection, channel) => {
      // This independent connection can only see committed dispatch evidence.
      expect((await read()).delivery).toMatchObject({ outcome: "dispatched" });
      return { messageId: `message-${channel}`, threadId: channel };
    });
    await deliverNotificationTask({ organizationId: h.org.id, eventId: Number(event.eventId) });
    const accepted = await read();
    const { delivery, ...before } = queued;
    const { delivery: acceptedDelivery, ...after } = accepted;
    expect(after).toEqual(before);
    expect(after).not.toHaveProperty("delivery_metadata");
    expect(after).not.toHaveProperty("delivery_run_id");
    expect(acceptedDelivery).toMatchObject({ outcome: "provider_accepted" });
    const activity = await listOrgActivity({
      organizationId: h.org.id, userId: h.user.id, ownerSlug: "synthetic-workspace", includeRuns: false,
    });
    expect(activity.items[0]).toMatchObject({ status: "agent_message", at: String(queued.created_at), delivery: acceptedDelivery });
    expect(activity.items[0].run_id).toBeUndefined();
    expect(Value.Check(ManageOperationsResultSchema, { action: "list_activity", ...activity })).toBe(true);
    expect(delivery).not.toEqual(acceptedDelivery);
  });

  it("distinguishes intentional zero-target from an unavailable configured Automation target", async () => {
    const h = await setup();
    const empty = await createNotificationForUsers([h.user.id], { ...h.params, deliveryScope: "targeted" });
    await deliverNotificationTask({ organizationId: h.org.id, eventId: Number(empty.eventId) });
    let inbox = await listNotifications({ organizationId: h.org.id, userId: h.user.id });
    expect(inbox.notifications[0].delivery).toMatchObject({ outcome: "no_target", targets: [] });
    const sql = getTestDb();
    const [automation] = await sql`SELECT id FROM automations WHERE organization_id = ${h.org.id} LIMIT 1`;
    await sql`UPDATE automations SET delivery_target = '{"connection_id":999999,"channel_id":"slack:C_MISSING"}'::jsonb
      WHERE id = ${automation.id}`;
    const failed = await createNotificationForUsers([h.user.id], {
      ...h.params, idempotencyKey: "synthetic-unavailable-target", automationId: Number(automation.id),
    });
    await expect(deliverNotificationTask({ organizationId: h.org.id, eventId: Number(failed.eventId) }))
      .rejects.toThrow("target is unavailable");
    inbox = await listNotifications({ organizationId: h.org.id, userId: h.user.id });
    expect(inbox.notifications[0].delivery).toMatchObject({ outcome: "failed", targets: [], automation_id: Number(automation.id) });
    expect(h.post).not.toHaveBeenCalled();
  });

  it("retains retry attempts and stable destination keys without storing provider messages or credentials", async () => {
    const h = await setup();
    const event = await createNotificationForUsers([h.user.id], {
      ...h.params, channelId: "slack:C_FIRST", deliveryScope: "targeted",
    });
    const input = { organizationId: h.org.id, eventId: Number(event.eventId) };
    const providerError = Object.assign(new Error("SYNTHETIC_SECRET and extra provider body"), { status: 503 });
    h.post.mockRejectedValueOnce(providerError);
    await expect(deliverNotificationTask(input)).rejects.toMatchObject({
      message: "Notification delivery failed: provider_unavailable: SYNTHETIC_SECRET and extra provider body",
      errors: [expect.objectContaining({ cause: providerError })],
    });
    await deliverNotificationTask(input);
    await deliverNotificationTask(input);
    const [row] = await getTestDb()`SELECT metadata FROM events WHERE id = ${input.eventId}`;
    const attempts = row.metadata.delivery[0].attempts;
    expect(attempts.map((attempt: { status: string }) => attempt.status)).toEqual(["failed", "provider_accepted"]);
    expect(attempts.map((attempt: { attempt: number }) => attempt.attempt)).toEqual([1, 2]);
    expect(attempts[0].idempotency_key).toBe(attempts[1].idempotency_key);
    expect(attempts[0].error).toEqual({ code: "provider_unavailable", retryable: true });
    expect(JSON.stringify(row.metadata)).not.toContain("SYNTHETIC_SECRET");
    expect(JSON.stringify(row.metadata)).not.toContain("extra provider body");
    expect(h.post).toHaveBeenCalledTimes(2);
  });

  it.each([new Error("synthetic provider outage"), "synthetic provider outage"])(
    "preserves an unclassified provider cause without copying it into receipts: %s",
    async (providerError) => {
      const h = await setup();
      const event = await createNotificationForUsers([h.user.id], {
        ...h.params, channelId: "slack:C_FIRST", deliveryScope: "targeted",
      });
      h.post.mockRejectedValueOnce(providerError);
      await expect(deliverNotificationTask({ organizationId: h.org.id, eventId: Number(event.eventId) }))
        .rejects.toMatchObject({
          message: "Notification delivery failed: delivery_unknown: synthetic provider outage",
          errors: [expect.objectContaining({ cause: providerError })],
        });
      const [row] = await getTestDb()`SELECT metadata FROM events WHERE id = ${Number(event.eventId)}`;
      expect(row.metadata.delivery[0].attempts[0]).toMatchObject({
        status: "failed", error: { code: "delivery_unknown", retryable: true },
      });
      expect(JSON.stringify(row.metadata)).not.toContain("synthetic provider outage");
      const activity = await listOrgActivity({
        organizationId: h.org.id, userId: h.user.id, ownerSlug: "synthetic-workspace", includeRuns: false,
      });
      expect(activity.items[0].delivery).toMatchObject({ outcome: "failed" });
      expect(JSON.stringify(activity)).not.toContain("synthetic provider outage");
    },
  );

  it("keeps dispatch evidence if provider acceptance cannot commit, and records the queue retry separately", async () => {
    const h = await setup();
    const event = await createNotificationForUsers([h.user.id], {
      ...h.params, channelId: "slack:C_FIRST", deliveryScope: "targeted",
    });
    const input = { organizationId: h.org.id, eventId: Number(event.eventId) };
    const sql = getTestDb();
    const [task] = await sql`SELECT id FROM runs WHERE organization_id = ${h.org.id}
      AND action_key = ${NOTIFICATION_DELIVERY_TASK}`;
    const taskRunId = Number(task.id);
    await sql.unsafe(`CREATE FUNCTION test_reject_provider_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF jsonb_path_exists(NEW.metadata, '$.delivery[*].attempts[*] ? (@.status == "provider_accepted")') THEN
          RAISE EXCEPTION 'synthetic receipt commit failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_reject_provider_receipt BEFORE UPDATE ON events
      FOR EACH ROW EXECUTE FUNCTION test_reject_provider_receipt();`);
    try {
      await expect(deliverNotificationTask(input, { taskRunId, attempt: 1 })).rejects.toMatchObject({
        message: "Notification delivery failed: delivery_unknown: synthetic receipt commit failure",
        errors: [expect.objectContaining({
          cause: expect.objectContaining({ message: "synthetic receipt commit failure", code: "P0001" }),
        })],
      });
      await expect(deliverNotificationTask(input, { taskRunId, attempt: 2 })).rejects.toThrow();
      await expect(deliverNotificationTask(input, { taskRunId, attempt: 1 })).rejects.toThrow("attempt_superseded");
      const [row] = await sql`SELECT metadata FROM events WHERE id = ${input.eventId}`;
      expect(row.metadata.delivery[0].attempts).toMatchObject([
        { attempt: 1, status: "dispatched", error: null },
        { attempt: 2, status: "dispatched", error: null },
      ]);
      expect(row.metadata.delivery[0].messageId).toBeUndefined();
      expect(h.post).toHaveBeenCalledTimes(2);
    } finally {
      await sql.unsafe("DROP TRIGGER test_reject_provider_receipt ON events; DROP FUNCTION test_reject_provider_receipt()");
    }
    await deliverNotificationTask(input, { taskRunId, attempt: 3 });
    const [row] = await sql`SELECT metadata FROM events WHERE id = ${input.eventId}`;
    expect(row.metadata.delivery[0].attempts.map((attempt: { status: string }) => attempt.status))
      .toEqual(["dispatched", "dispatched", "provider_accepted"]);
    // The provider has no common idempotency contract. Do not hide this ambiguity.
    expect(h.post).toHaveBeenCalledTimes(3);
  });

  it("commits one queue handoff with the inbox, including racing producer retries", async () => {
    const h = await setup();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        createNotificationForUsers([h.user.id], h.params),
      ),
    );
    expect(new Set(results.map((r) => r.eventId)).size).toBe(1);
    expect(h.post).not.toHaveBeenCalled();
    const sql = getTestDb();
    const rows = await sql`
      SELECT queue_name, action_input
      FROM runs
      WHERE organization_id = ${h.org.id}
        AND action_key = ${NOTIFICATION_DELIVERY_TASK}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].queue_name).toBe(NOTIFICATION_DELIVERY_TASK_QUEUE);
    expect(rows[0].action_input.payload.eventId).toBe(results[0].eventId);
  });

  it("commits successful receipts and retries only the failed destination", async () => {
    const h = await setup();
    const event = await createNotificationForUsers([h.user.id], h.params);
    let fail = true;
    h.post.mockImplementation(async (_connection, channel) => {
      if (channel === "slack:C_SECOND" && fail) {
        throw new Error("provider unavailable");
      }
      return { messageId: `message-${channel}`, threadId: channel };
    });
    const input = { organizationId: h.org.id, eventId: Number(event.eventId) };
    await expect(deliverNotificationTask(input)).rejects.toThrow();
    const sql = getTestDb();
    const [saved] = await sql`
      SELECT metadata FROM events WHERE id = ${input.eventId}
    `;
    expect(saved.metadata.delivery.map((target: { attempts: { status: string }[] }) => target.attempts.at(-1)?.status))
      .toEqual(["provider_accepted", "failed"]);
    fail = false;
    await deliverNotificationTask(input);
    await deliverNotificationTask(input);
    expect(
      h.post.mock.calls.filter((c) => c[1] === "slack:C_FIRST"),
    ).toHaveLength(1);
    expect(
      h.post.mock.calls.filter((c) => c[1] === "slack:C_SECOND"),
    ).toHaveLength(2);
  });

  it("serializes concurrent delivery replays", async () => {
    const h = await setup();
    const event = await createNotificationForUsers([h.user.id], h.params);
    const input = { organizationId: h.org.id, eventId: Number(event.eventId) };
    await Promise.all([
      deliverNotificationTask(input),
      deliverNotificationTask(input),
    ]);
    expect(h.post).toHaveBeenCalledTimes(2);
  });

  it("retries when a chat manager is unavailable", async () => {
    const h = await setup();
    const event = await createNotificationForUsers([h.user.id], h.params);
    __setChatInstanceManagerForTests(null);
    await expect(
      deliverNotificationTask({
        organizationId: h.org.id,
        eventId: Number(event.eventId),
      }),
    ).rejects.toThrow("gateway");
  });

  it("retries a resolved owner DM without widening to channels", async () => {
    const h = await setup();
    await linkChatIdentityInGraph({
      organizationId: h.org.id,
      platform: "slack",
      userId: h.user.id,
      teamId: "T_TEST",
      platformUserId: "U_SYNTHETIC_OWNER",
    });
    let fail = true;
    const postDirectMessage = vi.fn(async () => {
      if (fail) {
        throw new Error("provider unavailable");
      }
      return { messageId: "synthetic-dm-message", threadId: "synthetic-dm" };
    });
    __setChatInstanceManagerForTests({
      postMessageToChannel: h.post,
      postDirectMessage,
    });
    const event = await createNotificationForUsers([h.user.id], {
      ...h.params,
      type: "action_approval_needed",
      deliveryScope: "targeted",
      ownerUserId: h.user.id,
    });
    const input = {
      organizationId: h.org.id,
      eventId: Number(event.eventId),
    };

    await expect(deliverNotificationTask(input)).rejects.toThrow(
      "delivery_unknown",
    );
    fail = false;
    await deliverNotificationTask(input);
    await deliverNotificationTask(input);
    expect(postDirectMessage).toHaveBeenCalledTimes(2);
    expect(h.post).not.toHaveBeenCalled();
  });

  it("rejects another tenant's event", async () => {
    const h = await setup();
    const event = await createNotificationForUsers([h.user.id], h.params);
    await expect(
      deliverNotificationTask({
        organizationId: "other-synthetic-org",
        eventId: Number(event.eventId),
      }),
    ).rejects.toThrow();
    expect(h.post).not.toHaveBeenCalled();
  });

  it("never sends an old notification into a newly bound channel", async () => {
    const h = await setup();
    const event = await createNotificationForUsers([h.user.id], h.params);
    await createTestAutomationSubscription({
      organizationId: h.org.id,
      agentId: "delivery-test",
      connectionSlug: "agentconn-delivery-test",
      platform: "slack",
      channelId: "slack:C_NEW",
      teamId: "T_TEST",
      configuredBy: h.user.id,
    });
    await deliverNotificationTask({
      organizationId: h.org.id,
      eventId: Number(event.eventId),
    });
    expect(h.post.mock.calls.map((c) => c[1])).toEqual([
      "slack:C_FIRST",
      "slack:C_SECOND",
    ]);
  });

  it("rolls the inbox back when its queue handoff cannot commit", async () => {
    const h = await setup();
    const sql = getTestDb();
    await sql.unsafe(`
      CREATE FUNCTION test_reject_notification_task()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action_key = 'deliver-notification' THEN
          RAISE EXCEPTION 'synthetic queue failure';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await sql.unsafe(`
      CREATE TRIGGER test_reject_notification_task
      BEFORE INSERT ON runs
      FOR EACH ROW EXECUTE FUNCTION test_reject_notification_task()
    `);
    try {
      await expect(
        createNotificationForUsers([h.user.id], h.params),
      ).rejects.toThrow("synthetic queue failure");
      const [row] = await sql`
        SELECT count(*)::int AS n
        FROM events
        WHERE organization_id = ${h.org.id}
          AND metadata->>'_lobu_idempotency_key' = ${h.params.idempotencyKey}
      `;
      expect(row.n).toBe(0);
      expect(h.post).not.toHaveBeenCalled();
    } finally {
      await sql.unsafe("DROP TRIGGER test_reject_notification_task ON runs");
      await sql.unsafe("DROP FUNCTION test_reject_notification_task()");
    }
  });

  it("does not fall back when the saved destination is unbound", async () => {
    const h = await setup();
    const event = await createNotificationForUsers([h.user.id], {
      ...h.params,
      channelId: "slack:C_FIRST",
      deliveryScope: "targeted",
    });
    const sql = getTestDb();
    await sql`
      UPDATE automations
      SET triggers = '[]'::jsonb
      WHERE organization_id = ${h.org.id}
        AND triggers::text LIKE '%C_FIRST%'
    `;
    await expect(
      deliverNotificationTask({
        organizationId: h.org.id,
        eventId: Number(event.eventId),
      }),
    ).rejects.toThrow("binding_unavailable");
    expect(h.post).not.toHaveBeenCalled();
  });

  it("drops controls for an approval resolved before delivery", async () => {
    const h = await setup();
    const sql = getTestDb();
    const [run] = await sql`
      INSERT INTO runs (
        organization_id, run_type, action_key, approval_status, status
      ) VALUES (
        ${h.org.id}, 'internal', 'synthetic-approval', 'pending', 'pending'
      )
      RETURNING id
    `;
    const event = await createNotificationForUsers([h.user.id], {
      ...h.params,
      type: "action_approval_needed",
      decisionRunId: Number(run.id),
    });
    await sql`
      UPDATE runs
      SET approval_status = 'approved', status = 'completed'
      WHERE id = ${run.id}
    `;
    await deliverNotificationTask({
      organizationId: h.org.id,
      eventId: Number(event.eventId),
    });
    expect(h.post).not.toHaveBeenCalled();
  });

  it("settles a resource-linked approval resolved during its first post", async () => {
    const h = await setup();
    const sql = getTestDb();
    const [run] = await sql`
      INSERT INTO runs (
        organization_id, run_type, action_key, approval_status, status
      ) VALUES (
        ${h.org.id}, 'internal', 'synthetic-racing-approval', 'pending', 'pending'
      )
      RETURNING id
    `;
    const runId = Number(run.id);
    const proposal = await createTestEvent({
      organization_id: h.org.id,
      title: "Synthetic approval",
      content: "Approve this delivery",
      semantic_type: "operation",
    });
    await sql`
      UPDATE events
      SET run_id = ${runId},
          interaction_type = 'approval',
          interaction_status = 'pending'
      WHERE id = ${proposal.id}
    `;
    const card = Card({
      title: "Approve this delivery",
      children: [
        Actions([
          Button({
            id: `run-approval:${runId}:approve`,
            label: "Approve",
          }),
        ]),
      ],
    });
    const event = await createNotificationForUsers([h.user.id], {
      ...h.params,
      type: "action_approval_needed",
      resourceType: "event",
      resourceId: String(proposal.id),
      card,
    });
    const editMessageContent = vi.fn(async () => undefined);
    h.post.mockImplementation(async (_connection, channel) => {
      await sql`
        UPDATE runs
        SET approval_status = 'approved',
            status = 'completed',
            completed_at = NOW()
        WHERE id = ${runId}
      `;
      return { messageId: `message-${channel}`, threadId: channel };
    });
    __setChatInstanceManagerForTests({
      postMessageToChannel: h.post,
      editMessageContent,
    });

    await deliverNotificationTask({
      organizationId: h.org.id,
      eventId: Number(event.eventId),
    });
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(editMessageContent).toHaveBeenCalledTimes(1);
    const settledCard = JSON.stringify(editMessageContent.mock.calls[0]);
    expect(settledCard).toContain("Approved");
    expect(settledCard).not.toContain('"type":"button"');
  });

  it("includes the review link in a plain chat notification", async () => {
    const h = await setup();
    const event = await createNotificationForUsers([h.user.id], {
      ...h.params,
      resourceUrl: "https://example.test/review",
    });
    await deliverNotificationTask({
      organizationId: h.org.id,
      eventId: Number(event.eventId),
    });
    expect(h.post.mock.calls[0]?.[2]).toEqual({
      markdown: "Useful task\n\nhttps://example.test/review",
    });
  });

  it.each([
    "ready", "activated", "running", "timeout", "expired",
    "approval-required", "lost-identity", "not-page-activated",
    "ready-with-approval", "resolved-separate-approval",
  ])("checks current browser handoff readiness: %s", async (state) => {
    const h = await setup();
    const sql = getTestDb();
    let activatedBy: string | null = null;
    if (state === "activated") {
      const [device] = await sql`
        INSERT INTO device_workers (user_id, worker_id, platform, capabilities, organization_id, last_seen_at, app_version)
        VALUES (${h.user.id}, 'synthetic-draft-device', 'chrome-extension', '[]'::jsonb, ${h.org.id}, NOW(), '0.6.1')
        RETURNING id
      `;
      activatedBy = device.id;
    }
    const [run] = await sql`
      INSERT INTO runs (
        organization_id, run_type, action_key, approval_status, status,
        activation_kind, activation_target_urls, run_metadata, expires_at,
        activated_at, activated_by_device_worker_id, activation_tab_id
      ) VALUES (
        ${h.org.id}, 'action', 'synthetic-browser-draft',
        ${state === "approval-required" ? "pending" : "auto"},
        ${state === "running" || state === "timeout" ? state : "pending"},
        ${state === "not-page-activated" ? null : "page_visit"},
        CASE WHEN ${state === "not-page-activated"} THEN NULL ELSE ARRAY['https://example.test/draft']::text[] END,
        ${sql.json(state === "lost-identity" ? {} : { page_activation_identity: "exact" })},
        ${new Date(Date.now() + (state === "expired" ? -60000 : 60000))},
        ${state === "activated" ? new Date() : null},
        ${activatedBy}::uuid, ${state === "activated" ? 42 : null}
      ) RETURNING id
    `;
    let decisionRunId: number | undefined;
    if (state === "ready-with-approval" || state === "resolved-separate-approval") {
      const [approval] = await sql`
        INSERT INTO runs (organization_id, run_type, action_key, approval_status, status)
        VALUES (${h.org.id}, 'internal', 'synthetic-separate-approval',
          ${state === "resolved-separate-approval" ? "approved" : "pending"}, 'pending')
        RETURNING id
      `;
      decisionRunId = Number(approval.id);
    }
    const event = await createNotificationForUsers([h.user.id], {
      ...h.params,
      browserRunId: Number(run.id),
      browserUrl: "https://example.test/draft",
      decisionRunId,
    });
    await deliverNotificationTask({ organizationId: h.org.id, eventId: Number(event.eventId) });
    expect(h.post).toHaveBeenCalledTimes(state.startsWith("ready") ? 2 : 0);
  });

  it("does not treat a post without a message id as delivered", async () => {
    const h = await setup();
    const event = await createNotificationForUsers([h.user.id], h.params);
    h.post.mockResolvedValue({ messageId: "", threadId: "synthetic-thread" });
    await expect(
      deliverNotificationTask({
        organizationId: h.org.id,
        eventId: Number(event.eventId),
      }),
    ).rejects.toThrow("provider_receipt_missing");
  });

  it("does not replay a successful provider post without a thread id", async () => {
    const h = await setup();
    const event = await createNotificationForUsers([h.user.id], h.params);
    h.post.mockImplementation(async (_connection, channel) => ({
      messageId: `message-${channel}`,
      threadId: "",
    }));
    const input = { organizationId: h.org.id, eventId: Number(event.eventId) };

    await deliverNotificationTask(input);
    await deliverNotificationTask(input);
    expect(h.post).toHaveBeenCalledTimes(2);
    const [saved] = await getTestDb()`
      SELECT metadata FROM events WHERE id = ${input.eventId}
    `;
    expect(saved.metadata.delivery).toHaveLength(2);
    expect(saved.metadata.delivery).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channelKey: "slack:C_FIRST", threadId: "" }),
        expect.objectContaining({ channelKey: "slack:C_SECOND", threadId: "" }),
      ]),
    );
  });
});
