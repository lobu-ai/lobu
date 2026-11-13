#!/usr/bin/env bun

/**
 * One-time backfill of missing `$member` + `auth:signup` claims.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * The authz channel-visibility gate resolves a signed-in user to their `$member`
 * entity via an `entity_identities` row (namespace `auth_user_id`, source
 * `auth:signup`, on a `$member` entity). The provisioning hooks that write that
 * claim only started doing so on 2026-06-28 (the ACL gate PR). Older member rows
 * that have not passed through provisioning again can therefore lack the claim,
 * making every enforced channel invisible to those users.
 *
 * The forward path is now correct — this fills in the historical rows so those
 * users resolve, exactly as a fresh sign-up would. It is NOT a migration
 * (docs/MIGRATIONS.md: no scan inside the blocking Helm hook).
 *
 * ─── Exactly what it does ────────────────────────────────────────────────────
 * For each `(user, org)` member row lacking the claim, it calls the SAME
 * `provisionMemberAndCoreIdentities` a real sign-up uses — which mints the
 * `$member` (by email) and writes `auth_user_id` + `email` claims, and now also
 * enforces the runtime invariant that `userId` must own `email`. No bespoke SQL
 * that could drift from the production write path.
 *
 * ─── The retarget hazard (why this is gated, read before running) ────────────
 * Backfilling a claim makes a previously-invisible org eligible for
 * `resolveTenantMember` (which drives WHERE a user's personal identity facts —
 * Google profile/contacts — get written). Before the personal-org-tag fix in
 * this same PR, `resolveTenantMember` picked the OLDEST private org with a
 * claim, so backfilling a claim into a SHARED org older than a user's personal
 * one would silently redirect their personal facts into that shared org.
 *
 * This script therefore skips any row where the target org is NOT the user's
 * tagged personal org AND is private (a shared-org backfill can only change
 * targeting, never fix a personal-org symptom). Run it only on a build that
 * includes the `personal_org_for_user_id`-first `resolveTenantMember`.
 *
 * `--include-shared` lifts the skip ONLY when the user already has a
 * *resolvable* tagged personal org: an org with `personal_org_for_user_id`
 * AND a live `auth:signup` `$member` claim. A bare tag is not enough —
 * `resolveTenantMember` only prefers the tagged org when that claim exists;
 * otherwise it falls back to `createdAt ASC` among private orgs with claims,
 * so backfilling an older private shared org would silently redirect personal
 * identity facts into the shared org.
 *
 * ─── Safety ──────────────────────────────────────────────────────────────────
 *   - DRY-RUN by default; pass `--execute` to actually write.
 *   - Idempotent for healable rows: a second run finds no repaired rows.
 *   - Refuses rows where another live auth_user_id claim blocks the repair.
 *   - Per-row: a failure logs and continues (never aborts the whole batch).
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   bun run scripts/backfill-member-claims.ts                  # dry-run
 *   bun run scripts/backfill-member-claims.ts --execute        # write
 *   bun run scripts/backfill-member-claims.ts --org <id>       # one org
 *   bun run scripts/backfill-member-claims.ts --include-shared # private shared orgs (only if user has a resolvable tagged personal org)
 *
 * DATABASE_URL must point at the target database.
 */

/** Pure retarget-guard decision for a private, non-personal (shared) org row. */
export type SharedPrivateDecision =
  | "backfill"
  | "skip-shared-default"
  | "skip-no-resolvable-personal";

/**
 * Decide whether a private non-personal org may be backfilled.
 * Personal or public orgs are not gated here — callers only invoke this for
 * `!isPersonal && visibility === "private"`.
 */
export function decideSharedPrivateBackfill(opts: {
  includeShared: boolean;
  /**
   * True when the user has an org tagged personal_org_for_user_id that ALSO
   * has a live auth:signup $member claim — the same condition
   * resolveTenantMember needs to prefer that personal org over createdAt.
   */
  hasResolvableTaggedPersonalOrg: boolean;
}): SharedPrivateDecision {
  if (!opts.includeShared) return "skip-shared-default";
  if (!opts.hasResolvableTaggedPersonalOrg) {
    return "skip-no-resolvable-personal";
  }
  return "backfill";
}

import { parseArgs as parseNodeArgs } from "node:util";
import { provisionMemberAndCoreIdentities } from "../packages/server/src/auth/subject-identities";
import { resolvableMemberClaimExists } from "../packages/server/src/authz/member-claim-predicate";
import { getDb } from "../packages/server/src/db/client";
import { organizationLiveSql } from "../packages/server/src/workspace/deletion-state";

interface DriftRow {
  userId: string;
  organizationId: string;
  orgSlug: string;
  visibility: string;
  email: string | null;
  name: string | null;
  /** The member row's actual better-auth role, so a drifted non-owner is not
   * minted as an owner when its $member entity is created fresh. */
  role: string;
  /** True when this org is explicitly tagged as the user's personal org. */
  isPersonal: boolean;
  /** A live auth_user_id row that prevents the correct claim from being inserted. */
  hasBlockingClaim: boolean;
}

interface BackfillOptions {
  execute: boolean;
  org?: string;
  includeShared: boolean;
}

function parseArgs(argv: string[]): BackfillOptions {
  const { values } = parseNodeArgs({
    args: argv,
    options: {
      execute: { type: "boolean" },
      org: { type: "string" },
      "include-shared": { type: "boolean" },
    },
    allowPositionals: false,
    strict: true,
  });
  return {
    execute: values.execute ?? false,
    includeShared: values["include-shared"] ?? false,
    ...(values.org ? { org: values.org } : {}),
  };
}

async function findDrift(org?: string): Promise<DriftRow[]> {
  const sql = getDb();
  const rows = await sql<{
    userId: string;
    organizationId: string;
    orgSlug: string;
    visibility: string;
    email: string | null;
    name: string | null;
    role: string;
    isPersonal: boolean;
    hasBlockingClaim: boolean;
  }>`
    SELECT
      m."userId"          AS "userId",
      m."organizationId"  AS "organizationId",
      o.slug              AS "orgSlug",
      o.visibility        AS visibility,
      u.email             AS email,
      u.name              AS name,
      m.role              AS role,
      COALESCE(
        o.metadata::jsonb->>'personal_org_for_user_id' = m."userId",
        false
      ) AS "isPersonal",
      EXISTS (
        SELECT 1
        FROM entity_identities blocker
        WHERE blocker.organization_id = m."organizationId"
          AND blocker.namespace = 'auth_user_id'
          AND blocker.identifier = m."userId"
          AND blocker.deleted_at IS NULL
      ) AS "hasBlockingClaim"
    FROM "member" m
    JOIN organization o ON o.id = m."organizationId"
    JOIN "user" u ON u.id = m."userId"
    WHERE ${sql.unsafe(organizationLiveSql("o"))}
      AND NOT ${resolvableMemberClaimExists(sql, sql`m."organizationId"`, sql`m."userId"`)}
    ${org ? sql`AND m."organizationId" = ${org}` : sql``}
    ORDER BY o."createdAt" ASC
  `;
  return rows;
}

async function hasResolvableClaim(
  organizationId: string,
  userId: string
): Promise<boolean> {
  const sql = getDb();
  const rows = await sql<{ found: boolean }>`
    SELECT ${resolvableMemberClaimExists(sql, sql`${organizationId}`, sql`${userId}`)} AS found
  `;
  return rows[0]?.found ?? false;
}

/**
 * True when the user has a tagged personal org that resolveTenantMember can
 * actually prefer: tag present AND a live auth:signup $member claim on that
 * org. A bare tag (drifted/blocked claim) is not safe for --include-shared.
 */
async function userHasResolvableTaggedPersonalOrg(
  userId: string
): Promise<boolean> {
  const sql = getDb();
  // Compose the shared claim predicate against the tagged personal org, so
  // this check cannot drift from findDrift / hasResolvableClaim / the gate.
  const rows = await sql<{ found: boolean }>`
    SELECT EXISTS (
      SELECT 1
      FROM organization o
      WHERE o.metadata::jsonb->>'personal_org_for_user_id' = ${userId}
        AND ${resolvableMemberClaimExists(sql, sql`o.id`, sql`${userId}`)}
    ) AS found
  `;
  return rows[0]?.found ?? false;
}

async function main(): Promise<void> {
  let opts: BackfillOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error("set DATABASE_URL");
    process.exit(1);
  }
  const drift = await findDrift(opts.org);

  console.log(
    `Found ${drift.length} member row(s) without an auth:signup claim ` +
      `(${opts.execute ? "EXECUTE" : "DRY-RUN"}${opts.includeShared ? ", include-shared" : ""}).`
  );

  let backfilled = 0;
  let skippedBlocked = 0;
  let skippedShared = 0;
  let skippedNoResolvablePersonal = 0;
  let skippedNoEmail = 0;
  let failed = 0;
  /** Cache so we don't re-query the personal-org safety check once per shared row. */
  const resolvablePersonalCache = new Map<string, boolean>();

  for (const row of drift) {
    if (row.hasBlockingClaim) {
      skippedBlocked++;
      console.error(
        `  skip (blocking auth_user_id claim) user=${row.userId} org=${row.orgSlug}`
      );
      continue;
    }

    // Retarget guard: writing a claim into a private, NON-personal (shared) org
    // can change resolveTenantMember targeting. Default skip; --include-shared
    // only proceeds when the user already has a resolvable tagged personal org
    // (tag + live auth:signup claim) so the createdAt fallback cannot redirect
    // personal identity facts into the shared org.
    if (!row.isPersonal && row.visibility === "private") {
      let hasResolvableTaggedPersonalOrg = resolvablePersonalCache.get(
        row.userId
      );
      if (hasResolvableTaggedPersonalOrg === undefined) {
        hasResolvableTaggedPersonalOrg =
          await userHasResolvableTaggedPersonalOrg(row.userId);
        resolvablePersonalCache.set(row.userId, hasResolvableTaggedPersonalOrg);
      }
      const decision = decideSharedPrivateBackfill({
        includeShared: opts.includeShared,
        hasResolvableTaggedPersonalOrg,
      });
      if (decision === "skip-shared-default") {
        skippedShared++;
        console.log(
          `  skip (shared private org) user=${row.userId} org=${row.orgSlug}`
        );
        continue;
      }
      if (decision === "skip-no-resolvable-personal") {
        skippedNoResolvablePersonal++;
        console.error(
          `  skip (include-shared unsafe: no resolvable tagged personal org) user=${row.userId} org=${row.orgSlug}`
        );
        continue;
      }
    }
    if (!row.email) {
      skippedNoEmail++;
      console.log(`  skip (no email) user=${row.userId} org=${row.orgSlug}`);
      continue;
    }

    if (!opts.execute) {
      console.log(`  would backfill user=${row.userId} org=${row.orgSlug}`);
      backfilled++;
      continue;
    }

    try {
      await provisionMemberAndCoreIdentities(row.organizationId, {
        userId: row.userId,
        email: row.email,
        name: row.name,
        role: row.role,
      });
      if (!(await hasResolvableClaim(row.organizationId, row.userId))) {
        throw new Error("provisioning returned without a resolvable claim");
      }
      backfilled++;
      console.log(`  backfilled user=${row.userId} org=${row.orgSlug}`);
    } catch (err) {
      failed++;
      console.error(
        `  FAILED user=${row.userId} org=${row.orgSlug}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  console.log(
    `\nDone. ${opts.execute ? "backfilled" : "would backfill"}=${backfilled}` +
      ` skipped-blocked=${skippedBlocked} skipped-shared=${skippedShared}` +
      ` skipped-no-resolvable-personal=${skippedNoResolvablePersonal}` +
      ` skipped-no-email=${skippedNoEmail} failed=${failed}`
  );
  process.exit(
    failed > 0 || skippedBlocked > 0 || skippedNoResolvablePersonal > 0 ? 1 : 0
  );
}

// Only run when invoked as a CLI entrypoint — tests import the pure guard.
if (import.meta.main) {
  void main();
}
