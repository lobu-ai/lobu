/**
 * `manage_views` is a union of per-action variants, so the schema — not the
 * handler — decides what each action requires and accepts. These pin what the
 * flat contract could not express: `source_code` is required only by `set`,
 * `key` only by the actions that name a view, a field that belongs to another
 * action is an error instead of a silent no-op, and the registry's per-action
 * access filtering keeps the write actions out of a read-scope listing.
 */
import { describe, expect, it } from "bun:test";
import { ManageViewsSchema } from "@lobu/core/contracts/tools/manage-views";
import { getAllTools } from "../../tools/registry";
import { validateToolArgs } from "../../tools/validate-args";
import { ToolUserError } from "../../utils/errors";

const validate = (args: unknown) =>
	validateToolArgs("manage_views", ManageViewsSchema, args);

function messageOf(fn: () => unknown): string {
	try {
		fn();
	} catch (err) {
		expect(err).toBeInstanceOf(ToolUserError);
		return (err as ToolUserError).message;
	}
	throw new Error("expected validation to throw");
}

describe("manage_views union contract", () => {
	it("requires source_code for set and key for get/remove, at the schema", () => {
		expect(messageOf(() => validate({ action: "set", key: "pipeline" }))).toMatch(
			/source_code/
		);
		expect(messageOf(() => validate({ action: "get" }))).toMatch(/key/);
		expect(messageOf(() => validate({ action: "remove" }))).toMatch(/key/);
	});

	it("rejects a field another action takes instead of ignoring it", () => {
		// `key` belongs to set/get/remove but not to list: passing it there is
		// an error, not a silent no-op.
		const list = messageOf(() => validate({ action: "list", key: "pipeline" }));
		expect(list).toMatch(/unknown argument\(s\): key/);
		expect(list).toMatch(
			/valid arguments for action 'list' are: action$/,
		);
	});

	it("accepts each action's full field set", () => {
		expect(
			validate({
				action: "set",
				key: "pipeline",
				source_code: "export default function P() { return null; }",
				name: "Pipeline",
				attach: [{ type: "deal", placement: "tab" }],
				params: { by: { type: "string", default: "owner" } },
				actions: { markWon: { emits: "deal.won" } },
			}),
		).toMatchObject({ key: "pipeline", name: "Pipeline" });
		expect(validate({ action: "get", key: "pipeline" })).toEqual({
			action: "get",
			key: "pipeline",
		});
		expect(validate({ action: "list" })).toEqual({ action: "list" });
		expect(validate({ action: "remove", key: "pipeline" })).toEqual({
			action: "remove",
			key: "pipeline",
		});
	});
});

/**
 * What an MCP client actually sees: the union is flattened to one object
 * (hosts reject a top-level `anyOf`), so per-action requirements survive only
 * as prose on the `action` enum.
 */
describe("manage_views wire schema", () => {
	const listedFor = (maxAccessLevel: "read" | "admin") =>
		getAllTools({ publicOnly: false, maxAccessLevel }).find(
			(tool) => tool.name === "manage_views",
		);

	it("hides the write actions from a read-scope listing", () => {
		expect(listedFor("read")?.inputSchema.properties.action.enum).toEqual([
			"get",
			"list",
		]);
		expect(listedFor("admin")?.inputSchema.properties.action.enum).toEqual([
			"set",
			"get",
			"list",
			"remove",
		]);
	});

	it("names each action's required fields on the flattened enum", () => {
		const description: string =
			listedFor("admin")?.inputSchema.properties.action.description ?? "";
		const lineFor = (action: string) =>
			description.split("\n").find((line) => line.startsWith(`- ${action}:`));
		expect(lineFor("set")).toContain("Required: key, source_code.");
		expect(lineFor("get")).toContain("Required: key.");
		expect(lineFor("list")).not.toContain("Required:");
		expect(lineFor("remove")).toContain("Required: key.");
	});
});
