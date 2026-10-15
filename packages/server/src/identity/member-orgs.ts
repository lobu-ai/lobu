/**
 * Resolve the `$member` entity a signed-in user has in each org they belong to.
 *
 * This is the lookup Slack sign-in adoption uses to stamp a workspace-scoped
 * `slack_user_id` onto the right `$member`. It is deliberately keyed on the
 * `auth:signup` `auth_user_id` identity — the row personal-org provisioning
 * writes — so it only ever returns members that were provisioned for THIS
 * authenticated user.
 */

import { getDb } from "../db/client";
import { organizationIdLiveSql } from "../workspace/deletion-state";

export interface ResolvedTenantMember {
	tenantOrganizationId: string;
	memberEntityId: number;
}

/**
 * Every org where this user has a provisioned `$member` entity, oldest org id
 * first. Returns an empty array when personal-org provisioning has not yet
 * completed — callers treat that as "nothing to stamp yet" and retry on the
 * next account refresh.
 */
export async function resolveMemberOrgsForUser(
	userId: string,
): Promise<ResolvedTenantMember[]> {
	const sql = getDb();
	const rows = await sql<{ organization_id: string; entity_id: number }>`
    SELECT m."organizationId" AS organization_id, e.id AS entity_id
    FROM "member" m
    JOIN entity_identities ei
      ON ei.organization_id = m."organizationId"
     AND ei.namespace = 'auth_user_id'
     AND ei.identifier = ${userId}
     AND ei.scope_key IS NULL
     AND ei.deleted_at IS NULL
     AND ei.source_connector = 'auth:signup'
    JOIN entities e
      ON e.id = ei.entity_id
     AND e.organization_id = ei.organization_id
     AND e.deleted_at IS NULL
    JOIN entity_types et
      ON et.id = e.entity_type_id
     AND et.organization_id = e.organization_id
     AND et.slug = '$member'
    WHERE m."userId" = ${userId}
      AND ${sql.unsafe(organizationIdLiveSql('m."organizationId"'))}
    ORDER BY m."organizationId" ASC
  `;
	return rows.map((r) => ({
		tenantOrganizationId: String(r.organization_id),
		memberEntityId: Number(r.entity_id),
	}));
}
