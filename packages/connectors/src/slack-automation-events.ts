interface SlackMessageEvent {
	type?: string;
	channel?: string;
	user?: string;
	text?: string;
	bot_id?: string;
	subtype?: string;
	channel_type?: string;
	team?: string;
	thread_ts?: string;
	ts?: string;
}

interface SlackEventCallback {
	type?: string;
	team_id?: string;
	event?: SlackMessageEvent;
}

interface SlackUserMessageEvent extends SlackMessageEvent {
	channel: string;
	user: string;
}

function parseEventCallback(
	body: string,
	contentType: string,
): SlackEventCallback | null {
	// Slack uses form bodies for slash commands/interactivity. Those are a
	// different normalized event kind and must not be mistaken for messages.
	if (contentType.includes("application/x-www-form-urlencoded")) return null;
	try {
		const payload = JSON.parse(body) as SlackEventCallback;
		return payload.type === "event_callback" ? payload : null;
	} catch {
		return null;
	}
}

function isUserMessage(
	event: SlackMessageEvent,
): event is SlackUserMessageEvent {
	if (!event.channel || !event.user || event.bot_id || event.subtype)
		return false;
	return event.type === "app_mention" || event.type === "message";
}

/** Parse the mention/DM subset used by the unclaimed-workspace response. */
export function parseSlackUserMessageEvent(
	body: string,
	contentType: string,
): { channel: string; user: string } | null {
	const event = parseEventCallback(body, contentType)?.event;
	if (!event || !isUserMessage(event)) return null;
	const isMention = event.type === "app_mention";
	const isDirectMessage =
		event.type === "message" && event.channel_type === "im";
	if (!isMention && !isDirectMessage) return null;
	return { channel: event.channel, user: event.user };
}
