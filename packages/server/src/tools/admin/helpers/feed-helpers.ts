import { getDb, pgBigintArray } from '../../../db/client';
import { formatAjvError, getAjv } from '../../../utils/ajv-singleton';
import { exceedsValidationLimits } from '../../../utils/metadata-limits';

export interface FeedDefinition {
  key?: string;
  name?: string;
  displayNameTemplate?: string;
  configSchema?: {
    properties?: Record<string, unknown>;
    [keyword: string]: unknown;
  } | null;
  operations?: Array<'sync' | 'read'>;
}

export function feedOperations(
  feedsSchema: Record<string, FeedDefinition> | null,
  feedKey: string
): Array<'sync' | 'read'> {
  const definition = feedsSchema?.[feedKey];
  return Array.isArray(definition?.operations) ? definition.operations : [];
}

/**
 * Validate a feed `config` against the connector's declared feed configSchema
 * (JSON Schema, `connector_definitions.feeds_schema[feed_key].configSchema`).
 * Returns a human-readable error naming the offending field, or null when
 * valid. A connector/feed with no declared configSchema accepts any config —
 * the schema itself decides strictness (additionalProperties etc.).
 *
 * Without this check a mis-shaped config (e.g. `url` instead of rss's required
 * `feed_urls`) is persisted "successfully" and only fails at sync time, giving
 * an MCP caller zero upfront signal.
 *
 */
export function validateFeedConfig(
  feedsSchema: Record<string, FeedDefinition> | null,
  feedKey: string,
  config: Record<string, unknown>
): string | null {
  // Direct key lookup plus the `key` field fallback — deliberately NOT the
  // single-entry fallback getFeedDefinition uses for display names: guessing a
  // schema for an undeclared feed_key would reject legacy feeds cosmetically
  // matched to the wrong definition.
  const definition =
    feedsSchema?.[feedKey] ??
    Object.values(feedsSchema ?? {}).find((d) => d?.key === feedKey) ??
    null;
  const configSchema = definition?.configSchema;
  if (!configSchema || Object.keys(configSchema).length === 0) return null;

  // Bound untrusted input before handing it to AJV (same posture as
  // validateEntityMetadata in schema-validation.ts).
  if (exceedsValidationLimits(config)) {
    return `Invalid config for feed '${feedKey}': config exceeds size/nesting limits`;
  }

  const validate = getAjv().compile(configSchema);
  if (validate(config)) return null;
  const detail = (validate.errors ?? []).map(formatAjvError).join('; ') || 'validation failed';
  return `Invalid config for feed '${feedKey}': ${detail}`;
}

function getFeedDefinition(
  feedsSchema: Record<string, FeedDefinition> | null,
  feedKey: string
): FeedDefinition | null {
  if (!feedsSchema) return null;
  if (feedsSchema[feedKey]) return feedsSchema[feedKey];

  for (const definition of Object.values(feedsSchema)) {
    if (definition?.key === feedKey) return definition;
  }

  const definitions = Object.values(feedsSchema);
  return definitions.length === 1 ? (definitions[0] ?? null) : null;
}

export function splitConfigByFeedScope(
  config: Record<string, unknown> | null | undefined,
  feedsSchema: Record<string, FeedDefinition> | null
): {
  connectionConfig: Record<string, unknown> | null;
  feedConfig: Record<string, unknown> | null;
} {
  if (!config || Object.keys(config).length === 0) {
    return {
      connectionConfig: null,
      feedConfig: null,
    };
  }

  const feedScopedKeys = new Set<string>();
  for (const definition of Object.values(feedsSchema ?? {})) {
    for (const key of Object.keys(definition?.configSchema?.properties ?? {})) {
      feedScopedKeys.add(key);
    }
  }

  const connectionConfig: Record<string, unknown> = {};
  const feedConfig: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    if (feedScopedKeys.has(key)) {
      feedConfig[key] = value;
    } else {
      connectionConfig[key] = value;
    }
  }

  return {
    connectionConfig: Object.keys(connectionConfig).length > 0 ? connectionConfig : null,
    feedConfig: Object.keys(feedConfig).length > 0 ? feedConfig : null,
  };
}

export async function resolveFeedDisplayName(params: {
  explicitName?: string | null;
  feedKey: string;
  config?: Record<string, unknown> | null;
  entityIds?: number[] | null;
  feedsSchema: Record<string, FeedDefinition> | null;
}): Promise<string> {
  if (params.explicitName?.trim()) return params.explicitName.trim();

  const definition = getFeedDefinition(params.feedsSchema, params.feedKey);
  const baseName = definition?.name ?? params.feedKey;

  if (definition?.displayNameTemplate && params.config) {
    const rendered = definition.displayNameTemplate
      .replace(/\{(\w+)\}/g, (_, key) => {
        const value = params.config?.[key];
        return value != null ? String(value) : '';
      })
      .replace(/\s*-\s*$/, '')
      .trim();
    if (rendered) return rendered;
  }

  if (params.entityIds?.length) {
    const sql = getDb();
    const rows = await sql`
      SELECT name
      FROM entities
      WHERE id = ANY(${pgBigintArray(params.entityIds)}::bigint[])
      ORDER BY name
      LIMIT 5
    `;
    const names = rows.map((row: { name: string }) => row.name).filter(Boolean);
    if (names.length > 0) return `${baseName} for ${names.join(', ')}`;
  }

  if (params.config) {
    const firstStringValue = Object.values(params.config).find(
      (value) => typeof value === 'string' && value.trim().length > 0
    ) as string | undefined;
    if (firstStringValue) return `${baseName}: ${firstStringValue}`;
  }

  return baseName;
}
