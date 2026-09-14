/**
 * `apply_chat_connection` must not let a tenant write OPERATOR-owned connection
 * settings — above all `previewMode`, which marks a connection as Lobu's own
 * hosted relay and steers cross-organization routing. Why the guard is an
 * allowlist, and what `previewMode` actually controls, is documented once in
 * `tools/admin/manage_connections/handlers/chat-settings-guard.ts`; its
 * decisions are enumerated in that module's unit test.
 *
 * Neither of those can see the handler. This file pins the two things they
 * cannot: that `apply_chat_connection` consults the guard at all, and that it
 * does so before any other work.
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
		// The STRONGEST caller this tool admits: an org owner on a real human web
		// session. Refused here means refused for agents, PATs and MCP sessions
		// too, so the gate needs no separate actor-kind axis the way
		// `action_modes` does.
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
		// Ordering, which is the reason the guard sits at the top of the handler:
		// nothing — not the agent lookup, not the upsert — runs on a request
		// carrying an operator-only key. An unknown `agent_id` is the cheapest
		// observable step after the guard: if the guard were moved below it, this
		// would come back "Agent not found" instead.
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
		// Guard the guard: an allowlist that refused everything would satisfy the
		// cases above while breaking the feature. Persistence needs a running chat
		// instance manager, which this harness has none of — so assert the thing
		// that is actually under test here, that the guard did not reject. Whether
		// those keys then persist is `upsertByoChatConnection`'s existing logic,
		// which this change does not touch.
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
