/**
 * Assembled chat-ingress harness shared by the platform e2e suites.
 *
 * Callers build a real Chat SDK `Chat` around a real platform adapter whose
 * outbound HTTP methods they stub (the external boundary). This harness wires
 * the rest of the production path behind it: `registerMessageHandlers`, the
 * channel subscription reader, the Automation planner, the conversation state
 * store, and the Postgres run queue. Assertions then read `runs`,
 * `channel_messages`, and `automations` — observable outputs, not internals.
 */
import type { Chat, StateAdapter } from "chat";
import { AutomationSubscriptionService } from "../../channels/automation-subscription-service.js";
import { ConversationStateStore } from "../../connections/conversation-state-store.js";
import { type MessageHandlerBridge, registerMessageHandlers } from "../../connections/message-handler-bridge.js";
import type { PlatformConnection } from "../../connections/types.js";
import { QueueProducer } from "../../infrastructure/queue/queue-producer.js";
import { RunsQueue } from "../../infrastructure/queue/runs-queue.js";

/** Poll an assertion until it passes or `timeoutMs` elapses. */
export async function waitFor(
  check: () => void | Promise<void>,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

interface ChatBridgeInstance {
  connection: PlatformConnection;
  conversationState: ConversationStateStore;
  chat: Chat;
  /** The registered bridge; interaction clicks enter through it. */
  messageBridge?: MessageHandlerBridge;
}

export interface AssembledChatBridge {
  /**
   * The connection registry the bridge reads; also satisfies what
   * `ChatResponseBridge` needs to render a completion on this "replica".
   */
  manager: {
    has(connectionId: string): boolean;
    getInstance(connectionId: string): ChatBridgeInstance | undefined;
    warmConnection(connectionId: string): Promise<boolean>;
    getPublicGatewayUrl(): string;
  };
  /** Register another connection's Chat instance on the same queue. */
  attach(chat: Chat, state: StateAdapter, connection: PlatformConnection): void;
  stop(): Promise<void>;
}

/**
 * Start the shared run queue and register the bridge for one connection.
 * Further connections (a second installation on another replica-shared
 * state store, say) join through `attach`.
 */
export async function startAssembledChatBridge(
  chat: Chat,
  state: StateAdapter,
  connection: PlatformConnection,
): Promise<AssembledChatBridge> {
  const queue = new RunsQueue();
  await queue.start();
  const producer = new QueueProducer(queue);
  await producer.start();

  const instances = new Map<string, ChatBridgeInstance>();
  const chats: Chat[] = [];
  const subscriptions = new AutomationSubscriptionService();
  const manager = {
    has: (connectionId: string) => instances.has(connectionId),
    getInstance: (connectionId: string) => instances.get(connectionId),
    warmConnection: async (connectionId: string) => instances.has(connectionId),
    getPublicGatewayUrl: () => "https://gateway.example.test",
  };
  const services = {
    getArtifactStore: () => null,
    getPublicGatewayUrl: () => "https://gateway.example.test",
    getAutomationSubscriptionService: () => subscriptions,
    getAgentMetadataStore: () => undefined,
    getUserAgentsStore: () => undefined,
    getTranscriptionService: () => undefined,
    getAgentSettingsStore: () => undefined,
    getDeclaredAgentRegistry: () => undefined,
    getProviderCatalogService: () => undefined,
    getQueueProducer: () => producer,
  };

  const attach = (
    nextChat: Chat,
    nextState: StateAdapter,
    nextConnection: PlatformConnection,
  ) => {
    const instance: ChatBridgeInstance = {
      connection: nextConnection,
      conversationState: new ConversationStateStore(nextState),
      chat: nextChat,
    };
    instances.set(nextConnection.id, instance);
    chats.push(nextChat);
    instance.messageBridge = registerMessageHandlers(
      nextChat,
      nextConnection,
      services as never,
      manager as never,
    );
  };
  attach(chat, state, connection);

  return {
    manager,
    attach,
    stop: async () => {
      for (const registered of chats) await registered.shutdown();
      await queue.stop();
    },
  };
}
