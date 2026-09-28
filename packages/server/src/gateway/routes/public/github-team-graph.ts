/**
 * GitHub org-membership team graph (#17, PR2).
 *
 * On GitHub App install/refresh the org's members are now ENUMERATED (the App is
 * granted Organization → Members:read) and persisted as a team graph, instead of
 * being fetched-then-discarded:
 *
 *   - the org itself becomes a `company` entity, identified by the org's
 *     `github_login` + (immutable) `github_user_id` — orgs and users share
 *     GitHub's numeric id space;
 *   - each member becomes a `person` (resolved via the SAME entity-identity
 *     machinery PR1 uses, so a member who has also authored issues collapses to
 *     one entity);
 *   - a `member_of` relationship (person → company) is written per member.
 *
 * Entity-model decision: REUSE `company` for the org + a `member_of`
 * relationship-type, rather than introducing a `team` entity type. The org is a
 * company; "team" is the relationship, which the entity_relationships +
 * relationship-type machinery already expresses. No new entity type, no
 * migration.
 *
 * Idempotent: the company entity dedupes on its github identity; `member_of`
 * dedupes on the live-triple unique index
 * (from_entity_id, to_entity_id, relationship_type_id) WHERE deleted_at IS NULL.
 * A re-install/refresh adds new members and re-affirms existing edges without
 * duplicating anything.
 *
 * Tenant-scoped: the org id is the verified install's owning org; every
 * read/write filters on it, and entity_identities are UNIQUE per
 * (org, namespace, identifier) — never cross-tenant.
 *
 * Best-effort: like auto-provision, the install bind has already committed when
 * this runs, so any failure is logged and surfaced in the result, never thrown.
 */

import { getDb } from "../../../db/client.js";
import { createLogger } from "@lobu/core";
import { GITHUB_IDENTITY } from "@lobu/connectors/github-identity";
import { ensureMemberOfType } from "../../../authz/access-graph.js";
import { upsertEdges } from "../../../utils/edge-writes.js";
import { applyEventAttributions } from "../../../utils/entity-link-upsert.js";
import { withAclEdgeWrite } from "../../../utils/relationship-validation.js";

const logger = createLogger("github-team-graph");

const GITHUB_CONNECTOR_KEY = "github";

/** A GitHub org member as the org-members API reports it. */
export interface GithubOrgMember {
	login: string;
	id?: number;
}

/** The org account an installation belongs to. */
export interface GithubOrgAccount {
	login: string;
	id?: number;
	/** "Organization" enables the team graph; "User" installs have no members. */
	type: string;
}

export interface TeamGraphResult {
	/** The company entity id for the org, or null when not built. */
	companyEntityId: number | null;
	/** Member person entity ids that now have a member_of edge to the company. */
	memberEntityIds: number[];
	/** How many member_of edges were newly created (vs already present). */
	createdEdges: number;
}

const EMPTY_RESULT: TeamGraphResult = {
	companyEntityId: null,
	memberEntityIds: [],
	createdEdges: 0,
};

/**
 * Default org-members enumeration with the installation's OWN scoped token
 * (`GET /orgs/{org}/members`, paginated). Tenant-safe: the token only ever sees
 * the installed org. Returns `[]` on any HTTP/parse failure (best-effort).
 */
export async function defaultFetchOrgMembers(
	installationToken: string,
	org: string,
): Promise<GithubOrgMember[]> {
	const perPage = 100;
	const MAX_PAGES = 100;
	const members: GithubOrgMember[] = [];
	let page = 1;
	while (page <= MAX_PAGES) {
		let res: Response;
		try {
			res = await fetch(
				`https://api.github.com/orgs/${encodeURIComponent(org)}/members?per_page=${perPage}&page=${page}`,
				{
					headers: {
						Authorization: `Bearer ${installationToken}`,
						Accept: "application/vnd.github+json",
						"User-Agent": "lobu",
						"X-GitHub-Api-Version": "2022-11-28",
					},
				},
			);
		} catch (error) {
			logger.warn(
				{ error: error instanceof Error ? error.message : String(error), page },
				"GitHub /orgs/{org}/members request failed during team-graph build",
			);
			return members;
		}
		if (!res.ok) {
			logger.warn(
				{ status: res.status, page },
				"GitHub /orgs/{org}/members returned non-OK during team-graph build",
			);
			return members;
		}
		const body = (await res.json()) as Array<{ login?: string; id?: number }>;
		const pageMembers = Array.isArray(body) ? body : [];
		if (pageMembers.length === 0) break;
		for (const m of pageMembers) {
			if (typeof m.login === "string" && m.login.length > 0) {
				members.push({
					login: m.login,
					id: typeof m.id === "number" ? m.id : undefined,
				});
			}
		}
		if (pageMembers.length < perPage) break;
		page += 1;
	}
	return members;
}

/** Resolve an org owner/admin as `entities.created_by` (NOT NULL). */
async function resolveOrgCreator(orgId: string): Promise<string | null> {
	const sql = getDb();
	const rows = await sql<{ userId: string }>`
		SELECT "userId"
		FROM "member"
		WHERE "organizationId" = ${orgId}
		ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
		         "createdAt" ASC
		LIMIT 1
	`;
	return rows.length > 0 ? rows[0].userId : null;
}

/**
 * Find-or-create the `company` entity for the org, identified by the org's
 * github_login (+ immutable github_user_id when known). Reuses the person
 * resolver's entity-identity machinery by targeting entityType `company`, so the
 * org entity dedupes on its github identity exactly like members do.
 */
async function ensureOrgCompany(params: {
	orgId: string;
	account: GithubOrgAccount;
}): Promise<number | null> {
	const item: { origin_type: string; metadata: Record<string, unknown> } = {
		origin_type: "org",
		metadata: {
			org_login: params.account.login,
			...(typeof params.account.id === "number"
				? { org_id: String(params.account.id) }
				: {}),
		},
	};
	const resolved = await applyEventAttributions({
		connectorKey: GITHUB_CONNECTOR_KEY,
		orgId: params.orgId,
		items: [item],
		rules: {
			org: [
				{
					role: "belongs_to",
					entityType: "company",
					autoCreate: true,
					titlePath: "metadata.org_login",
					identities: [
						// PRIMARY: the org's immutable numeric id is authoritative (rename-safe).
						{
							namespace: GITHUB_IDENTITY.USER_ID,
							eventPath: "metadata.org_id",
							primary: true,
						},
						{ namespace: GITHUB_IDENTITY.LOGIN, eventPath: "metadata.org_login" },
					],
					traits: {
						github_login: {
							eventPath: "metadata.org_login",
							mergeStrategy: "prefer_non_empty",
						},
					},
				},
			],
		},
	});
	const ids = resolved.entityIdsByItem.get(0) ?? [];
	return ids.length > 0 ? ids[0] : null;
}

/**
 * Build the team graph for a GitHub App install: upsert the org `company`,
 * resolve each member to a `person`, and write `member_of` edges. Injectable
 * `fetchMembers` so tests never hit GitHub.
 *
 * @returns counts of what was built; empty when the install is a User account
 *          (no members) or no members resolved.
 */
export async function buildGithubTeamGraph(params: {
	organizationId: string;
	account: GithubOrgAccount;
	/** Members to persist. Tests pass these directly; prod fetches them. */
	members: GithubOrgMember[];
}): Promise<TeamGraphResult> {
	// User-account installs have no org membership to graph.
	if (params.account.type !== "Organization") return EMPTY_RESULT;
	if (params.members.length === 0) return EMPTY_RESULT;

	const creatorUserId = await resolveOrgCreator(params.organizationId);
	if (!creatorUserId) {
		logger.warn(
			{ organization_id: params.organizationId },
			"Team-graph skipped: org has no member to attribute as entity creator",
		);
		return EMPTY_RESULT;
	}

	const companyEntityId = await ensureOrgCompany({
		orgId: params.organizationId,
		account: params.account,
	});
	if (companyEntityId === null) {
		logger.warn(
			{ organization_id: params.organizationId, org_login: params.account.login },
			"Team-graph skipped: could not resolve/create the org company entity",
		);
		return EMPTY_RESULT;
	}

	// Resolve every member to a person in ONE batch (shared entity-identity
	// machinery — a member who also authored issues collapses to one person).
	const memberItems = params.members.map((m) => ({
		origin_type: "org_member",
		metadata: {
			author_login: m.login,
			...(typeof m.id === "number" ? { author_id: String(m.id) } : {}),
		},
	}));
	const resolvedMembers = await applyEventAttributions({
		connectorKey: GITHUB_CONNECTOR_KEY,
		orgId: params.organizationId,
		items: memberItems,
		rules: {
			org_member: [
				{
					role: "authored_by",
					entityType: "person",
					autoCreate: true,
					titlePath: "metadata.author_login",
					identities: [
						// PRIMARY: immutable id governs resolution when present (rename-safe).
						{
							namespace: GITHUB_IDENTITY.USER_ID,
							eventPath: "metadata.author_id",
							primary: true,
						},
						{ namespace: GITHUB_IDENTITY.LOGIN, eventPath: "metadata.author_login" },
					],
					traits: {
						github_login: {
							eventPath: "metadata.author_login",
							mergeStrategy: "prefer_non_empty",
						},
					},
				},
			],
		},
	});

	const memberEntityIds: number[] = [];
	for (let i = 0; i < memberItems.length; i++) {
		const ids = resolvedMembers.entityIdsByItem.get(i);
		if (ids && ids.length > 0) memberEntityIds.push(ids[0]);
	}
	const uniqueMemberIds = [...new Set(memberEntityIds)];
	if (uniqueMemberIds.length === 0) {
		return { companyEntityId, memberEntityIds: [], createdEdges: 0 };
	}

	const typeId = await ensureMemberOfType(params.organizationId);
	// person -> company. Idempotent on the live-triple unique index; a re-bind
	// re-affirms the edge without duplicating it.
	// The classified `member_of` type makes the trigger require the ACL write
	// flag for this edge.
	const created = await withAclEdgeWrite(getDb(), (tx) =>
		upsertEdges({
			db: tx,
			organizationId: params.organizationId,
			relationshipTypeId: typeId,
			pairs: uniqueMemberIds.map((memberId) => ({
				fromEntityId: memberId,
				toEntityId: companyEntityId,
			})),
			source: "feed",
			confidence: 1.0,
			createdBy: creatorUserId,
			// Installation ownership is account-scoped, not connection-scoped. The
			// stable account key is reused across reinstall/refresh and therefore
			// does not accumulate one claim per connection generation.
			claimKey: `config:github-team-graph:${params.account.id ?? params.account.login}`,
			onConflict: "ignore",
		}),
	);
	const createdEdges = created.length;

	logger.info(
		{
			organization_id: params.organizationId,
			org_login: params.account.login,
			company_entity_id: companyEntityId,
			members: uniqueMemberIds.length,
			created_edges: createdEdges,
		},
		"Built GitHub team graph",
	);

	return {
		companyEntityId,
		memberEntityIds: uniqueMemberIds,
		createdEdges,
	};
}
