/**
 * ClientSDK `entities` namespace.
 *
 * Delegates to `manageEntity` with action-discriminated payloads. Per-call auth
 * checks fire inside the handler; this wrapper does not duplicate them.
 */

import type {
	EntityCreateInput,
	EntityCreateResult,
	EntityDeleteInput,
	EntityDeleteResult,
	EntityDiscoverDuplicatesInput,
	EntityDiscoverDuplicatesResult,
	EntityGetInput,
	EntityGetResult,
	EntityLinkInput,
	EntityLinkResult,
	EntityListInput,
	EntityListResult,
	EntityListLinksInput,
	EntityListLinksResult,
	EntityUnlinkInput,
	EntityUnlinkResult,
	EntityUpdateInput,
	EntityUpdateResult,
	EntityUpdateLinkInput,
	EntityUpdateLinkResult,
} from "@lobu/core/contracts/tools/manage-entity";
import type { Env } from "../../index";
import { manageEntity } from "../../tools/admin/manage_entity";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export interface EntitiesNamespace {
	discoverDuplicates(input: EntityDiscoverDuplicatesInput): Promise<EntityDiscoverDuplicatesResult>;
	list(filter?: EntityListInput): Promise<EntityListResult>;
	get(input: EntityGetInput): Promise<EntityGetResult>;
	create(input: EntityCreateInput): Promise<EntityCreateResult>;
	update(input: EntityUpdateInput): Promise<EntityUpdateResult>;
	delete(input: EntityDeleteInput): Promise<EntityDeleteResult>;
	link(input: EntityLinkInput): Promise<EntityLinkResult>;
	unlink(input: EntityUnlinkInput): Promise<EntityUnlinkResult>;
	updateLink(input: EntityUpdateLinkInput): Promise<EntityUpdateLinkResult>;
	listLinks(input: EntityListLinksInput): Promise<EntityListLinksResult>;
}

export function buildEntitiesNamespace(
	ctx: ToolContext,
	env: Env,
): EntitiesNamespace {
	const { method } = createActionCaller(manageEntity, env, ctx, "entities");

	return {
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
	};
}
