/**
 * `manage_entity` is a union of per-action variants, so the schema — not the
 * handler — decides what each action requires and accepts. These pin what the
 * flat contract could not express: `entity_type`+`name`, `entity_id`, the link
 * endpoint triple, `winner_entity_id` and `candidate_entity_ids` are required
 * where they matter rather than checked by hand; a field that belongs to
 * another action is an error on this one instead of a silent no-op (the flat
 * object accepted `entity_type` on `update` and `name` on `delete`); the two
 * ways to address an edge stay a handler decision; and the registry's
 * per-action access filtering — which only ever applied to union variants —
 * now keeps owner-admin writes out of a read-scope client's listing.
 */
import { describe, expect, it } from "bun:test";
import { ManageEntitySchema } from "@lobu/core/contracts/tools/manage-entity";
import { getAllTools } from "../../tools/registry";
import { validateToolArgs } from "../../tools/validate-args";
import { ToolUserError } from "../../utils/errors";

const validate = (args: unknown) =>
	validateToolArgs("manage_entity", ManageEntitySchema, args);

function messageOf(fn: () => unknown): string {
	try {
		fn();
	} catch (err) {
		expect(err).toBeInstanceOf(ToolUserError);
		return (err as ToolUserError).message;
	}
	throw new Error("expected validation to throw");
}

describe("manage_entity union contract", () => {
	it("accepts all three list parent filters without changing write contracts", () => {
		for (const filter of [{}, { parent_id: null }, { parent_id: 7 }]) {
			const input = { action: "list", entity_type: "synthetic-task", ...filter };
			expect(validate(input)).toEqual(input);
		}
		expect(messageOf(() => validate({ action: "list", parent_id: "bad-parent" }))).toMatch(/parent_id/);
		expect(messageOf(() => validate({ action: "create", entity_type: "synthetic-task", name: "Task", parent_id: null }))).toMatch(/parent_id/);
		expect(messageOf(() => validate({ action: "update", entity_id: 7, parent_id: null }))).toMatch(/parent_id/);
	});

	it("requires each action's identifying fields at the schema", () => {
		expect(messageOf(() => validate({ action: "create", name: "Acme" }))).toMatch(
			/entity_type/,
		);
		expect(messageOf(() => validate({ action: "create", entity_type: "company" }))).toMatch(
			/name/,
		);
		for (const action of ["update", "get", "delete", "list_links", "unmerge"]) {
			expect(messageOf(() => validate({ action }))).toMatch(/entity_id/);
		}
		expect(
			messageOf(() => validate({ action: "link", from_entity_id: 1, to_entity_id: 2 })),
		).toMatch(/relationship_type_slug/);
		expect(messageOf(() => validate({ action: "merge", entity_id: 7 }))).toMatch(
			/winner_entity_id/,
		);
		expect(messageOf(() => validate({ action: "resolve_duplicates" }))).toMatch(
			/candidate_entity_ids/,
		);
	});

	it("rejects a field another action takes instead of ignoring it", () => {
		const update = messageOf(() =>
			validate({ action: "update", entity_id: 7, entity_type: "company", name: "Acme" }),
		);
		expect(update).toMatch(/unknown argument\(s\): entity_type/);
		expect(update).toMatch(/valid arguments for action 'update' are: action, entity_id, name/);

		const del = messageOf(() => validate({ action: "delete", entity_id: 7, name: "Acme" }));
		expect(del).toMatch(/unknown argument\(s\): name/);
		expect(del).toMatch(
			/valid arguments for action 'delete' are: action, entity_id, force_delete_tree, dry_run, automation_source$/,
		);

		expect(
			messageOf(() => validate({ action: "get", entity_id: 7, search: "acme" })),
		).toMatch(/unknown argument\(s\): search/);
	});

	it("leaves the edge addressing choice (id or endpoint triple) to the handler", () => {
		for (const action of ["unlink", "update_link"]) {
			expect(validate({ action, relationship_id: 9 })).toEqual({ action, relationship_id: 9 });
			expect(
				validate({
					action,
					from_entity_id: 1,
					to_entity_id: 2,
					relationship_type_slug: "works_at",
				}),
			).toMatchObject({ action, relationship_type_slug: "works_at" });
			// Neither given: the schema accepts it; resolveRelationshipId raises the
			// "relationship_id, or from + to + slug" error with the action's name.
			expect(validate({ action })).toEqual({ action });
		}
	});

	it("bounds resolve_duplicates to at least two distinct candidates", () => {
		expect(messageOf(() => validate({ action: "resolve_duplicates", candidate_entity_ids: [7] })))
			.toMatch(/candidate_entity_ids/);
		expect(
			messageOf(() => validate({ action: "resolve_duplicates", candidate_entity_ids: [7, 7] })),
		).toMatch(/candidate_entity_ids/);
		expect(validate({ action: "resolve_duplicates", candidate_entity_ids: [7, 8] })).toEqual({
			action: "resolve_duplicates",
			candidate_entity_ids: [7, 8],
		});
	});

	it("accepts each action's full field set", () => {
		const source = { automation_id: 3, run_id: 44 };
		expect(
			validate({
				action: "create",
				entity_type: "company",
				name: "Acme",
				content: "body",
				slug: "acme",
				parent_id: 1,
				domain: "acme.com",
				category: "saas",
				platform_type: "b2b",
				main_market: "US",
				market: "US",
				link: "https://acme.com",
				metadata: { team_size: 5 },
				automation_source: source,
			}),
		).toMatchObject({ entity_type: "company", automation_source: source });
		expect(
			validate({
				action: "update",
				entity_id: 7,
				metadata: { stage: "won" },
				field_note: "closed by the AE",
				affirm_fields: ["owner"],
				automation_source: source,
			}),
		).toMatchObject({ entity_id: 7, affirm_fields: ["owner"] });
		expect(
			validate({
				action: "list",
				entity_type: "company",
				parent_id: 1,
				search: "acme",
				category: "saas",
				main_market: "US",
				market: "US",
				limit: 20,
				offset: 40,
				sort_by: "created_at",
				sort_order: "desc",
			}),
		).toMatchObject({ parent_id: 1, limit: 20, sort_order: "desc" });
		expect(validate({ action: "get", entity_id: 7, include_deleted: true })).toEqual({
			action: "get",
			entity_id: 7,
			include_deleted: true,
		});
		expect(
			validate({ action: "delete", entity_id: 7, force_delete_tree: true, dry_run: true }),
		).toMatchObject({ force_delete_tree: true, dry_run: true });
		expect(
			validate({
				action: "link",
				from_entity_id: 1,
				to_entity_id: 2,
				relationship_type_slug: "works_at",
				confidence: 0.9,
				source: "llm",
				metadata: { since: 2020 },
				automation_source: source,
			}),
		).toMatchObject({ confidence: 0.9, source: "llm" });
		expect(
			validate({
				action: "update_link",
				relationship_id: 9,
				confidence: 1,
				source: "ui",
				metadata: { since: 2021 },
			}),
		).toMatchObject({ relationship_id: 9, source: "ui" });
		expect(
			validate({
				action: "list_links",
				entity_id: 7,
				direction: "inbound",
				relationship_type_slug: "works_at",
				source: "feed",
				confidence_min: 0.5,
				include_deleted: true,
				limit: 200,
				offset: 0,
			}),
		).toMatchObject({ direction: "inbound", source: "feed", limit: 200 });
		expect(
			validate({
				action: "merge",
				winner_entity_id: 1,
				duplicate_entity_ids: [2, 3],
				merge_evidence: [{ kind: "email", identifier: "a@acme.com" }],
				merge_rationale: "Same email.",
				dry_run: true,
				automation_source: source,
			}),
		).toMatchObject({ winner_entity_id: 1, duplicate_entity_ids: [2, 3] });
		expect(validate({ action: "merge", winner_entity_id: 1, entity_id: 2 })).toEqual({
			action: "merge",
			winner_entity_id: 1,
			entity_id: 2,
		});
		expect(validate({ action: "unmerge", entity_id: 2 })).toEqual({
			action: "unmerge",
			entity_id: 2,
		});
	});
});

/**
 * What an MCP client actually sees: the union is flattened to one object
 * (hosts reject a top-level `anyOf`), so per-action requirements survive only
 * as prose on the `action` enum.
 */
describe("manage_entity wire schema", () => {
	const listedFor = (maxAccessLevel: "read" | "write" | "admin") =>
		getAllTools({ publicOnly: false, maxAccessLevel }).find(
			(tool) => tool.name === "manage_entity",
		);

	it("filters the action enum by the caller's access tier", () => {
		expect(listedFor("read")?.inputSchema.properties.action.enum).toEqual([
			"list",
			"get",
			"list_links",
		]);
		expect(listedFor("write")?.inputSchema.properties.action.enum).toEqual([
			"create",
			"update",
			"list",
			"get",
			"link",
			"unlink",
			"update_link",
			"list_links",
		]);
		expect(listedFor("admin")?.inputSchema.properties.action.enum).toEqual([
			"create",
			"update",
			"list",
			"get",
			"delete",
			"link",
			"unlink",
			"update_link",
			"list_links",
			"merge",
			"resolve_duplicates",
			"unmerge",
		]);
	});

	it("names each action's required fields on the flattened enum", () => {
		const description: string =
			listedFor("admin")?.inputSchema.properties.action.description ?? "";
		const lineFor = (action: string) =>
			description.split("\n").find((line) => line.startsWith(`- ${action}:`));
		expect(lineFor("create")).toContain("Required: entity_type, name.");
		expect(lineFor("update")).toContain("Required: entity_id.");
		expect(lineFor("list")).not.toContain("Required:");
		expect(lineFor("link")).toContain(
			"Required: from_entity_id, to_entity_id, relationship_type_slug.",
		);
		expect(lineFor("unlink")).not.toContain("Required:");
		expect(lineFor("merge")).toContain("Required: winner_entity_id.");
		expect(lineFor("resolve_duplicates")).toContain("Required: candidate_entity_ids.");
		expect(lineFor("unmerge")).toContain("Required: entity_id.");
	});
});
