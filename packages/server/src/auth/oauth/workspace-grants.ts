import {
	type DbClient,
	getDb,
	parsePgTextArray,
	pgTextArray,
} from "../../db/client";
import { findExistingPersonalOrg } from "../personal-org-provisioning";

/** Keep consent payloads and direct-search fan-out bounded. */
export const MAX_GRANTED_ORGANIZATIONS = 50;

/**
 * Controls whether ordinary bare-account OAuth consent may include more than
 * one workspace. Both states issue an explicit grant snapshot with no default
 * workspace; grant verification and enforcement are never gated by this flag.
 */
export function isMultiWorkspaceGrantIssuanceEnabled(
	env: Record<string, string | undefined>,
): boolean {
	return env.LOBU_OAUTH_MULTI_WORKSPACE_GRANTS === "1";
}

export interface GrantedMemberWorkspace {
	id: string;
	slug: string;
	name: string;
	role: string;
	personal: boolean;
}

/** Canonicalize a caller-supplied snapshot without changing its order. */
export function canonicalizeGrantedOrganizationIds(
	ids: readonly string[],
): string[] {
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const value of ids) {
		const id = value.trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		unique.push(id);
	}
	return unique;
}

/** Decode the immutable stored grant; missing snapshots grant no workspaces. */
export function normalizeStoredGrantedOrganizationIds(value: unknown): string[] {
	let parsed: string[] = [];
	if (Array.isArray(value)) {
		parsed = value.filter((item): item is string => typeof item === "string");
	} else if (typeof value === "string") {
		parsed = parsePgTextArray(value);
	}
	return canonicalizeGrantedOrganizationIds(parsed);
}

/**
 * Return only grant entries for which membership is live right now.  The
 * unnest join preserves consent order and deliberately bypasses membership
 * caches so removal takes effect on every replica immediately.
 */
export async function listLiveGrantedMemberWorkspaces({
	sql = getDb(),
	userId,
	grantedOrganizationIds,
}: {
	sql?: DbClient;
	userId: string;
	grantedOrganizationIds: readonly string[];
}): Promise<GrantedMemberWorkspace[]> {
	const ids = canonicalizeGrantedOrganizationIds(grantedOrganizationIds);
	if (ids.length === 0 || ids.length > MAX_GRANTED_ORGANIZATIONS) return [];

	const [rows, personalOrg] = await Promise.all([
		sql`
      SELECT o.id, o.slug, o.name, m.role
      FROM unnest(${pgTextArray(ids)}::text[]) WITH ORDINALITY AS grant_row(id, position)
      JOIN organization o ON o.id = grant_row.id
      JOIN member m
        ON m."organizationId" = o.id
       AND m."userId" = ${userId}
      ORDER BY grant_row.position ASC
    `,
		findExistingPersonalOrg(userId, sql),
	]);

	return rows.map((row) => ({
		id: String(row.id),
		slug: String(row.slug),
		name: String(row.name),
		role: String(row.role),
		personal: personalOrg?.id === String(row.id),
	}));
}

/**
 * Resolve one target through both the immutable grant snapshot and a fresh
 * membership join. Unknown, ungranted, and removed targets all return null so
 * callers can expose one indistinguishable authorization error.
 */
export async function resolveGrantedWorkspaceTarget({
	sql = getDb(),
	userId,
	grantedOrganizationIds,
	slugOrId,
}: {
	sql?: DbClient;
	userId: string;
	grantedOrganizationIds: readonly string[];
	slugOrId: string;
}): Promise<GrantedMemberWorkspace | null> {
	const target = slugOrId.trim();
	if (!target) return null;
	const workspaces = await listLiveGrantedMemberWorkspaces({
		sql,
		userId,
		grantedOrganizationIds,
	});
	return (
		workspaces.find(
			(workspace) => workspace.id === target || workspace.slug === target,
		) ?? null
	);
}

export interface UngrantedMemberWorkspace {
	id: string;
	slug: string;
	name: string;
	role: string;
}

/**
 * Live membership check for a workspace the grant snapshot did not resolve.
 * Returns the member row when `userId` belongs to `slugOrId` right now, null
 * otherwise (unknown slug/id, or a real non-member).
 *
 * Callers use this ONLY after `resolveGrantedWorkspaceTarget` returned null to
 * tell "you're a member but this authorization predates the membership"
 * apart from "unknown or no access". The existence of a private workspace is
 * revealed only to its own members, who can already see it via the session
 * `/api/organizations` list — never to non-members.
 */
export async function findUngrantedMemberWorkspace({
	sql = getDb(),
	userId,
	slugOrId,
}: {
	sql?: DbClient;
	userId: string;
	slugOrId: string;
}): Promise<UngrantedMemberWorkspace | null> {
	const target = slugOrId.trim();
	if (!target || !userId) return null;
	const rows = await sql`
      SELECT o.id, o.slug, o.name, m.role
      FROM organization o
      JOIN member m
        ON m."organizationId" = o.id
       AND m."userId" = ${userId}
      WHERE o.slug = ${target} OR o.id = ${target}
      LIMIT 1
    `;
	if (rows.length === 0) return null;
	const row = rows[0];
	return {
		id: String(row.id),
		slug: String(row.slug),
		name: String(row.name),
		role: String(row.role),
	};
}

/**
 * Actionable copy for the member-but-ungranted case. Names the canonical slug
 * from the live member row (not the caller's raw input) and points at the
 * fix: a fresh OAuth consent that includes the workspace.
 */
export function formatUngrantedMemberMessage(slug: string): string {
	return (
		`You are a member of '${slug}' but this authorization doesn't include it. ` +
		`Reconnect with OAuth consent for that workspace, then retry.`
	);
}
