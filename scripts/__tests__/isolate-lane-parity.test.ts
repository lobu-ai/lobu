/**
 * Parity gate between the two agent runtimes.
 *
 * The isolate lane (`connector-worker/src/agent-turn`) must offer the model
 * every tool the subprocess lane (`agent-worker`) offers, or a cutover is a
 * regression a customer notices before a test does. This reads the lists both
 * lanes are built from — not a fixture — so a tool added to one lane fails
 * here until it reaches the other.
 *
 * Runs in CI's format-lint job beside the other source-scanning gates.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { createConversationTools } from "@lobu/plugin-conversations";
import { createMediaTools } from "@lobu/plugin-media/portable";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const read = (relative: string) =>
  readFileSync(join(REPO_ROOT, relative), "utf8");

/** The quoted names inside the first `<label> = [...]` or `new Set([...])` after `marker`. */
function quotedNamesAfter(source: string, marker: string): string[] {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`marker not found: ${marker}`);
  // The list is on the right of the assignment; a type annotation such as
  // `readonly BuiltinTool[]` sits on the left.
  const open = source.indexOf("[", source.indexOf("=", start));
  const close = source.indexOf("]", open);
  return [...source.slice(open, close).matchAll(/["']([a-z_]+)["']/g)]
    .map((m) => m[1] as string)
    .sort();
}

/** The string literals of a `type X = 'a' | 'b'` union. */
function unionLiterals(source: string, typeName: string): string[] {
  const match = new RegExp(`export type ${typeName} = ([^;]+);`).exec(source);
  if (!match) throw new Error(`type not found: ${typeName}`);
  return [...(match[1] as string).matchAll(/'([a-z_]+)'/g)]
    .map((m) => m[1] as string)
    .sort();
}

describe("isolate lane parity with the subprocess lane", () => {
  it("offers every pi builtin the subprocess lane hardens", () => {
    const subprocess = quotedNamesAfter(
      read("packages/agent-worker/src/runtime/session-runner.ts"),
      "const OVERRIDABLE_BUILTIN_NAMES"
    );
    const guest = unionLiterals(
      read("packages/connector-worker/src/agent-turn/types.ts"),
      "AgentTurnBuiltinTool"
    );
    const producer = quotedNamesAfter(
      read("packages/server/src/gateway/orchestration/agent-turn-shadow.ts"),
      "const WORKSPACE_TOOLS"
    );
    expect(guest).toEqual(subprocess);
    expect(producer).toEqual(subprocess);
  });

  it("names every conversation and media tool the plugins publish", () => {
    const gateway = quotedNamesAfter(
      read("packages/server/src/gateway/orchestration/agent-turn-shadow.ts"),
      "const GATEWAY_TOOLS"
    );
    const media = quotedNamesAfter(
      read("packages/server/src/gateway/orchestration/agent-turn-shadow.ts"),
      "const MEDIA_TOOLS"
    );
    const noop = () => undefined;
    const params = {
      gatewayUrl: "http://gateway.test",
      token: "t",
      channelId: "c",
      conversationId: "conv",
      platform: "api",
      onAskUserPosted: noop,
      onInBandReplyDelivered: noop,
    } as never;
    const conversationTools = createConversationTools(params)
      .map((tool) => tool.name)
      .sort();
    const mediaTools = createMediaTools({
      ...(params as object),
      filePort: {},
    } as never)
      .map((tool) => tool.name)
      .sort();
    expect(gateway).toEqual(conversationTools);
    expect(media).toEqual(mediaTools);
  });

  it("runs the memory plugin's hooks, not a reimplementation", () => {
    const guestMemory = read(
      "packages/connector-worker/src/agent-turn/memory.ts"
    );
    expect(guestMemory).toContain("createMemoryPlugin");
    expect(guestMemory).toContain("PluginHost");
  });
});
