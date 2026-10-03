/**
 * list_metrics — the metric catalog. Lists declared metrics plus measures and
 * dimensions exposed by derived entity SQL, so the agent can discover reusable
 * governed calculations before hand-writing SQL.
 */

import { type Static, Type } from '@sinclair/typebox';
import type { EntityMetrics } from '@lobu/connector-sdk';
import { getDb } from '../../db/client';
import type { Env } from '../../index';
import { inferColumns } from '../../utils/infer-measures';
import type { ToolContext } from '../registry';
import { withValidatedArgs } from '../validate-args';

export const ListMetricsSchema = Type.Object({
  entity_type: Type.Optional(
    Type.String({ description: 'Filter to one entity type slug (e.g. "company").' }),
  ),
  q: Type.Optional(
    Type.String({
      description: 'Keyword filter over available measure, dimension, and segment names and descriptions.',
    }),
  ),
});

interface MetricCatalogEntry {
  entity_type: string;
  name: string | null;
  measures: Array<{
    name: string;
    agg: string;
    eventSet: string;
    description: string;
    tier?: string;
    owner?: string;
  }>;
  dimensions: Array<{ name: string; description: string }>;
  segments: Array<{ name: string; description: string }>;
}

async function listMetricsImpl(
  args: Static<typeof ListMetricsSchema>,
  _env: Env,
  ctx: ToolContext,
): Promise<{ entity_types: MetricCatalogEntry[] }> {
  if (!ctx.organizationId) {
    throw new Error('list_metrics requires a bound organization');
  }
  const sql = getDb();
  const rows = (await sql`
    SELECT slug, name, metrics_config, backing_sql, backing_source
    FROM entity_types
    WHERE organization_id = ${ctx.organizationId}
      AND deleted_at IS NULL
      AND (metrics_config IS NOT NULL OR backing_sql IS NOT NULL)
      ${args.entity_type ? sql`AND slug = ${args.entity_type}` : sql``}
    ORDER BY slug
  `) as unknown as Array<{
    slug: string;
    name: string | null;
    metrics_config: unknown;
    backing_sql: string | null;
    backing_source: string | null;
  }>;

  const searchable = (value: string) => value.toLowerCase().replace(/[_-]+/g, ' ');
  const needle = args.q ? searchable(args.q) : undefined;
  const matches = (...vals: (string | undefined)[]) =>
    !needle || vals.some((v) => v && searchable(v).includes(needle));

  const entity_types: MetricCatalogEntry[] = [];
  for (const row of rows) {
    // A connection-backed type's metrics push down to its source, where only
    // the backing SQL's own columns exist; runMetric refuses declared event
    // measures there, so the catalog does not advertise them.
    const configured = (row.metrics_config ?? {}) as EntityMetrics;
    const m = row.backing_source ? {} : configured;
    const declaredMeasures = Object.entries(m.measures ?? {})
      .filter(([name, def]) => matches(name, def.description))
      .map(([name, def]) => ({
        name,
        agg: def.agg,
        eventSet: def.eventSet,
        description: def.description,
        ...(def.tier ? { tier: def.tier } : {}),
        ...(def.owner ? { owner: def.owner } : {}),
      }));
    const declaredDimensions = Object.entries(m.dimensions ?? {})
      .filter(([name, def]) => matches(name, def.description))
      .map(([name, def]) => ({ name, description: def.description }));
    const inferred = row.backing_sql ? inferColumns(row.backing_sql) : [];
    const declaredMeasureNames = new Set(Object.keys(configured.measures ?? {}));
    const measures = [
      ...declaredMeasures,
      ...inferred
        .filter(
          (column) =>
            column.role === 'measure' &&
            !declaredMeasureNames.has(column.name) &&
            matches(column.name, 'Precomputed by the derived entity SQL.'),
        )
        .map((column) => ({
          name: column.name,
          agg: 'derived',
          eventSet: 'backing_sql',
          description: 'Precomputed by the derived entity SQL.',
        })),
    ];
    const declaredDimensionNames = new Set(
      declaredDimensions.map((dimension) => dimension.name),
    );
    const dimensions = [
      ...declaredDimensions,
      ...inferred
        .filter(
          (column) =>
            column.role === 'dimension' &&
            !declaredDimensionNames.has(column.name) &&
            matches(column.name, 'Column exposed by the derived entity SQL.'),
        )
        .map((column) => ({
          name: column.name,
          description: 'Column exposed by the derived entity SQL.',
        })),
    ];
    const segments = Object.entries(m.segments ?? {})
      .filter(([name, def]) => matches(name, def.description))
      .map(([name, def]) => ({ name, description: def.description }));

    // With a keyword, only surface entity types that have a matching member.
    if (needle && measures.length === 0 && dimensions.length === 0 && segments.length === 0) {
      continue;
    }
    entity_types.push({ entity_type: row.slug, name: row.name, measures, dimensions, segments });
  }
  return { entity_types };
}

export const listMetrics = withValidatedArgs('list_metrics', ListMetricsSchema, listMetricsImpl);
