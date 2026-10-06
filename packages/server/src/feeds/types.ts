// Shape returned by manage_feeds(action='list_feeds'). A projection of the
// `feeds` table into the camelCase the frontend consumes.

export type FeedOperation = "sync" | "read";
export type FeedStore = "events" | "channel_messages";
export type FeedStatus = "active" | "paused" | "error";

export interface FeedSpec {
	/** `feeds.id`, stringified (bigint). */
	id: string;
	/** `feeds.feed_key` — for a channel-message feed this is the channel id. */
	feedKey: string;
	operations: FeedOperation[];
	store: FeedStore;
	connectionId: string;
	/** `display_name`, falling back to `feed_key`. */
	label: string;
	status: FeedStatus;
	/** ISO timestamp of the last sync, or null. */
	lastSyncAt: string | null;
	itemsCollected: number;
	/** For a channel-message feed, the agent bound to its channel (if any). */
	targetAgentId?: string | null;
}
