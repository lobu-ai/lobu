/**
 * Where a view lives in the web host's URL space. A view is selected by path,
 * never by a query key, so the page's query string is the view's params alone
 * and can never collide with the host's own keys (filters, peek, paging):
 *
 *   /<org>/data/-/views/<key>                workspace view (Data hub tab)
 *   /<org>/<type>/-/views/<key>              view attached to a type
 *   /<org>/<type>/<slug>/-/views/<key>       view attached to a record
 *
 * `-` marks where the host's path ends. It is reserved as a slug: entity-type
 * create rejects it (RESERVED_ENTITY_TYPE_SLUGS) and so does a record's
 * explicit slug, and a derived record slug never is one (slugify trims dashes). The server's `open_view` links and the web host's tabs both build
 * the suffix here, so the two cannot drift apart.
 */
export const VIEW_PATH_MARKER = "-";

/** The suffix that selects view `key` beneath a host page's path. */
export function viewPathSuffix(key: string): string {
  return `/${VIEW_PATH_MARKER}/views/${key}`;
}
