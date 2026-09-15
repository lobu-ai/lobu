import { beforeAll, expect, test } from "bun:test";
import {
	claimPendingTool,
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

test("claimPendingTool separates forbidden from missing", async () => {
	await storePendingTool(
		"ta_tristate",
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

	// A live row owned by someone else is forbidden, NOT missing — the caller
	// relies on that distinction to leave the approval card actionable.
	expect(
		await claimPendingTool("ta_tristate", {
			userId: "attacker-user",
			organizationId: "victim-org",
		}),
	).toEqual({ status: "forbidden" });

	// The forbidden probe must not have consumed the row.
	const taken = await claimPendingTool("ta_tristate", {
		userId: "victim-user",
		organizationId: "victim-org",
	});
	expect(taken.status).toBe("taken");
	expect(taken.status === "taken" ? taken.invocation.toolName : null).toBe(
		"delete_everything",
	);

	// Once consumed, retries report missing (idempotent no-op), never forbidden.
	expect(
		await claimPendingTool("ta_tristate", {
			userId: "victim-user",
			organizationId: "victim-org",
		}),
	).toEqual({ status: "missing" });
	expect(
		await claimPendingTool("ta_never_existed", { userId: "victim-user" }),
	).toEqual({ status: "missing" });
});
