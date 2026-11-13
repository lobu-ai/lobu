/**
 * $member projection-drift alerter.
 *
 * The authz channel-visibility gate resolves a signed-in user to their `$member`
 * entity via an `entity_identities` row: namespace `auth_user_id`, source
 * `auth:signup`, on an entity of type `$member`. When a better-auth `member` row
 * exists WITHOUT that claim, the gate resolves the user to nothing and hides
 * every enforced channel from them. Provisioning hooks log and swallow identity
 * write failures, so the missing projection can persist after membership is
 * committed.
 *
 * This job is the smoke detector, NOT the repair. It scans for two failure
 * shapes; the scheduler logs a non-zero result so provisioning regressions
 * surface without waiting for a user to report hidden channels:
 *
 *   1. `missing_claim` — a `member` row with no matching `$member` + `auth:signup`
 *      claim in that org. The historical drift.
 *
 *   2. `poison_claim` — a live `auth_user_id` claim that blocks the correct
 *      insert but points to the wrong entity shape or source.
 *
 * Workspaces with a pending deletion are skipped: the purge hard-deletes their
 * `$member` entities before the organization delete removes the `member` rows,
 * and nobody can resolve into a deleting workspace anyway.
 *
 * Read-only. Single-claimant per tick via the runs-queue (registered in
 * scheduled/jobs.ts), so multi-replica safe with no extra coordination.
 */

import { resolvableMemberClaimExists } from "../authz/member-claim-predicate";
import { getDb } from "../db/client";
import { organizationLiveSql } from "../workspace/deletion-state";

interface MemberClaimDriftResult {
	/**
	 * better-auth member rows with no resolvable `$member` + `auth:signup` claim
	 * in their org. Counts BOTH the drifted rows (no claim at all) AND the
	 * poisoned ones (claim exists but on a non-$member) — the gate resolves
	 * neither. `poisonClaim` isolates the poisoned subset.
	 */
	missingClaim: number;
	/**
	 * The self-heal-proof subset: a live `auth_user_id` claim that blocks the
	 * correct insert but cannot resolve to a live `$member` with source
	 * `auth:signup`.
	 */
	poisonClaim: number;
}

export async function runMemberClaimDriftCheck(): Promise<MemberClaimDriftResult> {
	const sql = getDb();

	const missingRows = await sql<{ n: number }>`
    SELECT count(*)::int AS n
    FROM "member" m
    JOIN organization o ON o.id = m."organizationId"
    WHERE ${sql.unsafe(organizationLiveSql("o"))}
      AND NOT ${resolvableMemberClaimExists(sql, sql`m."organizationId"`, sql`m."userId"`)}
  `;

	// Any live claim that blocks the correct insert without satisfying the gate.
	const poisonRows = await sql<{ n: number }>`
    SELECT count(*)::int AS n
    FROM entity_identities ei
    JOIN "member" m
      ON m."organizationId" = ei.organization_id
     AND m."userId" = ei.identifier
    JOIN organization o ON o.id = m."organizationId"
    JOIN entities e
      ON e.id = ei.entity_id
     AND e.organization_id = ei.organization_id
    JOIN entity_types et
      ON et.id = e.entity_type_id
     AND et.organization_id = e.organization_id
    WHERE ${sql.unsafe(organizationLiveSql("o"))}
      AND ei.namespace = 'auth_user_id'
      AND ei.scope_key IS NULL
      AND ei.deleted_at IS NULL
      AND (
        e.deleted_at IS NOT NULL
        OR et.slug <> '$member'
        OR ei.source_connector <> 'auth:signup'
      )
  `;

	const result: MemberClaimDriftResult = {
		missingClaim: missingRows[0]?.n ?? 0,
		poisonClaim: poisonRows[0]?.n ?? 0,
	};

	return result;
}
