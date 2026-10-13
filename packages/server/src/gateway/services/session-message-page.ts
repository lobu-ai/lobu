import type { ParsedMessage, SessionEntry } from "@lobu/core";
import { entryToMessage, parseSessionEntries } from "@lobu/core";

/**
 * Attach each tool result to its call, by id. Transcripts store calls and
 * results as separate entries (`tool_use`/`toolCall` items carry the id,
 * `tool_result` entries carry it back), while every consumer renders one row
 * per call — without this the result has no row to live on and history shows
 * calls without outputs. Runs once over the parsed entries; entries without
 * a matching call keep flowing to their normal handling (verbose tool-result
 * rows are still stripped below when asked).
 */
function pairToolResults(entries: SessionEntry[]): SessionEntry[] {
	const results = new Map<string, unknown>();
	for (const entry of entries) {
		const message = entry.message as
			| { role?: unknown; content?: unknown; toolCallId?: unknown }
			| undefined;
		if (!message || typeof message !== "object") continue;
		if (message.role === "toolResult" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (!part || typeof part !== "object") continue;
				const toolUseId = (part as { tool_use_id?: unknown }).tool_use_id;
				if (typeof toolUseId === "string" && toolUseId) {
					results.set(toolUseId, (part as { content?: unknown }).content);
				}
			}
		}
		// Pi-style result rows carry the call id beside the content.
		if (
			(message.role === "toolResult" || message.role === "tool_result") &&
			typeof message.toolCallId === "string" &&
			message.toolCallId
		) {
			results.set(message.toolCallId, message.content);
		}
	}
	if (results.size === 0) return entries;
	return entries.map((entry) => {
		const message = entry.message;
		if (!message || !Array.isArray(message.content)) return entry;
		let changed = false;
		const content = (message.content as unknown[]).map((part: unknown) => {
			if (!part || typeof part !== "object") return part;
			const item = part as { type?: unknown; id?: unknown; result?: unknown };
			const key =
				(item.type === "tool_use" || item.type === "toolCall") &&
				typeof item.id === "string"
					? item.id
					: null;
			if (key == null || !results.has(key) || "result" in item) return part;
			changed = true;
			return { ...item, result: results.get(key) };
		});
		if (!changed) return entry;
		return { ...entry, message: { ...message, content } };
	});
}

export function paginateSessionMessages(
	content: string,
	cursorParam: string,
	limit: number,
	options?: {
		excludeVerbose?: boolean;
		sessionIdFallback?: string;
	},
): {
	messages: ParsedMessage[];
	nextCursor: string | null;
	hasMore: boolean;
	sessionId: string;
} {
	const { entries, sessionId } = parseSessionEntries(content);
	const paired = pairToolResults(entries);
	const allMessages: ParsedMessage[] = [];
	for (const entry of paired) {
		const msg = entryToMessage(entry);
		if (!msg) continue;
		if (options?.excludeVerbose && msg.isVerbose) continue;
		allMessages.push(msg);
	}

	let startIndex = 0;
	if (cursorParam) {
		const idx = allMessages.findIndex((m) => m.id === cursorParam);
		if (idx >= 0) startIndex = idx + 1;
	}

	const pageMessages = allMessages.slice(startIndex, startIndex + limit);
	const hasMore = startIndex + limit < allMessages.length;
	const nextCursor = hasMore ? pageMessages[pageMessages.length - 1]?.id : null;

	return {
		messages: pageMessages,
		nextCursor,
		hasMore,
		sessionId: sessionId || options?.sessionIdFallback || "unknown",
	};
}
