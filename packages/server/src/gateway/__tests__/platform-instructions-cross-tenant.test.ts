/**
 * R7 #1(a): a platform instruction provider may do an agent-scoped DB read, so
 * `InstructionService.getPlatformInstructions` must skip it for an orgless
 * DB-backed agent (`orgScoped: false`). A shared id (e.g. "lobu-builder",
 * present in every org) would otherwise render another tenant's identity.
 */

import { describe, expect, test } from "bun:test";
import { BaseInstructionProvider, type InstructionContext } from "@lobu/core";
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

describe("platform instructions cross-tenant guard (R7 #1(a))", () => {
  test("the PLATFORM provider is gated by orgScoped — skipped for orgless db-backed", async () => {
    const svc = new InstructionService();
    const leaky = new LeakyPlatformProvider();
    svc.registerPlatformProvider("slack", leaky);

    const result = await svc.getPlatformInstructions(
      "slack",
      ctx({ organizationId: undefined, orgScoped: false })
    );

    // The platform provider was NOT invoked → no foreign platform identity.
    expect(leaky.called).toBe(false);
    expect(result).toBe("");
  });

  test("the PLATFORM provider RUNS for a normal org-scoped agent (regression)", async () => {
    const svc = new InstructionService();
    const leaky = new LeakyPlatformProvider();
    svc.registerPlatformProvider("slack", leaky);

    const result = await svc.getPlatformInstructions(
      "slack",
      ctx({ organizationId: "acme-org", orgScoped: true })
    );

    expect(leaky.called).toBe(true);
    expect(result).toContain("FOREIGN PLATFORM IDENTITY");
  });
});
