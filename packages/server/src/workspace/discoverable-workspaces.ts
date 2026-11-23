import { pgTextArray } from '../db/client';
import { managedAuthProviderSlugs } from './managed-auth-discovery';

/**
 * Public workspaces listed to people who are not members
 * (`LOBU_DISCOVERABLE_ORGS`, comma-separated slugs). Unset lists every public
 * workspace. Set, only the named workspaces appear in organization listings
 * and the sitemap; any other public workspace stays readable by anyone who
 * has its URL. Managed-auth providers stay listed because their connect
 * offers are read from the same listing.
 *
 * Returns a `text[]` literal for a query parameter, or null when unset.
 */
export function listedPublicOrganizationsParam(): string | null {
  const configured = process.env.LOBU_DISCOVERABLE_ORGS?.trim();
  if (!configured) return null;
  const slugs = configured
    .split(',')
    .map((slug) => slug.trim().toLowerCase())
    .filter(Boolean);
  return pgTextArray([...new Set([...slugs, ...managedAuthProviderSlugs()])]);
}

/** SQL predicate: `alias` is listed, given the placeholder bound to {@link listedPublicOrganizationsParam}. */
export function listedPublicOrganizationSql(alias: string, placeholder: string): string {
  return `(${placeholder}::text[] IS NULL OR lower(${alias}.slug) = ANY(${placeholder}::text[]))`;
}
