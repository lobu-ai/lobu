import { beforeAll, describe, expect, it } from "vitest";
import { loadConfiguredAutomationDeliveryTarget } from "../../../automations/delivery-target";
import { AutomationSubscriptionService } from "../../../gateway/channels/automation-subscription-service";
import type { Env } from "../../../index";
import type { AuthContext } from "../../../tools/execute";
import { executeTool } from "../../../tools/execute";
import { initWorkspaceProvider } from "../../../workspace";
import { createTestAutomationSubscription } from "../../setup/automation-subscriptions";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestOrganization,
	createTestUser,
	insertChatConnectionRow,
} from "../../setup/test-fixtures";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	MAX_CONSECUTIVE_FAILURES: "3",
	RATE_LIMIT_ENABLED: "false",
};

describe("manage_automations delivery_target", () => {
	let ownerCtx: AuthContext;
	let ownerUserId: string;
	let organizationId: string;
	let agentId: string;
	let otherAgentId: string;
	let connectionId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const org = await createTestOrganization({ name: "Automation delivery target" });
		organizationId = org.id;
		const owner = await createTestUser({ email: "delivery-owner@test.com" });
		await addUserToOrganization(owner.id, org.id, "owner");
		ownerUserId = owner.id;
		ownerCtx = {
			organizationId: org.id,
			tokenOrganizationId: org.id,
			userId: owner.id,
			memberRole: "owner",
			agentId: null,
			requestedAgentId: null,
			isAuthenticated: true,
			clientId: null,
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
			tokenType: "oauth",
			requestUrl: `http://localhost/api/${org.id}`,
			baseUrl: "",
			scopedToOrg: true,
			allowCrossOrg: false,
		};
		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "delivery-agent",
			ownerUserId: owner.id,
		});
		agentId = agent.agentId;
		const otherAgent = await createTestAgent({
			organizationId: org.id,
			agentId: "other-delivery-agent",
			ownerUserId: owner.id,
		});
		otherAgentId = otherAgent.agentId;
		await insertChatConnectionRow({
			id: "slackinst-delivery",
			organizationId: org.id,
			agentId: null,
			platform: "slack",
			metadata: { teamId: "T_DELIVERY" },
		});
		const sql = getTestDb();
		const [connection] = await sql<{ id: number }>`
			SELECT id FROM connections
			WHERE organization_id = ${org.id}
			  AND slug = 'slackinst-delivery'
		`;
		connectionId = Number(connection.id);
		await createTestAutomationSubscription({
			organizationId: org.id,
			agentId,
			connectionId,
			platform: "slack",
			// Legacy bindings may store the native channel id without a platform
			// prefix. The public target still uses the recommended canonical key.
			channelId: "C_TASKS",
			teamId: "T_DELIVERY",
			configuredBy: owner.id,
		});
	});

	it("persists, projects, validates, and clears a strict bound channel", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "delivery-targeted",
				name: "Delivery targeted",
				prompt: "Send a concise update.",
				managed_agent_id: agentId,
				delivery_target: {
					connection_id: connectionId,
					channel_id: "slack:C_TASKS",
				},
			},
			TEST_ENV,
			ownerCtx,
		)) as { automation_id: string };

		const sql = getTestDb();
		const [stored] = await sql<{ delivery_target: Record<string, unknown> }>`
			SELECT delivery_target FROM automations WHERE id = ${created.automation_id}
		`;
		expect(stored.delivery_target).toEqual({
			connection_id: connectionId,
			channel_id: "slack:C_TASKS",
		});

		const listed = (await executeTool(
			"manage_automations",
			{ action: "list", status: "active" },
			TEST_ENV,
			ownerCtx,
		)) as { automations: Array<Record<string, unknown>> };
		expect(
			listed.automations.find((row) => row.automation_id === created.automation_id),
		).toMatchObject({ delivery_target: stored.delivery_target });

		await expect(
			executeTool(
				"manage_automations",
				{
					action: "update",
					automation_id: created.automation_id,
					delivery_target: {
						connection_id: connectionId,
						channel_id: "slack:C_FINANCE",
					},
				},
				TEST_ENV,
				ownerCtx,
			),
		).rejects.toThrow(/must be an active chat channel/);

		await expect(
			executeTool(
				"manage_automations",
				{
					action: "update",
					automation_id: created.automation_id,
					managed_agent_id: otherAgentId,
				},
				TEST_ENV,
				ownerCtx,
			),
		).rejects.toThrow(/must be an active chat channel/);
		const [afterRejectedMove] = await sql<{
			managed_agent_id: string;
			delivery_target: Record<string, unknown>;
		}>`
			SELECT managed_agent_id, delivery_target
			FROM automations
			WHERE id = ${created.automation_id}
		`;
		expect(afterRejectedMove).toMatchObject({
			managed_agent_id: agentId,
			delivery_target: stored.delivery_target,
		});

		const cleared = (await executeTool(
			"manage_automations",
			{
				action: "update",
				automation_id: created.automation_id,
				delivery_target: null,
			},
			TEST_ENV,
			ownerCtx,
		)) as { updated_fields: string[] };
		expect(cleared.updated_fields).toContain("delivery_target");
		const [afterClear] = await sql<{ delivery_target: unknown }>`
			SELECT delivery_target FROM automations WHERE id = ${created.automation_id}
		`;
		expect(afterClear.delivery_target).toBeNull();
	});

	it("accepts a bound Discord channel exactly as manage_feeds lists it, without running", async () => {
		const sql = getTestDb();
		await insertChatConnectionRow({
			id: "discord-delivery",
			organizationId,
			agentId: null,
			platform: "discord",
		});
		const [connection] = await sql<{ id: number }>`
			SELECT id FROM connections
			WHERE organization_id = ${organizationId}
			  AND slug = 'agentconn-discord-delivery'
		`;
		const discordConnectionId = Number(connection.id);
		// The real link path materializes the channel's feed, which is what the
		// Automation editor lists as a delivery destination.
		await new AutomationSubscriptionService().createChatAutomation(
			agentId,
			"discord",
			"discord:111:222",
			undefined,
			{
				organizationId,
				connectionId: discordConnectionId,
				configuredBy: ownerUserId,
			},
		);

		const listFeeds = async () => {
			const { feeds } = (await executeTool(
				"manage_feeds",
				{ action: "list_feeds" },
				TEST_ENV,
				ownerCtx,
			)) as { feeds: Array<Record<string, unknown>> };
			const feed = feeds.find(
				(row) => Number(row.connection_id) === discordConnectionId,
			);
			if (!feed) throw new Error("Discord channel feed was not listed");
			return feed;
		};
		const feed = await listFeeds();
		expect(feed).toMatchObject({
			store: "channel_messages",
			connector_key: "discord",
			connection_status: "active",
			target_agent_id: agentId,
		});
		// The editor submits the listed connection and feed key verbatim.
		const deliveryTarget = {
			connection_id: Number(feed.connection_id),
			channel_id: String(feed.feed_key),
		};

		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "discord-delivery-targeted",
				name: "Discord delivery targeted",
				prompt: "Send a concise update.",
				managed_agent_id: agentId,
				triggers: [],
				delivery_target: deliveryTarget,
			},
			TEST_ENV,
			ownerCtx,
		)) as { automation_id: string };
		const listed = (await executeTool(
			"manage_automations",
			{ action: "list", status: "active" },
			TEST_ENV,
			ownerCtx,
		)) as { automations: Array<Record<string, unknown>> };
		expect(
			listed.automations.find((row) => row.automation_id === created.automation_id),
		).toMatchObject({ delivery_target: deliveryTarget });
		// Creating this Automation must not queue a run.
		const [runs] = await sql<{ n: number }>`
			SELECT COUNT(*)::int AS n FROM runs WHERE automation_id = ${created.automation_id}
		`;
		expect(runs.n).toBe(0);

		// Another agent cannot address this agent's Discord channel.
		await expect(
			executeTool(
				"manage_automations",
				{
					action: "create",
					slug: "discord-delivery-other-agent",
					name: "Discord delivery other agent",
					prompt: "Send a concise update.",
					managed_agent_id: otherAgentId,
					triggers: [],
					delivery_target: deliveryTarget,
				},
				TEST_ENV,
				ownerCtx,
			),
		).rejects.toThrow(/must be an active chat channel/);

		// An inactive connection is listed as such and rejected as a target.
		await sql`
			UPDATE connections SET status = 'paused' WHERE id = ${discordConnectionId}
		`;
		expect((await listFeeds()).connection_status).toBe("paused");
		await expect(
			executeTool(
				"manage_automations",
				{
					action: "create",
					slug: "discord-delivery-paused",
					name: "Discord delivery paused",
					prompt: "Send a concise update.",
					managed_agent_id: agentId,
					triggers: [],
					delivery_target: deliveryTarget,
				},
				TEST_ENV,
				ownerCtx,
			),
		).rejects.toThrow(/must be an active chat channel/);
	});

	it("lets an agent-less Automation target any active binding in its own workspace", async () => {
		const sql = getTestDb();
		const createAgentless = (slug: string, target: { connection_id: number; channel_id: string }) =>
			executeTool(
				"manage_automations",
				{
					action: "create",
					slug,
					name: slug,
					prompt: "Post actionable findings to the campaign channel.",
					triggers: [],
					delivery_target: target,
				},
				TEST_ENV,
				ownerCtx,
			) as Promise<{ automation_id: string }>;

		// No managed agent: an external client processes it, so a channel another
		// agent linked in this workspace is a valid destination.
		const created = await createAgentless("agentless-delivery", {
			connection_id: connectionId,
			channel_id: "slack:C_TASKS",
		});
		const [stored] = await sql<{
			managed_agent_id: string | null;
			delivery_target: Record<string, unknown>;
		}>`
			SELECT managed_agent_id, delivery_target FROM automations WHERE id = ${created.automation_id}
		`;
		expect(stored).toEqual({
			managed_agent_id: null,
			delivery_target: { connection_id: connectionId, channel_id: "slack:C_TASKS" },
		});
		expect(
			await loadConfiguredAutomationDeliveryTarget(
				sql,
				organizationId,
				Number(created.automation_id),
			),
		).toEqual({
			configured: true,
			target: {
				connectionId: "slackinst-delivery",
				channelId: "slack:C_TASKS",
				teamId: "T_DELIVERY",
			},
		});

		// A channel nobody bound is still rejected.
		await expect(
			createAgentless("agentless-unbound", {
				connection_id: connectionId,
				channel_id: "slack:C_NOWHERE",
			}),
		).rejects.toThrow(/must be an active chat channel/);

		// Another workspace's binding is never addressable.
		const foreignOrg = await createTestOrganization({ name: "Foreign delivery org" });
		const foreignOwner = await createTestUser({ email: "foreign-delivery-owner@test.com" });
		await addUserToOrganization(foreignOwner.id, foreignOrg.id, "owner");
		const foreignAgent = await createTestAgent({
			organizationId: foreignOrg.id,
			agentId: "foreign-delivery-agent",
			ownerUserId: foreignOwner.id,
		});
		await insertChatConnectionRow({
			id: "slackinst-foreign-delivery",
			organizationId: foreignOrg.id,
			agentId: null,
			platform: "slack",
			metadata: { teamId: "T_FOREIGN" },
		});
		const [foreignConnection] = await sql<{ id: number }>`
			SELECT id FROM connections
			WHERE organization_id = ${foreignOrg.id}
			  AND slug = 'slackinst-foreign-delivery'
		`;
		await createTestAutomationSubscription({
			organizationId: foreignOrg.id,
			agentId: foreignAgent.agentId,
			connectionId: Number(foreignConnection.id),
			platform: "slack",
			channelId: "slack:C_FOREIGN",
			teamId: "T_FOREIGN",
			configuredBy: foreignOwner.id,
		});
		await expect(
			createAgentless("agentless-foreign", {
				connection_id: Number(foreignConnection.id),
				channel_id: "slack:C_FOREIGN",
			}),
		).rejects.toThrow(/must be an active chat channel/);

		// A binding whose connection is inactive is rejected.
		await insertChatConnectionRow({
			id: "slackinst-paused-delivery",
			organizationId,
			agentId: null,
			platform: "slack",
			status: "paused",
			metadata: { teamId: "T_PAUSED" },
		});
		const [pausedConnection] = await sql<{ id: number }>`
			SELECT id FROM connections
			WHERE organization_id = ${organizationId}
			  AND slug = 'slackinst-paused-delivery'
		`;
		await createTestAutomationSubscription({
			organizationId,
			agentId,
			connectionId: Number(pausedConnection.id),
			platform: "slack",
			channelId: "slack:C_PAUSED",
			teamId: "T_PAUSED",
			configuredBy: ownerUserId,
		});
		await expect(
			createAgentless("agentless-paused", {
				connection_id: Number(pausedConnection.id),
				channel_id: "slack:C_PAUSED",
			}),
		).rejects.toThrow(/must be an active chat channel/);

		// Assigning an agent re-applies the same-agent rule to the kept target.
		await expect(
			executeTool(
				"manage_automations",
				{
					action: "update",
					automation_id: created.automation_id,
					managed_agent_id: otherAgentId,
				},
				TEST_ENV,
				ownerCtx,
			),
		).rejects.toThrow(/must be an active chat channel/);
		const [afterRejectedAssign] = await sql<{ managed_agent_id: string | null }>`
			SELECT managed_agent_id FROM automations WHERE id = ${created.automation_id}
		`;
		expect(afterRejectedAssign.managed_agent_id).toBeNull();
	});
});
