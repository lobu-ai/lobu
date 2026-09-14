/**
 * The bridge's auto-bind fallback: an unlinked DM to a connection with NO owning
 * agent (the OAuth-install shape) binds itself to the org's only agent instead
 * of answering with instructions.
 *
 * `resolveSoleOrgAgent` reads the database, so it is mocked here and the module
 * is imported after — what it decides from real rows is pinned separately by
 * `__tests__/integration/preview/auto-bind-dm.test.ts`. These cases pin the
 * conditions the bridge applies around it, which is where the DM-only and
 * hosted-relay guards live.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { PlatformConnection } from "../connections/types.js";
import { InMemoryStateAdapter } from "./fixtures/in-memory-state-adapter.js";

let soleAgent: string | null = "sole-agent";
const resolveSoleOrgAgent = mock(async () => soleAgent);
mock.module("../connections/auto-bind-agent.js", () => ({
	resolveSoleOrgAgent,
}));

const { MessageHandlerBridge } = await import(
	"../connections/message-handler-bridge.js"
);
const { ConversationStateStore } = await import(
	"../connections/conversation-state-store.js"
);

const CONN_ID = "conn-autobind";
const CHANNEL_ID = "D900";
const ORG_ID = "org-tenant";

const automationCooldown = {
	claim: async () => true,
	markZero: async () => true,
} as never;

function makeHarness(opts: {
	previewMode?: boolean;
	/** The connection's owning agent; OAuth installs have none. */
	agentId?: string;
}) {
	const conversationState = new ConversationStateStore(
		new InMemoryStateAdapter(),
	);
	const connection: PlatformConnection = {
		id: CONN_ID,
		platform: "gchat",
		agentId: opts.agentId,
		organizationId: ORG_ID,
		config: { platform: "gchat" } as never,
		settings: { allowGroups: true, previewMode: opts.previewMode ?? false },
		metadata: { botUsername: "lobu", botUserId: "U_BOT" },
		status: "active",
		createdAt: 1,
		updatedAt: 1,
	};
	const enqueueMessage = mock(async () => undefined);
	const materializeConnectionFallbackLink = mock(async () => true);
	const services = {
		getArtifactStore: () => null,
		getPublicGatewayUrl: () => "https://gateway.example.com",
		getAutomationSubscriptionService: () => ({
			resolveForConnection: mock(async () => null),
			healSubscriptionTeam: mock(async () => undefined),
			channelHasMessageSubscription: mock(async () => false),
			materializeConnectionFallbackLink,
		}),
		getAgentMetadataStore: () => undefined,
		getUserAgentsStore: () => undefined,
		getTranscriptionService: () => undefined,
		getAgentSettingsStore: () => undefined,
		getDeclaredAgentRegistry: () => undefined,
		getQueueProducer: () => ({ enqueueMessage }),
		getProviderCatalogService: () => undefined,
	} as never;
	const manager = {
		has: () => true,
		getInstance: () => ({ connection, conversationState }),
	} as never;
	const bridge = new MessageHandlerBridge(
		connection,
		services,
		manager,
		undefined as never,
		async ({ signal }: { signal: unknown }) => ({
			signal,
			replyTargets: [],
			backgroundTargets: [],
		}),
		automationCooldown,
	);
	return { bridge, enqueueMessage, materializeConnectionFallbackLink };
}

function makeThread() {
	return {
		id: `gchat:${CHANNEL_ID}`,
		channelId: CHANNEL_ID,
		adapter: undefined,
		subscribe: mock(async () => undefined),
		post: mock(async () => undefined),
		startTyping: mock(async () => undefined),
	};
}

function makeMessage() {
	return {
		id: "M1",
		text: "hi",
		author: {
			userId: "U_USER",
			userName: "alice",
			fullName: "Alice",
			isBot: false,
			isMe: false,
		},
		raw: {},
		attachments: [],
		metadata: { dateSent: new Date(), edited: false },
	};
}

describe("unlinked DM auto-bind", () => {
	beforeEach(() => {
		soleAgent = "sole-agent";
		resolveSoleOrgAgent.mockClear();
	});

	test("binds the DM to the org's only agent and answers the message", async () => {
		const { bridge, enqueueMessage, materializeConnectionFallbackLink } =
			makeHarness({ agentId: undefined });
		const thread = makeThread();

		await bridge.handleMessage(thread, makeMessage(), "dm");

		// The Automation is written...
		expect(materializeConnectionFallbackLink).toHaveBeenCalledTimes(1);
		expect(materializeConnectionFallbackLink.mock.calls[0]?.[2]).toBe(
			"sole-agent",
		);
		// ...and the message that triggered it is answered, not dropped: a person
		// who says "hi" must get a reply to THAT message, not to their next one.
		expect(enqueueMessage).toHaveBeenCalledTimes(1);
		// No notice — binding replaces it.
		expect(thread.post).not.toHaveBeenCalled();
	});

	test("does NOT auto-bind a group channel", async () => {
		// The trigger it would write matches every `message.created` on the
		// channel, so auto-binding a shared channel would make the bot answer
		// everything in it. A human picks the agent there, via the notice.
		const { bridge, enqueueMessage, materializeConnectionFallbackLink } =
			makeHarness({ agentId: undefined });
		const thread = makeThread();

		await bridge.handleMessage(thread, makeMessage(), "mention");

		expect(materializeConnectionFallbackLink).not.toHaveBeenCalled();
		expect(enqueueMessage).not.toHaveBeenCalled();
	});

	test("does NOT auto-bind through a hosted relay", async () => {
		// A previewMode connection's org is not the sender's, so binding the
		// sender's DM into it would hand a stranger that org's agent.
		const { bridge, materializeConnectionFallbackLink } = makeHarness({
			agentId: undefined,
			previewMode: true,
		});

		await bridge.handleMessage(makeThread(), makeMessage(), "dm");

		expect(materializeConnectionFallbackLink).not.toHaveBeenCalled();
		expect(resolveSoleOrgAgent).not.toHaveBeenCalled();
	});

	test("does NOT auto-bind when the connection already has an owning agent", async () => {
		// The owning agent already answers; there is no dead end to rescue, and
		// asking the database would be wasted work on the message hot path.
		const { bridge, enqueueMessage } = makeHarness({ agentId: "owner-agent" });

		await bridge.handleMessage(makeThread(), makeMessage(), "dm");

		expect(resolveSoleOrgAgent).not.toHaveBeenCalled();
		expect(enqueueMessage).toHaveBeenCalledTimes(1);
	});

	test("falls through to the notice when the org's agent is ambiguous", async () => {
		soleAgent = null;
		const { bridge, enqueueMessage, materializeConnectionFallbackLink } =
			makeHarness({ agentId: undefined });
		const thread = makeThread();

		await bridge.handleMessage(thread, makeMessage(), "dm");

		expect(materializeConnectionFallbackLink).not.toHaveBeenCalled();
		expect(enqueueMessage).not.toHaveBeenCalled();
		expect(thread.post).toHaveBeenCalledTimes(1);
	});
});
