import { describe, expect, test } from "bun:test";
import { Chat } from "chat";
import { InMemoryStateAdapter } from "../../../__tests__/fixtures/in-memory-state-adapter.js";
import { parseConfig } from "../../chat-connection-service.js";
import { ChatInstanceManager } from "../../chat-instance-manager.js";
import { GOOGLE_CHAT_WELCOME_TEXT, gchatPlatform } from "../gchat.js";

const credentials = JSON.stringify({
  client_email: "lobu-chat@example.iam.gserviceaccount.com",
  private_key: "not-used-by-the-inbound-webhook-test",
  project_id: "lobu-chat-test",
});

function standardDirectMessage(text = "hello Lobu"): any {
  const space = {
    name: "spaces/AAAA-test",
    type: "DM",
    spaceType: "DIRECT_MESSAGE",
  };
  const user = {
    name: "users/123",
    displayName: "Test User",
    email: "test.user@example.com",
    type: "HUMAN",
  };
  return {
    type: "MESSAGE",
    eventTime: "2026-08-24T12:00:00Z",
    space,
    user,
    message: {
      name: "spaces/AAAA-test/messages/message-1",
      createTime: "2026-08-24T12:00:00Z",
      text,
      sender: user,
      space,
    },
  };
}

async function createTestChat(config: { helpCommandId?: string } = {}) {
  const adapter = await gchatPlatform.createAdapter({
    credentials,
    disableSignatureVerification: true,
    userName: "lobu",
    ...config,
  });
  const chat = new Chat({
    userName: "lobu",
    adapters: { gchat: adapter },
    state: new InMemoryStateAdapter(),
  });
  return chat;
}

function webhook(body: Record<string, unknown>) {
  return new Request("https://gateway.test/api/v1/webhooks/gchat-test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitForDelivery(promise: Promise<void>): Promise<void> {
  await Promise.race([
    promise,
    Bun.sleep(1_000).then(() => {
      throw new Error("Timed out waiting for Google Chat event delivery");
    }),
  ]);
}

async function dispatchAndWait(chat: Chat, request: Request) {
  const tasks: Promise<unknown>[] = [];
  const response = await chat.webhooks.gchat(request, {
    waitUntil: (task) => tasks.push(task),
  });
  await Promise.all(tasks);
  return response;
}

describe("Google Chat platform compatibility", () => {
  test("welcome points users to the registered /lobu wrapper", () => {
    expect(GOOGLE_CHAT_WELCOME_TEXT).toContain("/lobu help");
  });

  test("accepts only this project's Workspace Add-on token at the canonical connection webhook", async () => {
    const endpointUrl =
      "https://gateway.test/api/v1/webhooks/gchat-addon-test";
    const manager = new ChatInstanceManager() as any;
    manager.publicGatewayUrl = "https://gateway.test";
    const adapter = (await manager.createAdapter({
      id: "gchat-addon-test",
      platform: "gchat",
      config: {
        platform: "gchat",
        credentials,
        googleChatProjectNumber: "123456789",
        endpointUrl: "https://stale.example.test/wrong-connection",
      },
    })) as any;
    let verifiedAudience: string | string[] | undefined;
    let tokenEmail =
      "service-123456789@gcp-sa-gsuiteaddons.iam.gserviceaccount.com";
    adapter.oauth2Client.verifyIdToken = async ({ audience }: any) => {
      verifiedAudience = audience;
      return {
        getPayload: () => ({
          iss: "https://accounts.google.com",
          aud: endpointUrl,
          email_verified: true,
          email: tokenEmail,
        }),
      };
    };
    adapter.verifyProjectNumberToken = async () => false;

    const chat = new Chat({
      userName: "lobu",
      adapters: { gchat: adapter },
      state: new InMemoryStateAdapter(),
    });
    const delivered: string[] = [];
    const completion = Promise.withResolvers<void>();
    chat.onDirectMessage(async (_thread, message) => {
      delivered.push(message.text);
      completion.resolve();
    });

    const response = await chat.webhooks.gchat(
      new Request(endpointUrl, {
        method: "POST",
        headers: {
          authorization: "Bearer signed-by-google",
          "content-type": "application/json",
        },
        body: JSON.stringify(standardDirectMessage()),
      })
    );
    await waitForDelivery(completion.promise);

    expect(response.status).toBe(200);
    expect(verifiedAudience).toBe(endpointUrl);
    expect(delivered).toEqual(["hello Lobu"]);

    tokenEmail =
      "service-987654321@gcp-sa-gsuiteaddons.iam.gserviceaccount.com";
    const wrongProjectResponse = await chat.webhooks.gchat(
      new Request(endpointUrl, {
        method: "POST",
        headers: {
          authorization: "Bearer signed-by-another-google-project",
          "content-type": "application/json",
        },
        body: JSON.stringify(standardDirectMessage("wrong project")),
      })
    );
    expect(wrongProjectResponse.status).toBe(401);
    expect(delivered).toEqual(["hello Lobu"]);
  });

  test("dispatches Google's standalone MESSAGE payload to the DM handler", async () => {
    const chat = await createTestChat();
    const delivered: string[] = [];
    const completion = Promise.withResolvers<void>();
    chat.onDirectMessage(async (_thread, message) => {
      delivered.push(message.text);
      completion.resolve();
    });

    const response = await chat.webhooks.gchat(webhook(standardDirectMessage()));
    await waitForDelivery(completion.promise);

    expect(response.status).toBe(200);
    expect(delivered).toEqual(["hello Lobu"]);
  });

  test("canonicalizes plain and mixed-case help at the adapter boundary", async () => {
    const chat = await createTestChat();
    const delivered: string[] = [];
    const completion = Promise.withResolvers<void>();
    chat.onDirectMessage(async (_thread, message) => {
      delivered.push(message.text);
      if (delivered.length === 2) completion.resolve();
    });
    const plainEvent = standardDirectMessage(" Help ");
    const slashEvent = standardDirectMessage("/HeLp");
    slashEvent.message.name = "spaces/AAAA-test/messages/message-2";
    slashEvent.message.createTime = "2026-08-24T12:00:01Z";
    slashEvent.eventTime = slashEvent.message.createTime;

    const plainResponse = await chat.webhooks.gchat(webhook(plainEvent));
    const slashResponse = await chat.webhooks.gchat(webhook(slashEvent));
    await waitForDelivery(completion.promise);

    expect(plainResponse.status).toBe(200);
    expect(slashResponse.status).toBe(200);
    expect(delivered).toEqual(["/help", "/help"]);
  });

  test("canonicalizes Workspace Add-on message help at the adapter boundary", async () => {
    const chat = await createTestChat();
    const delivered: string[] = [];
    const completion = Promise.withResolvers<void>();
    chat.onDirectMessage(async (_thread, message) => {
      delivered.push(message.text);
      completion.resolve();
    });
    const event = standardDirectMessage("/HELP");

    const response = await dispatchAndWait(
      chat,
      webhook({
        chat: {
          user: event.user,
          eventTime: event.eventTime,
          messagePayload: {
            message: event.message,
            space: event.space,
          },
        },
      }),
    );
    await waitForDelivery(completion.promise);

    expect(response.status).toBe(200);
    expect(delivered).toEqual(["/help"]);
  });

  test("returns the Marketplace welcome when added to a DM or space", async () => {
    const chat = await createTestChat();
    const messageEvent = standardDirectMessage();

    const response = await chat.webhooks.gchat(
      webhook({
        type: "ADDED_TO_SPACE",
        eventTime: messageEvent.eventTime,
        space: messageEvent.space,
        user: messageEvent.user,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: GOOGLE_CHAT_WELCOME_TEXT });
  });

  test("wraps the Marketplace welcome for a Workspace Add-on event", async () => {
    const chat = await createTestChat();
    const messageEvent = standardDirectMessage();

    const response = await chat.webhooks.gchat(
      webhook({
        chat: {
          user: messageEvent.user,
          eventTime: messageEvent.eventTime,
          addedToSpacePayload: { space: messageEvent.space },
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hostAppDataAction: {
        chatDataAction: {
          createMessageAction: {
            message: { text: GOOGLE_CHAT_WELCOME_TEXT },
          },
        },
      },
    });
  });

  test("dispatches the registered Workspace Add-on /help command", async () => {
    const chat = await createTestChat({ helpCommandId: "999" });
    const delivered: string[] = [];
    const deliveredThreadNames: string[] = [];
    const completion = Promise.withResolvers<void>();
    chat.onNewMention(async (thread, message) => {
      delivered.push(message.text);
      deliveredThreadNames.push(
        (chat.getAdapter("gchat") as any).decodeThreadId(thread.id).threadName,
      );
      completion.resolve();
    });
    const messageEvent = standardDirectMessage("/help");
    messageEvent.space.type = "ROOM";
    messageEvent.space.spaceType = "SPACE";
    messageEvent.message.space = messageEvent.space;
    const commandThread = { name: "spaces/AAAA-test/threads/thread-help" };
    delete messageEvent.message.thread;

    const response = await chat.webhooks.gchat(
      webhook({
        chat: {
          user: messageEvent.user,
          eventTime: messageEvent.eventTime,
          appCommandPayload: {
            appCommandMetadata: {
              appCommandId: "999",
              appCommandType: "SLASH_COMMAND",
            },
            message: messageEvent.message,
            space: messageEvent.space,
            thread: commandThread,
          },
        },
      }),
    );
    await waitForDelivery(completion.promise);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(delivered).toEqual(["@lobu /help"]);
    expect(deliveredThreadNames).toEqual([commandThread.name]);
  });

  test("dispatches the registered Workspace Add-on /lobu command with its subcommand", async () => {
    const chat = await createTestChat({ helpCommandId: "999" });
    const delivered: string[] = [];
    const completion = Promise.withResolvers<void>();
    chat.onNewMention(async (_thread, message) => {
      delivered.push(message.text);
      completion.resolve();
    });
    const messageEvent = standardDirectMessage("/lobu status");
    messageEvent.message.argumentText = "/lobu status";
    messageEvent.space.type = "ROOM";
    messageEvent.space.spaceType = "SPACE";
    messageEvent.message.space = messageEvent.space;

    const response = await chat.webhooks.gchat(
      webhook({
        chat: {
          user: messageEvent.user,
          eventTime: messageEvent.eventTime,
          appCommandPayload: {
            appCommandMetadata: {
              appCommandId: "999",
              appCommandType: "SLASH_COMMAND",
            },
            message: messageEvent.message,
            space: messageEvent.space,
          },
        },
      }),
    );
    await waitForDelivery(completion.promise);

    expect(response.status).toBe(200);
    expect(delivered).toEqual(["@lobu /lobu status"]);
  });

  test("preserves Workspace Add-on /lobu arguments when Google only supplies argumentText", async () => {
    const chat = await createTestChat({ helpCommandId: "999" });
    const delivered: string[] = [];
    const completion = Promise.withResolvers<void>();
    chat.onDirectMessage(async (_thread, message) => {
      delivered.push(message.text);
      completion.resolve();
    });
    const event = standardDirectMessage();
    delete event.message.text;
    event.message.argumentText = "/lobu link crm-ABC123";

    const response = await chat.webhooks.gchat(
      webhook({
        chat: {
          user: event.user,
          eventTime: event.eventTime,
          appCommandPayload: {
            appCommandMetadata: {
              appCommandId: "999",
              appCommandType: "SLASH_COMMAND",
            },
            message: event.message,
            space: event.space,
          },
        },
      }),
    );
    await waitForDelivery(completion.promise);

    expect(response.status).toBe(200);
    expect(delivered).toEqual(["/lobu link crm-ABC123"]);
  });

  test("does not dispatch /lobu for another project-local command ID", async () => {
    const chat = await createTestChat({ helpCommandId: "999" });
    const delivered: string[] = [];
    chat.onDirectMessage(async (_thread, message) => {
      delivered.push(message.text);
    });
    const event = standardDirectMessage("/lobu status");

    const response = await dispatchAndWait(
      chat,
      webhook({
        chat: {
          user: event.user,
          eventTime: event.eventTime,
          appCommandPayload: {
            appCommandMetadata: {
              appCommandId: "1",
              appCommandType: "SLASH_COMMAND",
            },
            message: event.message,
            space: event.space,
          },
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(delivered).toEqual([]);
  });

  test("maps a bare registered /lobu command to help", async () => {
    const chat = await createTestChat({ helpCommandId: "999" });
    const delivered: string[] = [];
    const completion = Promise.withResolvers<void>();
    chat.onDirectMessage(async (_thread, message) => {
      delivered.push(message.text);
      completion.resolve();
    });
    const event = standardDirectMessage("/lobu");

    const response = await chat.webhooks.gchat(
      webhook({
        chat: {
          user: event.user,
          eventTime: event.eventTime,
          appCommandPayload: {
            appCommandMetadata: {
              appCommandId: "999",
              appCommandType: "SLASH_COMMAND",
            },
            message: event.message,
            space: event.space,
          },
        },
      }),
    );
    await waitForDelivery(completion.promise);

    expect(response.status).toBe(200);
    expect(delivered).toEqual(["/help"]);
  });

  test("dispatches a Workspace Add-on slash command without message text", async () => {
    const chat = await createTestChat({ helpCommandId: "999" });
    const delivered: string[] = [];
    const completion = Promise.withResolvers<void>();
    chat.onNewMention(async (_thread, message) => {
      delivered.push(message.text);
      completion.resolve();
    });
    const event = standardDirectMessage();
    event.space.type = "ROOM";
    event.space.spaceType = "SPACE";
    event.message.space = event.space;
    delete event.message.text;

    const response = await chat.webhooks.gchat(
      webhook({
        chat: {
          user: event.user,
          eventTime: event.eventTime,
          appCommandPayload: {
            appCommandMetadata: {
              appCommandId: "999",
              appCommandType: "SLASH_COMMAND",
            },
            message: event.message,
            space: event.space,
          },
        },
      }),
    );
    await waitForDelivery(completion.promise);

    expect(response.status).toBe(200);
    expect(delivered).toEqual(["@lobu /help"]);
  });

  test("dispatches a Workspace Add-on quick command without a message", async () => {
    const chat = await createTestChat({ helpCommandId: "999" });
    const delivered: string[] = [];
    const completion = Promise.withResolvers<void>();
    chat.onDirectMessage(async (_thread, message) => {
      delivered.push(message.text);
      completion.resolve();
    });
    const event = standardDirectMessage();

    const response = await chat.webhooks.gchat(
      webhook({
        chat: {
          user: event.user,
          eventTime: event.eventTime,
          appCommandPayload: {
            appCommandMetadata: {
              appCommandId: "999",
              appCommandType: "QUICK_COMMAND",
            },
            space: event.space,
          },
        },
      }),
    );
    await waitForDelivery(completion.promise);

    expect(response.status).toBe(200);
    expect(delivered).toEqual(["/help"]);
  });

  test("dispatches a standalone quick command without a message", async () => {
    const chat = await createTestChat({ helpCommandId: "999" });
    const delivered: string[] = [];
    const completion = Promise.withResolvers<void>();
    chat.onDirectMessage(async (_thread, message) => {
      delivered.push(message.text);
      completion.resolve();
    });
    const event = standardDirectMessage();

    const response = await chat.webhooks.gchat(
      webhook({
        type: "APP_COMMAND",
        eventTime: event.eventTime,
        appCommandMetadata: {
          appCommandId: "999",
          appCommandType: "QUICK_COMMAND",
        },
        space: event.space,
        user: event.user,
      }),
    );
    await waitForDelivery(completion.promise);

    expect(response.status).toBe(200);
    expect(delivered).toEqual(["/help"]);
  });

  test("dispatches a standalone slash command without message text", async () => {
    const chat = await createTestChat({ helpCommandId: "999" });
    const delivered: string[] = [];
    const completion = Promise.withResolvers<void>();
    chat.onDirectMessage(async (_thread, message) => {
      delivered.push(message.text);
      completion.resolve();
    });
    const event = standardDirectMessage();
    delete event.message.text;
    event.message.slashCommand = { commandId: "999" };

    const response = await chat.webhooks.gchat(webhook(event));
    await waitForDelivery(completion.promise);

    expect(response.status).toBe(200);
    expect(delivered).toEqual(["/help"]);
  });

  test("dispatches a standalone registered /lobu command with arguments", async () => {
    const chat = await createTestChat({ helpCommandId: "999" });
    const delivered: string[] = [];
    const completion = Promise.withResolvers<void>();
    chat.onDirectMessage(async (_thread, message) => {
      delivered.push(message.text);
      completion.resolve();
    });
    const event = standardDirectMessage("/lobu link crm-ABC123");
    event.message.argumentText = "/lobu link crm-ABC123";
    event.message.slashCommand = { commandId: "999" };

    const response = await chat.webhooks.gchat(webhook(event));
    await waitForDelivery(completion.promise);

    expect(response.status).toBe(200);
    expect(delivered).toEqual(["/lobu link crm-ABC123"]);
  });

  test("dispatches a standalone annotated slash command without message text", async () => {
    const chat = await createTestChat({ helpCommandId: "999" });
    const delivered: string[] = [];
    const completion = Promise.withResolvers<void>();
    chat.onDirectMessage(async (_thread, message) => {
      delivered.push(message.text);
      completion.resolve();
    });
    const event = standardDirectMessage();
    delete event.message.text;
    event.message.annotations = [
      {
        type: "SLASH_COMMAND",
        slashCommand: { commandId: "999" },
      },
    ];

    const response = await chat.webhooks.gchat(webhook(event));
    await waitForDelivery(completion.promise);

    expect(response.status).toBe(200);
    expect(delivered).toEqual(["/help"]);
  });

  test("ignores a no-text command whose ID is not mapped to help", async () => {
    const chat = await createTestChat({ helpCommandId: "999" });
    const delivered: string[] = [];
    chat.onDirectMessage(async (_thread, message) => {
      delivered.push(message.text);
    });
    const event = standardDirectMessage();
    delete event.message.text;

    const response = await dispatchAndWait(
      chat,
      webhook({
        chat: {
          user: event.user,
          eventTime: event.eventTime,
          appCommandPayload: {
            appCommandMetadata: {
              appCommandId: "1",
              appCommandType: "SLASH_COMMAND",
            },
            message: event.message,
            space: event.space,
          },
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(delivered).toEqual([]);
  });

  test("does not reinterpret another project's command ID 1 as help", async () => {
    const chat = await createTestChat();
    const delivered: string[] = [];
    chat.onNewMention(async (_thread, message) => {
      delivered.push(message.text);
    });
    const messageEvent = standardDirectMessage("/about");
    messageEvent.space.type = "ROOM";
    messageEvent.space.spaceType = "SPACE";
    messageEvent.message.space = messageEvent.space;

    const response = await dispatchAndWait(
      chat,
      webhook({
        chat: {
          user: messageEvent.user,
          eventTime: messageEvent.eventTime,
          appCommandPayload: {
            appCommandMetadata: {
              appCommandId: "1",
              appCommandType: "SLASH_COMMAND",
            },
            message: messageEvent.message,
            space: messageEvent.space,
          },
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(delivered).toEqual([]);
  });

  test("canonicalizes mentioned space help at the adapter boundary", async () => {
    const chat = await createTestChat();
    const delivered: string[] = [];
    const completion = Promise.withResolvers<void>();
    chat.onNewMention(async (_thread, message) => {
      delivered.push(message.text);
      completion.resolve();
    });
    const event = standardDirectMessage("@Lobu help");
    event.space.type = "ROOM";
    event.space.spaceType = "SPACE";
    event.message.annotations = [
      {
        type: "USER_MENTION",
        startIndex: 0,
        length: 5,
        userMention: {
          user: { name: "users/lobu", displayName: "Lobu", type: "BOT" },
          type: "MENTION",
        },
      },
    ];
    event.message.thread = { name: "spaces/AAAA-test/threads/thread-1" };

    const response = await chat.webhooks.gchat(webhook(event));
    await waitForDelivery(completion.promise);

    expect(response.status).toBe(200);
    expect(delivered).toEqual(["@lobu /help"]);
  });

  test("canonicalizes Pub/Sub space help before duplicate webhook delivery", async () => {
    const chat = await createTestChat();
    const delivered: string[] = [];
    const completion = Promise.withResolvers<void>();
    chat.onNewMention(async (_thread, message) => {
      delivered.push(message.text);
      completion.resolve();
    });
    const event = standardDirectMessage("@Lobu help");
    event.space.type = "ROOM";
    event.space.spaceType = "SPACE";
    event.message.annotations = [
      {
        type: "USER_MENTION",
        startIndex: 0,
        length: 5,
        userMention: {
          user: { name: "users/lobu", displayName: "Lobu", type: "BOT" },
          type: "MENTION",
        },
      },
    ];
    event.message.thread = { name: "spaces/AAAA-test/threads/thread-1" };

    const pubSubResponse = await chat.webhooks.gchat(
      webhook({
        message: {
          data: Buffer.from(
            JSON.stringify({ message: event.message }),
          ).toString("base64"),
          attributes: {
            "ce-type": "google.workspace.chat.message.v1.created",
            "ce-subject": "//chat.googleapis.com/spaces/AAAA-test",
            "ce-time": event.eventTime,
          },
        },
        subscription: "projects/test/subscriptions/gchat-test",
      }),
    );
    await waitForDelivery(completion.promise);

    // Google can also deliver the same resource through the direct webhook.
    // The Pub/Sub-first copy must already be canonical because Chat SDK drops
    // this second copy by message ID.
    const webhookResponse = await dispatchAndWait(chat, webhook(event));

    expect(pubSubResponse.status).toBe(200);
    expect(webhookResponse.status).toBe(200);
    expect(delivered).toEqual(["@lobu /help"]);
  });

  test("does not canonicalize unmentioned space help from Pub/Sub", async () => {
    const chat = await createTestChat();
    const delivered: string[] = [];
    const subscribed = Promise.withResolvers<void>();
    chat.onNewMention(async (thread) => {
      await thread.subscribe();
      subscribed.resolve();
    });
    chat.onSubscribedMessage(async (_thread, message) => {
      delivered.push(message.text);
    });
    const event = standardDirectMessage("@Lobu subscribe");
    event.space.type = "ROOM";
    event.space.spaceType = "SPACE";
    event.message.annotations = [
      {
        type: "USER_MENTION",
        startIndex: 0,
        length: 5,
        userMention: {
          user: { name: "users/lobu", displayName: "Lobu", type: "BOT" },
          type: "MENTION",
        },
      },
    ];
    event.message.thread = { name: "spaces/AAAA-test/threads/thread-1" };
    await chat.webhooks.gchat(webhook(event));
    await waitForDelivery(subscribed.promise);

    const ordinaryMessage = {
      ...event.message,
      name: "spaces/AAAA-test/messages/message-ordinary-help",
      text: "help",
      annotations: [],
      createTime: "2026-08-24T12:00:01Z",
    };
    const response = await dispatchAndWait(
      chat,
      webhook({
        message: {
          data: Buffer.from(
            JSON.stringify({ message: ordinaryMessage }),
          ).toString("base64"),
          attributes: {
            "ce-type": "google.workspace.chat.message.v1.created",
            "ce-subject": "//chat.googleapis.com/spaces/AAAA-test",
            "ce-time": ordinaryMessage.createTime,
          },
        },
        subscription: "projects/test/subscriptions/gchat-test",
      }),
    );

    expect(response.status).toBe(200);
    expect(delivered).toEqual(["help"]);
  });

  test("dispatches standalone CARD_CLICKED action metadata", async () => {
    const chat = await createTestChat();
    const delivered: any[] = [];
    const completion = Promise.withResolvers<void>();
    chat.onAction("approve", async (event) => {
      delivered.push(event);
      completion.resolve();
    });
    const messageEvent = standardDirectMessage();

    const response = await chat.webhooks.gchat(
      webhook({
        type: "CARD_CLICKED",
        eventTime: messageEvent.eventTime,
        space: messageEvent.space,
        user: messageEvent.user,
        message: messageEvent.message,
        common: { parameters: {} },
        action: {
          actionMethodName: "approve",
          parameters: [{ key: "value", value: "invoice-42" }],
        },
      }),
    );
    await waitForDelivery(completion.promise);

    expect(response.status).toBe(200);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      actionId: "approve",
      value: "invoice-42",
      user: {
        userId: "users/123",
        fullName: "Test User",
      },
      messageId: "spaces/AAAA-test/messages/message-1",
    });
    expect(delivered[0].raw.chat.eventTime).toBe(messageEvent.eventTime);
  });

  test("retains credential mode for impersonation and Workspace Events", async () => {
    const adapter = (await gchatPlatform.createAdapter({
      credentials,
      disableSignatureVerification: true,
      impersonateUser: "admin@example.com",
    })) as any;

    expect(adapter.credentials).toEqual(JSON.parse(credentials));
    expect(adapter.authClient.email).toBe(
      "lobu-chat@example.iam.gserviceaccount.com",
    );
    expect(adapter.authClient.scopes).toContain(
      "https://www.googleapis.com/auth/chat.bot",
    );
    expect(adapter.impersonatedChatApi).toBeDefined();
    expect(adapter.getAuthOptions()).toEqual({
      credentials: JSON.parse(credentials),
      impersonateUser: "admin@example.com",
    });
  });

  test("retains ADC mode for impersonation and Workspace Events", async () => {
    const adapter = (await gchatPlatform.createAdapter({
      useApplicationDefaultCredentials: true,
      disableSignatureVerification: true,
      impersonateUser: "admin@example.com",
    })) as any;

    expect(adapter.useADC).toBe(true);
    expect(adapter.impersonatedChatApi).toBeDefined();
    expect(adapter.getAuthOptions()).toEqual({
      useApplicationDefaultCredentials: true,
      impersonateUser: "admin@example.com",
    });
  });

  test("rejects malformed service-account JSON during connection validation", () => {
    expect(() =>
      parseConfig("gchat", {
        credentials: "not-json",
        googleChatProjectNumber: "123456789",
      })
    ).toThrow(/service account JSON is invalid/);
  });

  test("rejects malformed service-account JSON before adapter startup", async () => {
    await expect(
      gchatPlatform.createAdapter({
        credentials: "not-json",
        disableSignatureVerification: true,
      }),
    ).rejects.toThrow(/service account JSON is invalid/);
  });

  test("accepts ADC as the existing alternative to a JSON key", () => {
    expect(
      parseConfig("gchat", {
        useApplicationDefaultCredentials: true,
        googleChatProjectNumber: "123456789",
      }),
    ).toEqual({
      platform: "gchat",
      useApplicationDefaultCredentials: true,
      googleChatProjectNumber: "123456789",
    });
  });

  test.each(["1", "999", "1000"])(
    "keeps Google Chat help command ID %s",
    (helpCommandId) => {
      expect(
        parseConfig("gchat", {
          useApplicationDefaultCredentials: true,
          googleChatProjectNumber: "123456789",
          helpCommandId,
        }),
      ).toEqual({
        platform: "gchat",
        useApplicationDefaultCredentials: true,
        googleChatProjectNumber: "123456789",
        helpCommandId,
      });
    },
  );

  test.each(["help", "0", "01", "1001"])(
    "rejects invalid Google Chat help command ID %s",
    (helpCommandId) => {
      expect(() =>
        parseConfig("gchat", {
          useApplicationDefaultCredentials: true,
          googleChatProjectNumber: "123456789",
          helpCommandId,
        }),
      ).toThrow(/helpCommandId/);
    },
  );
});
