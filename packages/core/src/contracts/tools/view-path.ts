/**
 * Where a view lives in the web host's URL space. A view is selected by path,
 * never by a query key, so the page's query string is the view's params alone
 * and can never collide with the host's own keys (filters, peek, paging):
 *
 *   /<org>/<key>                             workspace view (top-level page)
 *   /<org>/<type>/-/views/<key>              view attached to a type
 *   /<org>/<type>/<slug>/-/views/<key>       view attached to a record
 *
 * `-` marks where the host's path ends. It is reserved as a slug: entity-type
 * create rejects it (RESERVED_ENTITY_TYPE_SLUGS) and so does a record's
 * explicit slug, and a derived record slug never is one (slugify trims dashes). The server's `open_view` links and the web host's tabs both build
 * the suffix here, so the two cannot drift apart.
 *
 * A workspace view shares the `/<org>/<segment>` space with entity type list
 * pages. The database keeps the two apart (a workspace view key never equals a
 * live entity type slug) and `manage_views` refuses reserved route names, so
 * one segment always names exactly one page.
 */
export const VIEW_PATH_MARKER = "-";

/** The suffix that selects view `key` beneath a host page's path. */
export function viewPathSuffix(key: string): string {
  return `/${VIEW_PATH_MARKER}/views/${key}`;
}

/** A workspace view's own page: a top-level page of the workspace. */
export function workspaceViewPath(orgSlug: string, key: string): string {
  return `/${orgSlug}/${key}`;
}
