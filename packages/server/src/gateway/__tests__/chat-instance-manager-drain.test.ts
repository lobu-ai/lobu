import { describe, expect, mock, test } from "bun:test";
import { ChatInstanceManager } from "../connections/chat-instance-manager.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type WebhookOptions = { waitUntil(task: Promise<unknown>): void };

function managerWithWebhook(handle: (options: WebhookOptions) => void) {
  const manager = new ChatInstanceManager() as any;
  const cleanup = mock(async () => {});
  manager.resolveStored = async () => null;
  manager.ensureConnectionRunning = async () => true;
  manager.instances.set("conn-drain", {
    connection: { id: "conn-drain", platform: "slack" },
    chat: {
      webhooks: {
        slack: async (_request: Request, options: WebhookOptions) => {
          handle(options);
          return new Response("ok");
        },
      },
    },
    cleanup,
  });
  return { manager, cleanup };
}

const request = () => new Request("https://gateway.example.com/webhook");

describe("ChatInstanceManager webhook drain", () => {
  test("waits for tasks registered by an already-acked task during shutdown", async () => {
    const setup = deferred();
    const message = deferred();
    const registered = deferred();
    const { manager, cleanup } = managerWithWebhook(({ waitUntil }) => {
      // Slack reaction lookup registers handler dispatch after its async setup.
      waitUntil(
        setup.promise.then(() => {
          waitUntil(message.promise);
          registered.resolve();
        }),
      );
    });
    expect((await manager.handleWebhook("conn-drain", request())).status).toBe(200);
    const shutdown = manager.shutdown();
    try {
      setup.resolve();
      await registered.promise;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(cleanup).not.toHaveBeenCalled();
    } finally {
      message.resolve();
      await shutdown;
    }
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(manager.webhookTasks.size).toBe(0);
  });

  test("a rejected task does not skip cleanup", async () => {
    const { manager, cleanup } = managerWithWebhook(({ waitUntil }) => {
      waitUntil(Promise.reject(new Error("synthetic handler failure")));
    });
    await manager.handleWebhook("conn-drain", request());
    await manager.shutdown();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(manager.webhookTasks.size).toBe(0);
  });

  test("a stuck task is bounded by the drain budget", async () => {
    const message = deferred();
    const { manager, cleanup } = managerWithWebhook(({ waitUntil }) => {
      waitUntil(message.promise);
    });
    manager.webhookDrainTimeoutMs = 50;
    await manager.handleWebhook("conn-drain", request());
    const shutdown = manager.shutdown();
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(cleanup).not.toHaveBeenCalled();
      await shutdown;
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(manager.webhookTasks.size).toBe(1);
    } finally {
      message.resolve();
      await shutdown;
    }
  });
});
