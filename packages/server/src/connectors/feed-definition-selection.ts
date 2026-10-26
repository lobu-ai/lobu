import { pinnedDeviceConnectorContractSql } from '../utils/connector-execution-placement';
import type { DbClient } from '../db/client';

/** Correlated contract for feed `f` and connection `c`: feed pin, device manifest, then active. */
export function feedDefinitionSelection(sql: DbClient) {
  return sql`
    SELECT contract_definition.* FROM connector_definitions d
    LEFT JOIN LATERAL (${sql.unsafe(pinnedDeviceConnectorContractSql({
      connectorKey: 'c.connector_key', organizationId: 'c.organization_id',
      deviceWorkerId: 'c.device_worker_id', pinnedVersion: 'f.pinned_version', defaultVersion: 'd.version',
    }))}) selected_contract ON TRUE
    CROSS JOIN LATERAL jsonb_populate_record(d, jsonb_build_object(
      'version', selected_contract.version,
      'feeds_schema', CASE WHEN selected_contract.manifest IS NOT NULL THEN COALESCE(selected_contract.manifest->'feeds_schema', '{}'::jsonb) ELSE d.feeds_schema END,
      'actions_schema', CASE WHEN selected_contract.manifest IS NOT NULL THEN COALESCE(selected_contract.manifest->'actions_schema', '{}'::jsonb) ELSE d.actions_schema END,
      'runtime', CASE WHEN selected_contract.manifest IS NOT NULL THEN COALESCE(selected_contract.manifest->'runtime', '{}'::jsonb) ELSE d.runtime END,
      'required_capability', COALESCE(selected_contract.manifest->>'required_capability', d.required_capability)
    )) contract_definition
    WHERE d.organization_id = c.organization_id AND d.key = c.connector_key
      AND (d.status = 'active' OR d.version = f.pinned_version)
    ORDER BY (d.version = f.pinned_version) DESC NULLS LAST, (d.status = 'active') DESC, d.updated_at DESC, d.id DESC
    LIMIT 1
  `;
}
