/**
 * Coherence gate for the agent-turn lane.
 *
 * The guest's tool union, the producer's tool lists, and what the plugins
 * actually publish must all name the same tools — a tool added to one but not
 * the others is a capability the model is promised and never gets, or offered
 * and never declared. This reads the lists the lane is BUILT from, not a
 * fixture, so a drift fails here rather than in front of a customer.
 *
 * Runs in CI's format-lint job beside the other source-scanning gates.
 */

import { existsSync, readFileSync } from "node:fs";
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

describe("agent-turn lane coherence", () => {
  it("declares the same pi builtins in the guest union and the producer", () => {
    const guest = unionLiterals(
      read("packages/connector-worker/src/agent-turn/types.ts"),
      "AgentTurnBuiltinTool"
    );
    const producer = quotedNamesAfter(
      read("packages/server/src/gateway/orchestration/agent-turn-producer.ts"),
      "const WORKSPACE_TOOLS"
    );
    expect(producer).toEqual(guest);
  });

  it("names every conversation and media tool the plugins publish", () => {
    const gateway = quotedNamesAfter(
      read("packages/server/src/gateway/orchestration/agent-turn-producer.ts"),
      "const GATEWAY_TOOLS"
    );
    const media = quotedNamesAfter(
      read("packages/server/src/gateway/orchestration/agent-turn-producer.ts"),
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

  it("uses Pi's native session lifecycle and deletes the copied compaction implementation", () => {
    const session = read(
      "packages/connector-worker/src/agent-turn/native-session.ts"
    );
    expect(session).toContain("@mariozechner/pi-coding-agent");
    expect(session).toMatch(/(?:new AgentSession|createAgentSession)\(/);
    expect(session).toContain("SessionManager");
    const guest = read(
      "packages/connector-worker/src/agent-turn/guest-entry.ts"
    );
    expect(guest).toContain("./native-session.js");
    expect(existsSync(join(REPO_ROOT, "packages/core/src/compaction.ts"))).toBe(
      false
    );
  });

  it("runs the memory plugin's hooks, not a reimplementation", () => {
    const guestMemory = read(
      "packages/connector-worker/src/agent-turn/memory.ts"
    );
    expect(guestMemory).toContain("createMemoryPlugin");
    expect(guestMemory).toContain("PluginHost");
  });
});
