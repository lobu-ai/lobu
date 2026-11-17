import { createLogger, getErrorMessage } from "@lobu/core";
import type { AutomationTrigger } from "@lobu/core/contracts/tools/manage-automations";
import type { DbClient } from "../db/client";
import {
	resolveChannelFeedId,
	softDeleteChannelFeed,
} from "../gateway/channels/channel-feed";

const logger = createLogger("automation-channel-feeds");

interface ChannelSubscriptionRef {
	connectionId: number;
	channelKey: string;
}

function channelSubscriptions(
	triggers: AutomationTrigger[],
): ChannelSubscriptionRef[] {
	const refs: ChannelSubscriptionRef[] = [];
	for (const trigger of triggers) {
		if (
			trigger.kind !== "event" ||
			trigger.source === "workspace" ||
			trigger.connection_id == null ||
			!trigger.event_types.includes("message.created")
		) {
			continue;
		}
		const nativeChannelId = trigger.match?.channel_id;
		if (typeof nativeChannelId !== "string" || !nativeChannelId.trim()) continue;
		refs.push({
			connectionId: trigger.connection_id,
			channelKey: `${trigger.connector_key}:${nativeChannelId.trim()}`,
		});
	}
	return refs;
}

function key(ref: ChannelSubscriptionRef): string {
	return `${ref.connectionId}:${ref.channelKey}`;
}

/** Keep channel-feed projections aligned with canonical Automation triggers. */
export async function syncAutomationChannelFeeds(args: {
	organizationId: string;
	before?: AutomationTrigger[];
	after?: AutomationTrigger[];
	sql: DbClient;
}): Promise<void> {
	const before = channelSubscriptions(args.before ?? []);
	const after = channelSubscriptions(args.after ?? []);
	const beforeKeys = new Set(before.map(key));
	const afterKeys = new Set(after.map(key));

	for (const ref of after) {
		if (beforeKeys.has(key(ref))) continue;
		await resolveChannelFeedId({
			connectionId: String(ref.connectionId),
			organizationId: args.organizationId,
			channelKey: ref.channelKey,
			sql: args.sql,
		});
	}

	for (const ref of before) {
		if (afterKeys.has(key(ref))) continue;
		const remaining = await args.sql`
			SELECT 1
			FROM automation_message_subscriptions
			WHERE connection_id = ${ref.connectionId}
			  AND channel_id = ${ref.channelKey}
			LIMIT 1
		`;
		if (remaining.length > 0) continue;
		await softDeleteChannelFeed({
			connectionId: String(ref.connectionId),
			channelKey: ref.channelKey,
			sql: args.sql,
		});
	}
}

/** Reconcile the derived feed projection without failing an already-committed Automation write. */
export async function syncAutomationChannelFeedsBestEffort(
	args: Parameters<typeof syncAutomationChannelFeeds>[0],
): Promise<void> {
	try {
		await syncAutomationChannelFeeds(args);
	} catch (error) {
		logger.warn(
			{ error: getErrorMessage(error) },
			"Failed to reconcile channel feeds",
		);
	}
}
