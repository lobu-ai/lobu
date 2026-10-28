import { describe, expect, mock, test } from "bun:test";
import { CommandRegistry } from "@lobu/core";
import { registerBuiltInCommands } from "../built-in-commands.js";

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
      ["test-installation", "telegram:123", "org-installation", { teamId: undefined }],
    ]);
    expect(getSettings.mock.calls).toEqual([
      ["linked-agent", { organizationId: "org-linked-agent" }],
    ]);
  });
});
