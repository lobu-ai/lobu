import type { DbClient } from '../db/client';

/** Correlated selection for feed `f` and connection `c`: prefer its pinned version, then active. */
export function feedDefinitionSelection(sql: DbClient) {
  return sql`
    SELECT d.* FROM connector_definitions d
    WHERE d.organization_id = c.organization_id AND d.key = c.connector_key
      AND (d.status = 'active' OR d.version = f.pinned_version)
    ORDER BY (d.version = f.pinned_version) DESC NULLS LAST, (d.status = 'active') DESC, d.updated_at DESC, d.id DESC
    LIMIT 1
  `;
}
