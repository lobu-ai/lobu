import { describe, expect, it } from "vitest";
import type { ClientSDK } from "../sandbox/client-sdk";
import { runScript } from "../sandbox/run-script";
import {
	compileReactionScript,
	extractReactionInputSchema,
} from "../automations/reaction-executor";
import { AUTOMATION_CATALOG_TEMPLATES } from "./automation-templates";

const duplicateMergeTemplate = AUTOMATION_CATALOG_TEMPLATES.find(
	(entry) => entry.id === "duplicate-merge",
);
if (!duplicateMergeTemplate) {
	throw new Error("duplicate-merge Automation template is missing");
}
const duplicateMergeReaction = String(
	duplicateMergeTemplate.detail.reaction_script,
);

async function executeReaction(
	people: Array<{ id?: unknown; metadata?: Record<string, unknown> }>,
) {
	const calls: Record<string, unknown>[] = [];
	const sdk = {
		knowledge: {
			read: async () => ({ sources: { people } }),
		},
		entities: {
			manage: async (input: Record<string, unknown>) => {
				calls.push(input);
				return { groups_found: 0 };
			},
		},
	} as unknown as ClientSDK;
	const result = await runScript({
		source: duplicateMergeReaction,
		sdk,
		context: {
			window: {
				automation_id: 7,
				window_start: "2026-01-01T00:00:00.000Z",
				window_end: "2026-01-02T00:00:00.000Z",
			},
		},
	});
	return { calls, result };
}

describe("duplicate merge Automation template", () => {
	it("keeps the model explanatory and makes the entity type policy authoritative", () => {
		const prompt = String(duplicateMergeTemplate.detail.prompt);
		expect(prompt).toContain("analysis_summary");
		expect(prompt).toContain("x-lobu-resolution");
		expect(prompt).toContain("Do not call entity tools or emit backlog tasks");
	});

	it("ships a small reaction that compiles and declares its extraction contract", async () => {
		await expect(
			compileReactionScript(duplicateMergeReaction),
		).resolves.toBeTruthy();
		const schema = await extractReactionInputSchema(duplicateMergeReaction);
		expect(schema?.required).toEqual(["analysis_summary", "uncertain_groups"]);
		expect(duplicateMergeReaction.split("\n").length).toBeLessThan(40);
		expect(duplicateMergeReaction).not.toContain("normalizeIdentity");
		expect(duplicateMergeReaction).not.toContain("function union");
	});

	it("submits only unique candidate IDs to the server-side module", async () => {
		const { calls, result } = await executeReaction([
			{ id: 3, metadata: { email: " Person@Example.com " } },
			{ id: 4, metadata: { email: "person@example.com" } },
			{ id: 3, metadata: {} },
			{ id: "invalid" },
		]);
		expect(result.success).toBe(true);
		expect(calls).toEqual([
			{
				action: "resolve_duplicates",
				candidate_entity_ids: [3, 4],
			},
		]);
	});

	it("does nothing with fewer than two valid candidates", async () => {
		const { calls, result } = await executeReaction([
			{ id: 1 },
			{ id: "invalid" },
		]);
		expect(result.success).toBe(true);
		expect(calls).toEqual([]);
	});

	it("uses one mutation call regardless of candidate count", async () => {
		const people = Array.from({ length: 400 }, (_, index) => ({
			id: index + 1,
		}));
		const { calls, result } = await executeReaction(people);
		expect(result.success).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.candidate_entity_ids).toHaveLength(400);
	});

	it("fails before mutation when the candidate input exceeds the server limit", async () => {
		const people = Array.from({ length: 5_001 }, (_, index) => ({
			id: index + 1,
		}));
		const { calls, result } = await executeReaction(people);
		expect(result.success).toBe(false);
		expect(result.error?.message).toContain("More than 5000 entities");
		expect(calls).toEqual([]);
	});
});
