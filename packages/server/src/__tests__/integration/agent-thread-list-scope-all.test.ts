/**
 * `listAgentThreads({ scope: "all" })` — the cross-platform activity feed.
 *
 * Verifies that scope=all surfaces, for one agent in one org:
 *   - the requesting user's own WEB threads (platform "web"),
 *   - PLATFORM conversations (e.g. `slack:…`) tagged with the derived platform,
 *   - one Automation entry per Automation (platform "automation", carrying automationId),
 * sorted newest-first — and that an Automation's per-run snapshot never leaks in as
 * its own platform row. Also drives the two read endpoints the feed links to:
 * readConversationMessages (platform, by raw id) and readAutomationRunThreads.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AutomationSubscriptionService } from "../../gateway/channels/automation-subscription-service";
import {
	listAgentThreads,
	readConversationMessages,
} from "../../gateway/services/agent-thread-list";
import { buildApiConversationId } from "../../gateway/services/api-conversation-id";
import { readAutomationRunThreads } from "../../gateway/services/automation-run-thread";
import { insertEvent } from "../../utils/insert-event";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import { createTestAutomationSubscription } from "../setup/automation-subscriptions";
import {
	addUserToOrganization,
	createTestAgent,
	createTestOrganization,
	createTestUser,
	insertChatConnectionRow,
} from "../setup/test-fixtures";

const AGENT = "thread-list-scope-all-agent";
const SLACK_CONV = "slack:C123:1781641725.28"; // channel C123 — agent is bound to it
const SLACK_UNBOUND_CONV = "slack:CSECRET:1781641725.99"; // channel the agent is NOT bound to
const CSECRET_CONN_RUNTIME_ID = "slackinst-csecret"; // managed connection owning CSECRET, initially no chat-link
const TELEGRAM_DM_CONV = "telegram:6570514069"; // an unbound DM, gated on org role
const TELEGRAM_LEGACY_CONV = "telegram:111222333"; // platform row with is_direct NULL (unknown)
const AUTOMATION_ID = 990001;
const ARCHIVED_AUTOMATION_ID = 990003; // completed a run, then archived
const OTHER_AGENT = "thread-list-other-agent";
const OTHER_AUTOMATION_ID = 990002;

function sessionJsonl(text: string): string {
	return [
		JSON.stringify({
			type: "session",
			version: 3,
			id: "s",
			timestamp: "2026-06-28T00:00:00Z",
			cwd: "/w",
		}),
		JSON.stringify({
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-06-28T00:00:01Z",
			message: { role: "user", content: [{ type: "text", text }] },
		}),
	].join("\n");
}

describe("listAgentThreads scope=all", () => {
	let org: string;
	let otherOrg: string;
	let userId: string;

	beforeAll(async () => {
		org = (await createTestOrganization()).id;
		otherOrg = (await createTestOrganization()).id;
		userId = (await createTestUser()).id;
		await addUserToOrganization(userId, otherOrg);
		await createTestAgent({
			organizationId: org,
			agentId: AGENT,
			ownerUserId: userId,
		});
		await createTestAgent({
			organizationId: org,
			agentId: OTHER_AGENT,
			ownerUserId: userId,
		});
		const sql = getTestDb();

		// A transcript snapshot backs the read endpoints (readConversationMessages
		// and readAutomationRunThreads). Ordinary conversation listing reads the
		// `conversations` entity, so one appears only when it also has that row.
		const insertSnapshot = async (
			conversationId: string,
			text: string,
			at: string,
			entity?: {
				platform: string;
				kind: "owned" | "platform";
				userId: string | null;
				isDirect?: boolean | null;
			},
		) => {
			const [run] = await sql<{ id: number }[]>`
        INSERT INTO runs (run_type, status, organization_id, created_at, completed_at, run_at)
        VALUES ('chat_message', 'completed', ${org}, ${at}, ${at}, ${at})
        RETURNING id`;
			const jsonl = sessionJsonl(text);
			await sql`
        INSERT INTO agent_transcript_snapshot
          (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status, created_at)
        VALUES (${org}, ${AGENT}, ${conversationId}, ${run.id}, ${jsonl}, ${Buffer.byteLength(jsonl)}, 'completed', ${at})`;
			if (entity) {
				await sql`
          INSERT INTO conversations
            (organization_id, agent_id, platform, conversation_id,
             kind, user_id, title, is_direct, last_activity_at, created_at)
          VALUES (${org}, ${AGENT}, ${entity.platform},
                  ${conversationId}, ${entity.kind}, ${entity.userId}, ${text},
                  ${entity.isDirect ?? null}, ${at}, ${at})`;
			}
		};

		// The requesting user's own web thread.
		await insertSnapshot(
			buildApiConversationId({
				agentId: AGENT,
				userId,
				organizationId: org,
				threadId: "webthread",
			}),
			"hello from web",
			"2026-06-28T01:00:00Z",
			{ platform: "web", kind: "owned", userId },
		);
		// The agent is bound to channel C123 (per-agent fence) — so its transcript
		// is listable; CSECRET has no binding and must never surface.
		const connId = `conn_${AUTOMATION_ID}`;
		await insertChatConnectionRow({
			id: connId,
			organizationId: org,
			agentId: AGENT,
			platform: "slack",
			status: "active",
			createdBy: userId,
		});
		await createTestAutomationSubscription({
			organizationId: org,
			agentId: AGENT,
			connectionSlug: `agentconn-${connId}`,
			platform: "slack",
			channelId: "slack:C123",
			teamId: "T1",
		});

		// The managed connection's fallback agent handles CSECRET, but no chat-link
		// Automation makes that channel visible yet.
		await insertChatConnectionRow({
			id: CSECRET_CONN_RUNTIME_ID,
			organizationId: org,
			agentId: AGENT,
			platform: "slack",
			status: "active",
			credentialMode: "managed",
			metadata: { teamId: "T1" },
			createdBy: userId,
		});

		// A bound Slack conversation (newest) + an UNBOUND one. Both get a
		// conversations row (the gateway dual-writes every platform turn); the
		// UNBOUND one must still be fenced out by isConversationVisible at listing
		// time — proving the ACL gate runs on the entity, not just on the old
		// snapshot-derived path.
		await insertSnapshot(
			SLACK_CONV,
			"hello from slack",
			"2026-06-28T02:00:00Z",
			{
				platform: "slack",
				kind: "platform",
				userId: null,
			},
		);
		await insertSnapshot(
			SLACK_UNBOUND_CONV,
			"secret channel transcript",
			"2026-06-28T03:00:00Z",
			{
				platform: "slack",
				kind: "platform",
				userId: null,
			},
		);
		// A Telegram DM with no chat-link Automation. The channel fence can only fail
		// closed on it, so it is listable on the DM rule (owner/admin) or not at
		// all.
		await insertSnapshot(
			TELEGRAM_DM_CONV,
			"hello from telegram dm",
			"2026-06-28T04:00:00Z",
			{
				platform: "telegram",
				kind: "platform",
				userId: "6570514069",
				isDirect: true,
			},
		);
		// A platform row predating the column: is_direct unknown. Must keep the
		// old fail-closed semantics rather than riding in on the DM rule.
		await insertSnapshot(
			TELEGRAM_LEGACY_CONV,
			"legacy row with unknown surface",
			"2026-06-28T04:30:00Z",
			{
				platform: "telegram",
				kind: "platform",
				userId: "999",
				isDirect: null,
			},
		);

		// An automation + one of its run snapshots.
		await sql`
      INSERT INTO automations
        (id, organization_id, managed_agent_id, created_by, automation_group_id, name, status, min_cooldown_seconds, created_at, updated_at)
      VALUES (${AUTOMATION_ID}, ${org}, ${AGENT}, ${userId}, 0, 'Test Automation', 'active', 0, now(), now())`;
		await sql`
      INSERT INTO automations
        (id, organization_id, managed_agent_id, created_by, automation_group_id, name, status, min_cooldown_seconds, created_at, updated_at)
      VALUES (${OTHER_AUTOMATION_ID}, ${org}, ${OTHER_AGENT}, ${userId}, 0, 'Other Agent Automation', 'active', 0, now(), now())`;
		await sql`
			INSERT INTO runs
			  (run_type, status, organization_id, automation_id, approval_status,
			   run_metadata, created_at, completed_at)
			VALUES
			  ('automation', 'completed', ${org}, ${OTHER_AUTOMATION_ID}, 'auto',
			   ${sql.json({ prompt_rendered: "Other agent secret automation task" })},
			   '2026-06-28T00:31:00Z', '2026-06-28T00:32:00Z')
		`;
		const [automationRun] = await sql<{ id: number }[]>`
			INSERT INTO runs
			  (run_type, status, organization_id, automation_id,
			   approval_status, run_metadata, created_at, completed_at)
			VALUES
			  ('automation', 'completed', ${org}, ${AUTOMATION_ID},
			   'auto', ${sql.json({ prompt_rendered: "Rendered automation task" })},
			   '2026-06-28T00:29:00Z', '2026-06-28T00:30:00Z')
			RETURNING id`;
		const automationJsonl = sessionJsonl("automation run output");
		const automationConversationId = `${AGENT}_automation_${AUTOMATION_ID}_run_${automationRun.id}`;
		await sql`
			INSERT INTO agent_transcript_snapshot
			  (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl,
			   byte_size, terminal_status, created_at)
			VALUES
			  (${org}, ${AGENT}, ${automationConversationId},
			   ${automationRun.id}, ${automationJsonl}, ${Buffer.byteLength(automationJsonl)},
			   'completed', '2026-06-28T00:30:00Z')
		`;

		// The completed run above stamps the Automation at the database boundary.
		// Its sidebar entry is read from that column, not re-derived from the
		// snapshot on every request.

		// An ARCHIVED Automation that completed a run is stamped like any other. Its
		// snapshot rows are permanent — archiving cannot unmake them — which is why
		// the old query kept it listed. The listing now filters on live `status`, so
		// it drops out with no lifecycle sync anywhere.
		await sql`
      INSERT INTO automations
        (id, organization_id, managed_agent_id, created_by, automation_group_id, name, status, min_cooldown_seconds, created_at, updated_at)
      VALUES (${ARCHIVED_AUTOMATION_ID}, ${org}, ${AGENT}, ${userId}, 0, 'Archived Automation', 'archived', 0, now(), now())`;
		const [archivedRun] = await sql<{ id: number }[]>`
			INSERT INTO runs
			  (run_type, status, organization_id, automation_id, approval_status,
			   run_metadata, created_at, completed_at)
			VALUES
			  ('automation', 'completed', ${org}, ${ARCHIVED_AUTOMATION_ID}, 'auto',
			   ${sql.json({ prompt_rendered: "Archived automation task" })},
			   '2026-06-28T00:40:00Z', '2026-06-28T00:41:00Z')
			RETURNING id`;
		const archivedJsonl = sessionJsonl("archived automation run output");
		await sql`
			INSERT INTO agent_transcript_snapshot
			  (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl,
			   byte_size, terminal_status, created_at)
			VALUES
			  (${org}, ${AGENT}, ${`${AGENT}_automation_${ARCHIVED_AUTOMATION_ID}_run_${archivedRun.id}`},
			   ${archivedRun.id}, ${archivedJsonl}, ${Buffer.byteLength(archivedJsonl)},
			   'completed', '2026-06-28T00:41:00Z')
		`;

		const [approvalRun] = await sql<{ id: number }[]>`
			INSERT INTO runs
			  (run_type, status, organization_id, automation_id, parent_run_id,
			   approval_status, action_key, created_at)
			VALUES
			  ('internal', 'pending', ${org}, ${AUTOMATION_ID}, ${automationRun.id},
			   'pending', 'entity_field_change', now())
			RETURNING id`;
		await insertEvent({
			entityIds: [],
			organizationId: org,
			originId: `automation-approval-${approvalRun.id}`,
			title: "Approve automation change",
			content: "An automation proposed changing a contact.",
			semanticType: "operation",
			runId: approvalRun.id,
			interactionType: "approval",
			interactionStatus: "pending",
			metadata: {
				action: "update",
				tool: "entity_field_change",
				resourceKind: "entity",
				fields: { email: "new@example.com" },
				attribution: "automation",
			},
		});
	});

	afterAll(async () => {
		await cleanupTestDatabase();
	});

	it("lists an unbound DM for an owner/admin", async () => {
		const threads = await listAgentThreads({
			agentId: AGENT,
			organizationId: org,
			userId,
			scope: "all",
			isAdmin: true,
		});
		const dm = threads.find((t) => t.id === TELEGRAM_DM_CONV);
		expect(dm).toBeDefined();
		expect(dm?.platform).toBe("telegram");
	});

	it("hides a DM from a plain member, and hides unknown-surface rows from everyone", async () => {
		const asMember = await listAgentThreads({
			agentId: AGENT,
			organizationId: org,
			userId,
			scope: "all",
			isAdmin: false,
		});
		expect(asMember.map((t) => t.id)).not.toContain(TELEGRAM_DM_CONV);

		// is_direct NULL must not ride in on the DM rule — it keeps the channel
		// fence, which fails closed for an unbound channel.
		const asAdmin = await listAgentThreads({
			agentId: AGENT,
			organizationId: org,
			userId,
			scope: "all",
			isAdmin: true,
		});
		expect(asAdmin.map((t) => t.id)).not.toContain(TELEGRAM_LEGACY_CONV);
		expect(asMember.map((t) => t.id)).not.toContain(TELEGRAM_LEGACY_CONV);
	});

	it("keeps the group-channel fence unchanged for an admin", async () => {
		// Admin is the DM rule only — it must not become a blanket bypass of the
		// channel-membership fence for group channels.
		const threads = await listAgentThreads({
			agentId: AGENT,
			organizationId: org,
			userId,
			scope: "all",
			isAdmin: true,
		});
		expect(threads.map((t) => t.id)).not.toContain(SLACK_UNBOUND_CONV);
		expect(threads.map((t) => t.id)).toContain(SLACK_CONV);
	});

	it("returns web + platform + automation entries with correct platforms, newest-first", async () => {
		const threads = await listAgentThreads({
			agentId: AGENT,
			organizationId: org,
			userId,
			scope: "all",
		});
		const byPlatform = new Map(threads.map((t) => [t.platform, t]));

		expect(byPlatform.get("web")?.id).toBe("webthread");

		const slack = byPlatform.get("slack");
		expect(slack?.id).toBe(SLACK_CONV);
		expect(slack?.conversationId).toBe(SLACK_CONV);

		const automation = byPlatform.get("automation");
		expect(automation?.automationId).toBe(AUTOMATION_ID);
		expect(automation?.title).toBe("Test Automation");
		expect(automation?.createdAt).toBe(automation?.updatedAt);

		// Newest VISIBLE is the bound Slack channel at 02:00 — the unbound channel
		// at 03:00 is fenced out, so it must not take the top slot (or any slot).
		expect(threads[0]?.platform).toBe("slack");
		expect(threads[0]?.id).toBe(SLACK_CONV);

		// An automation's per-run snapshot must NOT surface as its own platform row.
		expect(threads.some((t) => t.id.includes("_automation_"))).toBe(false);
	});

	it("drops an archived Automation even though its completed runs remain", async () => {
		const threads = await listAgentThreads({
			agentId: AGENT,
			organizationId: org,
			userId,
			scope: "all",
		});

		// The archived Automation's transcript snapshot is still in the table and
		// still terminal_status='completed' — permanent history. The old query
		// ignored the current Automation status and listed it.
		expect(
			threads.some((t) => t.automationId === ARCHIVED_AUTOMATION_ID),
		).toBe(false);
		expect(threads.some((t) => t.title === "Archived Automation")).toBe(false);

		// The live Automation beside it is untouched — this is a lifecycle filter,
		// not a blanket exclusion of Automations.
		expect(threads.some((t) => t.automationId === AUTOMATION_ID)).toBe(true);
	});

	it("orders an Automation by its stored last-run stamp, not by run history", async () => {
		const threads = await listAgentThreads({
			agentId: AGENT,
			organizationId: org,
			userId,
			scope: "all",
		});
		const automation = threads.find((t) => t.automationId === AUTOMATION_ID);

		expect(automation?.id).toBe(`automation_${AUTOMATION_ID}`);
		// The stamped value, not max(created_at) over the snapshots.
		expect(automation?.updatedAt).toBe(
			new Date("2026-06-28T00:30:00Z").getTime(),
		);
	});

	it("fences out platform conversations on channels the agent isn't bound to", async () => {
		const threads = await listAgentThreads({
			agentId: AGENT,
			organizationId: org,
			userId,
			scope: "all",
		});
		// CSECRET has no binding — its transcript must never be listed, even though
		// it's the most recent snapshot.
		expect(threads.some((t) => t.id === SLACK_UNBOUND_CONV)).toBe(false);
		expect(threads.some((t) => t.conversationId === SLACK_UNBOUND_CONV)).toBe(
			false,
		);
	});

	it("does not materialize a connection into a different organization", async () => {
		const created =
			await new AutomationSubscriptionService().materializeConnectionFallbackLink(
				CSECRET_CONN_RUNTIME_ID,
				otherOrg,
				AGENT,
				"slack",
				"slack:CSECRET",
				"T1",
			);
		expect(created).toBe(false);
	});

	it("materializeConnectionFallbackLink makes a previously-unbound channel visible", async () => {
		// Precondition: CSECRET is fenced out (the connection-owner-fallback bug —
		// a turn ran here but no chat-link subscription exists).
		const before = await listAgentThreads({
			agentId: AGENT,
			organizationId: org,
			userId,
			scope: "all",
		});
		expect(before.some((t) => t.id === SLACK_UNBOUND_CONV)).toBe(false);

		// Materialize the chat-link the fallback path would have written on the
		// first inbound group message (idempotent upsert on org+connection+channel).
		const created =
			await new AutomationSubscriptionService().materializeConnectionFallbackLink(
				CSECRET_CONN_RUNTIME_ID,
				org,
				AGENT,
				"slack",
				"slack:CSECRET",
				"T1",
			);
		expect(created).toBe(true);

		// Now the channel is bound → its transcript is visible in history.
		const after = await listAgentThreads({
			agentId: AGENT,
			organizationId: org,
			userId,
			scope: "all",
		});
		const surfaced = after.find((t) => t.id === SLACK_UNBOUND_CONV);
		expect(surfaced).toBeDefined();
		expect(surfaced?.platform).toBe("slack");

		// Idempotent: a second materialize doesn't duplicate the binding or error.
		const again =
			await new AutomationSubscriptionService().materializeConnectionFallbackLink(
				CSECRET_CONN_RUNTIME_ID,
				org,
				AGENT,
				"slack",
				"slack:CSECRET",
				"T1",
			);
		expect(again).toBe(true);
		const afterAgain = await listAgentThreads({
			agentId: AGENT,
			organizationId: org,
			userId,
			scope: "all",
		});
		expect(afterAgain.filter((t) => t.id === SLACK_UNBOUND_CONV)).toHaveLength(
			1,
		);
	});

	it("is create-only: never relinks an existing explicit chat-link to the connection owner", async () => {
		const sql = getTestDb();
		const svc = new AutomationSubscriptionService();
		const [conn] = await sql<{ id: number }[]>`
			SELECT id FROM connections WHERE slug = ${CSECRET_CONN_RUNTIME_ID} LIMIT 1`;
		// An explicit /lobu link bound this channel to a DIFFERENT agent first.
		await svc.createChatAutomation(OTHER_AGENT, "slack", "slack:CEXPLICIT", "T1", {
			organizationId: org,
			connectionId: conn!.id,
		});
		const ownerOf = async () =>
			(
				await sql<{ managed_agent_id: string }[]>`
					SELECT w.managed_agent_id
					FROM automations w
					CROSS JOIN LATERAL jsonb_array_elements(w.triggers) t
					WHERE w.organization_id = ${org}
					  AND w.status = 'active'
					  AND t->'match'->>'channel_id' = 'CEXPLICIT'
					LIMIT 1`
			)[0]?.managed_agent_id;
		expect(await ownerOf()).toBe(OTHER_AGENT);

		// The connection-owner fallback fires for the same channel with AGENT.
		// Create-only must preserve the explicit binding, not relink it.
		const created = await svc.materializeConnectionFallbackLink(
			CSECRET_CONN_RUNTIME_ID,
			org,
			AGENT,
			"slack",
			"slack:CEXPLICIT",
			"T1",
		);
		expect(created).toBe(true);
		expect(await ownerOf()).toBe(OTHER_AGENT); // NOT relinked to AGENT
	});

	it("declines (returns false) when the connection slug can't be resolved", async () => {
		const created =
			await new AutomationSubscriptionService().materializeConnectionFallbackLink(
				"conn_does_not_exist",
				org,
				AGENT,
				"slack",
				"slack:CGHOST",
				"T1",
			);
		expect(created).toBe(false);
	});

	it("scope=user (default) excludes platform + automation conversations", async () => {
		const threads = await listAgentThreads({
			agentId: AGENT,
			organizationId: org,
			userId,
			scope: "user",
		});
		expect(threads.every((t) => t.platform === "web")).toBe(true);
		expect(threads.some((t) => t.id === "webthread")).toBe(true);
	});

	it("reads a platform conversation read-only by its raw id", async () => {
		const data = await readConversationMessages({
			agentId: AGENT,
			organizationId: org,
			conversationId: SLACK_CONV,
			cursor: "",
			limit: 200,
		});
		expect(JSON.stringify(data.messages)).toContain("hello from slack");
	});

	it("readAutomationRunThreads returns the automation's runs", async () => {
		const data = await readAutomationRunThreads({
			agentId: AGENT,
			organizationId: org,
			automationId: AUTOMATION_ID,
			limit: 20,
		});
		expect(data.runs).toHaveLength(1);
		expect(JSON.stringify(data.runs[0]?.messages)).toContain(
			"automation run output",
		);
		expect(data.runs[0]?.task).toBe("Rendered automation task");
		expect(data.runs[0]?.pendingActionCount).toBe(1);
		expect(data.runs[0]?.actions).toEqual([
			expect.objectContaining({
				type: "tool-approval",
				eventId: expect.any(Number),
				action: "update",
				fields: { email: "new@example.com" },
				attribution: "automation",
				resourceKind: "entity",
			}),
		]);
		expect(data).not.toHaveProperty("interactions");
		expect(data.runs[0]).not.toHaveProperty("automaticActions");
		expect(data.runs[0]).not.toHaveProperty("autoAppliedCount");
	});

	it("does not read a different agent's automation in the same organization", async () => {
		const data = await readAutomationRunThreads({
			agentId: AGENT,
			organizationId: org,
			automationId: OTHER_AUTOMATION_ID,
			limit: 20,
		});

		expect(data.runs).toEqual([]);
		expect(JSON.stringify(data)).not.toContain(
			"Other agent secret automation task",
		);
	});

	// Production shape, which every other fixture in this file gets wrong: an
	// Automation execution writes TWO run rows. The scheduler's `automation` row is
	// what the thread is built from, but the worker is dispatched under a
	// separate `chat_message` row and posts its snapshot against THAT run id —
	// it never learns the automation run id except inside the conversationId. A
	// snapshot joined on `run_id` therefore matched nothing in prod, and the
	// automation page rendered the prompt with no transcript under it at all.
	it("reads the transcript posted under the sibling dispatch run", async () => {
		const sql = getTestDb();
		const [automationRun] = await sql<{ id: number }[]>`
			INSERT INTO runs
			  (run_type, status, organization_id, automation_id,
			   approval_status, run_metadata, created_at, completed_at)
			VALUES
			  ('automation', 'completed', ${org}, ${AUTOMATION_ID},
			   'auto', ${sql.json({ prompt_rendered: "Dispatched automation task" })},
			   '2026-06-28T04:30:00Z', '2026-06-28T04:31:00Z')
			RETURNING id
		`;
		// The row the worker actually claims: no automation_id, run_type
		// 'chat_message'. Its only tie to the Automation is the conversationId.
		const [dispatchRun] = await sql<{ id: number }[]>`
			INSERT INTO runs
			  (run_type, status, organization_id, approval_status,
			   created_at, completed_at)
			VALUES
			  ('chat_message', 'completed', ${org}, 'auto',
			   '2026-06-28T04:30:01Z', '2026-06-28T04:30:02Z')
			RETURNING id
		`;
		const jsonl = sessionJsonl("dispatched automation transcript");
		await sql`
			INSERT INTO agent_transcript_snapshot
			  (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl,
			   byte_size, terminal_status, created_at)
			VALUES
			  (${org}, ${AGENT}, ${`${AGENT}_automation_${AUTOMATION_ID}_run_${automationRun.id}`},
			   ${dispatchRun.id}, ${jsonl}, ${Buffer.byteLength(jsonl)}, 'completed',
			   '2026-06-28T04:31:00Z')
		`;

		const data = await readAutomationRunThreads({
			agentId: AGENT,
			organizationId: org,
			automationId: AUTOMATION_ID,
			limit: 20,
		});
		const run = data.runs.find(
			(candidate) => candidate.runId === automationRun.id,
		);
		expect(run).toBeDefined();
		// The prompt alone is what the broken join left on the page.
		expect(run?.task).toBe("Dispatched automation task");
		expect(run?.messages.length).toBeGreaterThan(0);
		expect(JSON.stringify(run?.messages)).toContain(
			"dispatched automation transcript",
		);
	});

	it("keeps terminal approval decisions attached to their automation run", async () => {
		const sql = getTestDb();
		const [automationRun] = await sql<{ id: number }[]>`
			INSERT INTO runs
			  (run_type, status, organization_id, automation_id,
			   approval_status, created_at, completed_at)
			VALUES
			  ('automation', 'completed', ${org}, ${AUTOMATION_ID},
			   'auto', '2026-06-28T04:00:00Z', '2026-06-28T04:01:00Z')
			RETURNING id
		`;
		const jsonl = sessionJsonl("terminal decision run");
		await sql`
			INSERT INTO agent_transcript_snapshot
			  (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl,
			   byte_size, terminal_status, created_at)
			VALUES
			  (${org}, ${AGENT}, ${`${AGENT}_automation_${AUTOMATION_ID}_run_${automationRun.id}`},
			   ${automationRun.id}, ${jsonl}, ${Buffer.byteLength(jsonl)}, 'completed',
			   '2026-06-28T04:01:00Z')
		`;
		const [approvalRun] = await sql<{ id: number }[]>`
			INSERT INTO runs
			  (run_type, status, organization_id, automation_id, parent_run_id,
			   approval_status, action_key, action_input, created_at, completed_at)
			VALUES
			  ('internal', 'cancelled', ${org}, ${AUTOMATION_ID}, ${automationRun.id},
			   'rejected', 'entity_change',
			   ${sql.json({ source_run_id: automationRun.id, operation: "link" })},
			   '2026-06-28T04:01:00Z', '2026-06-28T04:02:00Z')
			RETURNING id
		`;
		await insertEvent({
			entityIds: [],
			organizationId: org,
			originId: `automation-rejected-${approvalRun.id}`,
			title: "Identity records kept separate",
			content: "The reviewer kept these entities separate.",
			semanticType: "operation",
			runId: approvalRun.id,
			interactionType: "approval",
			interactionStatus: "rejected",
			metadata: {
				action: "link",
				tool: "entity_change",
				resourceKind: "entity",
				reason:
					"The matching email is evidence, but policy still requires review.",
				reviewed_by_name: "Reviewer",
			},
		});

		const data = await readAutomationRunThreads({
			agentId: AGENT,
			organizationId: org,
			automationId: AUTOMATION_ID,
			limit: 20,
		});
		const run = data.runs.find(
			(candidate) => candidate.runId === automationRun.id,
		);
		expect(run?.pendingActionCount).toBe(0);
		expect(run?.actions).toEqual([
			expect.objectContaining({
				runId: approvalRun.id,
				status: "rejected",
				reason:
					"The matching email is evidence, but policy still requires review.",
				reviewedByName: "Reviewer",
			}),
		]);
	});

	it("keeps pending approvals visible when the automation run has no transcript", async () => {
		const sql = getTestDb();
		const [automationRun] = await sql<{ id: number }[]>`
			INSERT INTO runs
			  (run_type, status, organization_id, automation_id,
			   approval_status, run_metadata, created_at, completed_at)
			VALUES
			  ('automation', 'completed', ${org}, ${AUTOMATION_ID},
			   'auto', ${sql.json({ prompt_rendered: "Run without a transcript" })},
			   '2026-06-28T05:00:00Z', '2026-06-28T05:01:00Z')
			RETURNING id
		`;
		const [approvalRun] = await sql<{ id: number }[]>`
			INSERT INTO runs
			  (run_type, status, organization_id, automation_id, parent_run_id,
			   approval_status, action_key, action_input, created_at)
			VALUES
			  ('internal', 'pending', ${org}, ${AUTOMATION_ID}, ${automationRun.id},
			   'pending', 'entity_change',
			   ${sql.json({ source_run_id: automationRun.id, operation: "link" })},
			   '2026-06-28T05:01:00Z')
			RETURNING id
		`;
		await insertEvent({
			entityIds: [],
			organizationId: org,
			originId: `automation-no-transcript-${approvalRun.id}`,
			title: "Review identity association without transcript",
			content: "A durable approval must remain visible.",
			semanticType: "operation",
			runId: approvalRun.id,
			interactionType: "approval",
			interactionStatus: "pending",
			metadata: {
				action: "link",
				tool: "entity_change",
				resourceKind: "entity",
			},
		});

		const data = await readAutomationRunThreads({
			agentId: AGENT,
			organizationId: org,
			automationId: AUTOMATION_ID,
			limit: 20,
		});
		const run = data.runs.find(
			(candidate) => candidate.runId === automationRun.id,
		);
		expect(run?.task).toBe("Run without a transcript");
		expect(run?.messages).toEqual([]);
		expect(run?.pendingActionCount).toBe(1);
		expect(run?.actions).toEqual([
			expect.objectContaining({
				runId: approvalRun.id,
				status: "pending",
			}),
		]);
	});
});

/**
 * An EXPLICITLY bound DM (Slack Preview `/link`, claim onboarding) is the case
 * that makes the owner/admin rule a BYPASS rather than a replacement: it is a DM
 * (`is_direct = true`) but it does have a chat-link Automation, so the ordinary
 * channel fence already admits it and a plain member must keep that access.
 *
 * It gets its own org/agent because the shared fixture above asserts a single
 * slack conversation and newest-first ordering; a second visible slack row there
 * would decide those assertions instead of testing this one.
 */
describe("listAgentThreads scope=all — an explicitly bound DM", () => {
	const BOUND_DM_AGENT = "thread-list-bound-dm-agent";
	const BOUND_DM_CONV = "slack:D123:";
	let org: string;
	let userId: string;

	beforeAll(async () => {
		org = (await createTestOrganization()).id;
		userId = (await createTestUser()).id;
		await createTestAgent({
			organizationId: org,
			agentId: BOUND_DM_AGENT,
			ownerUserId: userId,
		});
		const sql = getTestDb();
		const connId = "conn_bound_dm";
		await insertChatConnectionRow({
			id: connId,
			organizationId: org,
			agentId: BOUND_DM_AGENT,
			platform: "slack",
			status: "active",
			createdBy: userId,
		});
		await createTestAutomationSubscription({
			organizationId: org,
			agentId: BOUND_DM_AGENT,
			connectionSlug: `agentconn-${connId}`,
			platform: "slack",
			channelId: "slack:D123",
			teamId: "T1",
		});
		await sql`
      INSERT INTO conversations
        (organization_id, agent_id, platform, conversation_id,
         kind, user_id, title, is_direct, last_activity_at, created_at)
      VALUES (${org}, ${BOUND_DM_AGENT}, 'slack', ${BOUND_DM_CONV},
              'platform', 'U123', 'hello from a bound slack dm',
              true, '2026-06-28T02:00:00Z', '2026-06-28T02:00:00Z')`;
	});

	afterAll(async () => {
		await cleanupTestDatabase();
	});

	it("stays visible to the non-admin connection owner via the channel fence", async () => {
		const threads = await listAgentThreads({
			agentId: BOUND_DM_AGENT,
			organizationId: org,
			userId,
			scope: "all",
			isAdmin: false,
		});
		expect(threads.map((t) => t.id)).toContain(BOUND_DM_CONV);
	});
});
