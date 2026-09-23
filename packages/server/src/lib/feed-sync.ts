/**
 * Feed Sync Library
 *
 * Extracted from scripts/sync-local.ts for programmatic reuse.
 */

import { executeCompiledConnector } from '@lobu/connector-worker/executor/runtime';
import { getDb, parsePgNumberArray } from '../db/client';
import { dbEgressConfig, isCloudMode } from '../utils/cloud-mode';
import { findBundledConnectorFile } from '../utils/connector-catalog';
import { connectorRunEnv } from '@lobu/connector-worker/env';
import { resolveConnectorCode } from '../utils/ensure-connector-installed';
import { mergeExecutionConfig, resolveExecutionAuth } from '../utils/execution-context';
import logger from '../utils/logger';

export interface FeedRecord {
  id: number;
  type: string;
  organization_id: string;
  connection_id: number;
  connector_key: string;
  feed_key: string;
  entity_ids: number[];
  config: Record<string, unknown>;
  connection_config: Record<string, unknown>;
  checkpoint: Record<string, unknown> | null;
  connector_version_row_id: number | null;
  connector_version: string | null;
  compiled_code: string | null;
  compile_config_hash: string | null;
  connector_version_organization_id: string | null;
  auth_profile_id: number | null;
  app_auth_profile_id: number | null;
}

export interface FeedFilter {
  feedId?: number;
  type?: string;
}

export async function fetchFeeds(filter?: FeedFilter): Promise<FeedRecord[]> {
  const sql = getDb();

  let query = `
    SELECT
      f.id,
      f.organization_id,
      f.connection_id,
      c.connector_key,
      f.feed_key,
      f.feed_key AS type,
      COALESCE(f.entity_ids, '{}'::bigint[]) AS entity_ids,
      COALESCE(f.config, '{}'::jsonb) AS config,
      COALESCE(c.config, '{}'::jsonb) AS connection_config,
      f.checkpoint,
      cv.id AS connector_version_row_id,
      cv.version AS connector_version,
      cv.compiled_code,
      cv.compile_config_hash,
      cv.organization_id AS connector_version_organization_id,
      c.auth_profile_id,
      c.app_auth_profile_id
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    LEFT JOIN LATERAL (
      SELECT d.version
      FROM connector_definitions d
      WHERE d.key = c.connector_key
        AND d.status = 'active'
        AND d.organization_id = f.organization_id
      ORDER BY d.updated_at DESC
      LIMIT 1
    ) resolved_def ON TRUE
    LEFT JOIN LATERAL (
      SELECT id, version, compiled_code, compile_config_hash, organization_id
      FROM connector_versions
      WHERE connector_key = c.connector_key
        AND version = COALESCE(f.pinned_version, resolved_def.version)
        AND (organization_id = f.organization_id OR organization_id IS NULL)
      ORDER BY organization_id NULLS LAST
      LIMIT 1
    ) cv ON TRUE
    WHERE f.status = 'active'
      AND c.status = 'active'
      AND c.deleted_at IS NULL
      AND f.deleted_at IS NULL
  `;
  const params: unknown[] = [];

  if (filter?.feedId != null) {
    params.push(filter.feedId);
    query += ` AND f.id = $${params.length}`;
  }
  if (filter?.type) {
    params.push(filter.type);
    query += ` AND f.feed_key = $${params.length}`;
  }

  query += ' ORDER BY f.id';

  const result = await sql.unsafe(query, params);
  return result.map((row) => ({
    ...(row as FeedRecord),
    entity_ids: parsePgNumberArray((row as { entity_ids: unknown }).entity_ids),
  })) as FeedRecord[];
}

export async function runFeed(feed: FeedRecord): Promise<{ itemCount: number }> {
  logger.info(
    {
      feedId: feed.id,
      feedKey: feed.feed_key,
      connectorKey: feed.connector_key,
      entityIds: feed.entity_ids,
    },
    'Starting feed sync'
  );

  const compiledCode = await resolveConnectorCode(feed.connector_key, {
    id: feed.connector_version_row_id,
    organization_id: feed.connector_version_organization_id,
    version: feed.connector_version,
    compiled_code: feed.compiled_code,
    compile_config_hash: feed.compile_config_hash,
  });

  const { credentials, connectionCredentials, sessionState } = await resolveExecutionAuth({
    organizationId: feed.organization_id,
    connectionId: feed.connection_id,
    authProfileId: feed.auth_profile_id,
    appAuthProfileId: feed.app_auth_profile_id,
    credentialDb: getDb(),
    logContext: { feedId: feed.id },
    logMessage: 'Failed to resolve feed credentials',
  });
  let itemCount = 0;
  const result = await executeCompiledConnector({
    compiledCode,
    job: {
      mode: 'sync',
      config: {
        ...mergeExecutionConfig(feed.connection_config, connectionCredentials, feed.config),
        // Authoritative egress config (injected last): cloud policy plus global
        // operator host exemptions cannot be overridden by connection config.
        ...dbEgressConfig(),
      },
      checkpoint: feed.checkpoint,
      // The same whitelist a fleet worker hands connector code — never the
      // gateway's own env. See connectorRunEnv / the class-wide guard test.
      env: connectorRunEnv({
        organizationSupplied: findBundledConnectorFile(feed.connector_key) === null,
        cloud: isCloudMode(),
      }),
      sessionState,
      credentials,
      feedKey: feed.feed_key,
      feedId: feed.id,
      entityIds: feed.entity_ids,
    },
    hooks: {
      onCommit: async (events) => {
        itemCount += events.length;
      },
    },
  });

  if (result.mode !== 'sync') {
    throw new Error(`Expected sync result, got mode=${result.mode}`);
  }

  logger.info({ feedId: feed.id, itemCount }, 'Feed sync completed');
  return { itemCount };
}
