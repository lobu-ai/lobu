/**
 * Connection slug helpers.
 *
 * Connections carry a stable `slug` (unique per org among live rows) so that
 * `lobu apply` can diff connections by an immutable key instead of the mutable
 * `display_name`. The slugify rules here are the source of truth — the backfill
 * in db/migrations/20260512131703_connections_slug.sql mirrors their semantics.
 */

import { getErrorMessage, slugify } from '@lobu/core';
import { compileConnectionRowVisibility } from '../authz/connection-visibility';
import type { AuthzScope } from '../authz/scope';
import { type DbClient, getDb, pgTextArray } from '../db/client';
import logger from './logger';

/**
 * Server-side slug format guard. Lowercase letters/digits/hyphens, 1–63 chars,
 * must start with an alphanumeric. The CLI `apply` pipeline will eventually
 * apply the same validation; enforce it at the API boundary now.
 */
export const CONNECTION_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function connectionSlugFormatError(slug: string): string | null {
  if (CONNECTION_SLUG_PATTERN.test(slug)) return null;
  return `Invalid connection slug '${slug}'. Slugs must be 1–63 chars of lowercase letters, digits, and hyphens, starting with a letter or digit (pattern ${CONNECTION_SLUG_PATTERN.source}).`;
}

/** Thrown when a connection insert hits the per-org slug unique constraint. */
export class ConnectionSlugConflictError extends Error {
  constructor(public readonly slug: string) {
    super(`Connection slug '${slug}' already exists for this organization.`);
    this.name = 'ConnectionSlugConflictError';
  }
}

const PG_UNIQUE_VIOLATION = '23505';
const CONNECTION_SLUG_CONSTRAINT = 'connections_org_slug_unique';
const CONNECTION_DEVICE_PIN_CONSTRAINT = 'idx_connections_org_connector_device_live';

/** True when a thrown DB error is the per-org connection-slug unique violation. */
export function isConnectionSlugUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; constraint_name?: unknown; message?: unknown };
  if (e.code !== PG_UNIQUE_VIOLATION) return false;
  if (typeof e.constraint_name === 'string') return e.constraint_name === CONNECTION_SLUG_CONSTRAINT;
  // Fallback when the driver doesn't surface the constraint name.
  return typeof e.message === 'string' && e.message.includes(CONNECTION_SLUG_CONSTRAINT);
}

/**
 * True when a thrown DB error is the per-(org, connector, device) live-pin
 * unique violation. A pre-flight SELECT cannot prevent this on its own: two
 * replicas can both observe a free device and race into the index, so the
 * loser must still be translated into the same readable error rather than
 * leaking the driver's constraint text.
 */
export function isConnectionDevicePinUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; constraint_name?: unknown; message?: unknown };
  if (e.code !== PG_UNIQUE_VIOLATION) return false;
  if (typeof e.constraint_name === 'string')
    return e.constraint_name === CONNECTION_DEVICE_PIN_CONSTRAINT;
  return (
    typeof e.message === 'string' && e.message.includes(CONNECTION_DEVICE_PIN_CONSTRAINT)
  );
}

/**
 * Slugify a connection name: lowercase, runs of non-alphanumerics → `-`,
 * trim leading/trailing `-`. Returns an empty string when the input has no
 * alphanumeric characters (callers fall back to a connector-key-derived slug).
 */
export function slugifyConnectionName(value: string | null | undefined): string {
  if (!value) return '';
  return slugify(value);
}

/** Whether a slug is already used by a live (`deleted_at IS NULL`) connection in the org. */
export async function connectionSlugTaken(params: {
  organizationId: string;
  slug: string;
  excludeId?: number | null;
  db?: DbClient;
}): Promise<boolean> {
  const sql = params.db ?? getDb();
  const rows = await sql`
    SELECT 1
    FROM connections
    WHERE organization_id = ${params.organizationId}
      AND slug = ${params.slug}
      AND deleted_at IS NULL
      AND (${params.excludeId ?? null}::bigint IS NULL OR id <> ${params.excludeId ?? null}::bigint)
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Generate a unique connection slug for an org (auto-generate path only — never
 * pass a caller-supplied explicit slug here, since this auto-suffixes on
 * collision which would silently break a caller's stable identity).
 *
 * - base = slugify(displayName) → slugify(connectorKey) → 'connection'
 * - if `base` is taken by another live connection in the org, try `base-2`,
 *   `base-3`, … until free.
 * - `explicitSlug` is treated only as a *base hint* (still auto-suffixed) — used
 *   by test fixtures that want collision-tolerant seed data, not by the API.
 * - `excludeId` skips a specific connection row (so a row doesn't collide with
 *   itself on update).
 * - Pass `db` to run inside an existing transaction (`sql.begin` hands the
 *   callback a `DbClient`-shaped handle).
 */
export async function ensureUniqueConnectionSlug(params: {
  organizationId: string;
  connectorKey: string;
  explicitSlug?: string | null;
  displayName?: string | null;
  excludeId?: number | null;
  db?: DbClient;
}): Promise<string> {
  const sql = params.db ?? getDb();
  const fromExplicit = slugifyConnectionName(params.explicitSlug);
  const fromName = slugifyConnectionName(params.displayName);
  const baseSlug =
    fromExplicit || fromName || slugifyConnectionName(params.connectorKey) || 'connection';

  let candidate = baseSlug;
  let suffix = 2;
  for (;;) {
    const taken = await connectionSlugTaken({
      organizationId: params.organizationId,
      slug: candidate,
      excludeId: params.excludeId,
      db: sql,
    });
    if (!taken) return candidate;
    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
}

/**
 * Resolve the slug for a *new* connection row from the tool args.
 *
 * - Explicit slug → validate the format and reject (no auto-suffixing) if it's
 *   already taken in the org. Returns `{ error }` for the caller to surface.
 * - No explicit slug → auto-generate-and-suffix from `displayName` /
 *   `connectorKey`.
 */
export async function resolveNewConnectionSlug(params: {
  organizationId: string;
  connectorKey: string;
  explicitSlug?: string | null;
  displayName?: string | null;
  db?: DbClient;
}): Promise<{ slug: string } | { error: string }> {
  const explicit = params.explicitSlug?.trim();
  if (explicit) {
    const fmtErr = connectionSlugFormatError(explicit);
    if (fmtErr) return { error: fmtErr };
    if (await connectionSlugTaken({ organizationId: params.organizationId, slug: explicit, db: params.db })) {
      return { error: `Connection slug '${explicit}' already exists for this organization.` };
    }
    return { slug: explicit };
  }
  return {
    slug: await ensureUniqueConnectionSlug({
      organizationId: params.organizationId,
      connectorKey: params.connectorKey,
      displayName: params.displayName,
      db: params.db,
    }),
  };
}

/**
 * Insert a connection row with slug-conflict handling.
 *
 * `doInsert(slug)` performs the actual `INSERT ... RETURNING *` with the given
 * slug. Because `resolveNewConnectionSlug`'s "is it taken?" check and the insert
 * aren't atomic, two concurrent creates can race on the same candidate:
 *   - explicit slug (`explicit: true`): a conflict is fatal — throw
 *     `ConnectionSlugConflictError` (caller maps it to `{ error }`).
 *   - auto-generated: retry up to `maxAttempts`, regenerating a fresh suffix
 *     each time; if still conflicting, surface the conflict.
 */
export async function insertConnectionWithSlug<T>(opts: {
  organizationId: string;
  connectorKey: string;
  displayName?: string | null;
  initialSlug: string;
  explicit: boolean;
  doInsert: (slug: string) => Promise<T>;
  db?: DbClient;
  maxAttempts?: number;
}): Promise<T> {
  const maxAttempts = opts.explicit ? 1 : (opts.maxAttempts ?? 5);
  let slug = opts.initialSlug;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await opts.doInsert(slug);
    } catch (err) {
      if (!isConnectionSlugUniqueViolation(err) || attempt >= maxAttempts) {
        if (isConnectionSlugUniqueViolation(err)) throw new ConnectionSlugConflictError(slug);
        throw err;
      }
      slug = await ensureUniqueConnectionSlug({
        organizationId: opts.organizationId,
        connectorKey: opts.connectorKey,
        displayName: opts.displayName,
        db: opts.db,
      });
    }
  }
}

/**
 * True when none of these workspaces holds a live connection the caller can
 * see. `connections` is a bounded config table. Row visibility depends on the
 * principal alone, so one predicate covers every workspace, and another
 * member's private connection never counts. A failed probe answers false so
 * callers keep their standard guidance.
 */
export async function hasNoVisibleConnections(
  scope: AuthzScope,
  organizationIds: readonly string[]
): Promise<boolean> {
  if (organizationIds.length === 0) return false;
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT 1 FROM connections c
      WHERE c.organization_id = ANY(${pgTextArray([...organizationIds])}::text[])
        AND c.deleted_at IS NULL
        ${sql.unsafe(compileConnectionRowVisibility(scope, 'c'))}
      LIMIT 1
    `;
    return rows.length === 0;
  } catch (error) {
    logger.warn(`[connections] connection presence probe failed: ${getErrorMessage(error)}`);
    return false;
  }
}
