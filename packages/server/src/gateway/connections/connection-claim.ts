/**
 * Provider-agnostic "claim" engine, lifted from the Slack-specific claim flow
 * (see `slackClaimProvider` in `slack-claim.ts`, its first consumer). A
 * marketplace / provider-initiated install lands as an org-less `pending` row;
 * this binds it to the claiming user's org once the provider's authority check
 * passes and the user confirms the destination org.
 *
 * The engine owns the org-resolution half — two-phase confirm-before-bind,
 * idempotent already-connected success, explicit-org membership checks,
 * and the terminal error taxonomy. The PROVIDER owns the authority
 * half: what a pending install is, how idempotency is decided, who is allowed to
 * claim (the `authorize` verdict), and how the bind is persisted. Every
 * dependency is injected so routes wire real stores and tests use a stub
 * provider.
 */

/** Shared authorization error statuses (each maps to an HTTP code in the route). */
export type ClaimError =
  | { status: "unauthenticated"; signinProvider?: string }
  | { status: "invalid_request" }
  | { status: "no_pending" }
  /** The claimer must sign in with `signinProvider` before authority can be checked. */
  | { status: "signin_required"; signinProvider: string }
  /** The provider denied authority; `code` is the provider-specific reason. */
  | { status: "not_authorized"; code: string }
  | { status: "not_member_of_org" }
  | { status: "no_org" }
  | { status: "claim_failed"; message: string };

/**
 * Which cross-org conflict the fence matched — the two are DIFFERENT concepts and
 * map to different outcomes:
 *  - `same_workspace`: the SAME external subject (exact team id) is active in
 *    another org. A genuine "already connected elsewhere; move it?" case.
 *  - `enterprise_scope_overlap`: a ROUTING overlap where one side is an org-wide
 *    Grid install that covers sibling workspaces the other org claims per-
 *    workspace (or vice-versa). Not the same subject — a scope collision — so it
 *    is surfaced distinctly and blocked by default (no silent move).
 */
export type ClaimConflictKind = "same_workspace" | "enterprise_scope_overlap";

/** The identity of the OTHER org a subject conflicts with, and how it matched. */
export interface ClaimForeignBinding {
  orgSlug: string | null;
  orgName: string | null;
  matchKind: ClaimConflictKind;
}

/**
 * A provider's `bind` throws this when its ATOMIC (under-lock) cross-org fence
 * trips — the raced path the engine's sequential pre-check could not see (two
 * concurrent claims both read null before either committed). The engine catches
 * it and maps it to the SAME `already_connected_elsewhere` result the pre-check
 * returns, so both paths yield a consistent 409 carrying the other org, never a
 * 500 `claim_failed`. Provider-agnostic on purpose: the Slack adapter translates
 * its store-specific `CrossOrgTransferBlockedError` into this.
 */
export class ClaimMoveBlockedError extends Error {
  constructor(readonly existing: ClaimForeignBinding) {
    super("Subject already actively bound in a different org (move not confirmed)");
    this.name = "ClaimMoveBlockedError";
  }
}

/** Terminal outcome of the bind (`claimPendingConnection`). */
export type ClaimResult =
  | {
      status: "ok";
      orgSlug: string | null;
      bindingId: string;
      nextUrl?: string;
      /** True when the subject was already connected (idempotent no-op). */
      alreadyConnected?: boolean;
    }
  /**
   * The SAME external subject (exact workspace) is ALREADY actively bound in a
   * DIFFERENT org than the one the claimer confirmed. The engine does NOT silently
   * create a second binding (that silent duplication is a cross-org pollution
   * vector). It returns this explicit outcome carrying the other org's identity so
   * the UI can prompt "This workspace is already connected in <org>. Move it
   * here?" — the caller re-issues with `confirmMove: true` to proceed (fence, not
   * forbid: a single external workspace may legitimately serve multiple orgs).
   */
  | { status: "already_connected_elsewhere"; existing: ClaimForeignBinding }
  /**
   * A Grid ENTERPRISE-SCOPE overlap: an org-wide install in one org covers the
   * sibling workspaces another org claims per-workspace (or vice-versa). This is
   * NOT the same subject — it's a routing collision — so it is distinct from
   * `already_connected_elsewhere`. Blocked by DEFAULT (safety) and NOT overridable
   * by `confirmMove`: the cross-key demote can't actually move an org-wide vs
   * per-workspace install, so a "move it here" prompt would be a lie. Lifting this
   * needs product support for Grid carve-outs + atomic group demotion.
   */
  | { status: "enterprise_scope_overlap"; existing: ClaimForeignBinding }
  | ClaimError;

/** A Lobu org the claimer may bind the subject into. */
export interface ClaimEligibleOrg {
  id: string;
  slug: string;
  name: string;
  /**
   * True when this is the claimer's auto-provisioned personal org (marked by
   * `metadata.personal_org_for_user_id`). Sorted LAST so the UI preselects a
   * team org — a subject should not silently bind into a personal org.
   */
  isPersonal: boolean;
}

/** The provider's verdict on whether `userId` may claim `pending`. */
export type ClaimAuthorization =
  | { status: "authorized"; subjectName: string | null }
  | { status: "signin_required"; signinProvider: string }
  | { status: "not_authorized"; code: string };

/** Confirmation context for the UI (`resolveClaimContext`). */
export type ClaimContext =
  | {
      status: "ready";
      /** Human-readable subject name for the confirm copy. */
      subjectName: string | null;
      /** Orgs the claimer belongs to (the destination picker). */
      orgs: ClaimEligibleOrg[];
    }
  | {
      // The subject is already connected — the UI links to it instead of showing
      // a scary "not found" error for a re-visited/spent link.
      status: "already_connected";
      orgSlug: string | null;
      nextUrl?: string;
    }
  | ClaimError;

/**
 * The provider half of a claim. `P` is the provider's pending-install shape.
 * Everything here is provider policy: resolving the pending row, deciding
 * idempotency, the authority verdict, and persisting the bind.
 */
export interface ClaimContinuation {
  platform: string;
  connection: string;
  channelId: string;
  label?: string;
  teamId?: string;
}

export function claimContinuation(orgSlug: string | null, continuation?: ClaimContinuation): { nextUrl?: string } {
  if (!orgSlug || !continuation) return {};
  const query = new URLSearchParams({
    platform: continuation.platform, connection: continuation.connection, listen: continuation.channelId,
  });
  if (continuation.label) query.set("label", continuation.label);
  if (continuation.teamId) query.set("team", continuation.teamId);
  return { nextUrl: `/${encodeURIComponent(orgSlug)}/automations/new?${query}` };
}

export interface ClaimProvider<P = unknown> {
  /** The connector/provider key (e.g. `"slack"`). */
  provider: string;
  signinProvider?: string;
  /** The kind of subject being claimed (e.g. `"workspace"`, `"account"`). */
  subjectKind: string;
  /** The parked pending install for `ref`, or null if none. */
  resolvePending(ref: string): Promise<P | null>;
  /**
   * The org the subject is ALREADY bound to (active install), or null.
   * Idempotency is provider policy: a non-null result becomes an
   * `already_connected` success rather than an error.
   */
  resolveExistingBinding(ref: string, userId: string): Promise<{ orgSlug: string | null; continuation?: ClaimContinuation } | null>;
  /**
   * The identity of an org OTHER than `targetOrganizationId` that already holds
   * an active binding for this subject, or null when the only (or no) active
   * binding is in the target org itself. Used to FENCE a silent cross-org walk:
   * a non-null result blocks the bind (returning `already_connected_elsewhere`)
   * unless the claimer explicitly confirmed the move. The provider decides what
   * "same subject" means across its keying (e.g. Slack matches team_id AND a Grid
   * enterprise_id) — the engine only asks the question.
   */
  resolveActiveBindingElsewhere(
    ref: string,
    pending: P,
    targetOrganizationId: string,
  ): Promise<ClaimForeignBinding | null>;
  /** The provider's authority verdict for the claiming user against `pending`. */
  authorize(userId: string, pending: P): Promise<ClaimAuthorization>;
  /**
   * Bind: persist the token + create the active install, returning its id. When
   * `confirmMove` is set the caller has explicitly approved MOVING an active
   * binding that lives in another org into `organizationId`; the provider must
   * re-verify and enforce the cross-org fence atomically (under the same lock as
   * the write) so a concurrent claim on another pod cannot slip a silent move
   * through the engine's pre-check.
   */
  bind(
    pending: P,
    organizationId: string,
    userId: string,
    confirmMove: boolean,
  ): Promise<{ bindingId: string; continuation?: ClaimContinuation }>;
}

/**
 * The org-resolution dependencies the engine owns (lifted verbatim from the
 * former `SlackClaimDeps`). Shared by every provider; wired once per route.
 */
export interface ClaimEngineDeps {
  /** The orgs the claimer is a member of (the destination picker). */
  resolveMemberOrgs(userId: string): Promise<ClaimEligibleOrg[]>;
  /**
   * Resolve an explicitly chosen org (slug or id) to its id IFF the user is a
   * member, else null. Guards the confirm step so a user can only bind into an
   * org they belong to.
   */
  resolveOrgIfMember(userId: string, orgSlugOrId: string): Promise<string | null>;
  /** The org's URL slug (for the success redirect), or null. */
  resolveOrgSlug(organizationId: string): Promise<string | null>;
}

/**
 * Run the claim authorization guards WITHOUT binding, delegating the authority
 * verdict to the provider. Returns the pending install on success, a distinct
 * `already_connected` when the subject is already bound, or an error.
 */
async function resolveClaimTarget<P>(
  provider: ClaimProvider<P>,
  input: { userId: string | null; ref: string },
): Promise<
  | { status: "ready"; pending: P; subjectName: string | null }
  | { status: "already_connected"; orgSlug: string | null; nextUrl?: string }
  | ClaimError
> {
  if (!input.userId) return { status: "unauthenticated", ...(provider.signinProvider ? { signinProvider: provider.signinProvider } : {}) };
  if (!input.ref) return { status: "invalid_request" };

  const pending = await provider.resolvePending(input.ref);
  if (pending) {
    const verdict = await provider.authorize(input.userId, pending);
    if (verdict.status === "authorized") {
      return { status: "ready", pending, subjectName: verdict.subjectName };
    }
    if (verdict.status === "signin_required") {
      return {
        status: "signin_required",
        signinProvider: verdict.signinProvider,
      };
    }
    return { status: "not_authorized", code: verdict.code };
  }

  // No pending install: either it's already connected (a re-visited/spent link),
  // or the app was never installed for this subject.
  const existing = await provider.resolveExistingBinding(input.ref, input.userId);
  if (existing) {
    return { status: "already_connected", orgSlug: existing.orgSlug, ...claimContinuation(existing.orgSlug, existing.continuation) };
  }
  return { status: "no_pending" };
}

/**
 * Confirmation context: run the guards and return the subject name + the
 * claimer's eligible orgs, so the UI can show "Connect <subject> to <org>"
 * before any write. Surfaces `already_connected` for a subject that's already
 * bound. No mutation.
 */
export async function resolveClaimContext<P>(
  provider: ClaimProvider<P>,
  deps: ClaimEngineDeps,
  input: { userId: string | null; ref: string },
): Promise<ClaimContext> {
  try {
    const target = await resolveClaimTarget(provider, input);
    if (target.status !== "ready") return target;
    const orgs = await deps.resolveMemberOrgs(input.userId as string);
    if (orgs.length === 0) return { status: "no_org" };
    return { status: "ready", subjectName: target.subjectName, orgs };
  } catch (err) {
    return {
      status: "claim_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Bind the pending subject into the org the user CONFIRMED. `organizationId`
 * (slug or id) is required from the confirm step; it is membership-verified. An
 * already-connected subject resolves to an idempotent success pointing at its
 * existing org.
 */
export async function claimPendingConnection<P>(
  provider: ClaimProvider<P>,
  deps: ClaimEngineDeps,
  input: {
    userId: string | null;
    ref: string;
    organizationId?: string;
    /**
     * The claimer explicitly confirmed MOVING an active binding that lives in
     * another org into the confirmed org. Without it a subject already active
     * elsewhere yields `already_connected_elsewhere` (fence, not forbid): the
     * second claim must be deliberate, never a silent duplicate.
     */
    confirmMove?: boolean;
  },
): Promise<ClaimResult> {
  try {
    const target = await resolveClaimTarget(provider, input);
    if (target.status === "already_connected") {
      return {
        status: "ok",
        orgSlug: target.orgSlug,
        bindingId: "",
        alreadyConnected: true,
        ...(target.nextUrl ? { nextUrl: target.nextUrl } : {}),
      };
    }
    if (target.status !== "ready") return target;

    // Binding a subject to an org is NEVER implicit. This flow creates a
    // connection under an org from an EXTERNAL (marketplace/OAuth) request, so
    // the destination org must be an explicit, membership-verified choice the
    // human confirmed on the claim page — never a silent default. A claim with
    // no confirmed org is rejected (`invalid_request`), not routed to the
    // caller's oldest org: that would let an external install create a
    // connection under an org the installer never picked.
    if (!input.organizationId) return { status: "invalid_request" };
    const organizationId = await deps.resolveOrgIfMember(
      input.userId as string,
      input.organizationId,
    );
    if (!organizationId) return { status: "not_member_of_org" };

    // Cross-org fence. If this subject conflicts with an ACTIVE binding in a
    // DIFFERENT org, a naive bind would silently transfer/duplicate it (the install
    // store demotes the prior org's active row on activation). The check ALWAYS
    // runs — even under `confirmMove` — because an `enterprise_scope_overlap` is
    // never overridable (the cross-key demote can't move it), while a
    // `same_workspace` conflict IS the deliberate move `confirmMove` authorizes.
    // This is the pre-check for a friendly outcome; `bind` re-enforces atomically.
    const elsewhere = await provider.resolveActiveBindingElsewhere(
      input.ref,
      target.pending,
      organizationId,
    );
    if (elsewhere) {
      if (elsewhere.matchKind === "enterprise_scope_overlap") {
        return { status: "enterprise_scope_overlap", existing: elsewhere };
      }
      // same_workspace: a confirmed move proceeds; otherwise fence.
      if (!input.confirmMove) {
        return { status: "already_connected_elsewhere", existing: elsewhere };
      }
    }

    const { bindingId, continuation } = await provider.bind(
      target.pending,
      organizationId,
      input.userId as string,
      input.confirmMove ?? false,
    );
    const orgSlug = await deps.resolveOrgSlug(organizationId);
    return { status: "ok", orgSlug, bindingId, ...claimContinuation(orgSlug, continuation) };
  } catch (err) {
    // The atomic (under-lock) fence in the provider's bind tripped on the raced
    // path — surface the SAME typed outcome as the pre-check (by matchKind), not a
    // 500.
    if (err instanceof ClaimMoveBlockedError) {
      const status =
        err.existing.matchKind === "enterprise_scope_overlap"
          ? "enterprise_scope_overlap"
          : "already_connected_elsewhere";
      return { status, existing: err.existing };
    }
    return {
      status: "claim_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Map a claim/context status to its HTTP code (shared by both routes). */
export function claimHttpStatus(
  status: string,
): 400 | 401 | 403 | 404 | 409 | 500 {
  switch (status) {
    case "unauthenticated":
      return 401;
    case "invalid_request":
      return 400;
    case "no_pending":
      return 404;
    case "signin_required":
    case "not_authorized":
    case "not_member_of_org":
      return 403;
    case "no_org":
    case "already_connected_elsewhere":
    case "enterprise_scope_overlap":
      return 409;
    default:
      return 500;
  }
}
