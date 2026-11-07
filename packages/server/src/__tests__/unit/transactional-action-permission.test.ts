import { describe, expect, it } from "bun:test";
import { requireActionPermission } from "../../actions/registry";
import type { DbClient } from "../../db/client";
import { AccessDeniedError, McpScopeRequiredError } from "../../tools/access-control";
import type { ToolContext } from "../../tools/registry";

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    organizationId: "synthetic-action-org",
    userId: "synthetic-action-user",
    memberRole: "owner",
    isAuthenticated: true,
    tokenType: "oauth",
    scopes: ["mcp:admin"],
    sourceContext: null,
    scopedToOrg: true,
    allowCrossOrg: false,
    grantedOrganizationIds: null,
    directSearchFederation: false,
    ...overrides,
  };
}

function transaction(role: string | null) {
  const statements: string[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    statements.push(query);
    expect(values).toContain("synthetic-action-org");
    if (query.includes('FROM "member"')) return role ? [{ role }] : [];
    if (query.includes("FROM organization")) return [{ slug: "synthetic-actions" }];
    throw new Error("Unexpected transaction query");
  }) as unknown as DbClient;
  return { sql, statements };
}

describe("transactional action permission denials", () => {
  it("uses the transaction for progressive admin-scope denial formatting", async () => {
    const tx = transaction("owner");
    await expect(requireActionPermission(tx.sql, context({ scopes: ["mcp:write"] }), "admin"))
      .rejects.toBeInstanceOf(McpScopeRequiredError);
    expect(tx.statements).toHaveLength(2);
    expect(tx.statements[1]).toContain("FROM organization");
  });

  it("uses fresh membership rather than a stale privileged context", async () => {
    const tx = transaction("member");
    await expect(requireActionPermission(tx.sql, context(), "admin"))
      .rejects.toBeInstanceOf(AccessDeniedError);
    expect(tx.statements).toHaveLength(2);
  });

  it("keeps missing token scopes fail-closed without acquiring another connection", async () => {
    const tx = transaction("owner");
    await expect(requireActionPermission(tx.sql, context({ scopes: undefined }), "write"))
      .rejects.toBeInstanceOf(AccessDeniedError);
    expect(tx.statements).toHaveLength(2);
  });

  it("does not resolve a denial slug for an authorized call", async () => {
    const tx = transaction("owner");
    await requireActionPermission(tx.sql, context(), "admin");
    expect(tx.statements).toHaveLength(1);
  });

  it("rejects a removed member before scope formatting", async () => {
    const tx = transaction(null);
    await expect(requireActionPermission(tx.sql, context(), "write")).rejects.toThrow("membership");
    expect(tx.statements).toHaveLength(1);
  });
});
