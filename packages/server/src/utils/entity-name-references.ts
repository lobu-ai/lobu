/**
 * Which records a `save_memory` call may link, by id or by exact name.
 *
 * Linking a memory to a record is part of writing the memory, not an edit to
 * the record: anyone who may save memories may link records they can read.
 * System (`$`) records are the exception, because a link to one can change
 * who may read the memory; those still need workspace write access.
 *
 * A name links only when exactly one live, readable, non-system record in the
 * workspace has that exact name (case-insensitive). Anything else is reported
 * back, never guessed: no partial or similar names, no identifiers, no type
 * inference. System records are excluded before counting so a member's own
 * `$member` record never makes a teammate's person record ambiguous.
 */
import type { UnlinkedEntityName } from '@lobu/core/contracts/tools/save-memory';
import {
  type EntityReadRestrictions,
  entityReadRestrictions,
  filterEntityReadRows,
} from '../authz/entity-read-policy';
import { type DbClient, pgBigintArray, pgTextArray } from '../db/client';
import type { ToolContext } from '../tools/registry';
import { ToolUserError } from './errors';
import { canWriteOrg } from './organization-access';

export interface EntityNameResolution {
  entityIds: number[];
  unlinked: UnlinkedEntityName[];
}

const NOT_LINKABLE = 'This record was not found in this workspace, or you do not have access to it.';

interface CandidateRow {
  id: number | string;
  entity_type: string;
}

async function readableRows<T extends CandidateRow>(
  sql: DbClient,
  rows: T[],
  restrictions: EntityReadRestrictions,
): Promise<T[]> {
  const typeVisible = rows.filter((row) => !restrictions.some((rule) => rule.entity_id === null &&
    (rule.entity_type_slug === null || rule.entity_type_slug === row.entity_type)));
  return filterEntityReadRows(sql, typeVisible, restrictions);
}

/** Every explicit id must be a readable record in this workspace; system records also need write access. */
export async function requireLinkableEntityIds(sql: DbClient, ids: number[], ctx: ToolContext): Promise<void> {
  if (ids.length === 0) return;
  const rows = await sql<CandidateRow>`
    SELECT e.id, et.slug AS entity_type
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.id = ANY(${pgBigintArray(ids)}::bigint[])
      AND e.organization_id = ${ctx.organizationId}
  `;
  const readable = new Set(
    (await readableRows(sql, rows, await entityReadRestrictions(sql, ctx))).map((row) => Number(row.id)),
  );
  if (ids.some((id) => !readable.has(id))) throw new ToolUserError(NOT_LINKABLE, 403);
  if (rows.some((row) => row.entity_type.startsWith('$')) && !(await canWriteOrg(sql, ctx))) {
    throw new ToolUserError('Linking a memory to a system record needs workspace owner or admin access.', 403);
  }
}

/** `names` are trimmed and de-duplicated by the caller. */
export async function resolveEntityNameReferences(
  sql: DbClient,
  names: string[],
  ctx: ToolContext,
): Promise<EntityNameResolution> {
  if (names.length === 0) return { entityIds: [], unlinked: [] };

  // One indexed probe per name (`idx_entities_name` on lower(name)).
  const rows = await sql<CandidateRow & { ref_name: string }>`
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
  const readable = await readableRows(sql, rows, await entityReadRestrictions(sql, ctx));

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
