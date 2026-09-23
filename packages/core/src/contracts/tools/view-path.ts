/**
 * Where a view lives in the web host's URL space. A view is selected by path,
 * never by a query key, so the page's query string is the view's params alone
 * and can never collide with the host's own keys (filters, peek, paging):
 *
 *   /<org>/data/-/views/<key>                workspace view (Data hub tab)
 *   /<org>/<type>/-/views/<key>              view attached to a type
 *   /<org>/<type>/<slug>/-/views/<key>       view attached to a record
 *
 * `-` is never a slug (slugify trims dashes), so it marks where the host's
 * path ends. The server's `open_view` links and the web host's tabs both build
 * the suffix here, so the two cannot drift apart.
 */
export const VIEW_PATH_MARKER = "-";

/** The suffix that selects view `key` beneath a host page's path. */
export function viewPathSuffix(key: string): string {
  return `/${VIEW_PATH_MARKER}/views/${key}`;
}
