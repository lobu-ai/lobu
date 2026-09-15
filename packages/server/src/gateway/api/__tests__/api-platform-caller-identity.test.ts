/**
 * The API platform adapter must bind a turn to the AUTHENTICATED caller.
 *
 * The enqueued `userId` is carried by the worker token, and a blocked tool call
 * stores it as the pending approval's claimant. `POST /api/v1/agents/approve`
 * claims with `authContext.userId`, so any identity the adapter *derives*
 * (previously `api-${token.slice(0, 8)}`) is one no approver can ever present —
 * every approval raised from an API-platform turn was permanently unclaimable.
 */

import { expect, mock, test } from "bun:test";
import type { MessagePayload } from "@lobu/core";
import { ApiPlatform } from "../platform.js";

function makePlatform(enqueued: MessagePayload[], session: unknown = null) {
  const platform = Object.create(ApiPlatform.prototype) as ApiPlatform;
  Object.assign(platform, {
    services: {
      getSessionManager: () => ({
        getSession: async () => session,
        setSession: mock(async () => {}),
        touchSession: async () => {},
      }),
      getQueueProducer: () => ({
        enqueueMessage: mock(async (payload: MessagePayload) => {
          enqueued.push(payload);
        }),
      }),
      getPublicGatewayUrl: () => "http://localhost:8787",
    },
  });
  return platform;
}

const OPTIONS = {
  agentId: "agent-1",
  organizationId: "org-1",
  channelId: "agent-1",
  conversationId: "agent-1",
  teamId: "api",
};

test("sendMessage enqueues the authenticated caller, not a token digest", async () => {
  const enqueued: MessagePayload[] = [];
  const platform = makePlatform(enqueued);

  await platform.sendMessage("token-abcdefghijkl", "hi", {
    ...OPTIONS,
    callerUserId: "user-real",
  });

  expect(enqueued).toHaveLength(1);
  expect(enqueued[0]!.userId).toBe("user-real");
  // RED before the fix: this was `api-token-ab`, an identity derived from the
  // token bytes that no caller could present on the approve route.
  expect(enqueued[0]!.userId).not.toBe("api-token-ab");
  expect(enqueued[0]!.userId).not.toStartWith("api-");
});

test("the created session records the same caller identity it enqueues", async () => {
  // The claimant predicate matches on the enqueued userId, but the session is
  // what later routes authorize against. If the two disagree the approval is
  // bound to an identity the session never had.
  const enqueued: MessagePayload[] = [];
  const sessions: Array<{ userId: string; threadCreator?: string }> = [];
  const platform = Object.create(ApiPlatform.prototype) as ApiPlatform;
  Object.assign(platform, {
    services: {
      getSessionManager: () => ({
        getSession: async () => null,
        setSession: mock(
          async (s: { userId: string; threadCreator?: string }) => {
            sessions.push(s);
          },
        ),
        touchSession: async () => {},
      }),
      getQueueProducer: () => ({
        enqueueMessage: mock(async (payload: MessagePayload) => {
          enqueued.push(payload);
        }),
      }),
      getPublicGatewayUrl: () => "http://localhost:8787",
    },
  });

  await platform.sendMessage("token-abcdefghijkl", "hi", {
    ...OPTIONS,
    callerUserId: "user-real",
  });

  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.userId).toBe("user-real");
  expect(sessions[0]!.threadCreator).toBe("user-real");
  expect(enqueued[0]!.userId).toBe(sessions[0]!.userId);
});

test("two callers sharing one token get distinct identities", async () => {
  // The token digest collapsed every caller holding the same token into ONE
  // synthetic id, so one user could claim another's pending approval. The
  // authenticated subject keeps them distinct.
  const enqueued: MessagePayload[] = [];
  const platform = makePlatform(enqueued, {
    conversationId: "agent-1",
    organizationId: "org-1",
  });

  await platform.sendMessage("shared-token-xyz", "hi", {
    ...OPTIONS,
    callerUserId: "user-a",
  });
  await platform.sendMessage("shared-token-xyz", "hi", {
    ...OPTIONS,
    callerUserId: "user-b",
  });

  expect(enqueued.map((p) => p.userId)).toEqual(["user-a", "user-b"]);
});
