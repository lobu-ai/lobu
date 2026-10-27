import { describe, expect, it } from "bun:test";
import { saveContent } from "../../tools/save_content";
import type { ToolContext } from "../../tools/registry";

const args = { content: "x", semantic_type: "content", metadata: {} } as never;
const baseCtx: ToolContext = {
  organizationId: "org_test",
  userId: "user_visitor",
  memberRole: null,
  isAuthenticated: true,
  tokenType: "oauth",
  scopedToOrg: false,
  allowCrossOrg: true,
  scopes: ["mcp:write"],
};
const ctx = (overrides: Partial<ToolContext>): ToolContext => ({ ...baseCtx, ...overrides });

describe("saveContent org-level write gate", () => {
  it("rejects an authenticated non-member", async () => {
    await expect(saveContent(args, {} as never, ctx({}))).rejects.toThrow(
      /workspace membership with write access/i,
    );
  });

  it("rejects a member without mcp:write scope", async () => {
    await expect(
      saveContent(args, {} as never, ctx({ memberRole: "member", scopes: ["mcp:read"] })),
    ).rejects.toThrow(/save_memory needs write access.*approved read-only/i);
  });

  it("system contexts (userId=null + auth=true) bypass the gate", async () => {
    // The access gate must not fire; we can't reach the DB in this unit test,
    // so success means we got past the gate (and died at `ensureMemberEntityType`).
    let bypassedGate = false;
    try {
      await saveContent(args, {} as never, ctx({ userId: null }));
    } catch (err) {
      bypassedGate = !/membership|MCP session/i.test(String(err));
    }
    expect(bypassedGate).toBe(true);
  });
});
