/**
 * `manage_classifiers` is a union of per-action variants, so the schema — not
 * the handler — decides what each action requires and accepts. These pin what
 * the flat contract could not express: `create`'s four required fields,
 * `classifier_id` for `delete` and `classifier_slug` for `classify` are
 * required at the schema rather than answered with a `success: false` result;
 * a field that belongs to another action is an error on this one instead of a
 * silent no-op (the flat object accepted `slug` on `list`); and the registry's
 * per-action access filtering — which only ever applied to union variants —
 * keeps the write actions out of a read-scope listing.
 */
import { describe, expect, it } from "bun:test";
import { ManageClassifiersSchema } from "@lobu/core/contracts/tools/manage-classifiers";
import { getAllTools } from "../../tools/registry";
import { validateToolArgs } from "../../tools/validate-args";
import { ToolUserError } from "../../utils/errors";

const validate = (args: unknown) =>
	validateToolArgs("manage_classifiers", ManageClassifiersSchema, args);

function messageOf(fn: () => unknown): string {
	try {
		fn();
	} catch (err) {
		expect(err).toBeInstanceOf(ToolUserError);
		return (err as ToolUserError).message;
	}
	throw new Error("expected validation to throw");
}

const values = { positive: { description: "Positive", examples: ["great"] } };

describe("manage_classifiers union contract", () => {
	it("requires each action's fields at the schema", () => {
		expect(messageOf(() => validate({ action: "create", slug: "sentiment", name: "S" }))).toMatch(
			/attribute_key|attribute_values/,
		);
		expect(messageOf(() => validate({ action: "delete" }))).toMatch(/classifier_id/);
		expect(messageOf(() => validate({ action: "classify", content_id: 1, value: "x" }))).toMatch(
			/classifier_slug/,
		);
		expect(
			messageOf(() =>
				validate({ action: "classify", classifier_slug: "s", content_id: 1, value: "x", confidence: 2 }),
			),
		).toMatch(/confidence/);
	});

	it("rejects a field another action takes instead of ignoring it", () => {
		const list = messageOf(() => validate({ action: "list", slug: "sentiment" }));
		expect(list).toMatch(/unknown argument\(s\): slug/);
		expect(list).toMatch(/valid arguments for action 'list' are: action, entity_id, status$/);

		const del = messageOf(() =>
			validate({ action: "delete", classifier_id: 7, slug: "sentiment" }),
		);
		expect(del).toMatch(/unknown argument\(s\): slug/);
		expect(del).toMatch(/valid arguments for action 'delete' are: action, classifier_id$/);
	});

	it("accepts each action's full field set", () => {
		expect(
			validate({
				action: "create",
				slug: "sentiment",
				name: "Sentiment",
				attribute_key: "sentiment",
				attribute_values: values,
				description: "tone",
				entity_id: 12,
				created_by: "agent",
			}),
		).toMatchObject({ slug: "sentiment", attribute_values: values });
		expect(validate({ action: "list" })).toEqual({ action: "list" });
		expect(validate({ action: "list", entity_id: 12, status: "all" })).toMatchObject({ status: "all" });
		expect(validate({ action: "delete", classifier_id: 7 })).toEqual({
			action: "delete",
			classifier_id: 7,
		});
		expect(
			validate({
				action: "classify",
				classifier_slug: "sentiment",
				classifications: [
					{ content_id: 1, value: null, reasoning: "unset" },
					{ content_id: 2, value: "positive", confidence: 0.4 },
				],
				source: "llm",
				reasoning: "batch",
			}),
		).toMatchObject({ source: "llm" });
		expect(
			validate({ action: "classify", classifier_slug: "sentiment", content_id: 1, value: "x", confidence: 0 }),
		).toMatchObject({ confidence: 0 });
		// Removed with the embedding engine.
		expect(messageOf(() => validate({ action: "create", slug: "s", name: "S", attribute_key: "s", attribute_values: values, min_similarity: 0.6 }))).toMatch(/min_similarity/);
	});
});

/**
 * What an MCP client actually sees: the union is flattened to one object
 * (hosts reject a top-level `anyOf`), so per-action requirements survive only
 * as prose on the `action` enum.
 */
describe("manage_classifiers wire schema", () => {
	const listedFor = (maxAccessLevel: "read" | "admin") =>
		getAllTools({ publicOnly: false, maxAccessLevel }).find(
			(tool) => tool.name === "manage_classifiers",
		);

	it("hides the write actions from a read-scope listing", () => {
		expect(listedFor("read")?.inputSchema.properties.action.enum).toEqual(["list"]);
		expect(listedFor("admin")?.inputSchema.properties.action.enum).toEqual([
			"create",
			"list",
			"delete",
			"classify",
		]);
	});

	it("names each action's required fields on the flattened enum", () => {
		const description: string =
			listedFor("admin")?.inputSchema.properties.action.description ?? "";
		const lineFor = (action: string) =>
			description.split("\n").find((line) => line.startsWith(`- ${action}:`));
		expect(lineFor("create")).toContain("Required: slug, name, attribute_key, attribute_values.");
		expect(lineFor("list")).not.toContain("Required:");
		expect(lineFor("delete")).toContain("Required: classifier_id.");
		expect(lineFor("classify")).toContain("Required: classifier_slug.");
	});
});
