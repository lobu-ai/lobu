import { beforeAll, expect, test } from "bun:test";
import {
	storePendingTool,
	takePendingTool,
} from "../auth/mcp/pending-tool-store.js";
import { ensureDbForGatewayTests } from "./helpers/db-setup.js";

beforeAll(async () => {
	await ensureDbForGatewayTests();
});

test("a different caller cannot consume another caller's pending approval", async () => {
	await storePendingTool(
		"ta_cross_caller_red",
		{
			mcpId: "danger",
			toolName: "delete_everything",
			args: {},
			agentId: "agent-victim",
			userId: "victim-user",
			organizationId: "victim-org",
			conversationId: "victim-conversation",
		},
		300,
	);

	const stolen = await takePendingTool("ta_cross_caller_red", {
		userId: "attacker-user",
		organizationId: "attacker-org",
		conversationId: "attacker-conversation",
	});
	expect(stolen).toBeNull();
	expect(
		await takePendingTool("ta_cross_caller_red", {
			userId: "victim-user",
			organizationId: "victim-org",
			conversationId: "victim-conversation",
		}),
	).not.toBeNull();
});
