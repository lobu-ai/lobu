/**
 * Integration tests for `ClientSDK.org()` — the cross-org accessor.
 *
 * Exercises the real `organization` / `member` tables. Covers slug and id
 * resolution, AccessDenied / OrgNotFound error shape, public-workspace
 * fallback, and immediate membership revocation.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import {
  buildClientSDK,
  CrossOrgAccessDenied,
} from "../../../sandbox/client-sdk";
import type { ToolContext } from "../../../tools/registry";
import { type AuthContext, executeTool, toToolContext } from "../../../tools/execute";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from "../../setup/test-fixtures";

const testEnv: Env = {
  ENVIRONMENT: "test",
  DATABASE_URL: process.env.DATABASE_URL,
};

describe("ClientSDK.org() accessor", () => {
  let orgA: Awaited<ReturnType<typeof createTestOrganization>>;
  let orgB: Awaited<ReturnType<typeof createTestOrganization>>;
  let orgPublic: Awaited<ReturnType<typeof createTestOrganization>>;
  let user1: Awaited<ReturnType<typeof createTestUser>>;
  let user2: Awaited<ReturnType<typeof createTestUser>>;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    orgA = await createTestOrganization({ name: "Org A", slug: "org-a-sdk" });
    orgB = await createTestOrganization({ name: "Org B", slug: "org-b-sdk" });
    orgPublic = await createTestOrganization({
      name: "Org Public",
      slug: "org-public-sdk",
      visibility: "public",
    });
    user1 = await createTestUser({ email: "user1-sdk@test.example.com" });
    user2 = await createTestUser({ email: "user2-sdk@test.example.com" });
    await addUserToOrganization(user1.id, orgA.id, "owner");
    await addUserToOrganization(user2.id, orgB.id, "admin");
  });

  function buildCtx(
    userId: string,
    orgId: string,
    grantedOrganizationIds: string[] = [orgId]
  ): ToolContext {
    return {
      organizationId: orgId,
      userId,
      memberRole: "owner",
      isAuthenticated: true,
      tokenType: "oauth",
      scopes: ["mcp:read", "mcp:write", "mcp:admin"],
      scopedToOrg: false,
      allowCrossOrg: grantedOrganizationIds.length > 0,
      grantedOrganizationIds,
      directSearchFederation: grantedOrganizationIds.length > 1,
    };
  }

  describe("buildClientSDK", () => {
    it("exposes every namespace", () => {
      const ctx = buildCtx(user1.id, orgA.id);
      const sdk = buildClientSDK(ctx, testEnv);
      expect(sdk.entities).toBeDefined();
      expect(sdk.entitySchema).toBeDefined();
      expect(sdk.connections).toBeDefined();
      expect(sdk.feeds).toBeDefined();
      expect(sdk.authProfiles).toBeDefined();
      expect(sdk.operations).toBeDefined();
      expect(sdk.automations).toBeDefined();
      expect(sdk.classifiers).toBeDefined();
      expect(sdk.viewTemplates).toBeDefined();
      expect(sdk.knowledge).toBeDefined();
      expect(sdk.organizations).toBeDefined();
      expect(sdk.query).toBeInstanceOf(Function);
      expect(sdk.log).toBeInstanceOf(Function);
      expect(sdk.org).toBeInstanceOf(Function);
    });

    it(".org() denies a private org outside the explicit grant", async () => {
      const ctx = buildCtx(user1.id, orgA.id);
      const sdk = buildClientSDK(ctx, testEnv);
      await expect(sdk.org(orgB.slug)).rejects.toBeInstanceOf(
        CrossOrgAccessDenied
      );
    });

    it(".org() accepts an explicit selection of the sole granted workspace", async () => {
      const ctx = buildCtx(user1.id, orgA.id, [orgA.id]);
      const sdk = buildClientSDK(ctx, testEnv);
      const selected = await sdk.org(orgA.slug);
      expect(selected).toBeDefined();
      expect(selected).not.toBe(sdk);
    });

    it(".org() does not treat a public workspace as an ambient OAuth grant", async () => {
      const ctx = buildCtx(user1.id, orgA.id);
      const sdk = buildClientSDK(ctx, testEnv);
      await expect(sdk.org(orgPublic.slug)).rejects.toBeInstanceOf(
        CrossOrgAccessDenied
      );
    });
  });

  describe("buildClientSDK with user1 also a member of orgB", () => {
    beforeAll(async () => {
      await addUserToOrganization(user1.id, orgB.id, "member");
    });

    it("organizations.list keeps public inventory but hides an ungranted member workspace", async () => {
      const ctx = buildCtx(user1.id, orgA.id, [orgA.id]);
      const organizations = await buildClientSDK(ctx, testEnv).organizations.list();
      expect(organizations.map((organization) => organization.id)).toContain(orgA.id);
      expect(organizations.map((organization) => organization.id)).toContain(orgPublic.id);
      expect(organizations.map((organization) => organization.id)).not.toContain(orgB.id);
    });

    it("organizations.list preserves membership discovery when no OAuth grant snapshot exists", async () => {
      const ctx = {
        ...buildCtx(user1.id, orgA.id),
        tokenType: "pat" as const,
        allowCrossOrg: false,
        grantedOrganizationIds: null,
        directSearchFederation: false,
      };
      const organizations = await buildClientSDK(ctx, testEnv).organizations.list();
      expect(organizations.map((organization) => organization.id)).toContain(orgA.id);
      expect(organizations.map((organization) => organization.id)).toContain(orgB.id);
    });

    it(".org() returns a fresh SDK for the other member org", async () => {
      const ctx = buildCtx(user1.id, orgA.id, [orgA.id, orgB.id]);
      const sdk = buildClientSDK(ctx, testEnv);
      const sdkB = await sdk.org(orgB.slug);
      expect(sdkB).toBeDefined();
      expect(sdkB).not.toBe(sdk);
      expect(sdkB.org).toBeInstanceOf(Function);
    });

    it("chained .org() re-validates against the original user", async () => {
      const ctx = buildCtx(user1.id, orgA.id, [orgA.id, orgB.id]);
      const sdk = buildClientSDK(ctx, testEnv);
      const sdkB = await sdk.org(orgB.slug);
      const sdkBackToA = await sdkB.org(orgA.slug);
      expect(sdkBackToA).toBeDefined();
    });

    it("revocation is detected after explicit cache invalidation", async () => {
      const ctx = buildCtx(user1.id, orgA.id, [orgA.id, orgB.id]);
      const sdk = buildClientSDK(ctx, testEnv);
      await sdk.org(orgB.slug);

      const sql = getTestDb();
      await sql`DELETE FROM "member" WHERE "userId" = ${user1.id} AND "organizationId" = ${orgB.id}`;

      await expect(sdk.org(orgB.slug)).rejects.toBeInstanceOf(
        CrossOrgAccessDenied
      );
    });

    it("rejects workspace changes for an agent-bound session", async () => {
      await addUserToOrganization(user1.id, orgB.id, "member");
      const ctx = {
        ...buildCtx(user1.id, orgA.id, [orgA.id, orgB.id]),
        agentId: "workspace-agent",
      };
      const sdk = buildClientSDK(ctx, testEnv);
      await expect(sdk.org(orgB.slug)).rejects.toThrow(/cannot change workspaces/i);
    });

    it("projects an agent-bound grant to the anchor for query_sql and organization discovery", async () => {
      const rawAuth = {
        ...buildCtx(user1.id, orgA.id, [orgA.id, orgB.id]),
        tokenOrganizationId: orgA.id,
        agentId: "workspace-agent",
        requestedAgentId: "workspace-agent",
        actingAutomationId: null,
        clientId: "agent-bound-client",
        requestUrl: "http://localhost/mcp",
        baseUrl: "http://localhost",
      } as AuthContext;
      const projected = toToolContext(rawAuth);
      expect(projected.allowCrossOrg).toBe(false);
      expect(projected.directSearchFederation).toBe(false);
      expect(projected.grantedOrganizationIds).toEqual([orgA.id]);

      await expect(executeTool(
        "query_sql", { sql: "SELECT 1", org_slug: orgB.slug }, testEnv, rawAuth
      )).rejects.toThrow(/not available/);

      const organizations = await buildClientSDK(projected, testEnv).organizations.list();
      expect(organizations.map((organization) => organization.id)).toContain(orgA.id);
      expect(organizations.map((organization) => organization.id)).not.toContain(orgB.id);
    });
  });

  describe("non-member isolation", () => {
    it("user2 cannot access orgA", async () => {
      const ctx = buildCtx(user2.id, orgB.id, [orgB.id, orgA.id]);
      const sdk = buildClientSDK(ctx, testEnv);
      await expect(sdk.org(orgA.slug)).rejects.toBeInstanceOf(
        CrossOrgAccessDenied
      );
    });
  });
});
