/**
 * ClientSDK `entities` namespace.
 *
 * Delegates to `manageEntity` with action-discriminated payloads. Per-call auth
 * checks fire inside the handler; this wrapper does not duplicate them.
 */

import type {
	EntityCreateInput,
	EntityDeleteInput,
	EntityDiscoverDuplicatesInput,
	EntityDiscoverDuplicatesResult,
	EntityGetInput,
	EntityLinkInput,
	EntityListInput,
	EntityListLinksInput,
	EntityUnlinkInput,
	EntityUpdateInput,
	EntityUpdateLinkInput,
} from "@lobu/core/contracts/tools/manage-entity";
import type { Env } from "../../index";
import { manageEntity } from "../../tools/admin/manage_entity";
import type { ToolContext } from "../../tools/registry";
import { search } from "../../tools/search";
import { createActionCaller } from "./action-call";

export interface EntitiesNamespace {
	manage(input: Record<string, unknown>): Promise<unknown>;
	discoverDuplicates(input: EntityDiscoverDuplicatesInput): Promise<EntityDiscoverDuplicatesResult>;
	list(filter?: EntityListInput): Promise<unknown>;
	get(input: EntityGetInput): Promise<unknown>;
	create(input: EntityCreateInput): Promise<unknown>;
	update(input: EntityUpdateInput): Promise<unknown>;
	delete(input: EntityDeleteInput): Promise<unknown>;
	link(input: EntityLinkInput): Promise<unknown>;
	unlink(input: EntityUnlinkInput): Promise<unknown>;
	updateLink(input: EntityUpdateLinkInput): Promise<unknown>;
	listLinks(input: EntityListLinksInput): Promise<unknown>;
	search(query: string, options?: { limit?: number }): Promise<unknown>;
}

export function buildEntitiesNamespace(
	ctx: ToolContext,
	env: Env,
): EntitiesNamespace {
	const { manage, method } = createActionCaller(manageEntity, env, ctx, "entities");

	return {
		manage,
		discoverDuplicates: method("discover_duplicates"),
		list: method("list"),
		get: method("get"),
		create: method("create"),
		update: method("update"),
		delete: method("delete"),
		link: method("link"),
		unlink: method("unlink"),
		updateLink: method("update_link"),
		listLinks: method("list_links"),
		search(query, options) {
			return search(
				{ query, limit: options?.limit } as never,
				env,
				ctx,
			) as Promise<unknown>;
		},
	};
}
