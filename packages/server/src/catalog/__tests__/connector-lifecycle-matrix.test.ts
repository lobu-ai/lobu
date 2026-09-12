import { describe, expect, it } from "vitest";
import { listCatalogConnectorDefinitions } from "../../utils/connector-catalog";

const EXPECTED_BUNDLED_CONNECTORS = [
	"discord",
	"github",
	"google.calendar",
	"google.drive",
	"google.gmail",
	"gchat",
	"hackernews",
	"jira",
	"linear",
	"market.quotes",
	"microsoft.outlook",
	"postgres",
	"producthunt",
	"reddit",
	"rss",
	"slack",
	"teams",
	"telegram",
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
			["app_installation", "env_keys", "none", "oauth"],
		);
	});

	it("keeps every bundled action connector in the executable local-action matrix", async () => {
		const definitions = await listCatalogConnectorDefinitions();
		const actionCounts = Object.fromEntries(
			definitions
				.filter((definition) => definition.actions_schema)
				.map((definition) => [
					definition.key,
					Object.keys(definition.actions_schema ?? {}).length,
				]),
		);
		expect(actionCounts).toEqual({
			github: 6,
			"google.calendar": 4,
			"google.drive": 2,
			"google.gmail": 5,
			"market.quotes": 1,
			"whatsapp.web": 6,
			x: 1,
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
