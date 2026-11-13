import { Actions, Button, Card, CardText, LinkButton } from "chat";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../index";
import { __setChatInstanceManagerForTests } from "../../../lobu/gateway";
import {
	getUnreadCount,
	listNotifications,
	refreshApprovalNotificationCards,
} from "../../../notifications/service";
import { manageOperations } from "../../../tools/admin/manage_operations";
import { listOrgActivity } from "../../../tools/admin/manage_operations/activity-feed";
import type { ToolContext } from "../../../tools/registry";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestConnection,
	createTestEvent,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

async function seedApprovalNotification(opts: {
	organizationId: string;
	userId: string;
	actionKey: string;
	title: string;
	/** When set, the proposal event is tied to this connection. */
	proposalConnectionId?: number;
}): Promise<number> {
	const sql = getTestDb();
	const [run] = await sql`
		INSERT INTO runs (
			organization_id, run_type, action_key, approval_status, status, created_at
		) VALUES (
			${opts.organizationId}, 'internal', ${opts.actionKey},
			'pending', 'pending', now()
		)
		RETURNING id
	`;
	const runId = Number(run.id);
	const proposal = await createTestEvent({
		organization_id: opts.organizationId,
		connection_id: opts.proposalConnectionId,
		title: `${opts.title} proposal`,
		content: "Pending approval",
		semantic_type: "operation",
	});
	await sql`
		UPDATE events
		SET run_id = ${runId},
		    interaction_type = 'approval',
		    interaction_status = 'pending'
		WHERE id = ${proposal.id}
	`;
	const notification = await createTestEvent({
		organization_id: opts.organizationId,
		title: opts.title,
		content: "Review this change",
		semantic_type: "notification",
		metadata: {
			notification_type: "action_approval_needed",
			resource_type: "event",
			resource_id: String(proposal.id),
			resource_url: `/acme/memory?run_ids=${runId}`,
		},
	});
	await sql`
		INSERT INTO notification_targets (event_id, user_id)
		VALUES (${notification.id}, ${opts.userId})
	`;
	return runId;
}

describe("approval notification live state", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	afterAll(async () => {
		await cleanupTestDatabase();
	});

	afterEach(() => {
		__setChatInstanceManagerForTests(null);
	});

	it("resolves the proposal run and exposes inline policy with current state", async () => {
		const sql = getTestDb();
		const org = await createTestOrganization({ slug: "acme" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const entityRunId = await seedApprovalNotification({
			organizationId: org.id,
			userId: user.id,
			actionKey: "entity_change",
			title: "Merge duplicates",
		});
		await seedApprovalNotification({
			organizationId: org.id,
			userId: user.id,
			actionKey: "manage_automations",
			title: "Change Automation",
		});

		const pending = await listOrgActivity({
			organizationId: org.id,
			userId: user.id,
			ownerSlug: org.slug,
			includeRuns: false,
			aggregate: false,
		});
		expect(pending.items.find((item) => item.title === "Merge duplicates")).toEqual(
			expect.objectContaining({
				run_id: entityRunId,
				interaction_type: "approval",
				interaction_status: "pending",
				interaction_inline: true,
			}),
		);
		expect(pending.items.find((item) => item.title === "Change Automation")).toEqual(
			expect.objectContaining({
				interaction_type: "approval",
				interaction_status: "pending",
				interaction_inline: undefined,
			}),
		);

		await sql`
			UPDATE runs
			SET approval_status = 'expired', status = 'cancelled'
			WHERE id = ${entityRunId}
		`;
		const expired = await listOrgActivity({
			organizationId: org.id,
			userId: user.id,
			ownerSlug: org.slug,
			includeRuns: false,
			aggregate: false,
		});
		expect(expired.items.find((item) => item.title === "Merge duplicates")).toEqual(
			expect.objectContaining({
				run_id: entityRunId,
				interaction_type: "approval",
				interaction_status: "expired",
				interaction_inline: true,
			}),
		);
	});

	it("counts an approval as unread only while it can still be decided", async () => {
		const sql = getTestDb();
		const org = await createTestOrganization({ slug: "acme" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const conn = await createTestConnection({
			organization_id: org.id,
			connector_key: "synthetic.device",
			created_by: user.id,
		});
		const expiringRunId = await seedApprovalNotification({
			organizationId: org.id,
			userId: user.id,
			actionKey: "entity_change",
			title: "Merge duplicates",
		});
		await seedApprovalNotification({
			organizationId: org.id,
			userId: user.id,
			actionKey: "observe",
			title: "Observe UI",
			proposalConnectionId: conn.id,
		});
		await seedApprovalNotification({
			organizationId: org.id,
			userId: user.id,
			actionKey: "manage_automations",
			title: "Change Automation",
		});
		const options = { organizationId: org.id, userId: user.id, limit: 50 };
		const unreadTitles = async () =>
			(await listNotifications({ ...options, unreadOnly: true })).notifications.map((n) => n.title).sort();
		expect(await getUnreadCount(org.id, user.id)).toBe(3);

		// One window elapses, one card becomes unreachable: neither can be decided any more.
		await sql`UPDATE runs SET approval_status = 'expired', status = 'cancelled' WHERE id = ${expiringRunId}`;
		await sql`UPDATE connections SET deleted_at = NOW() WHERE id = ${conn.id}`;

		expect(await getUnreadCount(org.id, user.id)).toBe(1);
		expect(await unreadTitles()).toEqual(["Change Automation"]);
		expect(
			(await listNotifications({ ...options, attentionOnly: true })).notifications.map((n) => n.title),
		).toEqual(["Change Automation"]);
		// History still holds all three, with their resolved state.
		const history = (await listNotifications(options)).notifications;
		expect(history.map((n) => [n.title, n.approval_status, n.is_read]).sort()).toEqual([
			["Change Automation", "pending", false],
			["Merge duplicates", "expired", false],
			["Observe UI", "expired", false],
		]);
	});

	it("resolves a pending approval whose review card is unreachable as expired", async () => {
		const sql = getTestDb();
		const org = await createTestOrganization({ slug: "acme" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const conn = await createTestConnection({
			organization_id: org.id,
			connector_key: "apple.computer_use",
			created_by: user.id,
		});
		// Soft-delete the connection: its events vanish from every content read
		// (connection-visibility predicate), so the approval card is unreachable
		// even though the raw-row notification join still resolves the pending
		// run. The card must resolve terminal, never as an actionable pending.
		await sql`UPDATE connections SET deleted_at = NOW() WHERE id = ${conn.id}`;
		await seedApprovalNotification({
			organizationId: org.id,
			userId: user.id,
			actionKey: "observe",
			title: "Observe UI",
			proposalConnectionId: conn.id,
		});

		const { notifications } = await listNotifications({
			organizationId: org.id,
			userId: user.id,
			limit: 50,
		});
		const notif = notifications.find((n) => n.title === "Observe UI");
		expect(notif).toBeDefined();
		expect(notif?.interaction_type).toBe("approval");
		expect(notif?.approval_status).toBe("expired");

		const feed = await listOrgActivity({
			organizationId: org.id,
			userId: user.id,
			ownerSlug: org.slug,
			includeRuns: false,
			aggregate: false,
		});
		expect(feed.items.find((item) => item.title === "Observe UI")).toEqual(
			expect.objectContaining({
				interaction_type: "approval",
				interaction_status: "expired",
			}),
		);
	});

	it("settles every persisted chat copy with reviewer, time, and origin", async () => {
		const sql = getTestDb();
		const org = await createTestOrganization({ slug: "acme" });
		const user = await createTestUser({ name: "Ada Reviewer" });
		await addUserToOrganization(user.id, org.id, "owner");
		const [run] = await sql`
			INSERT INTO runs (
				organization_id, run_type, action_key, approval_status, status, created_at
			) VALUES (${org.id}, 'action', 'search_jira', 'pending', 'pending', now())
			RETURNING id
		`;
		const runId = Number(run.id);
		const proposal = await createTestEvent({
			organization_id: org.id,
			title: "Search Jira proposal",
			content: "Pending approval",
			semantic_type: "operation",
		});
		await sql`
			UPDATE events
			SET run_id = ${runId},
			    interaction_type = 'approval',
			    interaction_status = 'pending'
			WHERE id = ${proposal.id}
		`;
		const initialCard = Card({
			title: "Search Jira issues",
			subtitle: "Conversation: Slack — #release-prep",
			children: [
				CardText("JQL: project = LOBU"),
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
					LinkButton({
						url: "https://app.lobu.ai/acme/memory?run_ids=1",
						label: "Review in Lobu",
					}),
				]),
			],
		});
		await createTestEvent({
			organization_id: org.id,
			title: "Search Jira issues",
			content: "Review this operation",
			semantic_type: "notification",
			metadata: {
				notification_type: "action_approval_needed",
				resource_type: "event",
				resource_id: String(proposal.id),
				resource_url: `/acme/memory?run_ids=${runId}`,
				card: initialCard,
				delivery: [
					{
						connectionId: "conn-slack",
						channelKey: "slack:C123",
						messageId: "1700000000.000500",
						threadId: "C123",
					},
				],
			},
		});
		const editMessageContent = vi.fn(async () => undefined);
		__setChatInstanceManagerForTests({ editMessageContent });
		const result = await manageOperations(
			{ action: "reject", run_id: runId },
			{} as Env,
			{
				organizationId: org.id,
				userId: user.id,
				memberRole: "owner",
				isAuthenticated: true,
				tokenType: "session",
				scopes: ["mcp:read", "mcp:write"],
				scopedToOrg: true,
				allowCrossOrg: false,
			} as ToolContext,
		);
		expect(result).toEqual(expect.objectContaining({ rejected: true, run_id: runId }));
		await vi.waitFor(() =>
			expect(editMessageContent).toHaveBeenCalledTimes(1),
		);

		const settledJson = JSON.stringify(editMessageContent.mock.calls[0]);
		expect(settledJson).toContain("Conversation: Slack — #release-prep");
		expect(settledJson).toContain("*Rejected* by Ada Reviewer");
		expect(settledJson).toContain("UTC");
		expect(settledJson).toContain('"label":"View in Lobu"');
		expect(settledJson).not.toContain('"type":"button"');

		const duplicateDecision = await createTestEvent({
			organization_id: org.id,
			title: "Later approval receipt",
			content: "A duplicate current receipt",
			semantic_type: "operation",
			metadata: { reviewed_by_name: "Later Reviewer" },
		});
		await sql`
			UPDATE events
			SET run_id = ${runId},
			    interaction_type = 'approval',
			    interaction_status = 'rejected',
			    occurred_at = now() + interval '1 minute'
			WHERE id = ${duplicateDecision.id}
		`;
		editMessageContent.mockClear();
		await refreshApprovalNotificationCards(org.id, [runId]);
		expect(editMessageContent).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(editMessageContent.mock.calls[0])).toContain(
			"Later Reviewer",
		);

		await sql`UPDATE runs SET approval_status = 'expired' WHERE id = ${runId}`;
		await sql`
			UPDATE events
			SET metadata = metadata || ${sql.json({ reason: "Approval window elapsed." })}::jsonb
			WHERE organization_id = ${org.id}
			  AND run_id = ${runId}
			  AND interaction_type = 'approval'
			  AND superseded_by IS NULL
		`;
		editMessageContent.mockClear();
		await refreshApprovalNotificationCards(org.id, [runId]);
		const expiredCard = JSON.stringify(editMessageContent.mock.calls[0]);
		expect(expiredCard).toContain("*Expired*");
		expect(expiredCard).toContain("Approval window elapsed.");
		expect(expiredCard).not.toContain('"label":"Approve"');
	});
});
