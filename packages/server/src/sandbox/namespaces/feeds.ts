/**
 * ClientSDK `feeds` namespace. Thin wrapper over `manageFeeds`.
 *
 * `create_feed` requires `feed_key` — the connector-declared identifier for the
 * data surface this feed will sync.
 */

import type {
	FeedCreateInput,
	FeedDeleteInput,
	FeedListInput,
	FeedReadInput,
	FeedReadManyInput,
	FeedRecollectInput,
	FeedTriggerInput,
	FeedUpdateInput,
} from "@lobu/core/contracts/tools/manage-feeds";
import type { Env } from "../../index";
import { manageFeeds } from "../../tools/admin/manage_feeds";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export interface FeedsNamespace {
	manage(input: Record<string, unknown>): Promise<unknown>;
	list(input?: FeedListInput): Promise<unknown>;
	get(input: FeedReadInput): Promise<unknown>;
	readMany(input: FeedReadManyInput): Promise<unknown>;
	create(input: FeedCreateInput): Promise<unknown>;
	update(input: FeedUpdateInput): Promise<unknown>;
	delete(input: FeedDeleteInput): Promise<unknown>;
	trigger(input: FeedTriggerInput): Promise<unknown>;
	recollect(input: FeedRecollectInput): Promise<unknown>;
}

export function buildFeedsNamespace(
	ctx: ToolContext,
	env: Env,
): FeedsNamespace {
	const { manage, method } = createActionCaller(manageFeeds, env, ctx, "feeds");

	return {
		manage,
		list: method("list_feeds", { publicMethod: "list" }),
		get: method("read_feed", { publicMethod: "get" }),
		readMany: method("read_feeds", { publicMethod: "readMany" }),
		create: method("create_feed", { publicMethod: "create" }),
		update: method("update_feed", { publicMethod: "update" }),
		delete: method("delete_feed", { publicMethod: "delete" }),
		trigger: method("trigger_feed", { publicMethod: "trigger" }),
		recollect: method("recollect_feed", { publicMethod: "recollect" }),
	};
}
