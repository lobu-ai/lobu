/**
 * Auto-provision a private personal organization for every newly created user.
 *
 * Mirrors the "filing cabinet" model: each user gets their own private org
 * (their data) which template agents (e.g. examples/personal-finance) can be
 * installed into. Without this, a user landing on the app has no workspace
 * to receive auto-installed agents or per-user mirrored schemas.
 */

import { slugify as slugifyBase } from "@lobu/core";
import { getDb } from "../db/client";
import { RESERVED_PATHS_SET } from "../utils/reserved";
import { recordWorkspaceChangeEvent } from "../utils/insert-event";
import { generateSecureToken } from "./oauth/utils";
import { provisionMemberAndCoreIdentities } from "./subject-identities";
import logger from "../utils/logger";

interface UserLike {
	id: string;
	email?: string | null;
	name?: string | null;
	username?: string | null;
}

// Reserved owner-slug names. Re-exports the canonical set from utils/reserved
// (which is a superset of the DB `org_slug_not_reserved` CHECK constraint in
// 20260420120000_extend_reserved_org_slugs.sql). Inserts that hit a DB-reserved
// slug raise a constraint violation, so the candidate-derivation layer must
// avoid them up front; extra app-level entries are defense-in-depth against
// route-collision squatting.
export const RESERVED_SLUGS = RESERVED_PATHS_SET;

const MAX_SLUG_LENGTH = 48;
const MAX_COLLISION_ATTEMPTS = 100;
// Namespace for pg_advisory_xact_lock(key1, key2). Kept in the signed int32
// range required by PostgreSQL's two-key advisory lock overload.
const PERSONAL_ORG_LOCK_NAMESPACE = 0x706f7267; // "porg"

type Sql = ReturnType<typeof getDb>;

// Org slugs strip diacritics (NFKD) and cap length so they stay route-safe.
export function slugify(input: string): string {
	return slugifyBase(input, { normalize: true, maxLength: MAX_SLUG_LENGTH });
}

export function deriveSlugCandidate(user: UserLike): string {
	const candidates = [user.username, user.name, user.email?.split("@")[0]];
	for (const raw of candidates) {
		if (!raw) continue;
		const s = slugify(raw);
		if (s) return s;
	}
	return `user-${user.id.slice(0, 8).toLowerCase()}`;
}

async function findAvailableSlug(base: string, sql: Sql): Promise<string> {
	const safeBase = RESERVED_SLUGS.has(base) ? `${base}-1` : base;
	let candidate = safeBase;
	for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt++) {
		if (!RESERVED_SLUGS.has(candidate)) {
			const rows = await sql`
        SELECT 1 FROM "organization" WHERE slug = ${candidate} LIMIT 1
      `;
			if (rows.length === 0) return candidate;
		}
		candidate = `${safeBase}-${attempt + 2}`;
	}
	// Last-resort suffix — astronomically unlikely to reach this branch.
	return `${safeBase}-${generateSecureToken(4)
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")}`;
}

type EnsureResult =
	| {
			organizationId: string;
			slug: string;
			created: false;
	  }
	| {
			organizationId: string;
			slug: string;
			created: true;
			/** Audit fields — populated only on the created branch. */
			memberId: string;
			orgName: string;
	  };

export function personalOrgLockKey(userId: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < userId.length; i++) {
		hash ^= userId.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash | 0;
}

async function lockPersonalOrgForUser(userId: string, sql: Sql): Promise<void> {
	await sql`
    SELECT pg_advisory_xact_lock(
      ${PERSONAL_ORG_LOCK_NAMESPACE},
      ${personalOrgLockKey(userId)}
    )
  `;
}

/**
 * Read the `personal_org_for_user_id` marker off an `organization` row.
 *
 * `organization.metadata` is a `text` column holding JSON, but Better Auth
 * hands hooks an already-parsed object, so accept both shapes. Anything that
 * fails to parse, or carries a non-string marker, returns null: callers use
 * this to *restrict* an action, so an unreadable row must not be treated as
 * personal.
 */
export function readPersonalOrgOwnerId(metadata: unknown): string | null {
	let parsed: Record<string, unknown> | null = null;
	if (typeof metadata === "string") {
		try {
			parsed = JSON.parse(metadata) as Record<string, unknown> | null;
		} catch {
			return null;
		}
	} else if (metadata && typeof metadata === "object") {
		parsed = metadata as Record<string, unknown>;
	}
	const marker = parsed?.personal_org_for_user_id;
	return typeof marker === "string" && marker.length > 0 ? marker : null;
}

/**
 * A user's personal org is not user-deletable.
 *
 * Device tokens are force-bound to it (the device-worker grant in
 * `oauth/routes.ts`), the device-worker middleware builds `workerOrgIds` from
 * it, and auto-wire targets it unconditionally (`device-reconcile.ts`).
 * Deleting it strands the account rather than freeing a workspace: pairing
 * 403s with "No personal organization is provisioned", existing workers 403 on
 * every poll, and auto-wire silently returns []. Team orgs stay deletable.
 */
export function isPersonalOrgDeletionBlocked(
	metadata: unknown,
	actingUserId: string,
): boolean {
	const ownerId = readPersonalOrgOwnerId(metadata);
	return ownerId !== null && ownerId === actingUserId;
}

export async function findExistingPersonalOrg(
	userId: string,
	sql: Sql,
): Promise<{ id: string; slug: string; name: string } | null> {
	// Idempotency: an org tagged with this user.id in metadata is already this
	// user's personal one. Re-running the hook (e.g. after a transient failure)
	// is a no-op. The ORDER BY keeps resolution deterministic if legacy data ever
	// contains duplicates.
	// organization.metadata is `text` storing JSON; cast to jsonb and use ->>
	// instead of LIKE so a userId containing % or _ can't match unintended rows.
	const existing = await sql`
    SELECT id, slug, name FROM "organization"
    WHERE metadata IS NOT NULL
      AND (metadata::jsonb)->>'personal_org_for_user_id' = ${userId}
    ORDER BY "createdAt" ASC, id ASC
    LIMIT 1
  `;
	if (existing.length === 0) return null;
	return existing[0] as { id: string; slug: string; name: string };
}

export async function ensurePersonalOrganization(
	user: UserLike,
): Promise<EnsureResult> {
	const sql = getDb();
	let result: EnsureResult | null = null;

	await sql.begin(async (tx) => {
		await lockPersonalOrgForUser(user.id, tx);

		const existing = await findExistingPersonalOrg(user.id, tx);
		if (existing) {
			result = {
				organizationId: existing.id,
				slug: existing.slug,
				created: false,
			};
			return;
		}

		const baseSlug = deriveSlugCandidate(user);
		const slug = await findAvailableSlug(baseSlug, tx);
		const orgId = `org_${generateSecureToken(8)}`;
		const memberId = `member_${generateSecureToken(8)}`;
		const orgName = user.name?.trim() || user.email?.split("@")[0] || slug;
		const metadata = JSON.stringify({ personal_org_for_user_id: user.id });

		await tx`
      INSERT INTO "organization" (id, name, slug, visibility, metadata, "createdAt")
      VALUES (${orgId}, ${orgName}, ${slug}, 'private', ${metadata}, NOW())
    `;
		await tx`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES (${memberId}, ${user.id}, ${orgId}, 'owner', NOW())
    `;

		result = { organizationId: orgId, slug, created: true, memberId, orgName };
	});

	const finalResult = result as EnsureResult | null;
	if (!finalResult) {
		throw new Error(
			"Personal organization transaction did not produce a result",
		);
	}

	// Org + owner membership audit trail (workspace category: appears in All
	// activity, not the Deployments feed). Emitted AFTER the transaction
	// commits — the events FK references the organization row, so the insert
	// must not race the commit.
	if (finalResult.created) {
		const orgState = {
			id: finalResult.organizationId,
			name: finalResult.orgName,
			slug: finalResult.slug,
			visibility: 'private',
		};
		recordWorkspaceChangeEvent({
			organizationId: finalResult.organizationId,
			resourceKind: 'organization',
			resourceId: finalResult.organizationId,
			op: 'created',
			summary: `Organization "${finalResult.orgName}" created`,
			state: orgState,
			changedFields: ['id', 'name', 'slug', 'visibility'],
			actorSource: 'ui',
			createdBy: user.id,
		});
		recordWorkspaceChangeEvent({
			organizationId: finalResult.organizationId,
			resourceKind: 'member',
			resourceId: finalResult.memberId,
			op: 'created',
			summary: `Member "${user.name || 'the owner'}" joined as owner`,
			state: { id: finalResult.memberId, user_id: user.id, role: 'owner' },
			changedFields: ['user_id', 'role'],
			actorSource: 'ui',
			createdBy: user.id,
		});
	}

	// Mirror the personal org slug onto the user's username when unset. The
	// frontend resolves a user's home org from session.user.username
	// (personalOrgSlug); having it set means the home route can route to the
	// personal org synchronously instead of waiting on the `/api/organizations`
	// fetch. Non-fatal and idempotent (only fills a null username); the NOT
	// EXISTS guard avoids colliding with another user's username. Runs for both
	// newly created and pre-existing personal orgs so legacy users self-heal on
	// their next login.
	try {
		await sql`
      UPDATE "user"
      SET username = ${finalResult.slug}
      WHERE id = ${user.id}
        AND username IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "user" u2
          WHERE u2.username = ${finalResult.slug} AND u2.id <> ${user.id}
        )
    `;
	} catch (error) {
		console.error("[Auth] Failed to set username for personal org:", {
			userId: user.id,
			slug: finalResult.slug,
			error: String(error),
		});
	}

	// Provision the $member entity + core identifiers (auth_user_id, email)
	// outside the transaction. ensureMemberEntity uses createEntity which
	// manages its own transaction and seeds the $member entity type if absent.
	// Failures here shouldn't roll back the org creation — the user has a
	// valid org, identity rows can be backfilled later. Run this for both newly
	// created and pre-existing personal orgs; the helper is idempotent.
	if (user.email) {
		try {
			await provisionMemberAndCoreIdentities(finalResult.organizationId, {
				userId: user.id,
				email: user.email,
				name: user.name,
			});
		} catch (error) {
			// Drift risk: the personal org + member row exist, but without the
			// $member + auth:signup claim the user resolves to nothing in the authz
			// gate. Structured to correlate with the drift detector; non-fatal so a
			// failed identity write can't break org creation (it's retried on the
			// next call — the helper is idempotent).
			logger.error(
				{
					err: error,
					event: "member_claim_drift",
					hook: "personalOrgProvisioning",
					organizationId: finalResult.organizationId,
					userId: user.id,
				},
				"[Auth] Failed to provision $member entity for personal org",
			);
		}
	}

	return finalResult;
}
