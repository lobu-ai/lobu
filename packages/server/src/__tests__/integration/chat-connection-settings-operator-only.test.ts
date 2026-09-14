/**
 * That `apply_chat_connection` consults the settings guard at all, and does so
 * before any other work — the two things neither the guard module nor its unit
 * test can see. Why the rule exists is documented on the guard itself.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { manageConnections } from "../../tools/admin/manage_connections";
import type { ConnectionsArgs } from "../../tools/admin/manage_connections/schemas";
import type { ToolContext } from "../../tools/registry";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase } from "../setup/test-db";
import { seedOwnerContext } from "../setup/test-fixtures";

/** A syntactically valid Telegram bot token — the platform's config demands one. */
const BOT_TOKEN = "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async function callManageConnections(
	args: ConnectionsArgs,
	ctx: ToolContext,
): Promise<Record<string, unknown>> {
	return (await manageConnections(args, {} as Env, ctx)) as Record<
		string,
		unknown
	>;
}

describe("apply_chat_connection refuses operator-only settings", () => {
	let humanCtx: ToolContext;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		const { ctx } = await seedOwnerContext({ orgName: "Chat Settings Org" });
		// The strongest caller this tool admits: an org owner on a human web
		// session. Refused here means refused for agents, PATs and MCP sessions too.
		humanCtx = { ...ctx, tokenType: "session" };
	});

	it("refuses previewMode, naming it", async () => {
		const result = await callManageConnections(
			{
				action: "apply_chat_connection",
				stable_id: "seized-telegram",
				connector_key: "telegram",
				config: { platform: "telegram", botToken: BOT_TOKEN },
				settings: { previewMode: true },
			} as ConnectionsArgs,
			humanCtx,
		);

		expect(result.error).toEqual(expect.stringContaining("previewMode"));
	});

	it("refuses before any other work, so a bad agent_id cannot shadow it", async () => {
		// An unknown `agent_id` is the cheapest observable step after the guard: if
		// the guard were moved below it, this would say "Agent not found" instead.
		const result = await callManageConnections(
			{
				action: "apply_chat_connection",
				stable_id: "ordering-telegram",
				connector_key: "telegram",
				agent_id: "no-such-agent",
				config: { platform: "telegram", botToken: BOT_TOKEN },
				settings: { previewMode: true },
			} as ConnectionsArgs,
			humanCtx,
		);

		expect(result.error).toEqual(expect.stringContaining("previewMode"));
	});

	it("does NOT refuse the settings a tenant legitimately owns", async () => {
		// An allowlist that refused everything would satisfy the cases above while
		// breaking the feature. Persistence needs a chat instance manager this
		// harness has none of, so assert only that the guard did not reject.
		const result = await callManageConnections(
			{
				action: "apply_chat_connection",
				stable_id: "legit-telegram",
				connector_key: "telegram",
				config: { platform: "telegram", botToken: BOT_TOKEN },
				settings: {
					allowGroups: false,
					allowFrom: ["U123"],
					recordChannelMessages: true,
					userConfigScopes: ["skills"],
				},
			} as ConnectionsArgs,
			humanCtx,
		);

		const error = typeof result.error === "string" ? result.error : "";
		expect(error).not.toContain("allowGroups");
		expect(error).not.toContain("allowFrom");
		expect(error).not.toContain("recordChannelMessages");
		expect(error).not.toContain("userConfigScopes");
		expect(error).not.toContain("not settable");
	});
});
