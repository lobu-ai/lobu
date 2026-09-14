import { SLACK_IDENTITY } from "@lobu/connectors/slack-identity";
import { getDb } from "../../db/client.js";
import { chatUserIdentityFor } from "./chat-identity-sources.js";

/**
 * Resolve a chat-platform user to the Lobu `user` they are, using the entity
 * graph as the source of truth.
 *
 * This used to read a dedicated `chat_user_identities` table. It no longer
 * does: the same fact is already recorded, better, by `persistLoginChatIdentity`
 * (auth/subject-identities.ts) on every matching OAuth sign-in and token
 * refresh. That writer stamps `entity_identities` in the platform's own
 * namespace onto the signer's `$member` in each org they belong to — and
 * refuses to write anything it cannot key safely.
 *
 * The KEY SHAPE is per platform and comes from the connector-owned descriptor
 * (`chat-identity-sources.ts`), never from this file. Slack's is the composite
 * `TEAM:USER`, because two workspaces can legitimately contain the same bare
 * `U…` and a lookup keyed on the user id alone would map one workspace's person
 * onto another workspace's Lobu account. Google's is the bare account id,
 * because Google cannot mint that id twice. Callers use this to grant privilege
 * (approval clicks, owner re-bind), so a wrong key is a mis-grant, not merely a
 * wrong answer.
 *
 * NOTE: this is a 1:1 platform-identity → user link, NOT cross-platform identity
 * CONSOLIDATION (one human's Slack + Telegram + custom identities merged to one
 * canonical user). That merge layer is a separate design — see the identity-
 * consolidation RFC.
 */

/**
 * The Lobu user id a chat-platform user has linked to, or null.
 *
 * Registry-driven: a platform resolves only when a connector contributes a
 * `ChatUserIdentity` for it AND that descriptor can key the inbound ids. Every
 * other platform resolves null, which is the correct fail-closed answer — an
 * unlinked id must never resolve to the wrong user.
 *
 * FAILS CLOSED on ambiguity. The identity rows are org-scoped, so one human in
 * several orgs yields several rows; they normally all carry the same
 * `auth_user_id` because the same authenticated human signed in. If two
 * DISTINCT Lobu users are reachable from one workspace principal the graph is
 * inconsistent, and this returns null rather than picking one.
 *
 * Callers that may hold a Grid enterprise id (`E…`) OR a workspace id (`T…`)
 * should try both keys themselves (e.g. message team + connection
 * external_tenant_id) rather than collapsing isolation here.
 */
export async function resolveChatUserIdentity(
	platform: string,
	teamId: string | undefined,
	platformUserId: string,
): Promise<string | null> {
	const identity = chatUserIdentityFor(platform);
	if (!identity) return null;
	// Same key builder the writer uses, so the key matches byte-for-byte. Returns
	// null when the platform's scoping requirements aren't met (e.g. Slack
	// without a team id) — never a bare, unscoped id for a platform that needs one.
	const combined = identity.buildUserKey(teamId, platformUserId);
	if (!combined) return null;

	const rows = await getDb()<{ lobu_user_id: string }>`
    SELECT DISTINCT auth_ei.identifier AS lobu_user_id
    FROM entity_identities chat_ei
    JOIN entities e
      ON e.id = chat_ei.entity_id
     AND e.organization_id = chat_ei.organization_id
     AND e.deleted_at IS NULL
    JOIN entity_identities auth_ei
      ON auth_ei.organization_id = chat_ei.organization_id
     AND auth_ei.entity_id = chat_ei.entity_id
     AND auth_ei.namespace = 'auth_user_id'
     AND auth_ei.scope_key IS NULL
     AND auth_ei.source_connector = 'auth:signup'
     AND auth_ei.deleted_at IS NULL
    WHERE chat_ei.namespace = ${identity.namespace}
      AND chat_ei.identifier = ${combined}
      AND chat_ei.scope_key IS NULL
      AND chat_ei.deleted_at IS NULL
    LIMIT 2
  `;
	if (rows.length !== 1) return null;
	return rows[0].lobu_user_id;
}

/**
 * The REVERSE lookup: the workspace-scoped Slack user id a Lobu user has in
 * `teamId`, or null. Used to address an owner directly in a workspace one of
 * the org's bot connections lives in.
 *
 * Same source of truth as `resolveChatUserIdentity`, walked the other way:
 * from the `$member` carrying this `auth_user_id` to the `slack_user_id`
 * stamped on it. The prefix match is on the composite `TEAM:USER` key, so it
 * stays workspace-scoped and index-usable (no leading wildcard).
 */
export async function resolveSlackUserIdForUser(
	userId: string,
	teamId: string,
): Promise<string | null> {
	const prefix = `${teamId.toUpperCase()}:`;
	// `_` is a LIKE wildcard AND a character `normalizeSlackUserId` accepts in a
	// team id, so an unescaped pattern like `T_ACME:%` would also match
	// `TXACME:…` — returning a user id from the wrong workspace. Escape all
	// LIKE metacharacters so the prefix matches literally.
	const likePrefix = prefix.replace(/([\\%_])/g, "\\$1");
	const rows = await getDb()<{ identifier: string }>`
    SELECT DISTINCT slack_ei.identifier
    FROM entity_identities auth_ei
    JOIN entities e
      ON e.id = auth_ei.entity_id
     AND e.organization_id = auth_ei.organization_id
     AND e.deleted_at IS NULL
    JOIN entity_identities slack_ei
      ON slack_ei.organization_id = auth_ei.organization_id
     AND slack_ei.entity_id = auth_ei.entity_id
     AND slack_ei.namespace = ${SLACK_IDENTITY.USER_ID}
     AND slack_ei.scope_key IS NULL
     AND slack_ei.deleted_at IS NULL
    WHERE auth_ei.namespace = 'auth_user_id'
      AND auth_ei.identifier = ${userId}
      AND auth_ei.scope_key IS NULL
      AND auth_ei.source_connector = 'auth:signup'
      AND auth_ei.deleted_at IS NULL
      AND slack_ei.identifier LIKE ${`${likePrefix}%`}
    LIMIT 2
  `;
	// FAILS CLOSED on ambiguity, exactly like `resolveChatUserIdentity`. The
	// stamps are org-scoped rows and are never deleted when superseded, so a user
	// who joins a second org, or whose Slack account id changes inside one
	// workspace, can hold two DISTINCT ids under the same `TEAM:` prefix. The
	// caller uses this as a DM recipient — picking arbitrarily sends the owner DM
	// to a stale Slack user and loses it silently.
	if (rows.length !== 1) return null;
	return rows[0].identifier.slice(prefix.length) || null;
}
