/**
 * Helpers for writing the user's $member entity + entity_identities rows.
 *
 * Used by the signup hook to populate the identity graph so the gateway can
 * later route inbound messages back to the right user's personal org via a
 * single entity_identities lookup.
 */

import {
	normalizeSlackUserId,
	slackChatUserIdentity,
} from "@lobu/connectors/slack-identity";
import { fetchUserInfoWithRaw } from "../connect/oauth-providers";
import { getDb } from "../db/client";
import {
	type ResolvedTenantMember,
	resolveMemberOrgsForUser,
} from "../identity/member-orgs";
import logger from "../utils/logger";
import {
	ensureMemberEntity,
	resolveMemberSchemaFields,
} from "../utils/member-entity";
import {
	type ChatLoginIdentityDeps,
	chatLoginIdentityFor,
	type LoginAccountForChatIdentity,
} from "./chat-login-identities";
import { getEnabledLoginProviderConfigs } from "./config";

const log = logger.child({ module: "auth-subject-identities" });

interface PersonalSubject {
	userId: string;
	email: string;
	name?: string | null;
	image?: string | null;
	/**
	 * Role recorded on a NEWLY created `$member` (ignored when the entity already
	 * exists — ensureMemberEntity never rewrites the role of an existing member).
	 * Defaults to `owner` for the personal-org sign-up path; the backfill passes
	 * the member row's actual role so a drifted non-owner is not minted as owner.
	 */
	role?: string;
}

interface IdentityRow {
	namespace: string;
	identifier: string;
}

type Sql = ReturnType<typeof getDb>;

/**
 * Insert (or no-op on conflict) entity_identities rows pointing at the given
 * member entity. The unique index on (organization_id, namespace, identifier,
 * COALESCE(scope_key, ''))
 * WHERE deleted_at IS NULL guards against duplicates.
 */
async function writeIdentities(
	sql: Sql,
	organizationId: string,
	memberEntityId: number,
	source: string,
	rows: IdentityRow[],
): Promise<void> {
	for (const row of rows) {
		await sql`
      INSERT INTO entity_identities (
        organization_id, entity_id, namespace, identifier, source_connector, scope_key
      ) VALUES (
        ${organizationId}, ${memberEntityId}, ${row.namespace}, ${row.identifier}, ${source}, NULL
      )
      ON CONFLICT (organization_id, namespace, identifier, COALESCE(scope_key, '')) WHERE deleted_at IS NULL
      DO NOTHING
    `;
	}
}

/**
 * Point a workspace-scoped chat identity at the user's `$member`, taking it over
 * from a `person` entity when one already owns it.
 *
 * Why an UPDATE and not another INSERT: `entity_identities` has a live-unique
 * index on `(organization_id, namespace, identifier,
 * COALESCE(scope_key, ''))`, so the claim exists at most once —
 * auth-written identities are always org-scoped (NULL). `writeIdentities`'
 * `ON CONFLICT DO NOTHING` therefore SILENTLY LOSES
 * whenever the ACL sync minted a `person` for this workspace user before the
 * human ever signed in — which is the normal ordering, since channel sync runs
 * on a timer and sign-in is a one-off. The gate only ever resolves a `$member`
 * (channel-visibility.ts), so leaving the claim on the `person` hides every
 * enforced channel from its real owner.
 *
 * Re-pointing the claim is sufficient on its own: the ACL graph builder resolves
 * members by whoever owns the identity (`resolveMembers` is deliberately
 * type-agnostic) and reconciles `member_of` edges from that entity on the next
 * sync tick, so the edges follow the claim. Writing edges here by hand would be
 * undone by that same reconcile.
 *
 * SAFETY: only ever called with an identity proven by the provider's own OIDC
 * token for THIS user, and only for an org the user is already a better-auth
 * member of. It never grants org membership, and it never matches on a
 * user-editable field such as a Slack profile email — a workspace admin can set
 * those, which would let an attacker attach their `U…` to a victim's `$member`.
 *
 * The takeover is scoped to `person` entities. A claim already held by another
 * `$member` is a genuine identity conflict (two humans, one platform id) and is
 * left alone — fail closed, never steal.
 *
 * `namespace` comes from the platform's connector-owned descriptor, so this
 * helper serves every chat platform without naming one.
 */
async function adoptChatIdentityOntoMember(
	sql: Sql,
	organizationId: string,
	memberEntityId: number,
	namespace: string,
	identifier: string,
): Promise<"created" | "adopted" | "already-owned" | "conflict"> {
	const inserted = await sql<{ id: number }>`
    INSERT INTO entity_identities (
      organization_id, entity_id, namespace, identifier, source_connector, scope_key
    ) VALUES (
      ${organizationId}, ${memberEntityId}, ${namespace}, ${identifier}, 'auth:signup', NULL
    )
    ON CONFLICT (organization_id, namespace, identifier, COALESCE(scope_key, '')) WHERE deleted_at IS NULL
    DO NOTHING
    RETURNING id
  `;
	if (inserted.length > 0) return "created";

	// Take over only from a `person`; a `$member` holder means two humans claim
	// one workspace id, which must not be silently reassigned.
	const adopted = await sql<{ id: number }>`
    UPDATE entity_identities ei
    SET entity_id = ${memberEntityId},
        source_connector = 'auth:signup',
        -- Keep a trail back to the person we took this from, matching the
        -- convention in entity-merge.ts (COALESCE so a re-run never overwrites
        -- the ORIGINAL owner with an intermediate one).
        merged_from_entity_id = COALESCE(ei.merged_from_entity_id, ei.entity_id),
        updated_at = current_timestamp
    FROM entities e
    JOIN entity_types et
      ON et.id = e.entity_type_id
     AND et.organization_id = e.organization_id
    WHERE ei.organization_id = ${organizationId}
      AND ei.namespace = ${namespace}
      AND ei.identifier = ${identifier}
      AND ei.scope_key IS NULL
      AND ei.deleted_at IS NULL
      AND e.id = ei.entity_id
      AND e.organization_id = ei.organization_id
      AND et.slug = 'person'
    RETURNING ei.id
  `;
	if (adopted.length > 0) return "adopted";

	const mine = await sql<{ id: number }>`
    SELECT id FROM entity_identities
    WHERE organization_id = ${organizationId}
      AND namespace = ${namespace}
      AND identifier = ${identifier}
      AND scope_key IS NULL
      AND entity_id = ${memberEntityId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
	return mine.length > 0 ? "already-owned" : "conflict";
}

async function findMemberEntityIdByEmail(
	sql: Sql,
	organizationId: string,
	email: string,
): Promise<number | null> {
	const { emailField } = await resolveMemberSchemaFields(organizationId);
	const rows = await sql.unsafe(
		`SELECT e.id
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE et.slug = '$member'
      AND e.organization_id = $1
      AND e.metadata->>$2 = $3
      AND e.deleted_at IS NULL
    LIMIT 1`,
		[organizationId, emailField, email],
	);
	if (rows.length === 0) return null;
	return Number(rows[0].id);
}

/**
 * Create a $member entity for the user in the given org and write the core
 * personal identifiers (auth_user_id, email). Idempotent — safe to call again.
 */
export async function provisionMemberAndCoreIdentities(
	organizationId: string,
	subject: PersonalSubject,
): Promise<{ memberEntityId: number }> {
	const sql = getDb();
	const owners = await sql<{ email: string | null }>`
    SELECT email FROM "user" WHERE id = ${subject.userId} LIMIT 1
  `;
	if (
		owners[0]?.email?.trim().toLowerCase() !==
		subject.email.trim().toLowerCase()
	) {
		throw new Error(
			`Refusing to provision identities for user ${subject.userId}: user does not own the member email`,
		);
	}

	await ensureMemberEntity({
		organizationId,
		userId: subject.userId,
		name: subject.name?.trim() || subject.email.split("@")[0],
		email: subject.email,
		image: subject.image ?? undefined,
		role: subject.role ?? "owner",
		status: "active",
	});

	const memberEntityId = await findMemberEntityIdByEmail(
		sql,
		organizationId,
		subject.email,
	);
	if (memberEntityId === null) {
		throw new Error(
			`Failed to locate $member entity for user ${subject.userId} in org ${organizationId} after ensureMemberEntity`,
		);
	}

	await writeIdentities(sql, organizationId, memberEntityId, "auth:signup", [
		{ namespace: "auth_user_id", identifier: subject.userId },
		{ namespace: "email", identifier: subject.email.toLowerCase() },
	]);

	return { memberEntityId };
}

/**
 * The writer's injected boundary: the extractors' network reads
 * (`ChatLoginIdentityDeps`) plus the tenant lookup this function does itself.
 * `defaultPersistDeps` wires the production implementations.
 */
export interface PersistLoginChatIdentityDeps extends ChatLoginIdentityDeps {
	/**
	 * EVERY org where this user is a `$member`, not just their personal one — a
	 * chat identity is meaningful in each org whose ACL graph covers that
	 * workspace, and the authz gate resolves per-org.
	 */
	resolveMemberOrgsForUser: (
		userId: string,
	) => Promise<ResolvedTenantMember[]>;
}

const defaultPersistDeps: PersistLoginChatIdentityDeps = {
	resolveMemberOrgsForUser,
	getEnabledLoginProviderConfigs,
	fetchUserInfoWithRaw,
};

/**
 * On sign-in with a provider that proves a chat identity, write that identity
 * onto the user's `$member` entity, sourced `auth:signup`, in EVERY org where
 * they are a member. Idempotent, and a no-op for every other provider.
 *
 * Which providers qualify, what namespace they write, and how the key is built
 * all come from the registry (`chat-login-identities.ts` +
 * `@lobu/connectors/*-identity`) — this function names no provider. Today:
 * Slack sign-in mints the team-scoped `slack_user_id` (`T…:U…`); Google sign-in
 * mints the bare `google_user_id`, which is what Google Chat puts in a sender's
 * `users/{id}`.
 *
 * Effect: the chat-side graph collapses the platform member onto the existing
 * `$member` instead of forking a separate `person`, because both sides now
 * resolve on the same canonical key. That link is what lets a chat user bind an
 * agent (`/lobu <agent>`) as themselves, and on Slack — the only platform whose
 * interaction bridge resolves a reviewer today — decide an approval card.
 *
 * Runs across every member org, not just the personal one: a workspace is
 * commonly connected to a SHARED org, and the authz gate resolves per-org — so
 * writing only to the personal org leaves the user invisible in exactly the org
 * whose channels they are trying to read.
 *
 * Fire-and-forget — failures log and never throw into the auth hook.
 */
export async function persistLoginChatIdentity(
	account: LoginAccountForChatIdentity,
	deps: PersistLoginChatIdentityDeps = defaultPersistDeps,
): Promise<void> {
	const entry = chatLoginIdentityFor(account.providerId);
	if (!entry) return;
	const { identity } = entry;
	try {
		const memberOrgs = await deps.resolveMemberOrgsForUser(account.userId);
		if (memberOrgs.length === 0) {
			log.debug(
				{ userId: account.userId, namespace: identity.namespace },
				"chat-identity: no tenant $member yet — skipping identity write",
			);
			return;
		}

		const principal = await entry.extract(account, deps);
		// null = the provider could not prove a principal (no token, no id_token
		// claim, no account id). Never guess one.
		const combined = principal
			? identity.buildUserKey(principal.teamId, principal.platformUserId)
			: null;
		if (!combined) {
			log.debug(
				{ userId: account.userId, namespace: identity.namespace },
				"chat-identity: could not build a scoped key — skipping identity write",
			);
			return;
		}

		const sql = getDb();
		for (const org of memberOrgs) {
			const outcome = await adoptChatIdentityOntoMember(
				sql,
				org.tenantOrganizationId,
				org.memberEntityId,
				identity.namespace,
				combined,
			);
			if (outcome === "conflict") {
				// Another `$member` in this org already holds this platform id. Two
				// humans cannot share one account, so this is a data problem a person
				// must look at — never silently reassign.
				log.warn(
					{
						userId: account.userId,
						organizationId: org.tenantOrganizationId,
						memberEntityId: org.memberEntityId,
						namespace: identity.namespace,
					},
					"chat-identity: identity already claimed by a different $member — leaving it alone",
				);
				continue;
			}
			log.debug(
				{
					userId: account.userId,
					organizationId: org.tenantOrganizationId,
					namespace: identity.namespace,
					source: principal?.source,
					outcome,
				},
				"chat-identity: linked chat identity to $member",
			);
		}
	} catch (err) {
		log.error(
			{ err, userId: account.userId, providerId: account.providerId },
			"chat-identity: failed to persist chat identity on login",
		);
	}
}

/**
 * Stamp a workspace-scoped Slack identity onto a user's `$member` in every org
 * they belong to, idempotently and failing closed on conflict.
 *
 * This is the same write `persistLoginChatIdentity` performs, exposed for the
 * install-claim path. That path needs it for a key OAuth alone cannot supply:
 * on Slack Grid the install row is keyed by the ENTERPRISE id (`E…`) while a
 * sign-in only ever proves the WORKSPACE id (`T…`), and inbound events may
 * carry either. Without the enterprise stamp the `E…` lookup resolves nothing
 * and the installer silently loses the identity-linked privileges.
 *
 * Refuses to write an unscoped id: `normalizeSlackUserId` returns null without
 * a team, and two workspaces can share a bare `U…`.
 */
export async function stampSlackIdentityForUser(
	userId: string,
	teamId: string | null | undefined,
	slackUserId: string,
): Promise<void> {
	const combined = normalizeSlackUserId(teamId, slackUserId);
	if (!combined) {
		log.debug(
			{ userId },
			"slack-identity: missing team_id or user id — skipping slack_user_id stamp",
		);
		return;
	}
	const memberOrgs = await resolveMemberOrgsForUser(userId);
	if (memberOrgs.length === 0) {
		log.debug(
			{ userId },
			"slack-identity: no tenant $member yet — skipping slack_user_id stamp",
		);
		return;
	}
	const sql = getDb();
	for (const org of memberOrgs) {
		const outcome = await adoptChatIdentityOntoMember(
			sql,
			org.tenantOrganizationId,
			org.memberEntityId,
			slackChatUserIdentity.namespace,
			combined,
		);
		if (outcome === "conflict") {
			// A different `$member` in this org already holds this Slack id. Two
			// humans cannot share one workspace account — never silently reassign.
			log.warn(
				{
					userId,
					organizationId: org.tenantOrganizationId,
					memberEntityId: org.memberEntityId,
				},
				"slack-identity: slack_user_id already claimed by a different $member — leaving it alone",
			);
		}
	}
}
