/**
 * `connector_definitions` are per-org snapshots written once at install and
 * never re-synced, so a connector gaining a capability in code (e.g. github's
 * `app_installation` auth method) leaves earlier installers on a stale schema.
 * This single-claimant cron re-syncs every org's EXISTING built-in definition
 * through the install write path so a deploy converges without an operator step.
 */

import { getDb } from '../db/client';
import {
  ATLASSIAN_MCP_FEEDS,
  isAtlassianMcpConfig,
} from '../operations/atlassian-mcp-feed';
import { upsertBundledConnectorForOrg } from '../utils/ensure-connector-installed';
import logger from '../utils/logger';

interface RefreshResult {
  /** Distinct (org, key) active definitions considered. */
  scanned: number;
  /** Definitions whose schema was re-synced from code. */
  refreshed: number;
  /** Keys skipped because they have no bundled source on disk (user-uploaded). */
  skippedNoSource: number;
  /** Definitions that errored during recompile/upsert (logged, not fatal). */
  errored: number;
}

interface DefRow {
  organization_id: string;
  key: string;
  mcp_config: Record<string, unknown> | null;
}

export async function refreshConnectorDefinitions(): Promise<RefreshResult> {
  const sql = getDb();

  // Every (org, key) that currently has an ACTIVE built-in definition. We only
  // refresh what an org already installed — never auto-install a new connector.
  const rows = (await sql`
    SELECT DISTINCT ON (organization_id, key)
      organization_id, key, mcp_config
    FROM connector_definitions
    WHERE status = 'active'
      AND organization_id IS NOT NULL
    ORDER BY organization_id, key, updated_at DESC
  `) as unknown as DefRow[];

  const result: RefreshResult = {
    scanned: rows.length,
    refreshed: 0,
    skippedNoSource: 0,
    errored: 0,
  };

  // Keys already known to have no bundled source (genuinely user-uploaded) —
  // skip the repeated registry lookup across the org rows sharing that key.
  const noSourceKeys = new Set<string>();

  for (const row of rows) {
    // MCP definitions have no bundled source file. Atlassian Rovo gained its
    // Jira feed after existing installs were already stored, so converge those
    // snapshots here instead of requiring every user to reinstall.
    if (isAtlassianMcpConfig(row.mcp_config)) {
      try {
        // Hourly: write only when the merge would change the stored feeds.
        await sql`
          UPDATE connector_definitions
          SET feeds_schema = COALESCE(feeds_schema, '{}'::jsonb)
                || ${sql.json(ATLASSIAN_MCP_FEEDS)}::jsonb,
              updated_at = NOW()
          WHERE organization_id = ${row.organization_id}
            AND key = ${row.key}
            AND status = 'active'
            AND feeds_schema IS DISTINCT FROM
              COALESCE(feeds_schema, '{}'::jsonb) || ${sql.json(ATLASSIAN_MCP_FEEDS)}::jsonb
        `;
        result.refreshed += 1;
      } catch (err) {
        result.errored += 1;
        logger.error(
          { connector_key: row.key, organization_id: row.organization_id, err },
          '[refresh-connector-definitions] Failed to refresh Atlassian MCP definition for org'
        );
      }
      continue;
    }
    if (noSourceKeys.has(row.key)) {
      result.skippedNoSource += 1;
      continue;
    }
    try {
      // SAME write path as install (upsertBundledConnectorForOrg): recompile
      // bundled source → upsert this org's definition. compileConnectorForIsolateFromFile
      // is mtime-LRU-cached, so re-resolving the same key across orgs is cheap.
      const refreshed = await upsertBundledConnectorForOrg({
        organizationId: row.organization_id,
        connectorKey: row.key,
      });
      if (!refreshed) {
        noSourceKeys.add(row.key);
        result.skippedNoSource += 1;
        continue;
      }
      result.refreshed += 1;
    } catch (err) {
      result.errored += 1;
      logger.error(
        { connector_key: row.key, organization_id: row.organization_id, err },
        '[refresh-connector-definitions] Failed to refresh definition for org'
      );
    }
  }

  return result;
}
