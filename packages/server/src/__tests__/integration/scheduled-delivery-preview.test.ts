/**
 * A wake (scheduled follow-up or operation outcome) replies in the
 * conversation that asked, including one served by a hosted-preview
 * connection that lives in a DIFFERENT organization. When that conversation
 * can no longer be reached, the wake fails rather than opening an unrelated
 * API thread.
 */

import type { MessagePayload } from "@lobu/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runWakeAgentTask } from "../../scheduled/jobs";
import { validateDeliveryAuthorization } from "../../scheduled/scheduled-jobs-service";
import { cleanupTestDatabase } from "../setup/test-db";
import { createTestAutomationSubscription } from "../setup/automation-subscriptions";
import {
	addUserToOrganization,
	createTestAgent,
	createTestOrganization,
	createTestUser,
	insertChatConnectionRow,
} from "../setup/test-fixtures";

const TEAM = "T_PREVIEW_WAKE";
const PREVIEW_CONNECTION = "preview-wake-conn";

function capturingServices(enqueued: MessagePayload[]) {
	return {
		getQueueProducer: () => ({
			enqueueMessage: async (payload: MessagePayload) => {
				enqueued.push(payload);
				return "queued";
			},
		}),
		// Any touch of the API-thread path is a failure.
		getSessionManager: () =>
			new Proxy({}, { get() { throw new Error("API_PATH_REACHED"); } }),
	} as never;
}

describe("wake delivery through a hosted-preview connection", () => {
	let tenantOrgId: string;
	const agentId = "preview-wake-agent";

	beforeEach(async () => {
		await cleanupTestDatabase();
		const hostOrg = await createTestOrganization();
		const tenantOrg = await createTestOrganization();
		tenantOrgId = tenantOrg.id;
		await createTestAgent({ organizationId: tenantOrg.id, agentId });
		// The connection lives in the HOST org; the binding belongs to the tenant.
		await insertChatConnectionRow({
			id: PREVIEW_CONNECTION,
			organizationId: hostOrg.id,
			agentId: "concierge",
			platform: "slack",
			status: "active",
			settings: { previewMode: true },
			metadata: {},
		});
		const configuredBy = await createTestUser();
		await addUserToOrganization(configuredBy.id, tenantOrg.id, "owner");
		await createTestAutomationSubscription({
			organizationId: tenantOrg.id,
			agentId,
			connectionSlug: `agentconn-${PREVIEW_CONNECTION}`,
			platform: "slack",
			channelId: "slack:C0PREVIEWWAKE",
			teamId: TEAM,
			configuredBy: configuredBy.id,
		});
	});
	afterAll(async () => {
		await cleanupTestDatabase();
	});

	const delivery = (channelId: string) => ({
		platform: "slack",
		connectionId: PREVIEW_CONNECTION,
		channelId,
		conversationId: `slack:${channelId}:1700000000.000200`,
		teamId: TEAM,
		userId: "U_PREVIEW_SENDER",
		senderEvidence: { isDirectMessage: false, senderVouched: false },
	});

	it("authorizes and replies in the original preview-served conversation", async () => {
		expect(
			await validateDeliveryAuthorization({
				organizationId: tenantOrgId,
				agentId,
				delivery: delivery("C0PREVIEWWAKE"),
			}),
		).toEqual({ authorized: true });

		const enqueued: MessagePayload[] = [];
		await runWakeAgentTask(capturingServices(enqueued), {
			__organization_id: tenantOrgId,
			__created_by_agent: agentId,
			__delivery_context: delivery("C0PREVIEWWAKE"),
			__message_id: "operation-outcome-7",
			agent_id: agentId,
			prompt: "operation finished",
		});
		expect(enqueued).toHaveLength(1);
		expect(enqueued[0]).toMatchObject({
			platform: "slack",
			channelId: "C0PREVIEWWAKE",
			conversationId: "slack:C0PREVIEWWAKE:1700000000.000200",
			userId: "U_PREVIEW_SENDER",
			messageId: "operation-outcome-7",
		});
		expect(enqueued[0].platformMetadata).toMatchObject({
			connectionId: PREVIEW_CONNECTION,
			source: "followup",
		});
	});

	it("fails instead of opening an API thread when the conversation is unreachable", async () => {
		expect(
			await validateDeliveryAuthorization({
				organizationId: tenantOrgId,
				agentId,
				delivery: delivery("C0NOTBOUND"),
			}),
		).toEqual({ authorized: false, reason: "connection-missing" });

		const enqueued: MessagePayload[] = [];
		await expect(
			runWakeAgentTask(capturingServices(enqueued), {
				__organization_id: tenantOrgId,
				__created_by_agent: agentId,
				__delivery_context: delivery("C0NOTBOUND"),
				agent_id: agentId,
				prompt: "operation finished",
			}),
		).rejects.toThrow(/connection-missing/);
		expect(enqueued).toHaveLength(0);
	});
});
