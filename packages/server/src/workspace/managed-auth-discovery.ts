import { getDb, pgTextArray } from '../db/client';

/**
 * Slugs of the workspaces that lend their OAuth apps to other Lobu users
 * (`LOBU_MANAGED_AUTH_ORGS`, comma-separated). Being public with an OAuth app
 * is not enough: a public workspace with its own app is an ordinary workspace
 * whose connections sync, so only a workspace named here is offered for
 * `connect_managed` and has its OAuth grants stamped consent-only.
 */
export function managedAuthProviderSlugs(): string[] {
  return (process.env.LOBU_MANAGED_AUTH_ORGS ?? '')
    .split(',')
    .map((slug) => slug.trim().toLowerCase())
    .filter(Boolean);
}

interface ManagedAuthConnectorOffer {
  connector_key: string;
  provider: string;
}

/**
 * List OAuth connectors backed by an active managed app in the public
 * workspaces named in `LOBU_MANAGED_AUTH_ORGS`.
 *
 * This mirrors runtime auth selection: only a connector whose first declared
 * oauth/env_keys/browser method is OAuth is offered. The profile resolver's
 * provider fallback lets an active provider-wide Google app serve both Gmail
 * and Calendar even when the profile names only one. Only identifiers are
 * returned; app credentials and profile metadata never leave the server.
 */
export async function listManagedAuthConnectorOffers(
  organizationIds: string[],
): Promise<Map<string, ManagedAuthConnectorOffer[]>> {
  const providerSlugs = managedAuthProviderSlugs();
  if (organizationIds.length === 0 || providerSlugs.length === 0) return new Map();

  const sql = getDb();
  const rows = (await sql`
    SELECT DISTINCT
      d.organization_id,
      d.key AS connector_key,
      lower(preferred_method.method->>'provider') AS provider
    FROM connector_definitions d
    JOIN "organization" o ON o.id = d.organization_id
    CROSS JOIN LATERAL (
      SELECT candidate.method
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(d.auth_schema->'methods') = 'array'
            THEN d.auth_schema->'methods'
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY candidate(method, position)
      WHERE candidate.method->>'type' IN ('oauth', 'env_keys', 'browser')
      ORDER BY candidate.position
      LIMIT 1
    ) preferred_method
    WHERE d.organization_id = ANY(${pgTextArray(organizationIds)}::text[])
      AND d.status = 'active'
      AND o.visibility = 'public'
      AND lower(o.slug) = ANY(${pgTextArray(providerSlugs)}::text[])
      AND preferred_method.method->>'type' = 'oauth'
      AND NULLIF(preferred_method.method->>'provider', '') IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM auth_profiles ap
        WHERE ap.organization_id = d.organization_id
          AND ap.profile_kind = 'oauth_app'
          AND ap.status = 'active'
          AND (
            ap.connector_key = d.key
            OR lower(ap.provider) = lower(preferred_method.method->>'provider')
          )
      )
    ORDER BY d.organization_id, d.key
  `) as unknown as Array<{
    organization_id: string;
    connector_key: string;
    provider: string;
  }>;

  const byOrganization = new Map<string, ManagedAuthConnectorOffer[]>();
  for (const row of rows) {
    const offers = byOrganization.get(row.organization_id) ?? [];
    offers.push({ connector_key: row.connector_key, provider: row.provider });
    byOrganization.set(row.organization_id, offers);
  }
  return byOrganization;
}

export async function resolveManagedAuthConnectorOffer(params: {
  organizationSlug: string;
  connectorKey: string;
}): Promise<string | null> {
  const sql = getDb();
  const organizations = (await sql`
    SELECT id, slug
    FROM "organization"
    WHERE slug = ${params.organizationSlug}
      AND visibility = 'public'
    LIMIT 1
  `) as unknown as Array<{ id: string; slug: string }>;
  const organization = organizations[0];
  if (!organization) return null;

  const offers = await listManagedAuthConnectorOffers([organization.id]);
  const offer = offers
    .get(organization.id)
    ?.find((candidate) => candidate.connector_key === params.connectorKey);
  return offer ? organization.slug : null;
}
