import { CrossOrgTransferBlockedError } from "../../lobu/stores/app-installation-store.js";
import type { SlackPendingInstall } from "../../lobu/stores/slack-installations.js";
import {
  type ClaimAuthorization,
  type ClaimForeignBinding,
  type ClaimProvider,
  ClaimMoveBlockedError,
} from "./connection-claim.js";
import type { SlackWebApi } from "./slack-web.js";
import logger from "../../utils/logger.js";

/**
 * The Slack adapter for the provider-agnostic claim engine (see
 * `connection-claim.ts`). Slack is the first consumer: a Slack-initiated
 * (marketplace) install lands as an org-less `pending` row (see
 * `writeSlackPendingInstall`); the engine binds it to the claiming user's org
 * once THIS adapter's `authorize` verdict passes and the user confirms.
 *
 * Authority is the Slack workspace-admin check — NOT a secret link token. The
 * install DM carries a convenience deep-link, but a signed-in admin of the
 * workspace can always connect a pending install for their team; a missing,
 * stale, or already-used link never blocks them. This module owns ONLY the
 * provider half: what a Slack pending install is, Slack idempotency, the
 * workspace-admin authority verdict, and the bind. The org-resolution half and
 * the confirm-before-bind two-phase live in the engine.
 */

/** The Slack-specific dependencies the adapter needs (injected for testing). */
export interface SlackClaimProviderDeps {
  /** The parked pending install for a workspace, or null if none. */
  resolvePending(team: string): Promise<SlackPendingInstall | null>;
  /** The org slug the workspace is ALREADY connected to (active install), or null. */
  resolveActiveOrgSlug(team: string): Promise<string | null>;
  /**
   * The TYPED cross-org conflict for claiming `team` into `targetOrganizationId`,
   * or null when there is none. Matches the exact workspace `team_id`
   * (`same_workspace`) and — only across an ORG-WIDE Grid install on either side —
   * an `enterprise_id` scope overlap (`enterprise_scope_overlap`). Two independent
   * per-workspace siblings of one enterprise do NOT conflict. `isEnterpriseInstall`
   * is the CLAIMING install's org-wide flag. Powers the cross-org fence.
   */
  resolveActiveBindingElsewhere(
    team: string,
    enterpriseId: string | null,
    isEnterpriseInstall: boolean,
    targetOrganizationId: string,
  ): Promise<ClaimForeignBinding | null>;
  /**
   * ALL of the claiming user's `slack_user_id` identities as `{teamId, slackUserId}`
   * pairs (bare `U…` ids, across every workspace they've signed in with Slack for).
   * A team-scoped match doubles as the workspace-membership proof; the full list
   * also lets a Grid org-admin who never joined the workspace prove identity via
   * `slackUserId == pending.installerUserId` (see `authorize`).
   */
  resolveClaimerSlackIdentities(
    userId: string,
  ): Promise<Array<{ teamId: string; slackUserId: string }>>;
  /**
   * Stamp a workspace-scoped Slack identity onto the user's `$member` in each
   * of their orgs. Fails closed when another `$member` already holds the id, so
   * a forged call cannot take over an identity. Injected so `bind`'s post-claim
   * linking is testable without a live DB.
   */
  stampSlackIdentityForUser(
    userId: string,
    teamId: string | null | undefined,
    slackUserId: string,
  ): Promise<void>;
  /** `users.info` admin/owner flags for the claimer. */
  usersInfo: SlackWebApi["usersInfo"];
  /**
   * Bind: persist the token + create the active install, returning its id.
   * `confirmMove` is true when the claimer explicitly approved MOVING a workspace
   * that is active in another org; the store must re-enforce the cross-org fence
   * atomically under its active-tenant advisory lock when it is false.
   */
  claim(
    pending: SlackPendingInstall,
    organizationId: string,
    confirmMove: boolean,
    userId: string,
  ): Promise<{ installationId: string }>;
}

/**
 * The Slack workspace-admin authority verdict, factored out of the former
 * `resolveClaimTarget` VERBATIM. Authority: the caller must have signed in with
 * Slack for the team (membership) AND be an admin/owner — OR (Grid only) be the
 * install's `installerUserId`.
 */
async function authorizeSlackClaim(
  deps: SlackClaimProviderDeps,
  userId: string,
  pending: SlackPendingInstall,
): Promise<ClaimAuthorization> {
  const identities = await deps.resolveClaimerSlackIdentities(userId);
  // The claimer's `U…` id for THIS workspace, if they've signed in with Slack
  // for it — both proves workspace membership and gives us their id for the
  // admin check. `slack_user_id` identities are stored uppercased.
  const teamPrefix = pending.teamId.toUpperCase();
  const bareUserId =
    identities.find((i) => i.teamId.toUpperCase() === teamPrefix)?.slackUserId ??
    null;

  // Path 1 — workspace membership + admin: signed in with Slack for THIS
  // workspace AND a workspace admin/owner. The canonical authority.
  if (bareUserId) {
    const info = await deps.usersInfo(pending.botToken, bareUserId);
    if (info.isAdmin || info.isOwner) {
      return { status: "authorized", subjectName: pending.teamName };
    }
    return { status: "not_authorized", code: "not_admin" };
  }
  // Path 2 — Grid installer-identity match. A Grid org-admin can provision the
  // workspace without ever joining it, so they have no team-scoped identity
  // and Slack's `admin.teams` is not in our bot scope. But Slack already gated
  // the Grid install action to someone with install authority, and Grid `U…`
  // ids are enterprise-GLOBAL — so a claimer whose OIDC-signed `U…` id equals
  // `pending.installerUserId` is a Slack-signed proof of the same person.
  // STRICTLY Grid-gated (`enterpriseId` non-null): plain workspaces let ANY
  // non-admin install apps, so installer-match must NOT grant authority there
  // (the authority model is admin-not-installer).
  // Case-normalized on both sides: the entity-graph source yields the raw
  // `team:user` identifier (unlike the account / linked-chat sources, which
  // uppercase) and `installerUserId` is stored verbatim from Slack's payload,
  // so a case-sensitive compare would deny a legitimate Grid admin. `bind`
  // normalizes the same way — the two must agree on who the installer is.
  const installerId = pending.installerUserId?.toUpperCase() ?? null;
  if (
    pending.enterpriseId &&
    installerId &&
    identities.some((i) => i.slackUserId.toUpperCase() === installerId)
  ) {
    return { status: "authorized", subjectName: pending.teamName };
  }
  // No workspace identity and no installer match — they never signed in with
  // Slack for this workspace, so we can't run the admin check.
  return { status: "signin_required", signinProvider: "slack" };
}

/**
 * Build the Slack `ClaimProvider` over the injected Slack deps. `bind` maps the
 * engine's `{bindingId}` contract onto Slack's `{installationId}`; the workspace
 * `team` id is the engine's provider-agnostic `ref`.
 */
export function slackClaimProvider(
  deps: SlackClaimProviderDeps,
): ClaimProvider<SlackPendingInstall> {
  return {
    provider: "slack",
    subjectKind: "workspace",
    resolvePending: (ref) => deps.resolvePending(ref),
    resolveExistingBinding: async (ref) => {
      const orgSlug = await deps.resolveActiveOrgSlug(ref);
      return orgSlug ? { orgSlug } : null;
    },
    resolveActiveBindingElsewhere: (ref, pending, targetOrganizationId) =>
      deps.resolveActiveBindingElsewhere(
        ref,
        pending.enterpriseId,
        pending.isEnterpriseInstall,
        targetOrganizationId,
      ),
    authorize: (userId, pending) => authorizeSlackClaim(deps, userId, pending),
    bind: async (pending, organizationId, userId, confirmMove) => {
      try {
        const { installationId } = await deps.claim(
          pending,
          organizationId,
          confirmMove,
          userId,
        );
        // Link ONLY Slack identities proven to belong to the claimer (OIDC /
        // resolveClaimerSlackIdentities). Never map pending.installerUserId to
        // the claimer unconditionally — a different workspace admin can claim
        // a plain-workspace install, and forging that link would hand them the
        // installer's identity on that U….
        //
        // When the claimer IS the installer (same U… in their signed-in
        // identities), also stamp the install's tenant key (T… or Grid E…) so
        // later event team ids that match the install row still resolve.
        try {
          const identities = await deps.resolveClaimerSlackIdentities(userId);
          // Stamp only identities with a proven team scope. Older Better Auth
          // accounts without an id_token resolve with an empty team; their bare
          // user proof is useful for Grid installer matching below but must not
          // create an unscoped identity — two workspaces can share a `U…`.
          //
          // Most of these are already in the graph (sign-in stamps them). This
          // loop is idempotent and heals the case where a Better Auth account
          // exists but the sign-in stamp never landed — e.g. the user had no
          // `$member` yet when they first signed in.
          for (const id of identities) {
            if (!id.teamId) continue;
            await deps.stampSlackIdentityForUser(
              userId,
              id.teamId,
              id.slackUserId,
            );
          }
          // Ensure the install's tenant key (T… or Grid E…) is linked ONLY when
          // the claimer is proven to be the installer, without rewriting the
          // exact identity already linked above:
          // - plain workspace: same teamId + same U… (U is workspace-local)
          // - Grid (enterpriseId set): same U… on any team (U is enterprise-global)
          const installer = pending.installerUserId?.toUpperCase() ?? null;
          const installTeam = pending.teamId.toUpperCase();
          const claimerIsInstaller =
            installer != null &&
            identities.some((i) => {
              if (i.slackUserId.toUpperCase() !== installer) return false;
              if (pending.enterpriseId) return true;
              return i.teamId.toUpperCase() === installTeam;
            });
          const installIdentityAlreadyLinked =
            installer != null &&
            identities.some(
              (i) =>
                i.teamId.toUpperCase() === installTeam &&
                i.slackUserId.toUpperCase() === installer,
            );
          if (
            claimerIsInstaller &&
            !installIdentityAlreadyLinked &&
            pending.installerUserId
          ) {
            await deps.stampSlackIdentityForUser(userId, installTeam, installer);
          }
        } catch (err) {
          // Swallow — claim already committed; identity can be healed later.
          // Log so a persistent identity-link failure is visible to on-call
          // rather than silently degrading owner routing.
          logger.warn(
            {
              err,
              installationId,
              userId,
              installerUserId: pending.installerUserId,
              teamId: pending.teamId,
            },
            "Slack claim identity linking failed after claim committed",
          );
        }
        return { bindingId: installationId };
      } catch (err) {
        // The store's ATOMIC fence tripped on the raced path (the sequential
        // pre-check saw null). Translate the store-specific error into the
        // engine's provider-agnostic ClaimMoveBlockedError so the raced path
        // returns the SAME typed 409 as the pre-check (by matchKind), carrying the
        // other org (still resolvable — the fenced claim released its own pending
        // row, leaving the incumbent active row intact).
        if (err instanceof CrossOrgTransferBlockedError) {
          const existing = await deps.resolveActiveBindingElsewhere(
            pending.teamId,
            pending.enterpriseId,
            pending.isEnterpriseInstall,
            organizationId,
          );
          throw new ClaimMoveBlockedError(
            existing ?? { orgSlug: null, orgName: null, matchKind: "same_workspace" },
          );
        }
        throw err;
      }
    },
  };
}
