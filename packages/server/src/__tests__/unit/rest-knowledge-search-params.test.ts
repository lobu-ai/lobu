import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../../index";
import { parseKnowledgeSearchQuery, restSearchKnowledge } from "../../rest-api";
import { GetContentSchema } from "../../tools/get_content/schema";
import { validateToolArgs } from "../../tools/validate-args";

async function parsed(query: string): Promise<Record<string, unknown>> {
	const app = new Hono<{ Bindings: Env }>();
	app.get("/search", (c) =>
		c.json(
			validateToolArgs("read_knowledge", GetContentSchema, parseKnowledgeSearchQuery(c))
		)
	);
	const response = await app.request(`/search?${query}`);
	expect(response.status).toBe(200);
	return response.json();
}

describe("knowledge search REST params", () => {
	it("forwards classification filters and the other content filters", async () => {
		expect(
			await parsed(
				"query=+security+news+&classification_filters=%7B%22topic%22%3A%5B%22security%22%5D%7D&classification_source=user&sort_by=date&sort_order=asc&run_id=7&content_ids=3,4&engagement_min=10"
			)
		).toMatchObject({
			query: "security news",
			classification_filters: { topic: ["security"] },
			classification_source: "user",
			sort_by: "date",
			sort_order: "asc",
			run_id: 7,
			content_ids: [3, 4],
			engagement_min: 10,
		});
	});

	it("forwards the read_knowledge filters the public feed sends", async () => {
		expect(
			await parsed(
				"semantic_type=note&semantic_type=summary&agent_id=agent-x&client_ids=client-a&client_ids=client-b,client-c&mcp_activity_id=act-1&produced_by_automation_id=11&analyzed_by_automation_id=12"
			)
		).toMatchObject({
			semantic_type: ["note", "summary"],
			agent_id: "agent-x",
			client_ids: ["client-a", "client-b", "client-c"],
			mcp_activity_id: "act-1",
			produced_by_automation_id: 11,
			analyzed_by_automation_id: 12,
		});
		expect(await parsed("semantic_type=note,summary")).toMatchObject({
			semantic_type: ["note", "summary"],
		});
	});

	it("accepts repeated keys and CSV for every list param", async () => {
		expect(
			await parsed(
				"feed_ids=1&feed_ids=2,3&connection_ids=4&connection_ids=5&entity_types=company&entity_types=person&platforms=slack&platforms=github"
			)
		).toMatchObject({
			feed_ids: [1, 2, 3],
			connection_ids: [4, 5],
			entity_types: ["company", "person"],
			platforms: ["slack", "github"],
		});
	});

	it.each([
		["false", false],
		["0", false],
		["true", true],
		["1", true],
	])("parses include_total=%s", async (raw, expected) => {
		expect(await parsed(`include_total=${raw}`)).toMatchObject({ include_total: expected });
	});

	it("omits include_total when absent or unrecognized so the exact count stays the default", async () => {
		expect(await parsed("query=security")).not.toHaveProperty("include_total");
		expect(await parsed("include_total=maybe")).not.toHaveProperty("include_total");
	});

	it("preserves omitted filters and an explicitly empty filter object", async () => {
		expect(await parsed("query=security")).not.toHaveProperty("classification_filters");
		expect(await parsed("query=security&classification_filters=%7B%7D")).toMatchObject({
			classification_filters: {},
		});
	});

	it.each([
		"", "%20", "%7Bnot-json", "%5B%22security%22%5D",
		"null", "true", "42", "%22security%22",
	])(
		"rejects malformed classification_filters %s instead of searching unfiltered",
		async (raw) => {
			const app = new Hono<{ Bindings: Env }>();
			app.get("/api/:orgSlug/knowledge/search", restSearchKnowledge);
			const response = await app.request(
				`/api/test-org/knowledge/search?query=security+news&classification_filters=${raw}`
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: expect.stringContaining("classification_filters must be a JSON object"),
			});
		}
	);
});
