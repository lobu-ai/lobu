/**
 * R7 BLOCK #1 layer (b): SlackInstructionProvider must NOT leak another tenant's
 * Slack identity. Identity now resolves from the signed `connectionId` rather
 * than an agent-scoped connection listing, so:
 *   - orgless/connection-less context ⇒ participation framing only, and no
 *     connection read at all (nothing to leak);
 *   - org-present ⇒ the read runs INSIDE the token org (orgContext.run).
 */

import { describe, expect, test } from "bun:test";
import type { InstructionContext } from "@lobu/core";
import { orgContext } from "../../../lobu/stores/org-context.js";
import { SlackInstructionProvider } from "../slack-instruction-provider.js";

function ctx(overrides: Partial<InstructionContext>): InstructionContext {
  return {
    userId: "u1",
    agentId: "lobu-builder",
    connectionId: "conn-1",
    sessionKey: "u1",
    workingDirectory: "/workspace",
    availableProjects: [],
    ...overrides,
  };
}

describe("SlackInstructionProvider — cross-tenant guard", () => {
  test("orgless context: leaks no Slack identity and does NOT read connections", async () => {
    let getCalled = false;
    const manager = {
      getConnection: async () => {
        getCalled = true;
        return {
          metadata: { botUsername: "foreign-bot", botUserId: "UFOREIGN" },
        };
      },
    } as never;
    const provider = new SlackInstructionProvider(manager);

    const result = await provider.getInstructions(
      ctx({ organizationId: undefined, connectionId: undefined })
    );

    // No connection read happened at all — nothing to leak.
    expect(getCalled).toBe(false);
    expect(result).not.toContain("foreign");
    // The participation framing is unconditional; only the handle is gated.
    expect(result).toContain("participant in this conversation");
  });

  test("org-present: reads connections INSIDE the token org and returns the identity", async () => {
    let seenOrg: string | undefined;
    const manager = {
      getConnection: async (_connectionId: string) => {
        // Capture the AMBIENT org the read runs under (must be the token org).
        seenOrg = orgContext.getStore()?.organizationId;
        return { metadata: { botUsername: "acme-bot", botUserId: "UACME" } };
      },
    } as never;
    const provider = new SlackInstructionProvider(manager);

    const result = await provider.getInstructions(
      ctx({ organizationId: "acme-org" })
    );

    expect(seenOrg).toBe("acme-org");
    expect(result).toContain("@acme-bot");
    expect(result).toContain("UACME");
    expect(result).not.toContain("foreign");
  });
});
/**
 * The joint the other two tests leave open.
 *
 * `agent-turn-producer.test.ts` proves the composer places a platform block
 * between "Agent Instructions" and "Built-In Tool Policies", but it registers
 * a FAKE provider that returns a hand-written string. The tests above prove
 * `SlackInstructionProvider` renders the right content and reads no foreign
 * tenant. Neither shows that what the real provider emits is the shape the
 * composer places — the `api` platform registers no provider
 * (`gateway/api/platform.ts` returns null), so the live Direct-API harness
 * structurally cannot see this either.
 *
 * Asserted here on the provider's real output so the two halves meet without
 * needing a Slack workspace: the block is a `**Slack identity:**` section that
 * starts on its own line and ends without a trailing blank line, which is what
 * lets the composer join it between two `##` headings.
 */
describe("SlackInstructionProvider — composable block shape", () => {
  test("emits a self-contained identity section the composer can place between headings", async () => {
    const manager = {
      getConnection: async () => ({
        metadata: { botUsername: "lobu", botUserId: "U123" },
      }),
    } as never;
    const provider = new SlackInstructionProvider(manager);

    const result = await provider.getInstructions(
      ctx({ organizationId: "acme-org", connectionId: "conn-slack-1" })
    );

    expect(result).toBeTruthy();
    const block = result as string;
    // Starts and ends cleanly: the composer concatenates with its own blank
    // lines, so a leading or trailing one here would double them and break the
    // exact-string placement assertion in the producer test.
    expect(block).toBe(block.trim());
    expect(block).toContain("**Slack identity:**");
    // The bot handle and id both reach the model, and the Slack-specific
    // mention encoding is appended by the subclass.
    expect(block).toContain("@lobu");
    expect(block).toContain("U123");
    expect(block).toContain("<@U123>");
    // Placeable: dropping it between two markdown headings must not introduce
    // a heading of its own that would reorder the prompt's sections.
    expect(block).not.toMatch(/^#/m);
  });
});
