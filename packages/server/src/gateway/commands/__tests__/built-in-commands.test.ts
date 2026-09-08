import { describe, expect, mock, test } from "bun:test";
import { CommandRegistry } from "@lobu/core";
import { registerBuiltInCommands } from "../built-in-commands.js";

async function helpFor(platform: string): Promise<string> {
  const registry = new CommandRegistry();
  registerBuiltInCommands(registry, { agentSettingsStore: {} as never, automationSubscriptionService: {} as never });
  const replies: string[] = [];
  await registry.tryHandle("help", {
    userId: "user-1",
    channelId: "channel-1",
    isGroup: false,
    platform,
    args: "",
    reply: async (text: string) => {
      replies.push(text);
    },
  });
  return replies.join("\n");
}

describe("built-in command help", () => {
  test.each(["slack", "gchat"])(
    "uses the native /lobu wrapper on %s",
    async (platform) => {
      const help = await helpFor(platform);
      expect(help).toContain("/lobu help - Show available commands");
      expect(help).toContain("/lobu new - Save context to memory");
      expect(help).toContain("/lobu clear - Clear chat history");
      expect(help).not.toContain("\n/help -");
    },
  );

  test("keeps bare commands on platforms without the wrapper", async () => {
    const help = await helpFor("telegram");
    expect(help).toContain("/help - Show available commands");
    expect(help).not.toContain("/lobu help");
  });
});

describe("built-in status command", () => {
  test("reads agent settings from the workspace selected by the chat subscription", async () => {
    const registry = new CommandRegistry();
    const resolveForConnection = mock(async () => ({ organizationId: "org-linked-agent" }));
    const getSettings = mock(async () => undefined);
    registerBuiltInCommands(registry, {
      agentSettingsStore: { getSettings } as never,
      automationSubscriptionService: { resolveForConnection } as never,
    });
    await registry.tryHandle("status", {
      platform: "telegram",
      userId: "chat-user",
      channelId: "telegram:123",
      connectionId: "test-installation",
      organizationId: "org-installation",
      agentId: "linked-agent",
      args: "",
      reply: async () => {},
    });
    expect(resolveForConnection.mock.calls).toEqual([
      ["test-installation", "telegram:123", "org-installation", false, undefined],
    ]);
    expect(getSettings.mock.calls).toEqual([
      ["linked-agent", { organizationId: "org-linked-agent" }],
    ]);
  });
});
