/**
 * R6: the orgless cross-tenant guard must cover EVERY agent-scoped read in
 * `/session-context`. A DB-backed shared id (e.g.
 * "lobu-builder", present in every org) with an ORGLESS worker token must NOT
 * id-only read another tenant's identity/soul/skills or derive another tenant's
 * lobu-memory MCP org slug. Declared (SDK-embedded) agents are org-agnostic and
 * must still resolve; a normal org-scoped agent must be fully intact.
 *
 * Drives the REAL InstructionService + McpConfigService with a spy settings
 * store, asserting the `orgScoped` flag gates the by-id reads.
 */

import { describe, expect, test } from "bun:test";
import { BaseInstructionProvider, type InstructionContext } from "@lobu/core";
import { McpConfigService } from "../auth/mcp/config-service.js";
import { InstructionService } from "../services/instruction-service.js";

/** A platform provider that, if not gated, leaks a foreign tenant's identity. */
class LeakyPlatformProvider extends BaseInstructionProvider {
  readonly name = "leaky-platform";
  readonly priority = 20;
  public called = false;
  protected buildInstructions(): string {
    this.called = true;
    return "FOREIGN PLATFORM IDENTITY @foreign-bot UFOREIGN";
  }
}

function makeSettingsStore(opts: { isDeclared: boolean }) {
  const reads: Array<{ agentId: string; organizationId?: string }> = [];
  const store = {
    isDeclaredAgent: () => opts.isDeclared,
    getSettings: async (
      agentId: string,
      ctx?: { organizationId?: string }
    ) => {
      reads.push({ agentId, organizationId: ctx?.organizationId });
      // The FOREIGN tenant's config that must never leak on the orgless path.
      return {
        identityMd: "FOREIGN IDENTITY",
        soulMd: "FOREIGN SOUL",
        userMd: "FOREIGN USER",
        skillsConfig: {
          skills: [
            { name: "foreign-skill", enabled: true, content: "FOREIGN SKILL" },
          ],
        },
      };
    },
  };
  return { store, reads };
}

function makeMcpConfig(resolvedSlug: string | null) {
  const calls: Array<{ agentId: string; organizationId?: string }> = [];
  const service = new McpConfigService({
    lobuMemory: {
      resolveOrgSlug: async (
        agentId: string,
        organizationId: string | undefined
      ) => {
        calls.push({ agentId, organizationId });
        // Mirror the real cross-tenant-safe resolver: null when orgless.
        if (!organizationId) return null;
        return resolvedSlug;
      },
    },
  });
  return { service, calls };
}

function ctx(overrides: Partial<InstructionContext>): InstructionContext {
  return {
    userId: "u1",
    agentId: "lobu-builder",
    sessionKey: "u1",
    workingDirectory: "/workspace",
    availableProjects: [],
    ...overrides,
  };
}

describe("session-context cross-tenant guard (R6) — all agent-scoped reads", () => {
  test("orgless DB-backed shared id: NO foreign identity/soul/skills, NO foreign MCP slug", async () => {
    const { store, reads } = makeSettingsStore({ isDeclared: false });
    const { service: mcp, calls } = makeMcpConfig("foreign-org");
    const svc = new InstructionService(mcp, store as never);

    const result = await svc.getSessionContext(
      "api",
      // orgless (no organizationId) + orgScoped:false — the gateway sets this.
      ctx({ organizationId: undefined, orgScoped: false })
    );

    // Identity/soul/user: NOT the foreign tenant's.
    expect(JSON.stringify(result.agentLayers)).not.toContain("FOREIGN");
    // Skills: generic discovery blurb, NOT the foreign skill content.
    expect(result.skillsInstructions).not.toContain("FOREIGN SKILL");
    // No by-id settings read happened at all.
    expect(reads).toHaveLength(0);
    // MCP: the orgless resolve returned null → no lobu-memory slug leaked.
    expect(result.mcpStatus).toHaveLength(0);
    // resolveOrgSlug was consulted with NO org (so it returned null).
    expect(calls.every((c) => !c.organizationId)).toBe(true);
  });

  test("orgless DECLARED agent: still resolves its (org-agnostic) instructions", async () => {
    const { store } = makeSettingsStore({ isDeclared: true });
    const { service: mcp } = makeMcpConfig("declared-org");
    const svc = new InstructionService(mcp, store as never);

    // A declared agent is org-agnostic → orgScoped is true even with no org.
    const result = await svc.getSessionContext(
      "api",
      ctx({ organizationId: undefined, orgScoped: true })
    );

    // The declared agent's own identity/soul resolve.
    expect(result.agentLayers.identityMd).toContain("FOREIGN IDENTITY");
  });

  test("normal org-scoped agent: identity + skills + MCP all intact (regression)", async () => {
    const { store, reads } = makeSettingsStore({ isDeclared: false });
    const { service: mcp, calls } = makeMcpConfig("acme");
    const svc = new InstructionService(mcp, store as never);

    const result = await svc.getSessionContext(
      "api",
      ctx({ organizationId: "acme-org", orgScoped: true })
    );

    // Settings read happened, org-scoped.
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.organizationId === "acme-org")).toBe(true);
    // Identity + skills resolve.
    expect(result.agentLayers.identityMd).toContain("FOREIGN IDENTITY");
    expect(result.skillsInstructions).toContain("foreign-skill");
    // MCP resolved with the org → a lobu-memory status entry exists.
    expect(result.mcpStatus.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.organizationId === "acme-org")).toBe(true);
  });

  test("R7 #1(a): the PLATFORM provider is gated by orgScoped — skipped for orgless db-backed", async () => {
    const { store } = makeSettingsStore({ isDeclared: false });
    const { service: mcp } = makeMcpConfig(null);
    const svc = new InstructionService(mcp, store as never);
    const leaky = new LeakyPlatformProvider();
    svc.registerPlatformProvider("slack", leaky);

    const result = await svc.getSessionContext(
      "slack",
      ctx({ organizationId: undefined, orgScoped: false })
    );

    // The platform provider was NOT invoked → no foreign platform identity.
    expect(leaky.called).toBe(false);
    expect(result.platformInstructions).toBe("");
  });

  test("R7 #1(a): the PLATFORM provider RUNS for a normal org-scoped agent (regression)", async () => {
    const { store } = makeSettingsStore({ isDeclared: false });
    const { service: mcp } = makeMcpConfig("acme");
    const svc = new InstructionService(mcp, store as never);
    const leaky = new LeakyPlatformProvider();
    svc.registerPlatformProvider("slack", leaky);

    const result = await svc.getSessionContext(
      "slack",
      ctx({ organizationId: "acme-org", orgScoped: true })
    );

    expect(leaky.called).toBe(true);
    expect(result.platformInstructions).toContain("FOREIGN PLATFORM IDENTITY");
  });
});
