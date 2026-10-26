import { describe, expect, mock, test } from "bun:test";
import { InMemoryStateAdapter } from "../../__tests__/fixtures/in-memory-state-adapter.js";
import { telegramPlatform } from "../platforms/telegram.js";
import { scopeInboundClaimsToConnection } from "../state-adapter.js";
import type { PlatformConnection } from "../types.js";

describe("connection-scoped inbound state", () => {
  test("replicas share claims and locks, while other connections stay independent", async () => {
    const store = new InMemoryStateAdapter();
    const first = scopeInboundClaimsToConnection(store, "connection-one", "org-one");
    const replica = scopeInboundClaimsToConnection(store, "connection-one", "org-one");
    const second = scopeInboundClaimsToConnection(store, "connection-one", "org-two");
    const key = "dedupe:slack:123.456";
    expect(await first.setIfNotExists(key, true, 60_000)).toBe(true);
    expect(await replica.setIfNotExists(key, true, 60_000)).toBe(false);
    expect(await second.setIfNotExists(key, true, 60_000)).toBe(true);

    const thread = "slack:C_TEST:123.456";
    const lock = await first.acquireLock(thread, 60_000);
    expect(lock).not.toBeNull();
    expect(await replica.acquireLock(thread, 60_000)).toBeNull();
    const secondLock = await second.acquireLock(thread, 60_000);
    expect(secondLock).not.toBeNull();
    expect(await replica.extendLock(lock!, 60_000)).toBe(true);
    await second.forceReleaseLock(thread);
    expect(await replica.acquireLock(thread, 60_000)).toBeNull();
    await replica.releaseLock(lock!);
    expect(await first.acquireLock(thread, 60_000)).not.toBeNull();

    await first.set("session:shared", { value: "shared" });
    expect(await store.get("session:shared")).toEqual({ value: "shared" });
    await first.subscribe(thread);
    expect(await second.isSubscribed(thread)).toBe(true);
  });

  test("Telegram media groups keep each connection's buffer under its own lock", async () => {
    const store = new InMemoryStateAdapter();
    const create = async (organizationId: string) => {
      const id = "shared-connection-slug";
      const adapter = await telegramPlatform.createAdapter(
        { botToken: "test-token", userName: "test-bot", mode: "webhook" },
        { connection: { id, organizationId } as PlatformConnection },
      );
      adapter.telegramFetch = mock(async () => ({ id: 42, username: "test_bot" }));
      const delivered = mock(async (
        _adapter: unknown, _thread: string, _message: { attachments: unknown[] },
      ) => {});
      await adapter.initialize({
        getState: () => scopeInboundClaimsToConnection(store, id, organizationId),
        processMessage: delivered,
      });
      return { adapter, delivered };
    };
    const first = await create("org-one");
    const second = await create("org-two");
    const message = (fileId: string) => ({
      message_id: 1,
      date: 1_700_000_000,
      chat: { id: -100123, type: "supergroup" },
      from: { id: 123, first_name: "Test" },
      media_group_id: "shared-album",
      photo: [{ file_id: fileId, file_unique_id: fileId, width: 10, height: 10 }],
    });
    await Promise.all([
      first.adapter.processIncomingMediaGroup(message("first-file"), "telegram:-100123"),
      second.adapter.processIncomingMediaGroup(message("second-file"), "telegram:-100123"),
    ]);
    for (const { delivered } of [first, second]) {
      expect(delivered).toHaveBeenCalledTimes(1);
      expect(delivered.mock.calls[0]![2].attachments).toHaveLength(1);
    }
  });
});
