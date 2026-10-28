import { describe, expect, it } from "bun:test";
import { executeTool, type AuthContext } from "../../tools/execute";
import { ToolUserError } from "../../utils/errors";

const baseAuth: AuthContext = {
  organizationId: "8dc12bdd-5d8c-4768-a2e9-a18005cc5ebd",
  tokenOrganizationId: "8dc12bdd-5d8c-4768-a2e9-a18005cc5ebd",
  userId: "user_test",
  memberRole: "owner",
  agentId: null,
  requestedAgentId: null,
  isAuthenticated: true,
  clientId: "test_client",
  scopes: ["mcp:read", "mcp:write", "mcp:admin"],
  tokenType: "oauth",
  requestUrl: "http://localhost:8787/api/test/query_sdk",
  baseUrl: "http://localhost:8787",
  scopedToOrg: false,
  allowCrossOrg: true,
};

describe("executeTool input-schema validation", () => {
  it("query_sdk with missing 'script' returns a ToolUserError naming the field", async () => {
    let caught: unknown;
    try {
      await executeTool("query_sdk", {}, {} as never, baseAuth);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolUserError);
    const err = caught as ToolUserError;
    expect(err.httpStatus).toBe(400);
    expect(err.message).toMatch(/script/);
    // Don't assert exact wording — only that the field name is in it.
  });

  it("query_sdk with { code: ... } (LLM typo) still reports 'script' missing", async () => {
    let caught: unknown;
    try {
      await executeTool(
        "query_sdk",
        { code: "export default async () => ({ ok: true });" },
        {} as never,
        baseAuth,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolUserError);
    expect((caught as ToolUserError).message).toMatch(/script/);
  });

  it("run_sdk with missing 'script' returns a ToolUserError naming the field", async () => {
    let caught: unknown;
    try {
      await executeTool("run_sdk", { dry_run: true }, {} as never, baseAuth);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolUserError);
    expect((caught as ToolUserError).httpStatus).toBe(400);
    expect((caught as ToolUserError).message).toMatch(/script/);
  });

  it("query_sdk with valid args passes validation (failure beyond the boundary is fine)", async () => {
    // A valid call passes the boundary validator. The handler may still fail
    // downstream (no real DB in this unit test), but the failure must NOT be
    // a ToolUserError from `validateToolArgs`. That's the contract we care
    // about: schema-valid input is forwarded to the handler unchanged.
    let caught: unknown;
    try {
      await executeTool(
        "query_sdk",
        { script: "export default async () => 1" },
        {} as never,
        baseAuth,
      );
    } catch (err) {
      caught = err;
    }
    if (caught instanceof ToolUserError) {
      expect(caught.message).not.toMatch(/Invalid arguments/);
    }
  });
});
