import { describe, expect, test } from "bun:test";
import { paginateSessionMessages } from "../services/session-message-page";

describe("session tool result pairing", () => {
	const result = [{ type: "text", text: '{"events_persisted":[{"id":42}]}' }];

	for (const type of ["toolCall", "tool_use"]) {
		test(`pairs ${type} results before pagination and verbose filtering`, () => {
			const call = { type, id: "call-1", name: "manage_automations" };
			const messages = [
				{ role: "assistant", content: [call] },
				{ role: "assistant", content: [{ type: "text", text: "Finished" }] },
				type === "toolCall"
					? { role: "toolResult", toolCallId: call.id, content: result }
					: { role: "toolResult", content: [{ type: "tool_result", tool_use_id: call.id, content: result }] },
			];
			const jsonl = messages.map((message, index) => JSON.stringify({
				type: "message", id: `m${index}`, message,
			})).join("\n");
			const page = paginateSessionMessages(jsonl, "", 1, { excludeVerbose: true });
			expect(page.messages[0]?.content).toEqual([{ ...call, result }]);
			expect(page.nextCursor).toBe("m0");
			const next = paginateSessionMessages(jsonl, page.nextCursor!, 1, { excludeVerbose: true });
			expect(next.messages.map((message) => message.id)).toEqual(["m1"]);
			expect(next.hasMore).toBe(false);
		});
	}

	test("keeps unmatched calls and inline results intact", () => {
		const calls = [
			{ type: "toolCall", id: "pending", name: "pending" },
			{ type: "toolCall", id: "inline", name: "done", result: "original" },
		];
		const jsonl = [
			{ type: "message", id: "m1", message: { role: "assistant", content: calls } },
			{ type: "message", id: "m2", message: { role: "toolResult", toolCallId: "inline", content: result } },
		].map((entry) => JSON.stringify(entry)).join("\n");
		expect(paginateSessionMessages(jsonl, "", 10, { excludeVerbose: true }).messages[0]?.content).toEqual(calls);
	});
});
