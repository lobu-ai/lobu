import { describe, expect, it } from "vitest";
import type { ClientSDK } from "../sandbox/client-sdk";
import { runScript } from "../sandbox/run-script";
import {
	compileReactionScript,
	extractReactionInputSchema,
} from "../automations/reaction-executor";
import { AUTOMATION_CATALOG_TEMPLATES } from "./automation-templates";

const template = AUTOMATION_CATALOG_TEMPLATES.find((entry) => entry.id === "duplicate-merge")!;
const script = String(template.detail.reaction_script);

async function executeReaction(
	pages: Array<Record<string, unknown>>,
	sources = [{ name: "assets", query: "@entity:asset" }],
) {
	const calls: Record<string, unknown>[] = [];
	const sdk = {
		query: async (query: string) => {
			expect(query).toBe("SELECT sources FROM automations WHERE id = 7");
			return [{ sources }];
		},
		knowledge: { read: async () => { throw new Error("Context pages cannot bound discovery"); } },
		entities: {
			discoverDuplicates: async (input: Record<string, unknown>) => {
				calls.push({ action: "discover_duplicates", ...input });
				const page = pages.shift();
				if (!page) throw new Error("Unexpected discovery page");
				return page;
			},
			manage: async (input: Record<string, unknown>) => {
				calls.push(input);
				return { deferred_candidates: 1 };
			},
		},
	} as unknown as ClientSDK;
	const result = await runScript({
		source: script, sdk,
		context: { automation: { id: 7, version: 2 } },
	});
	return { calls, result };
}

describe("duplicate merge Automation template", () => {
	it("keeps the model explanatory and performs discovery even if source context is unchanged", async () => {
		expect(template.version).toBe("4.0.0");
		expect(template.detail.triggers).toMatchObject([{ skip_if_unchanged: false }]);
		expect(String(template.detail.prompt)).toContain("x-lobu-resolution");
		expect(String(template.detail.prompt)).toContain("Do not call entity tools or emit backlog tasks");
		await expect(compileReactionScript(script)).resolves.toBeTruthy();
		expect((await extractReactionInputSchema(script))?.required).toEqual(["analysis_summary", "uncertain_groups"]);
		expect(script).not.toContain("normalizeIdentity");
		expect(script).not.toContain("function union");
	});

	it("continues discovery pages and submits only whole eligible components", async () => {
		const { calls, result } = await executeReaction([
			{ components: [
				{ candidate_entity_ids: [1, 6001], oversized: false },
				{ candidate_entity_ids: [3, 4, 5], oversized: false },
				{ candidate_entity_ids: [], oversized: true },
			], next_cursor: "page-two" },
			{ components: [{ candidate_entity_ids: [8, 9], oversized: false }], next_cursor: null },
		]);
		expect(result.success, result.error?.message).toBe(true);
		expect(calls).toEqual([
			{ action: "discover_duplicates", entity_type: "asset" },
			{ action: "resolve_duplicates", candidate_entity_ids: [1, 6001, 3, 4, 5] },
			{ action: "discover_duplicates", entity_type: "asset", cursor: "page-two" },
			{ action: "resolve_duplicates", candidate_entity_ids: [8, 9] },
		]);
		expect(result.returnValue).toEqual({ oversized_groups: 1, deferred_candidates: 2 });
	});

	it("handles empty and oversized-only pages without submitting partial groups", async () => {
		const { calls, result } = await executeReaction([
			{ components: [{ candidate_entity_ids: [], oversized: true }], next_cursor: "empty" },
			{ components: [], next_cursor: null },
		]);
		expect(result.success).toBe(true);
		expect(calls.every((call) => call.action === "discover_duplicates")).toBe(true);
		expect(result.returnValue).toEqual({ oversized_groups: 1, deferred_candidates: 0 });
	});

	it("reports a failed later page as failure after earlier work, never as a complete sweep", async () => {
		const { calls, result } = await executeReaction([
			{ components: [{ candidate_entity_ids: [1, 2], oversized: false }], next_cursor: "unavailable" },
		]);
		expect(result.success).toBe(false);
		expect(result.error?.message).toContain("Unexpected discovery page");
		expect(calls.filter((call) => call.action === "resolve_duplicates")).toHaveLength(1);
	});

	it("fails visibly before mutations for unsupported or absent configured sources", async () => {
		for (const sources of [[], [{ name: "assets", query: "SELECT * FROM entities" }]]) {
			const { calls, result } = await executeReaction([], sources);
			expect(result.success).toBe(false);
			expect(result.error?.message).toMatch(/requires.*source/);
			expect(calls).toEqual([]);
		}
	});
});
