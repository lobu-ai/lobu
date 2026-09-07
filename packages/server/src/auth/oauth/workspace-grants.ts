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
 * Deployment cutover for multi-workspace OAuth issuance.
 *
 * Keep this OFF through the additive database/application rollout. Old pods do
 * not understand immutable grant arrays, so enabling while they still receive
 * traffic can turn a selected-workspace consent into legacy all-membership
 * access. Set `LOBU_OAUTH_MULTI_WORKSPACE_GRANTS=1` only after every backend pod
 * runs the grant-aware verifier/tool enforcement. Rollback must first turn the
 * flag off and revoke/re-authorize any multi-grant clients before old code can
 * receive traffic again.
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
