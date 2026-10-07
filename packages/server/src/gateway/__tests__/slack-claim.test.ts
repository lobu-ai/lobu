/**
 * The Slack adapter (`slackClaimProvider`) for the provider-agnostic claim
 * engine. This tests the AUTHORITY half Slack owns: the workspace-admin verdict
 * (`authorize`), the Grid installer-identity match, plain-workspace rejection,
 * idempotent existing-binding detection, and the bind→bindingId mapping. The
 * org-resolution / confirm-before-bind flow lives in the engine and is covered
 * by `connection-claim.test.ts`.
 *
 * Pure unit test — the adapter takes every Slack dependency by injection, so no
 * DB / HTTP / server boot is needed.
 */

import { describe, expect, mock, test } from "bun:test";
import { CrossOrgTransferBlockedError } from "../../lobu/stores/app-installation-store.js";
import { ClaimMoveBlockedError } from "../connections/connection-claim.js";
import { slackClaimProvider } from "../connections/slack-claim.js";
import type { SlackClaimProviderDeps } from "../connections/slack-claim.js";
import type { SlackPendingInstall } from "../../lobu/stores/slack-installations.js";
import { normalizeSlackUserId } from "@lobu/connectors/slack-identity";

const TEAM = "T-CLAIM";

function pendingInstall(
  overrides: Partial<SlackPendingInstall> = {},
): SlackPendingInstall {
  return {
    id: "1",
    teamId: TEAM,
    teamName: "Acme",
    botUserId: "B123",
    installerUserId: "U-INSTALLER",
    botToken: "xoxb-workspace-token",
    isEnterpriseInstall: false,
    enterpriseId: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SlackClaimProviderDeps> = {}): {
  deps: SlackClaimProviderDeps;
  claim: ReturnType<typeof mock>;
  stampSlackIdentityForUser: ReturnType<typeof mock>;
} {
  const claim = mock(async () => ({ installationId: "slackinst-bound" }));
  const stampSlackIdentityForUser = mock(async () => {});
  const deps: SlackClaimProviderDeps = {
    resolvePending: mock(async () => pendingInstall()),
    resolveActiveOrgSlug: mock(async () => null),
    resolveActiveBindingElsewhere: mock(async () => null),
    resolveClaimerSlackIdentities: mock(async () => [
      { teamId: TEAM, slackUserId: "U-ADMIN" },
    ]),
    stampSlackIdentityForUser,
    usersInfo: mock(async () => ({ isAdmin: true, isOwner: false })),
    claim,
    ...overrides,
  };
  return { deps, claim, stampSlackIdentityForUser };
}

/** The `{teamId, platformUserId}` pairs a bind linked, for order-free asserts. */
function linkedPairs(
  linkMock: ReturnType<typeof mock>,
): Array<{ teamId: string | undefined; platformUserId: string }> {
  // stampSlackIdentityForUser(userId, teamId, slackUserId) — positional.
  return linkMock.mock.calls.map((c) => ({
    teamId: c[1] as string | undefined,
    platformUserId: c[2] as string,
  }));
}

describe("slackClaimProvider.authorize", () => {
  test("authorizes a signed-in workspace admin, carrying the workspace name", async () => {
    const { deps } = makeDeps();
    const provider = slackClaimProvider(deps);
    const verdict = await provider.authorize("user-1", pendingInstall());
    expect(verdict).toEqual({ status: "authorized", subjectName: "Acme" });
  });

  test("owner (not admin) is also authorized", async () => {
    const { deps } = makeDeps({
      usersInfo: mock(async () => ({ isAdmin: false, isOwner: true })),
    });
    const verdict = await slackClaimProvider(deps).authorize(
      "user-1",
      pendingInstall(),
    );
    expect(verdict.status).toBe("authorized");
  });

  test("a non-admin, non-owner is not_authorized with code not_admin", async () => {
    const { deps } = makeDeps({
      usersInfo: mock(async () => ({ isAdmin: false, isOwner: false })),
    });
    const verdict = await slackClaimProvider(deps).authorize(
      "user-1",
      pendingInstall(),
    );
    expect(verdict).toEqual({ status: "not_authorized", code: "not_admin" });
  });

  test("no workspace identity → signin_required{signinProvider:slack} before any Slack call", async () => {
    const usersInfo = mock(async () => ({ isAdmin: true, isOwner: true }));
    const { deps } = makeDeps({
      resolveClaimerSlackIdentities: mock(async () => []),
      usersInfo,
    });
    const verdict = await slackClaimProvider(deps).authorize(
      "user-1",
      pendingInstall(),
    );
    expect(verdict).toEqual({
      status: "signin_required",
      signinProvider: "slack",
    });
    expect(usersInfo).not.toHaveBeenCalled();
  });

  test("Grid org-admin with an installer-id match (enterpriseId set) is authorized without a Slack call", async () => {
    const usersInfo = mock(async () => ({ isAdmin: false, isOwner: false }));
    const { deps } = makeDeps({
      resolveClaimerSlackIdentities: mock(async () => [
        // A DIFFERENT workspace's identity — not TEAM-scoped.
        { teamId: "T-OTHER", slackUserId: "U-INSTALLER" },
      ]),
      usersInfo,
    });
    const verdict = await slackClaimProvider(deps).authorize(
      "user-1",
      pendingInstall({ installerUserId: "U-INSTALLER", enterpriseId: "E-GRID" }),
    );
    expect(verdict.status).toBe("authorized");
    expect(usersInfo).not.toHaveBeenCalled();
  });

  test("Grid installer match is case-insensitive on both sides", async () => {
    // The entity-graph identity source yields the raw `team:user` identifier
    // (the account / linked-chat sources uppercase; that one does not) and
    // `installerUserId` is stored verbatim from Slack. A case-sensitive
    // compare here denies a legitimate Grid admin — and disagrees with `bind`,
    // which normalizes. Fail-closed, but still wrong.
    const { deps } = makeDeps({
      resolveClaimerSlackIdentities: mock(async () => [
        { teamId: "t-other", slackUserId: "u-installer" },
      ]),
    });
    const verdict = await slackClaimProvider(deps).authorize(
      "user-1",
      pendingInstall({ installerUserId: "U-INSTALLER", enterpriseId: "E-GRID" }),
    );
    expect(verdict.status).toBe("authorized");
  });

  test("installer-id match on a PLAIN workspace (no enterpriseId) is NOT enough", async () => {
    const { deps } = makeDeps({
      resolveClaimerSlackIdentities: mock(async () => [
        { teamId: "T-OTHER", slackUserId: "U-INSTALLER" },
      ]),
    });
    const verdict = await slackClaimProvider(deps).authorize(
      "user-1",
      pendingInstall({ installerUserId: "U-INSTALLER", enterpriseId: null }),
    );
    expect(verdict).toEqual({
      status: "signin_required",
      signinProvider: "slack",
    });
  });
});

describe("slackClaimProvider.resolveExistingBinding", () => {
  test("returns the org slug when the workspace is already connected", async () => {
    const { deps } = makeDeps({
      resolveActiveOrgSlug: mock(async () => "acme"),
    });
    const existing = await slackClaimProvider(deps).resolveExistingBinding(TEAM);
    expect(existing).toEqual({ orgSlug: "acme" });
  });

  test("returns null when the workspace has no active install", async () => {
    const { deps } = makeDeps({
      resolveActiveOrgSlug: mock(async () => null),
    });
    const existing = await slackClaimProvider(deps).resolveExistingBinding(TEAM);
    expect(existing).toBeNull();
  });
});

describe("slackClaimProvider.resolveActiveBindingElsewhere", () => {
  test("keys the store lookup on the pending's team + enterprise + org-wide flag + target org", async () => {
    const resolveActiveBindingElsewhere = mock(async () => ({
      orgSlug: "other",
      orgName: "Other Org",
      matchKind: "enterprise_scope_overlap" as const,
    }));
    const { deps } = makeDeps({ resolveActiveBindingElsewhere });
    const foreign = await slackClaimProvider(deps).resolveActiveBindingElsewhere(
      TEAM,
      pendingInstall({ enterpriseId: "E-GRID", isEnterpriseInstall: true }),
      "org-target",
    );
    expect(foreign).toEqual({
      orgSlug: "other",
      orgName: "Other Org",
      matchKind: "enterprise_scope_overlap",
    });
    // Forwards enterprise id + the CLAIMING install's org-wide flag.
    expect(resolveActiveBindingElsewhere).toHaveBeenCalledWith(
      TEAM,
      "E-GRID",
      true,
      "org-target",
    );
  });

  test("passes a null enterpriseId + false org-wide flag for a plain workspace", async () => {
    const resolveActiveBindingElsewhere = mock(async () => null);
    const { deps } = makeDeps({ resolveActiveBindingElsewhere });
    await slackClaimProvider(deps).resolveActiveBindingElsewhere(
      TEAM,
      pendingInstall({ enterpriseId: null, isEnterpriseInstall: false }),
      "org-target",
    );
    expect(resolveActiveBindingElsewhere).toHaveBeenCalledWith(
      TEAM,
      null,
      false,
      "org-target",
    );
  });
});

describe("slackClaimProvider.bind", () => {
  test("maps the Slack installationId onto the engine's bindingId contract", async () => {
    const { deps, claim } = makeDeps();
    const result = await slackClaimProvider(deps).bind(
      pendingInstall(),
      "org-1",
      "user-1",
      false,
    );
    expect(result).toEqual({ bindingId: "slackinst-bound" });
    expect(claim).toHaveBeenCalledTimes(1);
    const [boundPending, boundOrg, boundConfirmMove] = claim.mock.calls[0]!;
    expect((boundPending as SlackPendingInstall).teamId).toBe(TEAM);
    expect(boundOrg).toBe("org-1");
    expect(boundConfirmMove).toBe(false);
  });

  test("forwards confirmMove:true to the store claim (deliberate move)", async () => {
    const { deps, claim } = makeDeps();
    await slackClaimProvider(deps).bind(pendingInstall(), "org-1", "user-1", true);
    expect(claim.mock.calls[0]![2]).toBe(true);
  });

  test("translates a store CrossOrgTransferBlockedError into ClaimMoveBlockedError carrying the other org", async () => {
    // The atomic (raced) path: deps.claim throws the store-specific error; the
    // adapter must re-resolve the incumbent org and rethrow the engine's
    // provider-agnostic ClaimMoveBlockedError so the engine returns a 409.
    const resolveActiveBindingElsewhere = mock(async () => ({
      orgSlug: "incumbent",
      orgName: "Incumbent Org",
      matchKind: "same_workspace" as const,
    }));
    const { deps } = makeDeps({
      resolveActiveBindingElsewhere,
      claim: mock(async () => {
        throw new CrossOrgTransferBlockedError("org-incumbent");
      }),
    });
    const pending = pendingInstall({ enterpriseId: "E-GRID", isEnterpriseInstall: true });
    let thrown: unknown;
    try {
      await slackClaimProvider(deps).bind(pending, "org-target", "user-1", false);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ClaimMoveBlockedError);
    expect((thrown as ClaimMoveBlockedError).existing).toEqual({
      orgSlug: "incumbent",
      orgName: "Incumbent Org",
      matchKind: "same_workspace",
    });
    // Re-resolved against the pending's team + enterprise + org-wide flag + target org.
    expect(resolveActiveBindingElsewhere).toHaveBeenCalledWith(
      TEAM,
      "E-GRID",
      true,
      "org-target",
    );
  });
});

/**
 * Post-claim identity linking. This is a PRIVILEGE-GRANTING write: the rows it
 * writes are what privilege resolution later reads to scope a Slack `U…`.
 * The invariant under test is that `bind` links
 * ONLY identities the claimer has already proven (via Slack OIDC / `/lobu link`),
 * and stamps the install's tenant key ONLY when the claimer is provably the
 * installer — never on `pending.installerUserId` alone.
 */
describe("slackClaimProvider.bind — identity linking", () => {
  test("links every team-scoped identity the claimer signed in with", async () => {
    const { deps, stampSlackIdentityForUser } = makeDeps({
      resolveClaimerSlackIdentities: mock(async () => [
        { teamId: TEAM, slackUserId: "U-ADMIN" },
        { teamId: "T-OTHER", slackUserId: "U-ELSEWHERE" },
      ]),
    });
    await slackClaimProvider(deps).bind(
      pendingInstall({ installerUserId: "U-INSTALLER" }),
      "org-1",
      "user-1",
      false,
    );
    expect(linkedPairs(stampSlackIdentityForUser)).toEqual([
      { teamId: TEAM, platformUserId: "U-ADMIN" },
      { teamId: "T-OTHER", platformUserId: "U-ELSEWHERE" },
    ]);
    // Every link is written for the CLAIMING user, never a third party.
    for (const call of stampSlackIdentityForUser.mock.calls) {
      expect(call[0] as string).toBe("user-1");
    }
  });

  test("does not persist an unscoped identity from an account without an id_token", async () => {
    const { deps, stampSlackIdentityForUser } = makeDeps({
      resolveClaimerSlackIdentities: mock(async () => [
        { teamId: "", slackUserId: "U-ADMIN" },
      ]),
    });
    await slackClaimProvider(deps).bind(
      pendingInstall({ installerUserId: "U-INSTALLER" }),
      "org-1",
      "user-1",
      false,
    );
    expect(stampSlackIdentityForUser).not.toHaveBeenCalled();
  });

  test("does NOT link the installer's U… when a different admin claims a plain workspace", async () => {
    // The takeover case: U-ADMIN claims an install performed by U-INSTALLER on
    // a plain workspace. Linking the installer id here would hand U-ADMIN the
    // installer's identity — and admin-tools privileges on that U….
    const { deps, stampSlackIdentityForUser } = makeDeps({
      resolveClaimerSlackIdentities: mock(async () => [
        { teamId: TEAM, slackUserId: "U-ADMIN" },
      ]),
    });
    await slackClaimProvider(deps).bind(
      pendingInstall({ installerUserId: "U-INSTALLER", enterpriseId: null }),
      "org-1",
      "user-1",
      false,
    );
    expect(linkedPairs(stampSlackIdentityForUser)).toEqual([
      { teamId: TEAM, platformUserId: "U-ADMIN" },
    ]);
    expect(
      linkedPairs(stampSlackIdentityForUser).some(
        (p) => p.platformUserId === "U-INSTALLER",
      ),
    ).toBe(false);
  });

  test("stamps the install team key when the claimer IS the installer (plain: same team + same U…)", async () => {
    const { deps, stampSlackIdentityForUser } = makeDeps({
      resolveClaimerSlackIdentities: mock(async () => [
        { teamId: TEAM, slackUserId: "U-INSTALLER" },
      ]),
    });
    await slackClaimProvider(deps).bind(
      pendingInstall({ installerUserId: "U-INSTALLER", enterpriseId: null }),
      "org-1",
      "user-1",
      false,
    );
    expect(linkedPairs(stampSlackIdentityForUser)).toContainEqual({
      teamId: TEAM,
      platformUserId: "U-INSTALLER",
    });
    expect(stampSlackIdentityForUser).toHaveBeenCalledTimes(1);
  });

  test("plain workspace: matching U… on a DIFFERENT team does not stamp the install key", async () => {
    // Plain-workspace `U…` ids are workspace-LOCAL, so the same U… on another
    // team is a different human. Only same-team + same-U counts.
    const { deps, stampSlackIdentityForUser } = makeDeps({
      resolveClaimerSlackIdentities: mock(async () => [
        { teamId: "T-OTHER", slackUserId: "U-INSTALLER" },
      ]),
    });
    await slackClaimProvider(deps).bind(
      pendingInstall({ installerUserId: "U-INSTALLER", enterpriseId: null }),
      "org-1",
      "user-1",
      false,
    );
    expect(linkedPairs(stampSlackIdentityForUser)).toEqual([
      { teamId: "T-OTHER", platformUserId: "U-INSTALLER" },
    ]);
    // No row under the INSTALL's team — that would be the collision takeover.
    expect(
      linkedPairs(stampSlackIdentityForUser).some((p) => p.teamId === TEAM),
    ).toBe(false);
  });

  test("Grid: matching U… on any team DOES stamp the install key (U is enterprise-global)", async () => {
    const { deps, stampSlackIdentityForUser } = makeDeps({
      resolveClaimerSlackIdentities: mock(async () => [
        { teamId: "T-OTHER", slackUserId: "U-INSTALLER" },
      ]),
    });
    await slackClaimProvider(deps).bind(
      pendingInstall({
        installerUserId: "U-INSTALLER",
        enterpriseId: "E-GRID",
        isEnterpriseInstall: true,
      }),
      "org-1",
      "user-1",
      false,
    );
    expect(linkedPairs(stampSlackIdentityForUser)).toContainEqual({
      teamId: TEAM,
      platformUserId: "U-INSTALLER",
    });
  });

  test("persists identities CANONICALIZED so uppercase inbound events resolve them", async () => {
    // The entity-graph source yields the raw `team:user` identifier, so a
    // lowercase pair can arrive here. `resolveChatUserIdentity` is an exact
    // SQL match with no folding — a row stored as `t-claim/u-installer` can
    // never serve an inbound Slack event carrying `T-CLAIM/U-INSTALLER`, and
    // the claimed installer silently loses admin-tools privileges. Worse, the
    // case-insensitive already-linked check would suppress the canonical
    // write, so the uppercase row never gets created either.
    const { deps, stampSlackIdentityForUser } = makeDeps({
      resolveClaimerSlackIdentities: mock(async () => [
        { teamId: "t-claim", slackUserId: "u-installer" },
      ]),
    });
    await slackClaimProvider(deps).bind(
      pendingInstall({ installerUserId: "U-INSTALLER", enterpriseId: null }),
      "org-1",
      "user-1",
      false,
    );
    // Canonicalization is `stampSlackIdentityForUser`'s job (it runs every
    // write through `normalizeSlackUserId`), so assert the KEY that reaches the
    // graph rather than the raw arguments — that is what an inbound event
    // matches against.
    const keys = linkedPairs(stampSlackIdentityForUser).map((p) =>
      normalizeSlackUserId(p.teamId, p.platformUserId),
    );
    expect(keys).toContain(`${TEAM}:U-INSTALLER`);
    // And no raw-case key survives normalization.
    expect(keys.some((k) => k !== k?.toUpperCase())).toBe(false);
  });

  test("a claimer with no proven identities links nothing", async () => {
    const { deps, stampSlackIdentityForUser } = makeDeps({
      resolveClaimerSlackIdentities: mock(async () => []),
    });
    await slackClaimProvider(deps).bind(
      pendingInstall({ installerUserId: "U-INSTALLER" }),
      "org-1",
      "user-1",
      false,
    );
    expect(stampSlackIdentityForUser).not.toHaveBeenCalled();
  });

  test("a link failure is swallowed — the claim still returns its bindingId", async () => {
    // The claim is already committed when linking runs; a link error must not
    // fail the bind the user is waiting on. Identity can be healed later.
    const { deps } = makeDeps({
      stampSlackIdentityForUser: mock(async () => {
        throw new Error("db down");
      }),
    });
    const result = await slackClaimProvider(deps).bind(
      pendingInstall(),
      "org-1",
      "user-1",
      false,
    );
    expect(result).toEqual({ bindingId: "slackinst-bound" });
  });
});

describe("slackClaimProvider creator identity", () => {
  test("passes the verified Lobu claimant, not the provider installer id, to persistence", async () => {
    const { deps, claim } = makeDeps();
    const pending = pendingInstall();
    await slackClaimProvider(deps).bind(pending, "test-org", "test-lobu-claimant", false);
    expect(claim).toHaveBeenCalledWith(pending, "test-org", false, "test-lobu-claimant");
  });
});
