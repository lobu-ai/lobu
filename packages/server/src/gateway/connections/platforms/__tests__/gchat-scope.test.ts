import { describe, expect, test } from "bun:test";
import { Chat } from "chat";
import { InMemoryStateAdapter } from "../../../__tests__/fixtures/in-memory-state-adapter.js";
import { gchatPlatform } from "../gchat.js";
import { googleChatEventSpace, scopeGoogleChatAdapter } from "../gchat-scope.js";
import type { ChatRuntimeConfig } from "../types.js";

const space = "spaces/installed";
const config = {
  platform: "gchat" as const,
  credentials: JSON.stringify({ client_email: "bot@example.test", private_key: "test-key" }),
  googleChatProjectNumber: "123456789",
};
const runtime: ChatRuntimeConfig = { config, revision: "initial", scope: space, stateKey: "test-installation" };

async function fixture() {
  let next = runtime;
  let revoked = false;
  const calls: string[] = [];
  const create = async (current: ChatRuntimeConfig) => {
    const adapter: any = await gchatPlatform.createAdapter(current.config);
    adapter.verifyDirectWebhookToken = async (request: Request) => request.headers.get("authorization") === "Bearer verified";
    adapter.chatApi.spaces.messages.create = async ({ parent }: any) => {
      calls.push(`${current.revision}:${parent}`);
      return { data: { name: `${parent}/messages/test` } };
    };
    adapter.chatApi.media.download = async ({ resourceName }: any) => {
      calls.push(`${current.revision}:${resourceName}`);
      return { data: Buffer.from("attachment") };
    };
    return adapter;
  };
  const base = await create(runtime);
  const adapter: any = scopeGoogleChatAdapter(base, {
    ...runtime, refresh: async () => {
      if (revoked) throw new Error("revoked");
      return next;
    },
  }, create);
  return { adapter, calls, base,
    rotate: () => { next = { ...runtime, revision: "rotated" }; },
    revoke: () => { revoked = true; },
  };
}

describe("Google Chat installed space isolation", () => {
  test("an installed Google Chat space cannot post into another space", async () => {
    const { adapter, calls } = await fixture();
    await expect(adapter.postChannelMessage("gchat:spaces/foreign", "hello")).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  for (const method of ["postMessage", "postEphemeral", "fetchMessages", "fetchThread", "onThreadSubscribe", "startTyping"]) {
    test(`${method} rejects foreign, malformed and mismatched nested threads`, async () => {
      const { adapter, calls, base } = await fixture();
      const valid = base.encodeThreadId({ spaceName: space });
      for (const id of ["gchat:spaces/foreign", `${valid}:extra:segment`,
        base.encodeThreadId({ spaceName: space, threadName: "spaces/foreign/threads/thread" }),
        base.encodeThreadId({ spaceName: space, threadName: `${space}/messages/../threads/thread` })]) {
        await expect(adapter[method](id, "hello")).rejects.toThrow();
      }
      expect(calls).toEqual([]);
    });
  }
  for (const method of ["editMessage", "deleteMessage", "addReaction", "removeReaction"]) {
    test(`${method} checks message and thread independently`, async () => {
      const { adapter, calls } = await fixture();
      for (const name of ["spaces/foreign/messages/id", `${space}/messages/%2fother`, `${space}/messages/..`]) {
        await expect(adapter[method](`gchat:${space}`, name, "hello")).rejects.toThrow();
      }
      await expect(adapter[method]("gchat:spaces/foreign", `${space}/messages/id`, "hello")).rejects.toThrow();
      expect(calls).toEqual([]);
    });
  }
  for (const method of ["postChannelMessage", "fetchChannelMessages", "fetchChannelInfo", "listThreads"]) {
    test(`${method} rejects foreign channels`, async () => {
      const { adapter, calls } = await fixture();
      await expect(adapter[method]("gchat:spaces/foreign", "hello")).rejects.toThrow();
      expect(calls).toEqual([]);
    });
  }
  test("retained SDK handles refresh after rotation and stop after revocation", async () => {
    const f = await fixture();
    const chat = new Chat({ userName: "lobu", adapters: { gchat: f.adapter }, state: new InMemoryStateAdapter() });
    await chat.initialize();
    const retained = chat.channel(`gchat:${space}`);
    await retained.post("first");
    f.rotate();
    await retained.post("second");
    expect(f.calls).toEqual([`initial:${space}`, `rotated:${space}`]);
    f.revoke();
    await expect(retained.post("third")).rejects.toThrow("revoked");
    expect(f.calls).toHaveLength(2);
    await chat.shutdown();
  });
  test("attachment closures refresh and cannot download another space", async () => {
    const f = await fixture();
    const attachment = f.adapter.rehydrateAttachment({ type: "file", fetchMetadata: { resourceName: `${space}/messages/id/attachments/file` } });
    f.rotate();
    expect(await attachment.fetchData()).toEqual(Buffer.from("attachment"));
    expect(f.calls).toEqual([`rotated:${space}/messages/id/attachments/file`]);
    f.revoke();
    await expect(attachment.fetchData()).rejects.toThrow("revoked");
    expect(() => f.adapter.rehydrateAttachment({ fetchMetadata: { resourceName: "spaces/foreign/messages/id/attachments/file" } })).toThrow();
    expect(f.adapter.rehydrateAttachment({ type: "file", fetchData: async () => Buffer.from("unsafe") }).fetchData).toBeUndefined();
  });
  test("does not expose the raw API or open unrestricted DMs", async () => {
    const { adapter, calls } = await fixture();
    expect(adapter.chatApi).toBeUndefined();
    expect(adapter.credentials).toBeUndefined();
    await expect(adapter.openDM("users/other")).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(gchatPlatform.canOpenDirectMessage!({ impersonateUser: "owner@example.test" }, { credentialMode: "managed" })).toBe(false);
    expect(gchatPlatform.canOpenDirectMessage!({ impersonateUser: "owner@example.test" }, { credentialMode: "byo" })).toBe(true);
  });
  test("attachment downloads retain their validated resource after metadata mutation", async () => {
    const f = await fixture();
    const resourceName = `${space}/messages/id/attachments/file`;
    const input = { type: "file", fetchMetadata: { resourceName } };
    const attachment = f.adapter.rehydrateAttachment(input);
    attachment.fetchMetadata.resourceName = "spaces/foreign/messages/id/attachments/file";
    f.rotate();
    expect(await attachment.fetchData()).toEqual(Buffer.from("attachment"));
    expect(f.calls).toEqual([`rotated:${resourceName}`]);
  });
  test("attachments returned by listThreads cannot retain an unguarded download", async () => {
    const f = await fixture();
    const resourceName = `${space}/messages/root/attachments/file`;
    f.base.listThreads = async () => ({ threads: [{
      id: f.base.encodeThreadId({ spaceName: space, threadName: `${space}/threads/root` }),
      rootMessage: { id: `${space}/messages/root`, attachments: [f.base.rehydrateAttachment({ type: "file", fetchMetadata: { resourceName } })] },
    }] });
    const result = await f.adapter.listThreads(`gchat:${space}`);
    const attachment = result.threads[0].rootMessage.attachments[0];
    f.revoke();
    await expect(attachment.fetchData()).rejects.toThrow("revoked");
    expect(f.calls).toEqual([]);
  });
  test("verified inbound messages create scoped reply handles", async () => {
    const f = await fixture();
    const chat = new Chat({ userName: "lobu", adapters: { gchat: f.adapter }, state: new InMemoryStateAdapter() });
    const replies: string[] = [];
    chat.onDirectMessage(async (thread, message) => {
      replies.push(message.text);
      await thread.post("reply");
    });
    const user = { name: "users/test", displayName: "Test User", type: "HUMAN" };
    const tasks: Promise<unknown>[] = [];
    const response = await chat.webhooks.gchat(new Request("https://gateway.test/webhook", {
      method: "POST", headers: { authorization: "Bearer verified" }, body: JSON.stringify({
        type: "MESSAGE", space: { name: space, type: "DM" }, user,
        message: { name: `${space}/messages/inbound`, text: "hello", sender: user, createTime: "2026-09-01T12:00:00Z" },
      }),
    }), { waitUntil: (task) => tasks.push(task) });
    await Promise.all(tasks);
    expect(response.status).toBe(200);
    expect(replies).toEqual(["hello"]);
    expect(f.calls).toEqual([`initial:${space}`]);
    await chat.shutdown();
  });
  test("adapter user caches are separated from the source", async () => {
    const f = await fixture();
    const state = new InMemoryStateAdapter();
    await state.set("gchat:user:users/123", { email: "personal@example.test" });
    const chat = new Chat({ userName: "lobu", adapters: { gchat: f.adapter }, state });
    await chat.initialize();
    expect(await f.adapter.getUser("users/123")).toBeNull();
    f.revoke();
    await expect(f.adapter.getUser("users/123")).rejects.toThrow("revoked");
    await chat.shutdown();
  });
  test("keeps Google JWT verification on the scoped inbound path", async () => {
    const f = await fixture();
    const chat = new Chat({ userName: "lobu", adapters: { gchat: f.adapter }, state: new InMemoryStateAdapter() });
    await chat.initialize();
    const body = { type: "ADDED_TO_SPACE", space: { name: space, type: "SPACE" } };
    const request = (token: string) => new Request("https://gateway.test/webhook", {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });
    expect((await chat.webhooks.gchat(request("forged"))).status).toBe(401);
    expect((await chat.webhooks.gchat(request("verified"))).status).toBe(200);
    await chat.shutdown();
  });
  test("rejects prefixed reaction resources before the SDK fetches their message", async () => {
    const f = await fixture();
    f.base.pubsubAudience = "https://gateway.test/pubsub";
    f.base.verifyBearerToken = async () => true;
    f.base.chatApi.spaces.messages.get = async ({ name }: any) => {
      f.calls.push(name);
      return { data: {} };
    };
    const chat = new Chat({ userName: "lobu", adapters: { gchat: f.adapter }, state: new InMemoryStateAdapter() });
    await chat.initialize();
    const tasks: Promise<unknown>[] = [];
    const response = await chat.webhooks.gchat(new Request("https://gateway.test/pubsub", {
      method: "POST", body: JSON.stringify({
        subscription: "projects/test/subscriptions/test",
        message: {
          attributes: {
            "ce-type": "google.workspace.chat.reaction.v1.created",
            "ce-subject": `//chat.googleapis.com/${space}`,
          },
          data: Buffer.from(JSON.stringify({ reaction: {
            name: "/spaces/foreign/messages/id/reactions/id", emoji: { unicode: "👍" },
          } })).toString("base64"),
        },
      }),
    }), { waitUntil: (task) => tasks.push(task) });
    await Promise.allSettled(tasks);
    await chat.shutdown();
    expect(f.calls).toEqual([]);
    expect(response.status).toBe(403);
  });
  test("accepts a same-space message resource as the SDK fallback thread", async () => {
    const { adapter } = await fixture();
    const id = adapter.encodeThreadId({ spaceName: space, threadName: `${space}/messages/root` });
    expect(adapter.decodeThreadId(id).threadName).toBe(`${space}/messages/root`);
  });
});

describe("Google Chat resource envelopes", () => {
  for (const envelope of [
    { space: { name: space }, message: { name: `${space}/messages/id`, thread: { name: "spaces/foreign/threads/id" } } },
    { chat: { buttonClickedPayload: { space: { name: space }, message: { name: "spaces/foreign/messages/id" } } } },
    { targetResource: `//chat.googleapis.com/${space}`, reaction: { name: "spaces/foreign/messages/id/reactions/id" } },
    { targetResource: `//chat.googleapis.com/${space}`, reaction: { name: "/spaces/foreign/messages/id/reactions/id" } },
    { space: { name: `${space}/../foreign` } },
  ]) {
    test(`rejects mixed or malformed resources: ${JSON.stringify(envelope)}`, () => {
      expect(() => googleChatEventSpace(envelope)).toThrow();
      expect(() => googleChatEventSpace({ subscription: "test", message: { data: Buffer.from(JSON.stringify(envelope)).toString("base64") } })).toThrow();
    });
  }
  test("extracts standalone, Add-on and Pub/Sub resources", () => {
    expect(googleChatEventSpace({ space: { name: space } })).toBe(space);
    expect(googleChatEventSpace({ chat: { removedFromSpacePayload: { space: { name: space } } } })).toBe(space);
    expect(googleChatEventSpace({ subscription: "test", message: { data: Buffer.from(JSON.stringify({ targetResource: `//chat.googleapis.com/${space}`, reaction: { name: `${space}/messages/id/reactions/id` } })).toString("base64") } })).toBe(space);
  });
});
