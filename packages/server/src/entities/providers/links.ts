/**
 * Relationships of a remote record, read live from every backed relationship
 * type whose rules name the record's type: as a source, edges are matched on
 * `from_key`; as a target, on `to_key`. Each (type, direction) is paged on its
 * own and reports its own status, so one failing source never reads as "no
 * relationships".
 */

import { formatEntityRef } from '@lobu/core/contracts/entity-ref';
import type { RemoteEdge, RemoteEdgeStream } from '@lobu/core/contracts/tools/manage-entity';
import type { ToolContext } from '../../tools/registry';
import { listBackedRelationshipTypes, readRemoteByKey, type ResolvedRemoteRef } from './index';

const EDGE_COLUMNS = new Set(['from_key', 'to_key', 'from_name', 'to_name']);

function text(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value);
  return s === '' ? undefined : s;
}

export async function remoteLinks(
  resolved: ResolvedRemoteRef,
  options: {
    direction: 'outbound' | 'inbound' | 'both';
    relationshipTypeSlug?: string;
    limit: number;
    offset: number;
  },
  ctx: ToolContext
): Promise<{ edges: RemoteEdge[]; streams: RemoteEdgeStream[] }> {
  const { parsed } = resolved;
  const types = (await listBackedRelationshipTypes(ctx.organizationId, parsed.type)).filter(
    (t) => !options.relationshipTypeSlug || t.slug === options.relationshipTypeSlug
  );
  const reads: Array<{
    slug: string;
    sql: string;
    connection: string;
    direction: 'outbound' | 'inbound';
    counterparts: string[];
  }> = [];
  for (const t of types) {
    if (options.direction !== 'inbound' && t.targets.length > 0) {
      reads.push({ slug: t.slug, sql: t.backing_sql, connection: t.backing_source, direction: 'outbound', counterparts: t.targets });
    }
    if (options.direction !== 'outbound' && t.sources.length > 0) {
      reads.push({ slug: t.slug, sql: t.backing_sql, connection: t.backing_source, direction: 'inbound', counterparts: t.sources });
    }
  }

  const results = await Promise.all(
    reads.map(async (read) => {
      if (read.counterparts.length !== 1) {
        return {
          stream: {
            stream: read.slug,
            direction: read.direction,
            ok: false,
            returned: 0,
            has_more: false,
            error: `Relationship type '${read.slug}' has rules to several entity types (${read.counterparts.join(', ')}) for '${parsed.type}'; a backed type needs one counterpart per direction`,
            error_code: 'VALIDATION',
            retryable: false,
          } satisfies RemoteEdgeStream,
          edges: [] as RemoteEdge[],
        };
      }
      const outbound = read.direction === 'outbound';
      const result = await readRemoteByKey(
        {
          sql: read.sql,
          connection: read.connection,
          keyColumn: outbound ? 'from_key' : 'to_key',
          key: parsed.key,
          limit: options.limit + 1,
          offset: options.offset,
          // The counterpart key orders a page stably for offset paging.
          sort: { column: outbound ? 'to_key' : 'from_key', order: 'asc' },
        },
        ctx
      );
      if (!result.ok) {
        return {
          stream: {
            stream: read.slug,
            direction: read.direction,
            ok: false,
            returned: 0,
            has_more: false,
            error: result.error,
            error_code: result.error_code,
            retryable: result.retryable,
          } satisfies RemoteEdgeStream,
          edges: [] as RemoteEdge[],
        };
      }
      const page = result.rows.slice(0, options.limit);
      const counterpart = read.counterparts[0];
      const edges: RemoteEdge[] = [];
      for (const row of page) {
        const fromKey = text(row.from_key);
        const toKey = text(row.to_key);
        if (!fromKey || !toKey) continue;
        const attributes: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) if (!EDGE_COLUMNS.has(k)) attributes[k] = v;
        const fromName = text(row.from_name);
        const toName = text(row.to_name);
        edges.push({
          type: read.slug,
          from: formatEntityRef({ type: outbound ? parsed.type : counterpart, key: fromKey }),
          to: formatEntityRef({ type: outbound ? counterpart : parsed.type, key: toKey }),
          ...(fromName ? { from_name: fromName } : {}),
          ...(toName ? { to_name: toName } : {}),
          attributes,
          source: 'remote',
        });
      }
      return {
        stream: {
          stream: read.slug,
          direction: read.direction,
          ok: true,
          returned: edges.length,
          // query_sql caps rows at 500, including our lookahead request.
          has_more: result.rows.length > options.limit || result.hasMore,
        } satisfies RemoteEdgeStream,
        edges,
      };
    })
  );

  return {
    edges: results.flatMap((r) => r.edges),
    streams: results.map((r) => r.stream),
  };
}
