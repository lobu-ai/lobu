/**
 * ClientSDK `entitySchema` namespace. Delegates to `manageEntitySchema`, which
 * is doubly discriminated by `schema_type` (entity_type vs relationship_type)
 * and `action`.
 *
 * Field names mirror the handler: plain `slug` for the type identifier,
 * `source_entity_type_slug` / `target_entity_type_slug` for add_rule.
 */

import type { FlatActionInput } from "@lobu/core/contracts/tools/action-input";
import type { ManageEntitySchemaArgs } from "@lobu/core/contracts/tools/manage-entity-schema";
import type { Env } from "../../index";
import { manageEntitySchema } from "../../tools/admin/manage_entity_schema";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller, idArg } from "./action-call";

/**
 * The contract's fields one action reads; `R` names the ones it requires.
 * `schema_type` and `action` are not inputs — each method fills them in.
 */
type Input<
	K extends keyof ManageEntitySchemaArgs,
	R extends K = never,
> = FlatActionInput<ManageEntitySchemaArgs, K, R>;
type TypeFields = "slug" | "name" | "description" | "metadata_schema";
type EntityTypeFields =
	| TypeFields
	| "icon"
	| "color"
	| "event_kinds"
	| "backing"
	| "metrics_config"
	| "rules_source";
type RelationshipTypeFields =
	| TypeFields
	| "inverse_type_slug"
	| "status"
	| "backing";

export interface EntitySchemaNamespace {
	manage(input: Record<string, unknown>): Promise<unknown>;
	listTypes(input?: Input<"list_scope">): Promise<unknown>;
	getType(slug: string): Promise<unknown>;
	createType(input: Input<EntityTypeFields, "slug" | "name">): Promise<unknown>;
	updateType(input: Input<EntityTypeFields, "slug">): Promise<unknown>;
	deleteType(input: Input<"slug", "slug">): Promise<unknown>;
	auditType(slug: string): Promise<unknown>;

	listRelTypes(input?: Input<"list_scope" | "include_deleted">): Promise<unknown>;
	getRelType(slug: string): Promise<unknown>;
	createRelType(
		input: Input<RelationshipTypeFields | "is_symmetric", "slug" | "name">,
	): Promise<unknown>;
	updateRelType(input: Input<RelationshipTypeFields, "slug">): Promise<unknown>;
	deleteRelType(input: Input<"slug", "slug">): Promise<unknown>;

	addRule(
		input: Input<
			"slug" | "source_entity_type_slug" | "target_entity_type_slug",
			"slug" | "source_entity_type_slug" | "target_entity_type_slug"
		>,
	): Promise<unknown>;
	removeRule(input: Input<"slug" | "rule_id", "rule_id">): Promise<unknown>;
	listRules(input: Input<"slug", "slug">): Promise<unknown>;
}

export function buildEntitySchemaNamespace(
	ctx: ToolContext,
	env: Env,
): EntitySchemaNamespace {
	const { manage, method } = createActionCaller(
		manageEntitySchema,
		env,
		ctx,
		"entitySchema",
	);
	const entityMethod = (
		actionName: string,
		publicMethod: string,
		mapArgs: (...args: any[]) => object = (input) => input ?? {},
	) =>
		method(actionName, {
			publicMethod,
			mapArgs: (...args) => ({
				...mapArgs(...args),
				schema_type: "entity_type",
			}),
		});
	const relationshipMethod = (
		actionName: string,
		publicMethod: string,
		mapArgs: (...args: any[]) => object = (input) => input ?? {},
	) =>
		method(actionName, {
			publicMethod,
			mapArgs: (...args) => ({
				...mapArgs(...args),
				schema_type: "relationship_type",
			}),
		});

	return {
		manage,
		listTypes: entityMethod("list", "listTypes"),
		getType: entityMethod("get", "getType", (slug) => ({
			slug: idArg("entitySchema.getType", "slug", slug, "string"),
		})),
		createType: entityMethod("create", "createType"),
		updateType: entityMethod("update", "updateType"),
		deleteType: entityMethod("delete", "deleteType"),
		auditType: entityMethod("audit", "auditType", (slug) => ({
			slug: idArg("entitySchema.auditType", "slug", slug, "string"),
		})),

		listRelTypes: relationshipMethod("list", "listRelTypes"),
		getRelType: relationshipMethod("get", "getRelType", (slug) => ({
			slug: idArg("entitySchema.getRelType", "slug", slug, "string"),
		})),
		createRelType: relationshipMethod("create", "createRelType"),
		updateRelType: relationshipMethod("update", "updateRelType"),
		deleteRelType: relationshipMethod("delete", "deleteRelType"),

		addRule: relationshipMethod("add_rule", "addRule"),
		removeRule: relationshipMethod("remove_rule", "removeRule"),
		listRules: relationshipMethod("list_rules", "listRules"),
	};
}
