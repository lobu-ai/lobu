import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { orgContext } from "../../lobu/stores/org-context.js";
import { GrantStore } from "../permissions/grant-store.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const ORG_ID = "test-org";

/**
 * Wrap a test body in `orgContext.run` so the GrantStore (which scopes by
 * `tryGetOrgId()` post-Phase-C) can resolve the active org for the seeded
 * agent row. Every test in this file uses the default org_id from
 * `seedAgentRow` ("test-org").
 */
function withOrg<T>(fn: () => Promise<T>): Promise<T> {
  return orgContext.run({ organizationId: ORG_ID }, fn);
}

describe("GrantStore (PG-backed)", () => {
  let store: GrantStore;

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 30_000);

  beforeEach(async () => {
    await resetTestDatabase();
    // grants.agent_id has an FK on agents(id); seed the row used by every
    // test in this file so the inserts below succeed.
    await seedAgentRow("agent-1");
    store = new GrantStore();
  }, 30_000);

  describe("grant", () => {
    test("stores grant without expiry when expiresAt is null", async () => {
      await withOrg(async () => {
        await store.grant("agent-1", "api.openai.com", null);
        const grants = await store.listGrants("agent-1");
        expect(grants).toHaveLength(1);
        expect(grants[0]?.pattern).toBe("api.openai.com");
        expect(grants[0]?.expiresAt).toBeNull();
        expect(grants[0]?.grantedAt).toBeGreaterThan(0);
      });
    });

    test("stores grant with expiry when expiresAt is set", async () => {
      await withOrg(async () => {
        const future = Date.now() + 60_000;
        await store.grant("agent-1", "api.openai.com", future);
        const grants = await store.listGrants("agent-1");
        expect(grants).toHaveLength(1);
        expect(grants[0]?.expiresAt).not.toBeNull();
      });
    });

    test("stores denied grant", async () => {
      await withOrg(async () => {
        await store.grant("agent-1", "evil.com", null, true);
        const grants = await store.listGrants("agent-1");
        expect(grants[0]?.denied).toBe(true);
      });
    });

    test("preserves MCP path casing when storing grants", async () => {
      await withOrg(async () => {
        await store.grant("agent-1", "/mcp/Gmail/tools/SendEmail", null);
        expect(
          await store.hasGrant("agent-1", "/mcp/Gmail/tools/SendEmail")
        ).toBe(true);
      });
    });
  });

  describe("hasGrant", () => {
    test("returns true for existing grant", async () => {
      await withOrg(async () => {
        await store.grant("agent-1", "api.openai.com", null);
        expect(await store.hasGrant("agent-1", "api.openai.com")).toBe(true);
      });
    });

    test("returns false for missing grant", async () => {
      await withOrg(async () => {
        expect(await store.hasGrant("agent-1", "unknown.com")).toBe(false);
      });
    });

    test("returns false for denied grant", async () => {
      await withOrg(async () => {
        await store.grant("agent-1", "evil.com", null, true);
        expect(await store.hasGrant("agent-1", "evil.com")).toBe(false);
      });
    });

    test("matches MCP wildcard pattern", async () => {
      await withOrg(async () => {
        await store.grant("agent-1", "/mcp/gmail/tools/*", null);
        expect(
          await store.hasGrant("agent-1", "/mcp/gmail/tools/send_email")
        ).toBe(true);
      });
    });

    test("matches exact MCP path with original casing", async () => {
      await withOrg(async () => {
        await store.grant("agent-1", "/mcp/Gmail/tools/SendEmail", null);
        expect(
          await store.hasGrant("agent-1", "/mcp/Gmail/tools/SendEmail")
        ).toBe(true);
      });
    });

    test("MCP wildcard denied blocks access", async () => {
      await withOrg(async () => {
        await store.grant("agent-1", "/mcp/gmail/tools/*", null, true);
        expect(
          await store.hasGrant("agent-1", "/mcp/gmail/tools/send_email")
        ).toBe(false);
      });
    });

    test("matches domain wildcard pattern", async () => {
      await withOrg(async () => {
        await store.grant("agent-1", "*.example.com", null);
        expect(await store.hasGrant("agent-1", "api.example.com")).toBe(true);
      });
    });

    test("matches leading-dot domain wildcard pattern", async () => {
      await withOrg(async () => {
        await store.grant("agent-1", ".example.com", null);
        expect(await store.hasGrant("agent-1", "api.example.com")).toBe(true);
      });
    });

    test("domain wildcard matches deeper subdomains (any depth)", async () => {
      await withOrg(async () => {
        await store.grant("agent-1", "*.example.com", null);
        expect(await store.hasGrant("agent-1", "api.v2.example.com")).toBe(
          true
        );
      });
    });

    test("domain wildcard deny blocks deeper subdomains (any depth)", async () => {
      await withOrg(async () => {
        await store.grant("agent-1", "*.evil.com", null, true);
        expect(await store.hasGrant("agent-1", "api.v2.evil.com")).toBe(false);
        expect(await store.isDenied("agent-1", "api.v2.evil.com")).toBe(true);
      });
    });

    test("domain wildcard does not match two-part domains", async () => {
      await withOrg(async () => {
        await store.grant("agent-1", "*.example.com", null);
        expect(await store.hasGrant("agent-1", "example.com")).toBe(false);
      });
    });

    test("domain wildcard denied blocks access", async () => {
      await withOrg(async () => {
        await store.grant("agent-1", "*.evil.com", null, true);
        expect(await store.hasGrant("agent-1", "sub.evil.com")).toBe(false);
      });
    });

    test("exact match takes precedence over wildcards", async () => {
      await withOrg(async () => {
        await store.grant("agent-1", "api.example.com", null);
        expect(await store.hasGrant("agent-1", "api.example.com")).toBe(true);
      });
    });

    test("non-MCP non-domain path returns false", async () => {
      await withOrg(async () => {
        expect(await store.hasGrant("agent-1", "/some/other/path")).toBe(false);
      });
    });

    test("expired grant is filtered out", async () => {
      await withOrg(async () => {
        const past = Date.now() - 1000;
        await store.grant("agent-1", "stale.com", past);
        expect(await store.hasGrant("agent-1", "stale.com")).toBe(false);
      });
    });
  });

  describe("isDenied", () => {
    test("returns true for denied grant", async () => {
      await withOrg(async () => {
        await store.grant("agent-1", "evil.com", null, true);
        expect(await store.isDenied("agent-1", "evil.com")).toBe(true);
      });
    });

    test("returns false for allowed grant", async () => {
      await withOrg(async () => {
        await store.grant("agent-1", "good.com", null);
        expect(await store.isDenied("agent-1", "good.com")).toBe(false);
      });
    });

    test("returns false for missing grant", async () => {
      await withOrg(async () => {
        expect(await store.isDenied("agent-1", "unknown.com")).toBe(false);
      });
    });
  });

  describe("revoke", () => {
    test("removes grant", async () => {
      await withOrg(async () => {
        await store.grant("agent-1", "api.openai.com", null);
        expect(await store.hasGrant("agent-1", "api.openai.com")).toBe(true);
        await store.revoke("agent-1", "api.openai.com");
        expect(await store.hasGrant("agent-1", "api.openai.com")).toBe(false);
      });
    });

    test("removes normalized wildcard grant variants", async () => {
      await withOrg(async () => {
        await store.grant("agent-1", "*.github.com", null);
        expect(await store.hasGrant("agent-1", "api.github.com")).toBe(true);
        await store.revoke("agent-1", ".github.com");
        expect(await store.hasGrant("agent-1", "api.github.com")).toBe(false);
      });
    });
  });

  describe("listGrants", () => {
    test("returns empty array when no grants", async () => {
      await withOrg(async () => {
        const grants = await store.listGrants("agent-1");
        expect(grants).toEqual([]);
      });
    });

    test("lists every active grant for the agent", async () => {
      await withOrg(async () => {
        await store.grant("agent-1", "api.openai.com", null);
        await store.grant("agent-1", "*.github.com", null);
        const grants = await store.listGrants("agent-1");
        expect(grants).toHaveLength(2);
        const patterns = grants.map((g) => g.pattern).sort();
        expect(patterns).toEqual([".github.com", "api.openai.com"]);
      });
    });
  });
});

/**
 * GrantStore org scoping fails closed. `agents_pkey` is (organization_id, id),
 * so the same agent id legitimately exists in many orgs; an unscoped read would
 * answer for every tenant and an unscoped revoke would delete every tenant's
 * grant. Cross-org hasGrant/isDenied are pinned in
 * multi-tenant-isolation-reproducers (finding 2).
 */
describe("GrantStore org scoping", () => {
  const ORG_B = "test-org-b";
  let store: GrantStore;

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 30_000);

  beforeEach(async () => {
    await resetTestDatabase();
    await seedAgentRow("agent-1");
    await seedAgentRow("agent-1", { organizationId: ORG_B });
    store = new GrantStore();
  }, 30_000);

  test("listGrants returns only the calling org's grants", async () => {
    await store.grant("agent-1", "a.example.com", null, false, ORG_ID);
    await store.grant("agent-1", "b.example.com", null, false, ORG_B);

    const grants = await store.listGrants("agent-1", ORG_ID);
    expect(grants.map((g) => g.pattern)).toEqual(["a.example.com"]);
  });

  test("revoke never deletes another org's grant", async () => {
    await store.grant("agent-1", "shared.example.com", null, false, ORG_ID);
    await store.grant("agent-1", "shared.example.com", null, false, ORG_B);

    await store.revoke("agent-1", "shared.example.com", ORG_ID);

    expect(await store.listGrants("agent-1", ORG_ID)).toHaveLength(0);
    expect(await store.listGrants("agent-1", ORG_B)).toHaveLength(1);
  });

  test("throws rather than running unscoped when no org can be resolved", async () => {
    // No orgContext and no explicit org: every method must refuse.
    await expect(store.hasGrant("agent-1", "x.example.com")).rejects.toThrow(
      /GrantStore\.hasGrant requires organizationId/
    );
    await expect(store.listGrants("agent-1")).rejects.toThrow(
      /GrantStore\.listGrants requires organizationId/
    );
    await expect(store.isDenied("agent-1", "x.example.com")).rejects.toThrow(
      /GrantStore\.isDenied requires organizationId/
    );
    await expect(store.revoke("agent-1", "x.example.com")).rejects.toThrow(
      /GrantStore\.revoke requires organizationId/
    );
  });
});
