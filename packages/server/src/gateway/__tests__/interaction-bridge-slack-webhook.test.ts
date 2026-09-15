import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Actions, Button, Card, CardText, Chat, LinkButton } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  linkChatIdentityInGraph,
} from "../../__tests__/setup/test-fixtures.js";
import { getDb } from "../../db/client.js";
import { __setChatInstanceManagerForTests } from "../../lobu/gateway.js";
import { proposeEntityFieldChange } from "../../tools/admin/entity-field-approval.js";
import type { ToolContext } from "../../tools/registry.js";
import { initWorkspaceProvider } from "../../workspace/index.js";
import { storePendingTool, type PendingToolInvocation } from "../auth/mcp/pending-tool-store.js";
import { registerActionHandlers } from "../connections/interaction-bridge.js";
import type { PlatformConnection } from "../connections/types.js";
import { ensureDbForGatewayTests, resetTestDatabase } from "./helpers/db-setup.js";
import { InMemoryStateAdapter } from "./fixtures/in-memory-state-adapter.js";
import {
  blockActionsPayload,
  buildSignedBlockActionsRequest,
} from "./fixtures/slack-signing.js";

const SIGNING_SECRET = "test-signing-secret-0123456789ab";
const BOT_TOKEN = "xoxb-test-token";
const BOT_USER_ID = "U_BOT";

function createHarness(options: {
  executeToolResult?: {
    content: Array<{ type: string; text: string }>;
    isError: boolean;
  };
}) {
  const { executeToolResult } = options;

  const adapter = createSlackAdapter({
    signingSecret: SIGNING_SECRET,
    botToken: BOT_TOKEN,
    botUserId: BOT_USER_ID,
  });
  // Stub Slack Web API calls so `thread.post` resolves synchronously without
  // hitting slack.com. We only care about the dispatch seam, not Slack I/O.
  const postMessage = mock(async () => ({ ts: "1700000000.000999" }) as any);
  const editMessage = mock(async () => ({ ts: "1700000000.000100" }) as any);
  (adapter as any).postMessage = postMessage;
  (adapter as any).editMessage = editMessage;

  const state = new InMemoryStateAdapter();
  const chat = new Chat({
    userName: "lobu",
    adapters: { slack: adapter },
    state,
  });

  const grantStore = { grant: mock(async () => undefined) };
  const executeToolDirect = mock(
    async () =>
      executeToolResult ?? {
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }
  );

  registerActionHandlers(
    chat as any,
    { id: "conn-1", platform: "slack", organizationId: "org-1" } as PlatformConnection,
    grantStore as any,
    executeToolDirect as any
  );

  return {
    adapter,
    chat,
    state,
    grantStore,
    executeToolDirect,
    postMessage,
    editMessage,
  };
}

/** Wait for an expectation to pass, polling briefly. Supports async checks. */
async function waitFor(
  check: () => void | Promise<void>,
  { timeoutMs = 3000, intervalMs = 20 } = {}
): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      await check();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw lastErr;
}

describe("Slack block_actions → registerActionHandlers (Tier B integration)", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

	afterEach(() => {
		__setChatInstanceManagerForTests(null);
	});

  test("signed tool-approval button triggers grant, executes tool, deletes pending", async () => {
    const pending: PendingToolInvocation = {
      mcpId: "github",
      toolName: "create_issue",
      args: { title: "from slack" },
      agentId: "agent-1",
      userId: "U_SLACK",
      organizationId: "org-1",
      conversationId: "slack:dm:123",
      channelId: "slack:D123",
      teamId: "T123",
      connectionId: "432",
      platform: "slack",
      source: "chat",
      adminTools: ["run_sdk"],
      adminActorUserId: "auth-user-1",
      deploymentName: "lobu-builder",
    };
    await storePendingTool("req-slack-1", pending, 24 * 60 * 60);

    const h = createHarness({
      executeToolResult: {
        content: [{ type: "text", text: "issue created: #7" }],
        isError: false,
      },
    });

    const request = buildSignedBlockActionsRequest(
      SIGNING_SECRET,
      blockActionsPayload({
        teamId: "T123",
        userId: "U_SLACK",
        channelId: "C_CHAN",
        messageTs: "1700000000.000100",
        actionId: "tool:req-slack-1:1h",
        value: "1h",
      })
    );

    const response = await h.chat.webhooks.slack(request);
    expect(response.status).toBe(200);

    // Wait on the tail of the handler (executeToolDirect) so earlier steps
    // (claim, grant) have all completed by the time we assert on them.
    await waitFor(() => expect(h.executeToolDirect).toHaveBeenCalled());

    // The pending row was deleted by the take-on-claim path.
    const sql = getDb();
    const remaining = await sql`
      SELECT 1 FROM oauth_states WHERE id = 'req-slack-1' AND scope = 'pending-tool'
    `;
    expect(remaining.length).toBe(0);

    expect(h.grantStore.grant).toHaveBeenCalledTimes(1);
    const [agentId, pattern] = h.grantStore.grant.mock.calls[0];
    expect(agentId).toBe("agent-1");
    expect(pattern).toBe("/mcp/github/tools/create_issue");
    expect(h.executeToolDirect).toHaveBeenCalledTimes(1);
    expect(h.executeToolDirect.mock.calls[0]).toEqual([
      "agent-1",
      "U_SLACK",
      "github",
      "create_issue",
      { title: "from slack" },
      {
        organizationId: "org-1",
        conversationId: "slack:dm:123",
        channelId: "slack:D123",
        teamId: "T123",
        connectionId: "432",
        platform: "slack",
        source: "chat",
        adminTools: ["run_sdk"],
        adminActorUserId: "auth-user-1",
        deploymentName: "lobu-builder",
      },
    ]);
    expect(h.editMessage).toHaveBeenCalledTimes(1);
    expect(h.postMessage).toHaveBeenCalled();
  });

  test("signed question button invokes onAction with button value", async () => {
    const h = createHarness({});

    const request = buildSignedBlockActionsRequest(
      SIGNING_SECRET,
      blockActionsPayload({
        teamId: "T123",
        userId: "U_ACTOR",
        channelId: "C_CHAN",
        messageTs: "1700000000.000200",
        actionId: "question:q-42:1",
        value: "Option Two",
      })
    );

    const response = await h.chat.webhooks.slack(request);
    expect(response.status).toBe(200);

    await waitFor(() => expect(h.postMessage).toHaveBeenCalled());

    // The response posted back to the thread should be the button's value.
    const postedArg = h.postMessage.mock.calls[0]?.[1];
    const postedText =
      typeof postedArg === "string" ? postedArg : postedArg?.markdown;
    expect(postedText).toBe("Option Two");

    // No grant for questions; executeToolDirect never called.
    expect(h.grantStore.grant).not.toHaveBeenCalled();
    expect(h.executeToolDirect).not.toHaveBeenCalled();
  });

  test("tampered signature is rejected before handler runs", async () => {
    const pending: PendingToolInvocation = {
      mcpId: "github",
      toolName: "create_issue",
      args: {},
      agentId: "a",
      userId: "u",
			organizationId: "org-1",
    };
    await storePendingTool("req-bad", pending, 24 * 60 * 60);

    const h = createHarness({});

    const payload = blockActionsPayload({
      teamId: "T123",
      userId: "U_ACTOR",
      channelId: "C_CHAN",
      messageTs: "1700000000.000300",
      actionId: "tool:req-bad:1h",
      value: "1h",
    });
    const request = buildSignedBlockActionsRequest(SIGNING_SECRET, payload);
    const tampered = new Request(request.url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=deadbeef",
        "x-slack-request-timestamp":
          request.headers.get("x-slack-request-timestamp") ?? "0",
      },
      body: await request.text(),
    });

    const response = await h.chat.webhooks.slack(tampered);
    expect(response.status).not.toBe(200);
    // Give any stray async work a tick — nothing downstream should have run.
    await new Promise((r) => setTimeout(r, 20));

    // Pending row still present because no claim happened.
    const sql = getDb();
    const remaining = await sql`
      SELECT 1 FROM oauth_states WHERE id = 'req-bad' AND scope = 'pending-tool'
    `;
    expect(remaining.length).toBe(1);

    expect(h.grantStore.grant).not.toHaveBeenCalled();
    expect(h.executeToolDirect).not.toHaveBeenCalled();
    expect(h.postMessage).not.toHaveBeenCalled();
  });
});

/**
 * Durable entity_field_change approvals ride the same Slack block_actions
 * webhook as tool grants / ask_user, but take a different branch
 * (`run-approval:{runId}:approve|reject` → manage_operations). Agents built
 * the card + direct-handler path first; this seals the signed-webhook → apply
 * seam so a Preview/tenant bot click actually mutates the entity.
 */
describe("Slack block_actions → run-approval entity_field_change (Tier B)", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  async function seedPendingFieldChange(): Promise<{
    orgId: string;
    entityId: number;
    runId: number;
    adminSlackId: string;
    teamId: string;
  }> {
    const TEAM_ID = "T-RUNAPPROVE";
    const org = await createTestOrganization({ name: "Run Approval Webhook Org" });
    const admin = await createTestUser({ name: "Admin Reviewer" });
    await addUserToOrganization(admin.id, org.id, "admin");
    await linkChatIdentityInGraph({
      organizationId: org.id,
      platform: "slack",
      userId: admin.id,
      teamId: TEAM_ID,
      platformUserId: "U-ADMIN-RA",
    });

    const entity = await createTestEntity({
      name: "Payment Gateway Latency",
      organization_id: org.id,
      created_by: admin.id,
    });
    await getDb()`
      UPDATE entities SET
        metadata = ${getDb().json({ severity: "critical" })},
        field_controls = ${getDb().json({
          severity: { set_by: admin.id, set_at: new Date().toISOString() },
        })}
      WHERE id = ${entity.id}
    `;

    const proposeCtx = {
      organizationId: org.id,
      userId: null,
      agentId: "peerbot",
      memberRole: null,
      isAuthenticated: true,
      tokenType: "oauth",
      scopedToOrg: true,
    } as unknown as ToolContext;
    const proposed = await proposeEntityFieldChange(proposeCtx, {
      entity_id: entity.id,
      fields: { severity: "high" },
      current: { severity: "critical" },
      attribution: "agent",
      reason: "An agent proposes updating severity on this entity.",
    });

    return {
      orgId: org.id,
      entityId: entity.id,
      runId: proposed.runId,
      adminSlackId: "U-ADMIN-RA",
      teamId: TEAM_ID,
    };
  }

	async function seedDeliveredApprovalCard(
		organizationId: string,
		runId: number,
	): Promise<void> {
		const sql = getDb();
		const [proposal] = await sql<{ id: number }>`
			SELECT id FROM events
			WHERE organization_id = ${organizationId}
			  AND run_id = ${runId}
			  AND interaction_type = 'approval'
			ORDER BY id
			LIMIT 1
		`;
		const card = Card({
			title: "Update entity field",
			subtitle: "Conversation: Slack — #approvals",
			children: [
				CardText("Severity: critical → high"),
				Actions([
					Button({
						id: `run-approval:${runId}:approve`,
						label: "Approve",
						style: "primary",
					}),
					Button({
						id: `run-approval:${runId}:reject`,
						label: "Reject",
						style: "danger",
					}),
					LinkButton({ url: "https://app.lobu.ai/review", label: "Review in Lobu" }),
				]),
			],
		});
		await sql`
			INSERT INTO events (
				organization_id, origin_id, title, payload_type, payload_text,
				occurred_at, semantic_type, metadata
			) VALUES (
				${organizationId}, ${`notification_${runId}`}, 'Update entity field',
				'text', 'Review this change', now(), 'notification',
				${sql.json({
					notification_type: "action_approval_needed",
					resource_type: "event",
					resource_id: String(proposal.id),
					resource_url: "/review",
					card,
					delivery: [
						{
							connectionId: "conn-run-approval",
							channelKey: "slack:C_APPROVALS",
							messageId: "1700000000.000500",
							threadId: "C_APPROVALS",
						},
					],
				})}
			)
		`;
	}

  function createRunApprovalHarness(opts: {
    organizationId: string;
    teamId: string;
  }) {
    const adapter = createSlackAdapter({
      signingSecret: SIGNING_SECRET,
      botToken: BOT_TOKEN,
      botUserId: BOT_USER_ID,
    });
    const postMessage = mock(async () => ({ ts: "1700000000.000999" }) as any);
    (adapter as any).postMessage = postMessage;

    const state = new InMemoryStateAdapter();
    const chat = new Chat({
      userName: "lobu",
      adapters: { slack: adapter },
      state,
    });

    registerActionHandlers(
      chat as any,
      {
        id: "conn-run-approval",
        platform: "slack",
        organizationId: opts.organizationId,
        config: {},
        settings: {},
        metadata: { teamId: opts.teamId },
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as unknown as PlatformConnection,
    );

    return { chat, postMessage };
  }

  test("signed Approve button applies the pending severity change", async () => {
    const fx = await seedPendingFieldChange();
    const h = createRunApprovalHarness({
      organizationId: fx.orgId,
      teamId: fx.teamId,
    });

    const request = buildSignedBlockActionsRequest(
      SIGNING_SECRET,
      blockActionsPayload({
        teamId: fx.teamId,
        userId: fx.adminSlackId,
        channelId: "C_APPROVALS",
        messageTs: "1700000000.000400",
        actionId: `run-approval:${fx.runId}:approve`,
        value: "approve",
      }),
    );

    const response = await h.chat.webhooks.slack(request);
    expect(response.status).toBe(200);

    await waitFor(async () => {
      const [run] = await getDb()<{
        approval_status: string | null;
        status: string | null;
      }>`SELECT approval_status, status FROM runs WHERE id = ${fx.runId}`;
      expect(run.approval_status).toBe("approved");
      expect(run.status).toBe("completed");
    });

    const [entity] = await getDb()<{ metadata: Record<string, unknown> }>`
      SELECT metadata FROM entities WHERE id = ${fx.entityId}
    `;
    expect(entity.metadata.severity).toBe("high");
		await waitFor(() => expect(h.postMessage).toHaveBeenCalledTimes(1));
		expect(String(h.postMessage.mock.calls[0]?.[1])).toContain("approved");
  });

  test("signed Reject button leaves the entity unchanged", async () => {
    const fx = await seedPendingFieldChange();
		await seedDeliveredApprovalCard(fx.orgId, fx.runId);
		const editMessageContent = mock(async () => undefined);
		__setChatInstanceManagerForTests({ editMessageContent });
    const h = createRunApprovalHarness({
      organizationId: fx.orgId,
      teamId: fx.teamId,
    });

    const request = buildSignedBlockActionsRequest(
      SIGNING_SECRET,
      blockActionsPayload({
        teamId: fx.teamId,
        userId: fx.adminSlackId,
        channelId: "C_APPROVALS",
        messageTs: "1700000000.000500",
        actionId: `run-approval:${fx.runId}:reject`,
        value: "reject",
      }),
    );

    const response = await h.chat.webhooks.slack(request);
    expect(response.status).toBe(200);

    await waitFor(async () => {
      const [run] = await getDb()<{ approval_status: string | null }>`
        SELECT approval_status FROM runs WHERE id = ${fx.runId}
      `;
      expect(run.approval_status).toBe("rejected");
    });

    const [entity] = await getDb()<{ metadata: Record<string, unknown> }>`
      SELECT metadata FROM entities WHERE id = ${fx.entityId}
    `;
    expect(entity.metadata.severity).toBe("critical");
		await waitFor(() => expect(editMessageContent).toHaveBeenCalledTimes(1));
		const settledJson = JSON.stringify(
			editMessageContent.mock.calls[0]?.[1]?.content,
		);
		expect(settledJson).toContain("*Rejected*");
		expect(settledJson).toContain("Admin Reviewer");
		expect(settledJson).toContain("Conversation: Slack — #approvals");
		expect(settledJson).not.toContain('\"type\":\"button\"');
  });

  test("unverified Slack user cannot approve — entity stays critical", async () => {
    const fx = await seedPendingFieldChange();
    const h = createRunApprovalHarness({
      organizationId: fx.orgId,
      teamId: fx.teamId,
    });

    const request = buildSignedBlockActionsRequest(
      SIGNING_SECRET,
      blockActionsPayload({
        teamId: fx.teamId,
        userId: "U-STRANGER",
        channelId: "C_APPROVALS",
        messageTs: "1700000000.000600",
        actionId: `run-approval:${fx.runId}:approve`,
        value: "approve",
      }),
    );

    const response = await h.chat.webhooks.slack(request);
    expect(response.status).toBe(200);

    await waitFor(() => expect(h.postMessage).toHaveBeenCalled());

    const [run] = await getDb()<{ approval_status: string | null }>`
      SELECT approval_status FROM runs WHERE id = ${fx.runId}
    `;
    expect(run.approval_status).toBe("pending");

    const [entity] = await getDb()<{ metadata: Record<string, unknown> }>`
      SELECT metadata FROM entities WHERE id = ${fx.entityId}
    `;
    expect(entity.metadata.severity).toBe("critical");

    const postedArg = h.postMessage.mock.calls[0]?.[1];
    const postedText =
      typeof postedArg === "string" ? postedArg : postedArg?.markdown;
    expect(String(postedText)).toContain("couldn’t verify");
  });
});
