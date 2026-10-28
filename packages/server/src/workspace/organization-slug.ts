/**
 * The slug of a live organization, by id.
 *
 * The one query behind `WorkspaceProvider.getOrgSlug` and
 * `utils/url-builder`'s `getOrganizationSlug`. It depends only on the db
 * client, so low-level modules (URL building, access-control denial messages)
 * can name a workspace without importing the workspace provider, whose auth
 * graph reaches the chat platform registry and would close an import cycle
 * through every platform module that builds a URL.
 */

import { getDb } from '../db/client';
import { organizationLiveSql } from './deletion-state';

export async function getLiveOrganizationSlug(orgId: string): Promise<string | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT slug FROM "organization" WHERE id = ${orgId} AND ${sql.unsafe(organizationLiveSql('organization'))} LIMIT 1
  `;
  return rows[0] ? (rows[0].slug as string) : null;
}
