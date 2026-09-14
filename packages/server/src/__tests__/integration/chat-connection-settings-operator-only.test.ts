/**
 * `apply_chat_connection` must not let a tenant write OPERATOR-owned connection
 * settings.
 *
 * `connection.config` and `connection.settings` both land in the same `config`
 * JSON column — `settings` is folded in at persist time
 * (`connections-projection.ts`, `foldedConfig`). But only ONE of them is
 * validated: chat config goes through `parseConfig`, whose `Value.Clean` strips
 * unknown keys (that is what keeps `action_modes` out of chat rows — see
 * `connections-action-modes-human-only.test.ts`). `settings` bypasses
 * `parseConfig` entirely and is spread verbatim in `upsertByoChatConnection`.
 * The validated door is locked and the unvalidated door beside it opens onto
 * the same room.
 *
 * `previewMode` is the key that makes this matter. It does not mean "a
 * demo connection" — it marks a connection as LOBU'S OWN hosted relay, and
 * twelve call sites read it: cross-organization message routing
 * (`message-handler-bridge.ts:512`), unbound `lobu run` claim redemption
 * (`preview/slack.ts:72`), tenant notification delivery through the shared bot
 * (`notifications/service.ts`, `bound-channels.ts`), and the unique global slot
 * (`uniq_preview_connection_per_platform_all`, one row per `connector_key`).
 *
 * No application code writes `previewMode` — every occurrence in the repo is a
 * read, and Lobu's own preview rows are provisioned by an operator directly
 * against the database. A tenant supplying it is never legitimate.
 *
 * The seizure this prevents: for a platform where Lobu runs NO hosted bot
 * (telegram, discord, teams, whatsapp today) the unique slot is unclaimed. A
 * tenant taking it flips `hasHostedPreviewConnection` true for that platform,
 * so OTHER tenants' hosted link codes redeem through the seizing tenant's bot.
 * That is cross-tenant, and `apply_chat_connection` being owner/admin-gated
 * (`OWNER_ADMIN_ACTIONS`) is no barrier — anyone who signs up owns an org.
 *
 * Allowlist SEMANTICS are unit-tested in
 * `tools/admin/manage_connections/handlers/__tests__/chat-settings-guard.test.ts`.
 * This file pins the one thing a unit test cannot: that the HANDLER consults the
 * guard, and refuses before anything is persisted.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { manageConnections } from "../../tools/admin/manage_connections";
import type { ConnectionsArgs } from "../../tools/admin/manage_connections/schemas";
import type { ToolContext } from "../../tools/registry";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import { seedOwnerContext } from "../setup/test-fixtures";

const sql = getTestDb();

/** A syntactically valid Telegram bot token — the platform's config demands one. */
const BOT_TOKEN = "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async function rowExists(slug: string): Promise<boolean> {
	const rows = (await sql`
    SELECT 1 FROM connections WHERE slug = ${slug} AND deleted_at IS NULL
  `) as unknown as Array<unknown>;
	return rows.length > 0;
}

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

	it("refuses previewMode, naming it, and persists nothing", async () => {
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
		// Refused, never partially applied.
		expect(await rowExists("seized-telegram")).toBe(false);
	});

	it("refuses previewMode buried among legitimate settings", async () => {
		// The shape an exploit actually takes: hide the privileged key among keys
		// a tenant may legitimately set, hoping the object is waved through whole.
		const result = await callManageConnections(
			{
				action: "apply_chat_connection",
				stable_id: "mixed-telegram",
				connector_key: "telegram",
				config: { platform: "telegram", botToken: BOT_TOKEN },
				settings: { allowGroups: false, previewMode: true },
			} as ConnectionsArgs,
			humanCtx,
		);

		expect(result.error).toEqual(expect.stringContaining("previewMode"));
		expect(await rowExists("mixed-telegram")).toBe(false);
	});

	it("refuses previewMode:false too — the key is not the tenant's to state", async () => {
		// `false` looks harmless, but accepting it concedes that the key is part
		// of the tenant's vocabulary, and an update path that merges settings
		// could then carry it. The key is refused on presence, not on value.
		const result = await callManageConnections(
			{
				action: "apply_chat_connection",
				stable_id: "falsey-telegram",
				connector_key: "telegram",
				config: { platform: "telegram", botToken: BOT_TOKEN },
				settings: { previewMode: false },
			} as ConnectionsArgs,
			humanCtx,
		);

		expect(result.error).toEqual(expect.stringContaining("previewMode"));
		expect(await rowExists("falsey-telegram")).toBe(false);
	});

	it("refuses an unknown settings key rather than persisting it", async () => {
		// `settings` is an open `Record<string, any>` in the tool contract, so an
		// allowlist is the only thing between a caller and an arbitrary key in the
		// same column the runtime reads its own flags from. A privileged flag
		// added later must fail closed on the day it lands, without anyone
		// remembering to come back here.
		const result = await callManageConnections(
			{
				action: "apply_chat_connection",
				stable_id: "unknown-key-telegram",
				connector_key: "telegram",
				config: { platform: "telegram", botToken: BOT_TOKEN },
				settings: { someFutureFlag: true },
			} as ConnectionsArgs,
			humanCtx,
		);

		expect(result.error).toEqual(expect.stringContaining("someFutureFlag"));
		expect(await rowExists("unknown-key-telegram")).toBe(false);
	});

	it("does NOT refuse the settings a tenant legitimately owns", async () => {
		// Guard the guard: an allowlist that refused everything would satisfy every
		// case above while breaking the feature. Persistence needs a running chat
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
