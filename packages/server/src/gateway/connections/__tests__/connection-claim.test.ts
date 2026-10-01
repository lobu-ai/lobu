/**
 * The provider-agnostic claim ENGINE (`claimPendingConnection` /
 * `resolveClaimContext`): binds a parked (pending) subject to the claiming
 * user's org once the PROVIDER's authority verdict passes and the user confirms
 * an org. The engine owns org-resolution, two-phase confirm-before-bind,
 * idempotent already-connected success, and the terminal error taxonomy; a stub
 * provider stands in for the authority half so no DB / HTTP / Slack is needed.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  type ClaimAuthorization,
  type ClaimEligibleOrg,
  type ClaimEngineDeps,
  type ClaimForeignBinding,
  ClaimMoveBlockedError,
  type ClaimProvider,
  claimHttpStatus,
  claimPendingConnection,
  resolveClaimContext,
} from "../connection-claim.js";

const REF = "T-CLAIM";

/** The stub provider's pending shape — opaque to the engine. */
interface StubPending {
  ref: string;
  name: string | null;
}

function makeProvider(overrides: Partial<ClaimProvider<StubPending>> = {}): {
  provider: ClaimProvider<StubPending>;
  bind: ReturnType<typeof mock>;
  authorize: ReturnType<typeof mock>;
} {
  const bind = mock(async () => ({ bindingId: "binding-bound" }));
  const authorize = mock(
    async (): Promise<ClaimAuthorization> => ({
      status: "authorized",
      subjectName: "Acme",
    }),
  );
  const provider: ClaimProvider<StubPending> = {
    provider: "stub",
    subjectKind: "workspace",
    resolvePending: mock(async () => ({ ref: REF, name: "Acme" })),
    resolveExistingBinding: mock(async () => null),
    resolveActiveBindingElsewhere: mock(async () => null),
    authorize,
    bind,
    ...overrides,
  };
  return { provider, bind, authorize };
}

function makeDeps(overrides: Partial<ClaimEngineDeps> = {}): ClaimEngineDeps {
  return {
    resolveMemberOrgs: mock(async () => [
      { id: "org-1", slug: "acme", name: "Acme", isPersonal: false },
    ]),
    resolveOrgIfMember: mock(async () => "org-1"),
    resolveOrgSlug: mock(async () => "acme"),
    ...overrides,
  };
}

// A confirmed claim always carries the org the user picked on the claim page —
// the engine rejects an org-less claim (never routes to a default org).
const input = { userId: "user-1", ref: REF, organizationId: "acme" };

test("continues a claimed space in the selected org's normal Automation editor", async () => {
  const { provider } = makeProvider({
    bind: async () => ({ bindingId: "bound", continuation: {
      platform: "test-chat", connection: "test-connection", channelId: "test-chat:rooms/test-room", label: "Test room",
    } }),
  });
  const result = await claimPendingConnection(provider, makeDeps(), input);
  expect(result.status).toBe("ok");
  const next = new URL((result as any).nextUrl, "https://workspace.test");
  expect(next.pathname).toBe("/acme/automations/new");
  expect(next.searchParams.get("connection")).toBe("test-connection");
  expect(next.searchParams.get("listen")).toBe("test-chat:rooms/test-room");
});

test("revisited claims authorize the user before returning their continuation", async () => {
  const existing = mock(async (_ref: string, userId: string) => userId === "user-1" ? {
    orgSlug: "acme", continuation: { platform: "test-chat", connection: "test-connection", channelId: "test-chat:rooms/test-room" },
  } : null);
  const { provider } = makeProvider({ resolvePending: async () => null, resolveExistingBinding: existing });
  const result = await resolveClaimContext(provider, makeDeps(), input);
  expect(result.status).toBe("already_connected");
  expect((result as any).nextUrl).toContain("/acme/automations/new?");
  expect(existing).toHaveBeenCalledWith(REF, "user-1");
});

describe("claimPendingConnection", () => {
  test("binds the subject on the happy path (authorized)", async () => {
    const { provider, bind } = makeProvider();
    const result = await claimPendingConnection(provider, makeDeps(), input);

    expect(result).toEqual({
      status: "ok",
      orgSlug: "acme",
      bindingId: "binding-bound",
    });
    expect(bind).toHaveBeenCalledTimes(1);
    const [boundPending, boundOrg, boundUser] = bind.mock.calls[0]!;
    expect((boundPending as StubPending).ref).toBe(REF);
    expect(boundOrg).toBe("org-1");
    expect(boundUser).toBe("user-1");
  });

  test("binds into the explicitly chosen org (membership-verified)", async () => {
    const { provider, bind } = makeProvider();
    const deps = makeDeps({
      resolveOrgIfMember: mock(async () => "org-2"),
      resolveOrgSlug: mock(async () => "other-org"),
    });
    const result = await claimPendingConnection(provider, deps, {
      ...input,
      organizationId: "other-org",
    });
    expect(result).toEqual({
      status: "ok",
      orgSlug: "other-org",
      bindingId: "binding-bound",
    });
    expect(bind.mock.calls[0]![1]).toBe("org-2");
  });

  test("rejects binding into an org the user is not a member of", async () => {
    const { provider, bind } = makeProvider();
    const deps = makeDeps({ resolveOrgIfMember: mock(async () => null) });
    const result = await claimPendingConnection(provider, deps, {
      ...input,
      organizationId: "not-mine",
    });
    expect(result).toEqual({ status: "not_member_of_org" });
    expect(bind).not.toHaveBeenCalled();
  });

  test("carries the provider's not_authorized code as payload and never binds", async () => {
    const { provider, bind } = makeProvider({
      authorize: mock(
        async (): Promise<ClaimAuthorization> => ({
          status: "not_authorized",
          code: "not_admin",
        }),
      ),
    });
    const result = await claimPendingConnection(provider, makeDeps(), input);
    expect(result).toEqual({ status: "not_authorized", code: "not_admin" });
    expect(bind).not.toHaveBeenCalled();
  });

  test("carries the provider's signin_required provider as payload", async () => {
    const { provider, bind } = makeProvider({
      authorize: mock(
        async (): Promise<ClaimAuthorization> => ({
          status: "signin_required",
          signinProvider: "slack",
        }),
      ),
    });
    const result = await claimPendingConnection(provider, makeDeps(), input);
    expect(result).toEqual({
      status: "signin_required",
      signinProvider: "slack",
    });
    expect(bind).not.toHaveBeenCalled();
  });

  test("already-connected subject is an idempotent success", async () => {
    const { provider, bind } = makeProvider({
      resolvePending: mock(async () => null),
      resolveExistingBinding: mock(async () => ({ orgSlug: "acme" })),
    });
    const result = await claimPendingConnection(provider, makeDeps(), input);
    expect(result).toEqual({
      status: "ok",
      orgSlug: "acme",
      bindingId: "",
      alreadyConnected: true,
    });
    expect(bind).not.toHaveBeenCalled();
  });

  // Cross-org fence (PR2): a subject already ACTIVE in a DIFFERENT org must not
  // be silently walked into a second org. The engine surfaces the other org and
  // refuses to bind unless the claimer explicitly confirms the move.
  describe("cross-org fence", () => {
    const foreign: ClaimForeignBinding = {
      orgSlug: "acme",
      orgName: "Acme",
      matchKind: "same_workspace",
    };
    const overlap: ClaimForeignBinding = {
      orgSlug: "grid",
      orgName: "Grid Org",
      matchKind: "enterprise_scope_overlap",
    };

    test("(a) first claim into org A binds normally (no foreign binding)", async () => {
      const { provider, bind } = makeProvider();
      const result = await claimPendingConnection(provider, makeDeps(), input);
      expect(result).toEqual({
        status: "ok",
        orgSlug: "acme",
        bindingId: "binding-bound",
      });
      // bind is called with confirmMove=false on the un-fenced first claim.
      expect(bind).toHaveBeenCalledTimes(1);
      expect(bind.mock.calls[0]![3]).toBe(false);
    });

    test("(b) naive second claim into org B is fenced, never bound", async () => {
      const resolveActiveBindingElsewhere = mock(async () => foreign);
      const { provider, bind } = makeProvider({ resolveActiveBindingElsewhere });
      const result = await claimPendingConnection(provider, makeDeps(), {
        ...input,
        organizationId: "other-org",
      });
      expect(result).toEqual({
        status: "already_connected_elsewhere",
        existing: foreign,
      });
      expect(bind).not.toHaveBeenCalled();
      // The fence is asked against the membership-resolved TARGET org id.
      expect(resolveActiveBindingElsewhere).toHaveBeenCalledTimes(1);
      expect(resolveActiveBindingElsewhere.mock.calls[0]![2]).toBe("org-1");
    });

    test("(c) second claim WITH confirmMove binds a same_workspace conflict (fence still runs)", async () => {
      const resolveActiveBindingElsewhere = mock(async () => foreign);
      const { provider, bind } = makeProvider({ resolveActiveBindingElsewhere });
      const result = await claimPendingConnection(provider, makeDeps(), {
        ...input,
        organizationId: "other-org",
        confirmMove: true,
      });
      expect(result).toEqual({
        status: "ok",
        orgSlug: "acme",
        bindingId: "binding-bound",
      });
      // The pre-check ALWAYS runs now (so enterprise_scope_overlap is never
      // silently confirmed away); confirmMove only waives the same_workspace block.
      expect(resolveActiveBindingElsewhere).toHaveBeenCalledTimes(1);
      expect(bind).toHaveBeenCalledTimes(1);
      expect(bind.mock.calls[0]![3]).toBe(true);
    });

    test("enterprise_scope_overlap blocks EVEN WITH confirmMove (not overridable)", async () => {
      const resolveActiveBindingElsewhere = mock(async () => overlap);
      const { provider, bind } = makeProvider({ resolveActiveBindingElsewhere });
      const result = await claimPendingConnection(provider, makeDeps(), {
        ...input,
        organizationId: "other-org",
        confirmMove: true,
      });
      expect(result).toEqual({
        status: "enterprise_scope_overlap",
        existing: overlap,
      });
      // A Grid scope overlap is a routing collision, not a movable binding — the
      // cross-key demote can't move it, so confirmMove must NOT bind it.
      expect(bind).not.toHaveBeenCalled();
    });

    test("both fence statuses map to 409, kept distinct", () => {
      expect(claimHttpStatus("already_connected_elsewhere")).toBe(409);
      expect(claimHttpStatus("enterprise_scope_overlap")).toBe(409);
    });

    test("atomic-guard trip in bind maps by matchKind (same_workspace → already_connected_elsewhere)", async () => {
      // The raced path: the sequential pre-check saw null (foreign binding not yet
      // committed), so bind runs — and its atomic under-lock fence trips, throwing
      // ClaimMoveBlockedError. The engine must surface the SAME typed 409 outcome.
      const racedBind = mock(async () => {
        throw new ClaimMoveBlockedError(foreign);
      });
      const { provider } = makeProvider({
        resolveActiveBindingElsewhere: mock(async () => null),
        bind: racedBind,
      });
      const result = await claimPendingConnection(provider, makeDeps(), input);
      expect(result).toEqual({
        status: "already_connected_elsewhere",
        existing: foreign,
      });
      expect(racedBind).toHaveBeenCalledTimes(1);
    });

    test("atomic-guard trip with an enterprise overlap maps to enterprise_scope_overlap", async () => {
      const { provider } = makeProvider({
        resolveActiveBindingElsewhere: mock(async () => null),
        bind: mock(async () => {
          throw new ClaimMoveBlockedError(overlap);
        }),
      });
      const result = await claimPendingConnection(provider, makeDeps(), input);
      expect(result).toEqual({
        status: "enterprise_scope_overlap",
        existing: overlap,
      });
    });
  });

  test("404s when the subject has no install at all", async () => {
    const { provider } = makeProvider({
      resolvePending: mock(async () => null),
      resolveExistingBinding: mock(async () => null),
    });
    const result = await claimPendingConnection(provider, makeDeps(), input);
    expect(result).toEqual({ status: "no_pending" });
  });

  test("rejects an org-less claim — never binds to a default org", async () => {
    // An external OAuth install must not create a connection under an org the
    // installer never picked. A claim with no confirmed org is invalid_request,
    // NOT silently routed to the caller's default/oldest org.
    const { provider, bind } = makeProvider();
    const resolveOrgIfMember = mock(async () => "org-1");
    const deps = makeDeps({ resolveOrgIfMember });
    const result = await claimPendingConnection(provider, deps, {
      ...input,
      organizationId: undefined,
    });
    expect(result).toEqual({ status: "invalid_request" });
    expect(bind).not.toHaveBeenCalled();
    expect(resolveOrgIfMember).not.toHaveBeenCalled();
  });

  test("401s an unauthenticated caller before any work", async () => {
    const { provider } = makeProvider();
    const resolvePending = provider.resolvePending as ReturnType<typeof mock>;
    const result = await claimPendingConnection(provider, makeDeps(), {
      ...input,
      userId: null,
    });
    expect(result).toEqual({ status: "unauthenticated" });
    expect(resolvePending).not.toHaveBeenCalled();
  });

  test("400s a missing ref", async () => {
    const { provider } = makeProvider();
    expect(
      (await claimPendingConnection(provider, makeDeps(), { ...input, ref: "" }))
        .status,
    ).toBe("invalid_request");
  });

  test("maps an unexpected bind failure to claim_failed", async () => {
    const { provider } = makeProvider({
      bind: mock(async () => {
        throw new Error("secret store unavailable");
      }),
    });
    const result = await claimPendingConnection(provider, makeDeps(), input);
    expect(result).toEqual({
      status: "claim_failed",
      message: "secret store unavailable",
    });
  });
});

describe("resolveClaimContext", () => {
  test("returns the eligible orgs with the isPersonal marker (personal last)", async () => {
    const orgs: ClaimEligibleOrg[] = [
      { id: "org-team", slug: "team", name: "Team Org", isPersonal: false },
      { id: "org-me", slug: "me", name: "My Personal", isPersonal: true },
    ];
    const { provider } = makeProvider();
    const deps = makeDeps({ resolveMemberOrgs: mock(async () => orgs) });
    const ctx = await resolveClaimContext(provider, deps, input);
    expect(ctx.status).toBe("ready");
    if (ctx.status !== "ready") throw new Error("expected ready");
    expect(ctx.orgs).toEqual(orgs);
    expect(ctx.orgs[0]!.isPersonal).toBe(false);
    expect(ctx.orgs[ctx.orgs.length - 1]!.isPersonal).toBe(true);
  });

  test("surfaces the subjectName from the authorize verdict", async () => {
    const { provider } = makeProvider({
      authorize: mock(
        async (): Promise<ClaimAuthorization> => ({
          status: "authorized",
          subjectName: "Contoso HQ",
        }),
      ),
    });
    const ctx = await resolveClaimContext(provider, makeDeps(), input);
    if (ctx.status !== "ready") throw new Error("expected ready");
    expect(ctx.subjectName).toBe("Contoso HQ");
  });

  test("no_org when the claimer belongs to no orgs", async () => {
    const { provider } = makeProvider();
    const deps = makeDeps({ resolveMemberOrgs: mock(async () => []) });
    const ctx = await resolveClaimContext(provider, deps, input);
    expect(ctx).toEqual({ status: "no_org" });
  });

  test("propagates already_connected without touching orgs", async () => {
    const { provider } = makeProvider({
      resolvePending: mock(async () => null),
      resolveExistingBinding: mock(async () => ({ orgSlug: "acme" })),
    });
    const resolveMemberOrgs = mock(async () => [] as ClaimEligibleOrg[]);
    const ctx = await resolveClaimContext(
      provider,
      makeDeps({ resolveMemberOrgs }),
      input,
    );
    expect(ctx).toEqual({ status: "already_connected", orgSlug: "acme" });
    expect(resolveMemberOrgs).not.toHaveBeenCalled();
  });
});

describe("claimHttpStatus", () => {
  test("maps every status to its HTTP code", () => {
    expect(claimHttpStatus("unauthenticated")).toBe(401);
    expect(claimHttpStatus("invalid_request")).toBe(400);
    expect(claimHttpStatus("no_pending")).toBe(404);
    expect(claimHttpStatus("signin_required")).toBe(403);
    expect(claimHttpStatus("not_authorized")).toBe(403);
    expect(claimHttpStatus("not_member_of_org")).toBe(403);
    expect(claimHttpStatus("no_org")).toBe(409);
    expect(claimHttpStatus("claim_failed")).toBe(500);
  });
});
