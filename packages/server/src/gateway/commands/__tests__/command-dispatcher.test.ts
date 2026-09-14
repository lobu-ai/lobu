import { describe, expect, mock, test } from "bun:test";
import { CommandDispatcher } from "../command-dispatcher.js";

/**
 * Builds a dispatcher with a registry/automation-subscription-service stubbed out, capturing
 * the (commandName, args) the registry is asked to handle.
 */
function makeDispatcher() {
  const calls: Array<{ name: string; args: string }> = [];
  const registry = {
    tryHandle: mock(async (name: string, ctx: { args: string }) => {
      calls.push({ name, args: ctx.args });
      return true;
    }),
  };
	const automationSubscriptionService = {
		resolveForConnection: mock(async () => null),
	};
  const dispatcher = new CommandDispatcher({
    registry: registry as never,
    automationSubscriptionService: automationSubscriptionService as never,
  });
  return { dispatcher, calls };
}

const input = {
  platform: "slack",
  userId: "U1",
  channelId: "slack:D1",
  isGroup: false,
  reply: async () => {},
} as never;

describe("CommandDispatcher.tryHandleSlashText", () => {
  test("unwraps the Slack `/lobu` wrapper so `/lobu link <code>` dispatches `link`", async () => {
    // Regression: in an AI-app DM Slack delivers `/lobu link <code>` as plain
    // message text (no slash-command UI). It must dispatch the `link`
    // subcommand, not a non-existent `lobu` command.
    const { dispatcher, calls } = makeDispatcher();
    const handled = await dispatcher.tryHandleSlashText(
      "/lobu link crm-ABC123",
			input,
    );
    expect(handled).toBe(true);
    expect(calls).toEqual([{ name: "link", args: "crm-ABC123" }]);
  });

  test("unwraps any subcommand, not just `link`", async () => {
    const { dispatcher, calls } = makeDispatcher();
    await dispatcher.tryHandleSlashText("/lobu status", input);
    expect(calls).toEqual([{ name: "status", args: "" }]);
  });

  test("non-wrapped `/link <code>` still dispatches `link`", async () => {
    const { dispatcher, calls } = makeDispatcher();
    await dispatcher.tryHandleSlashText("/link crm-XYZ789", input);
    expect(calls).toEqual([{ name: "link", args: "crm-XYZ789" }]);
  });

  test("plain (non-slash) message text is ignored", async () => {
    const { dispatcher, calls } = makeDispatcher();
    const handled = await dispatcher.tryHandleSlashText(
      "hey can you help me",
			input,
    );
    expect(handled).toBe(false);
    expect(calls).toEqual([]);
  });
});
