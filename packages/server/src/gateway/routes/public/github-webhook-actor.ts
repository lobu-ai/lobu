/**
 * GitHub App webhook actor → person resolution. The live App-webhook path used
 * to land deliveries with empty `events.entity_ids`; this resolves the authoring
 * actor to a tenant-scoped `person` through the same attribution target as polling.
 * Org-scoped via the caller's resolved install; resolution never crosses orgs.
 */

import {
	GITHUB_IDENTITY,
	normalizeGithubLogin,
} from "@lobu/connectors/github-identity";
import { type DbClient, getDb } from "../../../db/client.js";
import {
	loadAttributionRuleByType,
	applyEventAttributions,
} from "../../../utils/entity-link-upsert.js";

interface GithubActor {
	login?: unknown;
	id?: unknown;
}

function actorLogin(node: unknown): string | undefined {
	if (node === null || typeof node !== "object") return undefined;
	const login = (node as GithubActor).login;
	return typeof login === "string" && login.length > 0 ? login : undefined;
}

function actorId(node: unknown): string | undefined {
	if (node === null || typeof node !== "object") return undefined;
	const id = (node as GithubActor).id;
	if (typeof id === "number" && Number.isFinite(id)) return String(id);
	if (typeof id === "string" && /^\d+$/.test(id.trim())) return id.trim();
	return undefined;
}

/**
 * The authoring actor: the `user` of the subject (comment, then
 * issue/PR/discussion/review), falling back to `sender` (a user object) so
 * star/watch/membership events — which carry only `sender` — still attribute.
 */
export function extractGithubActor(
	payload: unknown,
): { author_login: string; author_id?: string } | null {
	if (payload === null || typeof payload !== "object") return null;
	const root = payload as Record<string, unknown>;

	const subjectUser = (key: string): unknown => {
		const subject = root[key];
		if (subject === null || typeof subject !== "object") return undefined;
		return (subject as Record<string, unknown>).user;
	};
	const candidates: unknown[] = [
		subjectUser("comment"),
		subjectUser("issue"),
		subjectUser("pull_request"),
		subjectUser("discussion"),
		subjectUser("review"),
		root.sender,
	];

	for (const node of candidates) {
		const login = actorLogin(node);
		if (!login) continue;
		const id = actorId(node);
		return id ? { author_login: login, author_id: id } : { author_login: login };
	}
	return null;
}

// x-github-event header → our connector event-kind names. Only authored content
// kinds map; unmapped events (push, …) resolve no actor.
const GITHUB_EVENT_TO_KIND: Record<string, string> = {
	issues: "issue",
	pull_request: "pull_request",
	issue_comment: "issue_comment",
	pull_request_review_comment: "pr_comment",
	// review.user / comment.user authors — both already handled by extractGithubActor.
	pull_request_review: "pull_request_review",
	commit_comment: "commit_comment",
	discussion: "discussion",
	discussion_comment: "discussion_comment",
	star: "stargazer",
	watch: "stargazer",
};

export interface GithubActorResolution {
	/** Resolved/created person entity ids (usually one). */
	entityIds: number[];
	/** Canonical identifier namespace slots to stamp onto event metadata. */
	metadata: Record<string, string>;
}

/**
 * Resolve the delivery's authoring actor to a tenant-scoped `person`, returning
 * the entity ids + identifier metadata slots to stamp on the landed row.
 * Best-effort: any failure returns null (caller lands the row unattributed).
 */
export async function resolveGithubWebhookActor(params: {
	organizationId: string;
	connectionId?: number | null;
	githubEvent: string | null;
	payload: unknown;
	/** Optional transaction handle so the graph writes are atomic with the caller's insert. */
	sql?: DbClient;
}): Promise<GithubActorResolution | null> {
	if (!params.githubEvent) return null;
	const kind = GITHUB_EVENT_TO_KIND[params.githubEvent];
	if (!kind) return null;

	const actor = extractGithubActor(params.payload);
	if (!actor) return null;
	// Validate shape; keep raw casing in metadata for display title/traits —
	// entity-link-upsert normalizes github_login for identities + read-time slots.
	if (!normalizeGithubLogin(actor.author_login)) return null;

	// The person entity-link rule is read from the connector definition (same
	// source the poll path uses) — not mirrored here. Absent def/rule → no
	// attribution (best-effort).
	// Raw-webhook winners pass their open transaction here; a pooled read would
	// hold that transaction's connection while waiting for a second one (#2818).
	const sql = params.sql ?? getDb();
	const rule = await loadAttributionRuleByType(sql, {
		connectorKey: "github",
		orgId: params.organizationId,
		entityType: "person",
		// The webhook actor is the author of the delivered event; pin the role so
		// a future non-author person rule on the same kind can't be picked instead.
		role: "authored_by",
	});
	if (!rule) return null;

	// occurred_at is a top-level EventEnvelope field — the last_authored_at trait
	// reads it there, matching the poll path.
	const item: {
		origin_type: string;
		occurred_at: string;
		metadata: Record<string, unknown>;
	} = {
		origin_type: kind,
		occurred_at: new Date().toISOString(),
		metadata: {
			author_login: actor.author_login,
			...(actor.author_id ? { author_id: actor.author_id } : {}),
		},
	};

	const resolved = await applyEventAttributions(
		{
			connectorKey: "github",
			connectionId: params.connectionId,
			orgId: params.organizationId,
			items: [item],
			rules: { [kind]: [rule] },
		},
		sql,
	);

	const entityIds = resolved.entityIdsByItem.get(0) ?? [];
	// applyEventAttributions stamped the canonical namespace slots onto
	// item.metadata; forward only those onto the landed row.
	const metadata: Record<string, string> = {};
	for (const ns of [GITHUB_IDENTITY.LOGIN, GITHUB_IDENTITY.USER_ID]) {
		const value = item.metadata[ns];
		if (typeof value === "string" && value.length > 0) metadata[ns] = value;
	}

	if (entityIds.length === 0 && Object.keys(metadata).length === 0) return null;
	return { entityIds, metadata };
}
