/**
 * The one reader of a workspace's pending-deletion marker.
 *
 * `requestWorkspaceDeletion` (`workspace/deletion.ts`) writes
 * `organization.metadata.deletion_requested_at`; listings, membership checks,
 * schedules and chat routing filter with the SQL predicates below, and the
 * Better Auth organization endpoints (which read through Better Auth's own
 * adapter) filter with {@link isDeletionRequested} in `auth/organization-delete.ts`.
 * No imports, so any layer can use it without a dependency cycle.
 */

export const DELETION_REQUESTED_AT_KEY = 'deletion_requested_at';
export const DELETION_REQUESTED_BY_KEY = 'deletion_requested_by';

/**
 * SQL predicate: the organization row aliased `alias` has no pending deletion.
 * `organization.metadata` is text holding JSON, as everywhere else it is read.
 * A NULL metadata yields NULL from `->>`, so it counts as live.
 */
export function organizationLiveSql(alias: string): string {
  return `((${alias}.metadata)::jsonb ->> '${DELETION_REQUESTED_AT_KEY}') IS NULL`;
}

/**
 * The same predicate for a query that carries only an organization id
 * expression (no `organization` join). A missing organization row is not live.
 */
export function organizationIdLiveSql(organizationIdExpr: string): string {
  return `EXISTS (SELECT 1 FROM organization live_org WHERE live_org.id = ${organizationIdExpr} AND ${organizationLiveSql('live_org')})`;
}

/** The same test on an organization's metadata as Better Auth returns it. */
export function isDeletionRequested(metadata: unknown): boolean {
  let parsed: unknown = metadata;
  if (typeof metadata === 'string') {
    try {
      parsed = JSON.parse(metadata);
    } catch {
      return false;
    }
  }
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as Record<string, unknown>)[DELETION_REQUESTED_AT_KEY] != null
  );
}
