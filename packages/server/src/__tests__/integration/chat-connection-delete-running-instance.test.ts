/**
 * Deleting a chat connection that is RUNNING on this replica. Stopping the
 * instance shuts its Chat down, which disconnects that instance's state
 * adapter; the history cleanup that follows must not reuse it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ChatInstanceManager } from "../../gateway/connections/chat-instance-manager";
import { ConversationStateStore } from "../../gateway/connections/conversation-state-store";
import { createConnectedGatewayStateAdapter } from "../../gateway/connections/state-adapter";
import { cleanupTestDatabase } from "../setup/test-db";

const CONNECTION_ID = "synthetic-running-chat";

describe("conversation history clearing", () => {
	afterEach(cleanupTestDatabase);

	it("a session reset empties that conversation's history and leaves others", async () => {
		const store = new ConversationStateStore(await createConnectedGatewayStateAdapter());
		const entry = { role: "user" as const, content: "hello", timestamp: Date.now() };
		await store.appendHistory(CONNECTION_ID, "synthetic:channel", "synthetic:thread", entry);
		await store.appendHistory(CONNECTION_ID, "synthetic:channel", "synthetic:other", entry);

		await store.clearHistory(CONNECTION_ID, "synthetic:channel", "synthetic:thread");

		expect(await store.getHistory(CONNECTION_ID, "synthetic:channel", "synthetic:thread")).toEqual([]);
		expect(await store.getHistory(CONNECTION_ID, "synthetic:channel", "synthetic:other")).toHaveLength(1);
	});
});

describe("removeConnection on a running instance", () => {
	afterEach(cleanupTestDatabase);

	it("clears the connection's history after its instance shut down", async () => {
		const state = await createConnectedGatewayStateAdapter();
		const conversationState = new ConversationStateStore(state);
		await conversationState.appendHistory(CONNECTION_ID, "synthetic:channel", "synthetic:thread", {
			role: "user",
			content: "hello",
			timestamp: Date.now(),
		});

		const manager = new ChatInstanceManager();
		Object.assign(manager as unknown as Record<string, unknown>, {
			connectionStore: {
				getConnection: async () => null,
				deleteConnection: async () => undefined,
			},
			services: { getSecretStore: () => ({ list: async () => [], delete: async () => undefined }) },
			deleteClaimForConnection: async () => undefined,
		});
		(manager as unknown as { instances: Map<string, unknown> }).instances.set(CONNECTION_ID, {
			conversationState,
			// What a running instance's cleanup does: Chat.shutdown() disconnects
			// the instance's state adapter.
			cleanup: () => state.disconnect(),
		});

		await expect(manager.removeConnection(CONNECTION_ID)).resolves.toBeUndefined();

		const fresh = new ConversationStateStore(await createConnectedGatewayStateAdapter());
		expect(
			await fresh.getHistory(CONNECTION_ID, "synthetic:channel", "synthetic:thread"),
		).toEqual([]);
	});
});
