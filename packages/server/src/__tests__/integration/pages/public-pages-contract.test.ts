/**
 * Public page contract coverage.
 *
 * Focuses on the public/private boundary and crawlable HTML payloads without
 * restoring the old large page suite verbatim.
 *
 * Skipped automatically when packages/owletto is not initialized — these tests
 * render HTML produced by the web submodule. CI checks it out via
 * LOBU_WEB_DEPLOY_KEY; local clones without that key cannot, so we skip
 * rather than fail on missing assets.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { get } from '../../setup/test-helpers';
import { MEMBER_ENTITY_TYPE_SLUG } from '../../../tools/constants';

const LEGACY_CANVAS_ENTITY_TYPE_SLUG = '$canvas';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_AVAILABLE = existsSync(
  resolve(__dirname, '../../../../../owletto/src')
);

const publicGatewayUrl = 'https://www.lobu.test/lobu';

describe.skipIf(!WEB_AVAILABLE)('public page contract', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    const sql = getTestDb();

    const publicOrg = await createTestOrganization({
      name: 'Public Contract Org',
      slug: 'public-contract-org',
      description: 'Public knowledge workspace for contract tests.',
      visibility: 'public',
    });
    await createTestOrganization({
      name: 'Private Contract Org',
      slug: 'private-contract-org',
      visibility: 'private',
    });

    const user = await createTestUser({ email: 'public-contract@test.example.com' });
    await addUserToOrganization(user.id, publicOrg.id, 'owner');

    await sql`
      INSERT INTO entity_types (organization_id, slug, name, description, icon, created_at, updated_at)
      VALUES
        (${publicOrg.id}, 'brand', 'Brand', 'Tracked public brands', '🏢', NOW(), NOW()),
        (${publicOrg.id}, 'product', 'Product', 'Tracked public products', '📦', NOW(), NOW())
    `;
    const [brandType] = await sql`
      SELECT id FROM entity_types
      WHERE organization_id = ${publicOrg.id} AND slug = 'brand'
    `;
    const brandTypeId = Number(brandType?.id);
    expect(brandTypeId).toBeGreaterThan(0);
    await sql`
      INSERT INTO entity_types (
        organization_id, slug, name, description, icon, backing_sql, created_at, updated_at
      )
      VALUES (
        ${publicOrg.id},
        'brand-directory',
        'Brand Directory',
        'Derived public brand directory',
        'list',
        ${`SELECT id, slug, name FROM entities WHERE entity_type_id = ${brandTypeId}`},
        NOW(),
        NOW()
      )
    `;

    const brand = await createTestEntity({
      name: 'Acme Brand',
      entity_type: 'brand',
      organization_id: publicOrg.id,
      created_by: user.id,
    });
    await createTestEntity({
      name: 'Acme Product',
      entity_type: 'product',
      organization_id: publicOrg.id,
      parent_id: brand.id,
      created_by: user.id,
    });
    await createTestEvent({
      entity_id: brand.id,
      title: 'Brand launch feedback',
      content: 'Customers describe Acme Brand as polished and reliable.',
      connector_key: 'contract.public',
    });

    // System built-in types are per-tenant internals and must not be advertised in the sitemap.
    await sql`
      INSERT INTO entity_types (organization_id, slug, name, description, icon, created_at, updated_at)
      VALUES
        (${publicOrg.id}, ${MEMBER_ENTITY_TYPE_SLUG}, 'Member', 'Organization member', '👤', NOW(), NOW()),
        (${publicOrg.id}, ${LEGACY_CANVAS_ENTITY_TYPE_SLUG}, 'Canvas', 'Automation canvas', 'layout', NOW(), NOW())
    `;
    await createTestEntity({
      name: 'Roster Person',
      entity_type: MEMBER_ENTITY_TYPE_SLUG,
      organization_id: publicOrg.id,
      created_by: user.id,
    });
    const canvas = await createTestEntity({
      name: 'Automation Canvas',
      entity_type: LEGACY_CANVAS_ENTITY_TYPE_SLUG,
      organization_id: publicOrg.id,
      parent_id: brand.id,
      created_by: user.id,
    });
    // Recent-content is org-wide: an event on a system entity would otherwise
    // publish that entity's name and its internal payload.
    await createTestEvent({
      entity_id: canvas.id,
      organization_id: publicOrg.id,
      title: 'Canvas internal state',
      content: 'CANVAS INTERNAL PAYLOAD',
      connector_key: 'contract.canvas',
    });

    // Identity-graph attribution: an event carrying an identifier claimed by a
    // system entity is linked WITHOUT appearing in events.entity_ids. This is
    // the branch entityLinkMatchSql exists for — a filter that trusted
    // entity_ids alone would miss it entirely.
    const systemMember = await createTestEntity({
      name: 'Roster Person Identity',
      entity_type: MEMBER_ENTITY_TYPE_SLUG,
      organization_id: publicOrg.id,
      created_by: user.id,
    });
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, created_at, updated_at)
      VALUES (${publicOrg.id}, ${systemMember.id}, 'email', 'roster-identity@contract.test', NOW(), NOW())
    `;
    const identityEvent = await createTestEvent({
      organization_id: publicOrg.id,
      title: 'Identity linked member note',
      content: 'IDENTITY LINKED PAYLOAD',
      connector_key: 'contract.identity',
    });
    await sql`
      UPDATE events
      SET metadata = COALESCE(metadata, '{}'::jsonb) || ${sql.json({ email: 'roster-identity@contract.test' })}
      WHERE id = ${identityEvent.id}
    `;

    // `events` is append-only, so soft-deleting a system entity leaves its
    // events behind. They must stay suppressed, not become public.
    const deletedCanvas = await createTestEntity({
      name: 'Deleted Automation Canvas',
      entity_type: LEGACY_CANVAS_ENTITY_TYPE_SLUG,
      organization_id: publicOrg.id,
      parent_id: brand.id,
      created_by: user.id,
    });
    await createTestEvent({
      entity_id: deletedCanvas.id,
      organization_id: publicOrg.id,
      title: 'Deleted canvas internal state',
      content: 'DELETED CANVAS PAYLOAD',
      connector_key: 'contract.deleted',
    });
    await sql`UPDATE entities SET deleted_at = NOW() WHERE id = ${deletedCanvas.id}`;
  });

  it('renders crawlable HTML and bootstrap data for a public workspace', async () => {
    const response = await get('/public-contract-org', {
      headers: { Accept: 'text/html' },
      env: { PUBLIC_GATEWAY_URL: publicGatewayUrl },
    });

    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('public, max-age=300');
    expect(body).toContain('Public Contract Org | Lobu');
    expect(body).toContain('window.__LOBU_PUBLIC_BOOTSTRAP__');
    expect(body).toContain(
      '<meta property="og:image" content="http://localhost/lobu-og.png?v=c4cf0dfc" />'
    );
    expect(body).toContain(
      '<meta name="twitter:image" content="http://localhost/lobu-og.png?v=c4cf0dfc" />'
    );
    expect(body).toContain('Tracked public brands');
    expect(body).toContain('Brand launch feedback');
  });

  it('renders public entity pages and real 404 HTML for missing pages', async () => {
    const entity = await get('/public-contract-org/brand/acme-brand', {
      headers: { Accept: 'text/html' },
      env: { PUBLIC_GATEWAY_URL: publicGatewayUrl },
    });
    const entityBody = await entity.text();
    expect(entity.status).toBe(200);
    expect(entityBody).toContain('Acme Brand | Public Contract Org | Lobu');
    expect(entityBody).toContain(
      '<link rel="canonical" href="http://localhost/public-contract-org/brand/acme-brand" />'
    );

    const missing = await get('/public-contract-org/brand/missing-brand', {
      headers: { Accept: 'text/html' },
      env: { PUBLIC_GATEWAY_URL: publicGatewayUrl },
    });
    const missingBody = await missing.text();
    expect(missing.status).toBe(404);
    expect(missingBody).toContain('Page Not Found');
    expect(missingBody).toContain('noindex,nofollow');
  });

  it('uses the derived list total on public entity-type pages', async () => {
    const response = await get('/public-contract-org/brand-directory', {
      headers: { Accept: 'text/html' },
      env: { PUBLIC_GATEWAY_URL: publicGatewayUrl },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('>1 entity</dd>');
    expect(body).toContain('"entity_count":1');
  });

  it('sitemap includes public routes and excludes private workspaces', async () => {
    const sitemap = await get('/sitemap.xml', { env: { PUBLIC_GATEWAY_URL: publicGatewayUrl } });
    const sitemapXml = await sitemap.text();

    expect(sitemap.status).toBe(200);
    expect(sitemapXml).toContain('<loc>http://localhost/public-contract-org</loc>');
    expect(sitemapXml).toContain(
      '<loc>http://localhost/public-contract-org/brand/acme-brand</loc>'
    );
    expect(sitemapXml).toContain(
      '<loc>http://localhost/public-contract-org/brand/acme-brand/product/acme-product</loc>'
    );
    expect(sitemapXml).not.toContain('private-contract-org');
  });

  it('sitemap excludes $-prefixed system entity types and their entities', async () => {
    const sitemap = await get('/sitemap.xml', { env: { PUBLIC_GATEWAY_URL: publicGatewayUrl } });
    const sitemapXml = await sitemap.text();

    expect(sitemap.status).toBe(200);
    expect(sitemapXml).not.toContain(`/${MEMBER_ENTITY_TYPE_SLUG}`);
    expect(sitemapXml).not.toContain('roster-person');
    expect(sitemapXml).not.toContain(`/${LEGACY_CANVAS_ENTITY_TYPE_SLUG}`);
    expect(sitemapXml).not.toContain('automation-canvas');
    // Guard the whole class, not just today's built-ins.
    expect(sitemapXml).not.toMatch(/<loc>[^<]*\/\$/);
  });

  it('404s a deep entity route whose path contains a system type', async () => {
    // The two-segment type lookup does not cover deep paths — a $canvas child
    // hanging off a public parent must 404 on its own full route.
    const response = await get(
      `/public-contract-org/brand/acme-brand/${LEGACY_CANVAS_ENTITY_TYPE_SLUG}/automation-canvas`,
      { headers: { Accept: 'text/html' }, env: { PUBLIC_GATEWAY_URL: publicGatewayUrl } }
    );
    const body = await response.text();
    expect(response.status).toBe(404);
    expect(body).toContain('noindex,nofollow');
    expect(body).not.toContain('Automation Canvas');
  });

  it('omits system types and their entities from rendered HTML and bootstrap', async () => {
    const env = { PUBLIC_GATEWAY_URL: publicGatewayUrl };

    // Workspace page: the entity-type list is both rendered and serialized into
    // window.__LOBU_PUBLIC_BOOTSTRAP__.
    const workspaceBody = await (
      await get('/public-contract-org', { headers: { Accept: 'text/html' }, env })
    ).text();
    expect(workspaceBody).not.toContain(`/public-contract-org/${LEGACY_CANVAS_ENTITY_TYPE_SLUG}`);
    expect(workspaceBody).not.toContain(`"${LEGACY_CANVAS_ENTITY_TYPE_SLUG}"`);
    expect(workspaceBody).not.toContain(`"${MEMBER_ENTITY_TYPE_SLUG}"`);
    // Ordinary types still render — the filter must not be over-broad.
    expect(workspaceBody).toContain('"brand"');

    // Recent knowledge must not carry a system entity's name or payload.
    expect(workspaceBody).not.toContain('Automation Canvas');
    expect(workspaceBody).not.toContain('Canvas internal state');
    expect(workspaceBody).not.toContain('CANVAS INTERNAL PAYLOAD');
    // Identity-linked (entity_ids empty) must be filtered on the same footing.
    expect(workspaceBody).not.toContain('Roster Person Identity');
    expect(workspaceBody).not.toContain('Identity linked member note');
    expect(workspaceBody).not.toContain('IDENTITY LINKED PAYLOAD');
    // Soft-deleting the system entity must not un-hide its append-only events.
    expect(workspaceBody).not.toContain('Deleted canvas internal state');
    expect(workspaceBody).not.toContain('DELETED CANVAS PAYLOAD');
    // Ordinary recent content is still listed.
    expect(workspaceBody).toContain('Brand launch feedback');

    // Entity page: a $canvas child must not appear in the child list.
    const entityBody = await (
      await get('/public-contract-org/brand/acme-brand', { headers: { Accept: 'text/html' }, env })
    ).text();
    expect(entityBody).not.toContain('Automation Canvas');
    expect(entityBody).not.toContain(`"${LEGACY_CANVAS_ENTITY_TYPE_SLUG}"`);
    // The ordinary child is still listed.
    expect(entityBody).toContain('Acme Product');
  });

  it('404s $-prefixed system type and entity pages instead of rendering them', async () => {
    const env = { PUBLIC_GATEWAY_URL: publicGatewayUrl };

    // The type listing page previously rendered 200 and exposed member names.
    const typePage = await get(`/public-contract-org/${MEMBER_ENTITY_TYPE_SLUG}`, {
      headers: { Accept: 'text/html' },
      env,
    });
    const typeBody = await typePage.text();
    expect(typePage.status).toBe(404);
    expect(typeBody).toContain('noindex,nofollow');
    expect(typeBody).not.toContain('Roster Person');

    // Entity pages beneath a system type must 404 too, not just the listing.
    const entityPage = await get(
      `/public-contract-org/${MEMBER_ENTITY_TYPE_SLUG}/roster-person`,
      { headers: { Accept: 'text/html' }, env }
    );
    const entityBody = await entityPage.text();
    expect(entityPage.status).toBe(404);
    expect(entityBody).not.toContain('Roster Person');
  });
});
