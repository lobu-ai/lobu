/**
 * Exact-name entity references for `save_memory`.
 *
 * A writer knows the names of what a memory is about, not record ids. A name
 * links only when exactly one live, readable, non-system record in the
 * workspace has that exact name (case-insensitive). Anything else is reported
 * back, never guessed: no partial or similar names, no identifiers, no type
 * inference. System (`$`) records are excluded before counting so a member's
 * own `$member` record never makes a teammate's person record ambiguous.
 */
import type { UnlinkedEntityName } from '@lobu/core/contracts/tools/save-memory';
import { entityReadRestrictions, filterEntityReadRows } from '../authz/entity-read-policy';
import { type DbClient, pgTextArray } from '../db/client';
import type { ToolContext } from '../tools/registry';


export interface EntityNameResolution {
  entityIds: number[];
  unlinked: UnlinkedEntityName[];
}

/** `names` are trimmed and de-duplicated by the caller. */
export async function resolveEntityNameReferences(
  sql: DbClient,
  names: string[],
  ctx: ToolContext,
  canLink: boolean,
): Promise<EntityNameResolution> {
  if (names.length === 0) return { entityIds: [], unlinked: [] };
  // Linking is a workspace-level permission: without it no lookup runs, so the
  // reason never depends on which records exist.
  if (!canLink) return { entityIds: [], unlinked: names.map((name) => ({ name, reason: 'not_writable' })) };

  // One indexed probe per name (`idx_entities_name` on lower(name)).
  const rows = await sql<{ ref_name: string; id: number | string; entity_type: string }>`
    SELECT ref.name AS ref_name, e.id, et.slug AS entity_type
    FROM unnest(${pgTextArray(names)}::text[]) AS ref(name)
    JOIN entities e ON lower(e.name) = lower(ref.name)
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.organization_id = ${ctx.organizationId}
      AND e.deleted_at IS NULL
      AND et.deleted_at IS NULL
      AND left(et.slug, 1) <> '$'
  `;

  // Count only records the caller may read, so a hidden namesake neither links
  // nor reveals itself as ambiguity.
  const restrictions = await entityReadRestrictions(sql, ctx);
  const typeVisible = rows.filter((row) => !restrictions.some((rule) => rule.entity_id === null &&
    (rule.entity_type_slug === null || rule.entity_type_slug === row.entity_type)));
  const readable = await filterEntityReadRows(sql, typeVisible, restrictions);

  const matches = new Map<string, Set<number>>();
  for (const row of readable) {
    const ids = matches.get(row.ref_name) ?? new Set<number>();
    ids.add(Number(row.id));
    matches.set(row.ref_name, ids);
  }

  const entityIds: number[] = [];
  const unlinked: UnlinkedEntityName[] = [];
  for (const name of names) {
    const ids = [...(matches.get(name) ?? [])];
    if (ids.length === 1) entityIds.push(ids[0] as number);
    else unlinked.push({ name, reason: ids.length === 0 ? 'not_found' : 'ambiguous' });
  }
  return { entityIds, unlinked };
}
