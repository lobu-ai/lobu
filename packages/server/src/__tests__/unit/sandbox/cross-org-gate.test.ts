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
    await expect(sdk.org("acme")).rejects.toBeInstanceOf(CrossOrgAccessDenied);
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
