import { Actions, Button, Card } from "chat";
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
  linkSlackIdentityInGraph,
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
    expect(saved.metadata.delivery).toHaveLength(1);
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
    await linkSlackIdentityInGraph({
      organizationId: h.org.id,
      userId: h.user.id,
      teamId: "T_TEST",
      slackUserId: "U_SYNTHETIC_OWNER",
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
      "provider unavailable",
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
    ).rejects.toThrow("no longer authorized");
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
    ).rejects.toThrow("message id");
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
