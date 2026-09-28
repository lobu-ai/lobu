import { describe, expect, it } from "bun:test";
import { buildClientSDK, CrossOrgAccessDenied } from "../../../sandbox/client-sdk";
import { ctx } from "./_helpers";

const env = {} as never;

describe("cross-org gate", () => {
  it.each([
    ["scoped /mcp/{slug}", { scopedToOrg: true, allowCrossOrg: false }],
    ["PAT auth", { tokenType: "pat" as const, allowCrossOrg: false }],
    ["session auth", { tokenType: "session" as const, allowCrossOrg: false }],
  ])("%s refuses client.org(other)", async (_label, overrides) => {
    const sdk = buildClientSDK(ctx(overrides), env, {
      mode: "full",
      allowCrossOrg: false,
    });
    const error = await sdk.org("other-workspace").catch((error) => error);
    expect(error).toBeInstanceOf(CrossOrgAccessDenied);
    expect(error).toMatchObject({
      name: "CrossOrgAccessDenied",
      code: "CrossOrgAccessDenied",
      reason: "unavailable",
      workspaceSlug: null,
    });
    expect(error.message).toContain("If the same identity already has access to the target workspace");
    expect(error.message).toContain("invoke there directly via /mcp/{slug}");
    expect(error.message).toContain("--context <context> --org <slug>");
    expect(error.message).toContain("use client directly");
    expect(error.message).not.toMatch(/reconnect|re-consent|other-workspace/i);
  });

  it("explicit allowCrossOrg: false overrides a permissive ToolContext", async () => {
    const sdk = buildClientSDK(ctx({}), env, {
      mode: "full",
      allowCrossOrg: false,
    });
    await expect(sdk.org("acme")).rejects.toBeInstanceOf(CrossOrgAccessDenied);
  });

  it("allowCrossOrg: true still denies a caller without a workspace grant snapshot", async () => {
    // A missing snapshot stays indistinguishable (generic denial, no DB lookup):
    // member-but-ungranted hints only apply when a grant snapshot exists and a
    // live membership check can tell the cases apart. The DB-backed
    // unknown/ungranted/revoked cases live in client-sdk-org.test.ts.
    const sdk = buildClientSDK(ctx({ grantedOrganizationIds: null }), env, {
      mode: "read",
      allowCrossOrg: true,
    });
    await expect(sdk.org("does-not-exist-xyz")).rejects.toBeInstanceOf(
      CrossOrgAccessDenied,
    );
  });
});
