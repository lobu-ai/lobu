/**
 * Integration test: what crawlers get from public workspace pages.
 *
 * - A failure while rendering is not a missing page: it must surface as a
 *   503 with `no-store`, never as a publicly cached 404.
 * - The sitemap lists only live types (a soft-deleted type's entities used to
 *   stay listed) and dates each workspace by its newest type or entity.
 * - On an org subdomain (market.lobu.ai) rendered links drop the owner
 *   segment, which the host already implies, so following them takes no 301.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../../index';
import { buildPublicPageModel, buildSitemapEntries } from '../../../public-pages';
import { getEnvFromProcess } from '../../../utils/env';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestEntity,
  createTestOrganization,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const ORIGIN = 'https://app.example.test';

describe('public pages > crawler-facing responses', () => {
  const env = getEnvFromProcess();
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let liveEntitySlug: string;
  let deletedTypeEntitySlug: string;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({
      name: 'Public Pages SEO Org',
      slug: 'seo-market',
      visibility: 'public',
    });
    await createTestEntity({ name: 'Lisbon', entity_type: 'city', organization_id: org.id });
    await createTestEntity({ name: 'Retired Thing', entity_type: 'retired', organization_id: org.id });
    liveEntitySlug = `/${org.slug}/city/lisbon`;
    deletedTypeEntitySlug = `/${org.slug}/retired/retired-thing`;

    const sql = getTestDb();
    await sql`
      UPDATE entity_types SET deleted_at = NOW()
      WHERE organization_id = ${org.id} AND slug = 'retired'
    `;
    // The workspace was created long ago; its content changed recently.
    await sql`UPDATE "organization" SET "createdAt" = '2024-01-02' WHERE id = ${org.id}`;
    await sql`
      UPDATE entities SET updated_at = '2026-10-01T12:00:00Z'
      WHERE organization_id = ${org.id} AND slug = 'lisbon'
    `;
  });

  /**
   * A real database failure inside entity resolution: the workspace lookup
   * still succeeds, then every entity query errors. The suite runs serially
   * on its own ephemeral database, so the rename is invisible to other files.
   */
  async function withEntitiesUnavailable<T>(run: () => Promise<T>): Promise<T> {
    const sql = getTestDb();
    await sql`ALTER TABLE entities RENAME TO entities_unavailable`;
    try {
      return await run();
    } finally {
      await sql`ALTER TABLE entities_unavailable RENAME TO entities`;
    }
  }

  describe('sitemap', () => {
    it('omits entities whose type is soft-deleted', async () => {
      const locs = (await buildSitemapEntries(ORIGIN)).map((entry) => entry.loc);
      expect(locs).toContain(`${ORIGIN}${liveEntitySlug}`);
      expect(locs).not.toContain(`${ORIGIN}${deletedTypeEntitySlug}`);
      expect(locs).not.toContain(`${ORIGIN}/${org.slug}/retired`);
    });

    it('dates a workspace by its newest type or entity, not its creation', async () => {
      const entries = await buildSitemapEntries(ORIGIN);
      const home = entries.find((entry) => entry.loc === `${ORIGIN}/${org.slug}`);
      expect(home?.lastmod).not.toMatch(/^2024-01-02/);
      expect(home?.lastmod && home.lastmod >= '2026-10-01').toBe(true);
    });
  });

  describe('rendering failures', () => {
    it('a path that does not exist is still a 404 model', async () => {
      const missing = `/${org.slug}/city/atlantis`;
      const model = await buildPublicPageModel(missing, env, `${ORIGIN}${missing}`);
      expect(model?.status).toBe(404);
    });

    it('a database error propagates instead of becoming a 404', async () => {
      await withEntitiesUnavailable(async () => {
        await expect(
          buildPublicPageModel(liveEntitySlug, env, `${ORIGIN}${liveEntitySlug}`)
        ).rejects.toThrow(/entities/);
      });
    });

    it('the page route answers 503 no-store, not a cacheable 404', async () => {
      const response = await withEntitiesUnavailable(() =>
        app.request(liveEntitySlug, { headers: { accept: 'text/html' } }, env)
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('retry-after')).toBe('60');
    });
  });

  describe('subdomain links', () => {
    it('drops the owner segment from rendered links on the org subdomain', async () => {
      const model = await buildPublicPageModel('/', env, 'https://seo-market.example.test/', org.slug);
      expect(model?.status).toBe(200);
      const hrefs = [...(model?.bodyHtml ?? '').matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      expect(hrefs).toContain('/city');
      expect(hrefs.filter((href) => href.startsWith(`/${org.slug}/`))).toEqual([]);
      // Canonical stays on the configured public origin, owner segment intact.
      expect(model?.canonicalUrl).toMatch(new RegExp(`/${org.slug}$`));
    });

    it.each([
      ['type directory', '/city', ['/', '/city/lisbon']],
      ['entity page', '/city/lisbon', ['/']],
      ['404 page', '/city/atlantis', ['/']],
    ])('%s on the subdomain links host-relative', async (_, path, expected) => {
      const model = await buildPublicPageModel(path, env, `https://seo-market.example.test${path}`, org.slug);
      const hrefs = [...(model?.bodyHtml ?? '').matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      for (const href of expected) expect(hrefs).toContain(href);
      expect(hrefs.filter((href) => href.startsWith(`/${org.slug}`))).toEqual([]);
    });

    it('keeps the owner segment on the canonical host', async () => {
      const model = await buildPublicPageModel(`/${org.slug}`, env, `${ORIGIN}/${org.slug}`, null);
      const hrefs = [...(model?.bodyHtml ?? '').matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      expect(hrefs).toContain(`/${org.slug}/city`);
    });
  });
});
