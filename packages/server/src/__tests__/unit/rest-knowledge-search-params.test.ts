import { describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import * as db from "../../db/client";
import type { Env } from "../../index";
import {
	parseKnowledgeSearchQuery,
	publicRestSearchKnowledge,
	restSearchKnowledge,
} from "../../rest-api";
import * as content from "../../tools/get_content";
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

describe("knowledge search REST route parity", () => {
	it.each([
		["signed-in", restSearchKnowledge],
		["public", publicRestSearchKnowledge],
	] as const)("%s route forwards filters and rejects malformed JSON", async (_name, handler) => {
		const getDb = spyOn(db, "getDb").mockReturnValue(
			(async () => [{ id: "test-org" }]) as never
		);
		const getContent = spyOn(content, "getContent").mockResolvedValue({ content: [] } as never);
		try {
			const app = new Hono<{ Bindings: Env }>();
			app.use("*", async (c, next) => {
				c.set("organizationId" as never, "test-org" as never);
				await next();
			});
			app.get("/api/:orgSlug/knowledge/search", handler);
			const params = new URLSearchParams({
				query: "security news",
				classification_filters: JSON.stringify({ topic: ["security"] }),
				classification_source: "user",
				sort_by: "date",
				sort_order: "asc",
			});
			const response = await app.request(`/api/test-org/knowledge/search?${params}`);
			expect(response.status).toBe(200);
			expect(getContent).toHaveBeenCalledTimes(1);
			expect(getContent.mock.calls[0][0]).toMatchObject({
				query: "security news",
				classification_filters: { topic: ["security"] },
				classification_source: "user",
				sort_by: "date",
				sort_order: "asc",
			});

			for (const raw of ["", "{not-json", "[]", "null", "true", "42", '"security"']) {
				params.set("classification_filters", raw);
				const invalid = await app.request(`/api/test-org/knowledge/search?${params}`);
				expect(invalid.status).toBe(400);
				expect(await invalid.json()).toMatchObject({
					error: expect.stringContaining("classification_filters must be a JSON object"),
				});
			}
			expect(getContent).toHaveBeenCalledTimes(1);
		} finally {
			getContent.mockRestore();
			getDb.mockRestore();
		}
	});
});
