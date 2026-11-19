import { describe, expect, it } from "vitest";
import { listCatalogConnectorDefinitions } from "../../utils/connector-catalog";

const EXPECTED_BUNDLED_CONNECTORS = [
	"agentid",
	"discord",
	"github",
	"google.calendar",
	"google.drive",
	"google.gmail",
	"gchat",
	"hackernews",
	"herdr",
	"imessage",
	"jira",
	"linear",
	"linkedin",
	"market.quotes",
	"microsoft.outlook",
	"postgres",
	"producthunt",
	"reddit",
	"rss",
	"shopify",
	"slack",
	"teams",
	"telegram",
	"tiktok.web",
	"webhook",
	"whatsapp",
	"whatsapp.web",
	"x",
	"youtube",
];

describe("bundled connector lifecycle matrix", () => {
	it("keeps every bundled connector discoverable with a supported auth family", async () => {
		const definitions = await listCatalogConnectorDefinitions();
		expect(definitions.map((definition) => definition.key).sort()).toEqual(
			[...EXPECTED_BUNDLED_CONNECTORS].sort(),
		);

		const supportedFamilies = new Set([
			"app_installation",
			"oauth",
			"env_keys",
			"browser",
			"interactive",
			"none",
		]);
		const representedFamilies = new Set<string>();
		for (const definition of definitions) {
			const methods = (
				definition.auth_schema as
					| { methods?: Array<{ type?: unknown }> }
					| null
			)?.methods;
			expect(methods?.length, `${definition.key} must declare auth methods`).toBeGreaterThan(0);
			for (const method of methods ?? []) {
				expect(typeof method.type).toBe("string");
				expect(
					supportedFamilies.has(String(method.type)),
					`${definition.key} uses unsupported auth family ${String(method.type)}`,
				).toBe(true);
				representedFamilies.add(String(method.type));
			}
		}
		expect([...representedFamilies].sort()).toEqual(
			["app_installation", "browser", "env_keys", "none", "oauth"],
		);
	});

	it("keeps every bundled action connector in the executable local-action matrix", async () => {
		const definitions = await listCatalogConnectorDefinitions();
		const isChatTransport = (raw: unknown) =>
			(raw as { delivery?: unknown }).delivery === "chat_transport";
		const actionCounts = Object.fromEntries(
			definitions
				.map((definition) => [
					definition.key,
					Object.values(definition.actions_schema ?? {}).filter((raw) => !isChatTransport(raw)).length,
				] as const)
				.filter(([, count]) => count > 0),
		);
		// Chat platforms the gateway's chat transport delivers for: their one
		// action is the agent's out-of-conversation send_message.
		const chatTransport = definitions
			.filter((definition) => Object.values(definition.actions_schema ?? {}).some(isChatTransport))
			.map((definition) => [definition.key, Object.keys(definition.actions_schema ?? {})]);
		expect(Object.fromEntries(chatTransport)).toEqual(
			Object.fromEntries(
				["discord", "gchat", "slack", "teams", "telegram", "whatsapp"].map((key) => [key, ["send_message"]]),
			),
		);
		expect(actionCounts).toEqual({
			github: 6,
			// Google actions are compiled one per Discovery method
			// (connectors/src/_google); a pinned-doc refresh moves these counts.
			"google.calendar": 32,
			// 61 compiled + download_file/get_file.
			"google.drive": 63,
			// 67 compiled + 6 hand-written (get_thread, send_email, …).
			"google.gmail": 73,
			herdr: 12,
			imessage: 4,
			linkedin: 20,
			"market.quotes": 2,
			// outlook's first actions: list_attachments + download_attachment.
			"microsoft.outlook": 2,
			// Browser-backed connectors also expose the gateway's verification action.
			"tiktok.web": 4,
			"whatsapp.web": 7,
			// prepare_reply (public-reply draft) + send_message (DM reply) +
			// set_like + set_follow + verification.
			x: 5,
			youtube: 5,
		});

		for (const definition of definitions) {
			for (const [operationKey, raw] of Object.entries(
				definition.actions_schema ?? {},
			)) {
				expect(operationKey.trim()).not.toBe("");
				expect(raw).toBeTypeOf("object");
			}
		}
	});
});
