import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Chat } from "chat";
import { getDb } from "../../../db/client.js";
import {
  createConnectedGatewayStateAdapter,
  createGatewayStateAdapter,
} from "../state-adapter.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `${process.pid}-${Date.now()}`;
const cacheKeys = new Set<string>();

function key(name: string): string {
  const cacheKey = `test:expiry-reclaim:${name}:${suffix}`;
  cacheKeys.add(cacheKey);
  return cacheKey;
}

const adapters: Array<{ disconnect(): Promise<void> }> = [];

async function connect() {
  const adapter = await createConnectedGatewayStateAdapter();
  adapters.push(adapter);
  return adapter;
}

afterEach(async () => {
  if (!hasDb) return;
  const sql = getDb();
  for (const cacheKey of cacheKeys) {
    await sql`
      DELETE FROM chat_state_cache
      WHERE key_prefix = 'chat-conn' AND cache_key = ${cacheKey}
    `;
  }
  cacheKeys.clear();
});

afterAll(async () => {
  for (const adapter of adapters) await adapter.disconnect();
});

describe("LobuStateAdapter.setIfNotExists expiry semantics", () => {
  test.skipIf(!hasDb)("reclaims an expired key", async () => {
    const adapter = await connect();
    const k = key("expired");

    // 🚨 Do NOT assert `get()` before the claim. `get` opportunistically DELETES
    // an expired row on miss, which removes the condition under test and makes
    // this pass against the unfixed code. The bug only surfaces on a claim path
    // that never reads first — exactly what the SDK's dedupe does.
    await adapter.set(k, "stale", -1000);
    expect(await adapter.setIfNotExists(k, "fresh", 60_000)).toBe(true);
    expect(await adapter.get(k)).toBe("fresh");
  });

  test.skipIf(!hasDb)("preserves a live key", async () => {
    const adapter = await connect();
    const k = key("live");

    expect(await adapter.setIfNotExists(k, "first", 60_000)).toBe(true);
    expect(await adapter.setIfNotExists(k, "second", 60_000)).toBe(false);
    expect(await adapter.get(k)).toBe("first");
  });

  test.skipIf(!hasDb)("preserves a non-expiring key", async () => {
    const adapter = await connect();
    const k = key("no-ttl");

    await adapter.set(k, "permanent");
    expect(await adapter.setIfNotExists(k, "usurper", 60_000)).toBe(false);
    expect(await adapter.get(k)).toBe("permanent");
  });

  test.skipIf(!hasDb)(
    "an expired claim is reclaimable repeatedly, not just once",
    async () => {
      const adapter = await connect();
      const k = key("repeat");

      await adapter.set(k, "gen1", -1000);
      expect(await adapter.setIfNotExists(k, "gen2", -1000)).toBe(true);
      expect(await adapter.setIfNotExists(k, "gen3", 60_000)).toBe(true);
      expect(await adapter.get(k)).toBe("gen3");
    },
  );

  test.skipIf(!hasDb)("only one concurrent caller reclaims an expired key", async () => {
    const adapter = await connect();
    const k = key("concurrent");
    await adapter.set(k, "stale", -1000);

    const claims = await Promise.all(
      ["first", "second"].map(async (value) => ({
        value,
        claimed: await adapter.setIfNotExists(k, value, 60_000),
      })),
    );
    const winner = claims.filter(({ claimed }) => claimed);

    expect(winner).toHaveLength(1);
    expect(await adapter.get(k)).toBe(winner[0]!.value);
  });
});

describe("Chat SDK inbound dedupe over the Postgres adapter", () => {
  function createAdapter() {
    return {
      name: "test",
      userName: "lobubot",
      async initialize() {},
      isDM: () => true,
      channelIdFromThreadId: (threadId: string) => threadId,
      getChannelVisibility: () => "private" as const,
    };
  }

  function createMessage(id: string, text: string) {
    return {
      id,
      text,
      author: {
        userId: "42",
        userName: "human",
        fullName: "Human",
        isBot: false,
        isMe: false,
      },
      isMention: false,
    };
  }

  test.skipIf(!hasDb)(
    "a stale dedupe row no longer swallows a replayed message id",
    async () => {
      const state = await connect();
      const messageId = `mid-${suffix}`;
      const dedupeKey = `dedupe:test:${messageId}`;
      const threadId = `test:dm-${suffix}`;
      const delivered: string[] = [];
      cacheKeys.add(dedupeKey);

      const adapter = createAdapter();
      const chat = new Chat({
        userName: "lobubot",
        adapters: { test: adapter as never },
        state: state as never,
        logger: "silent",
      });
      chat.onDirectMessage(async (_t: unknown, m: { text: string }) => {
        delivered.push(m.text);
      });
      await chat.initialize();

      const dispatch = async (text: string) => {
        let processing: Promise<void> | undefined;
        chat.processMessage(adapter as never, threadId, createMessage(messageId, text) as never, {
          waitUntil(task) {
            processing = task;
          },
        });
        if (!processing) throw new Error("SDK registered no background task");
        await processing;
      };

      await dispatch("first");
      expect(delivered).toEqual(["first"]);

      await dispatch("redelivery");
      expect(delivered).toEqual(["first"]);

      const sql = getDb();
      await sql`
        UPDATE chat_state_cache
        SET expires_at = now() - interval '1 hour'
        WHERE key_prefix = 'chat-conn' AND cache_key = ${dedupeKey}
      `;

      await dispatch("after expiry");
      expect(delivered).toEqual(["first", "after expiry"]);
      await chat.shutdown();
    },
  );
});

// chat-instance-manager builds fresh adapters for off-instance paths such as
// removeConnection history cleanup; an unconnected one throws on the first
// store op and aborts BYO chat delete before the row is soft-deleted.
describe("state adapter connect gate", () => {
  test.skipIf(!hasDb)("an unconnected adapter rejects store ops with a clear error", async () => {
    const adapter = createGatewayStateAdapter();
    await expect(adapter.get("any-key")).rejects.toThrow(/LobuStateAdapter is not connected/);
  });

  test.skipIf(!hasDb)("createConnectedGatewayStateAdapter passes the connect gate", async () => {
    const adapter = await connect();
    await expect(adapter.get(key("missing-after-connect"))).resolves.toBeNull();
  });
});
