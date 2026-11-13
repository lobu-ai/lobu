/**
 * Integration test: what crawlers get from public workspace pages.
 *
 * - A failure while rendering is not a missing page: it must surface as a
 *   503 with `no-store`, never as a publicly cached 404. That includes a
 *   retryable client error such as a rate limit.
 * - The sitemap lists only live types (a soft-deleted type's entities used to
 *   stay listed) and dates each workspace by its newest type or entity.
 * - On an org subdomain (market.lobu.ai) rendered links drop the owner
 *   segment, which the host already implies, so following them takes no 301.
 * - An anonymous render spends the visitor's per-IP public-read budget, so a
 *   crawler cannot fan out unmetered source reads through page loads.
 * - The request span of a render-failure 503 reports the failure behind it. A bare
 *   `HttpServerError: HTTP 503` hid a source outage as a system error.
 * - A crawler burst over source-backed pages cannot overrun the source: visitors
 *   share a bounded number of live reads per connection, identical reads run
 *   once, and a render that cannot wait answers 503 with a Retry-After the
 *   queue's drain time sets.
 */

import { createServer, type Server } from 'node:http';
import { createIsolateConnectorCompiler } from '@lobu/connector-worker/compile';
import { initTracing, shutdownTracing, SpanKind } from '@lobu/core';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../../../index';
import { pushdownFailureError } from '../../../lib/connector-pushdown';
import { buildPublicPageModel, buildSitemapEntries } from '../../../public-pages';
import { buildWrapperApp } from '../../../server-lifecycle';
import { querySqlImpl } from '../../../tools/admin/query_sql';
import * as resolvePathModule from '../../../tools/resolve_path';
import { ToolUserError } from '../../../utils/errors';
import { getEnvFromProcess } from '../../../utils/env';
import {
  getRateLimiter,
  RateLimitPresets,
  resetRateLimiterForTests,
} from '../../../utils/rate-limiter';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  ownerToolContext,
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

    describe('a retryable rejection (rate limit)', () => {
      afterEach(() => {
        vi.restoreAllMocks();
      });

      function rateLimitResolution() {
        vi.spyOn(resolvePathModule, 'resolvePath').mockRejectedValue(
          new ToolUserError('Public read limit reached.', 429, 'RATE_LIMITED')
        );
      }

      it('propagates instead of becoming a 404', async () => {
        rateLimitResolution();
        await expect(
          buildPublicPageModel(liveEntitySlug, env, `${ORIGIN}${liveEntitySlug}`)
        ).rejects.toMatchObject({ httpStatus: 429, retryable: true });
      });

      it('the page route answers 503 no-store', async () => {
        rateLimitResolution();
        const response = await app.request(
          liveEntitySlug,
          { headers: { accept: 'text/html' } },
          env
        );
        expect(response.status).toBe(503);
        expect(response.headers.get('cache-control')).toBe('no-store');
      });
    });

    describe('the request span reports the failure behind the 503', () => {
      afterEach(async () => {
        vi.restoreAllMocks();
        await shutdownTracing();
      });

      async function serverSpanOf(run: () => Promise<Response>) {
        const exporter = new InMemorySpanExporter();
        await shutdownTracing();
        initTracing({ serviceName: 'public-pages-span-test', spanProcessors: [new SimpleSpanProcessor(exporter)] });
        const response = await run();
        // The deployed app sends the page route's own 503 unchanged.
        expect([response.status, response.headers.get('cache-control'), response.headers.get('retry-after')])
          .toEqual([503, 'no-store', '60']);
        const spans = exporter.getFinishedSpans().filter((span) => span.kind === SpanKind.SERVER);
        expect(spans).toHaveLength(1);
        return spans[0].attributes;
      }

      const requestPage = () =>
        buildWrapperApp(env, null, app).request(liveEntitySlug, { headers: { accept: 'text/html' } });

      it('a source that refused the read is a dependency failure', async () => {
        // The production shape: a source-backed record whose connector failed.
        vi.spyOn(resolvePathModule, 'resolvePath').mockRejectedValue(
          pushdownFailureError(new Error('synthetic_source_invalid_response'), 'synthetic-source', 'query')
        );
        expect(await serverSpanOf(requestPage)).toMatchObject({
          'http.response.status_code': 503,
          'exception.type': 'ToolUserError',
          'error.code': 'UPSTREAM_5XX',
          'error.kind': 'dependency',
        });
      });

      it('a database failure keeps its own code', async () => {
        const attributes = await serverSpanOf(() => withEntitiesUnavailable(requestPage));
        expect(attributes).toMatchObject({ 'exception.type': 'PostgresError', 'error.code': '42P01' });
      });
    });
  });

  describe('anonymous render budget', () => {
    const previousTrustedProxy = process.env.TRUSTED_PROXY;
    const ipLimit = RateLimitPresets.PUBLIC_READ_PER_IP_MINUTE.limit;
    const render = (ip: string) =>
      app.request(liveEntitySlug, { headers: { accept: 'text/html', 'X-Forwarded-For': ip } }, env);
    /** Spend `n` of the IP's public reads without a request. */
    const spend = (ip: string, n: number) => {
      for (let i = 0; i < n; i++) {
        getRateLimiter().checkLimit(`rate:public-read:ip:${ip}`, RateLimitPresets.PUBLIC_READ_PER_IP_MINUTE);
      }
    };

    beforeAll(() => {
      process.env.TRUSTED_PROXY = '1';
    });
    afterAll(() => {
      if (previousTrustedProxy === undefined) delete process.env.TRUSTED_PROXY;
      else process.env.TRUSTED_PROXY = previousTrustedProxy;
      resetRateLimiterForTests();
    });
    // The window is clock-aligned; a frozen clock keeps the test inside one.
    beforeEach(() => {
      resetRateLimiterForTests();
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    });
    afterEach(() => vi.useRealTimers());

    it('each render spends one public read, and past the limit the page answers 429 no-store', async () => {
      expect((await render('203.0.113.20')).status).toBe(200);
      spend('203.0.113.20', ipLimit - 2);
      expect((await render('203.0.113.20')).status).toBe(200);

      const refused = await render('203.0.113.20');
      expect(refused.status).toBe(429);
      expect(refused.headers.get('cache-control')).toBe('no-store');
      const retryAfter = Number(refused.headers.get('retry-after'));
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);

      // The budget is per visitor: another address still renders.
      expect((await render('203.0.113.21')).status).toBe(200);
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

  describe('source-backed pages under a crawler burst', () => {
    const CONNECTOR_KEY = 'admission_source_test';
    const CONNECTION_SLUG = 'admission-source';
    // The source a source-backed type reads live: it records what the upstream
    // observed (concurrent calls, every call) and either answers after a pause
    // or, while `hold` is set, keeps `held-*` lookups open until released.
    const source = {
      inFlight: 0,
      peak: 0,
      calls: [] as Array<{ exact: string; limit: number }>,
      delayMs: 250,
      hold: false,
      held: [] as Array<() => void>,
    };
    const releaseHeld = () => {
      source.hold = false;
      for (const respond of source.held.splice(0)) respond();
    };
    let server: Server;
    let savedAllowHosts: string | undefined;
    let ownerId: string;

    const render = (path: string, signal?: AbortSignal) =>
      app.request(path, { headers: { accept: 'text/html' }, signal }, env);
    const recordPath = (key: string) => `/${org.slug}/sourced/${key}`;
    const reachedSource = (key: string) => source.calls.some((call) => call.exact === key);

    beforeAll(async () => {
      server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const exact = url.searchParams.get('exact') ?? '';
        const limit = Number(url.searchParams.get('limit'));
        source.inFlight += 1;
        source.peak = Math.max(source.peak, source.inFlight);
        source.calls.push({ exact, limit });
        const respond = () => {
          source.inFlight -= 1;
          if (res.destroyed) return;
          const rows = exact
            ? [{ slug: exact, name: `Record ${exact}` }]
            : [1, 2, 3].map((n) => ({ slug: `record-${n}`, name: `Record ${n}` }));
          res.writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ rows, total: rows.length }));
        };
        if (source.hold && exact.startsWith('held-')) source.held.push(respond);
        else setTimeout(respond, source.delayMs);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as { port: number };
      // A loopback upstream is reachable only through the operator's exact exemption.
      savedAllowHosts = process.env.LOBU_HTTP_EGRESS_ALLOW_HOSTS;
      process.env.LOBU_HTTP_EGRESS_ALLOW_HOSTS = '127.0.0.1';

      const compiledCode = await createIsolateConnectorCompiler().compileConnectorForIsolateFromSource(`
        import { defineConnector } from '@lobu/connector-sdk';
        export default defineConnector({
          key: '${CONNECTOR_KEY}', name: 'Admission source', version: '1.0.0',
          queryCapabilities: { exactMatch: true, selection: true },
          query: async (ctx) => {
            const exact = ctx.exactMatch ? String(ctx.exactMatch.value ?? ctx.exactMatch.values[0]) : '';
            const res = await fetch(ctx.config.base_url + '/query?exact=' + encodeURIComponent(exact) + '&limit=' + ctx.limit);
            if (!res.ok) throw new Error('admission source answered ' + res.status);
            return await res.json();
          },
        });
      `);
      await createTestConnectorDefinition({ key: CONNECTOR_KEY, name: 'Admission source', organization_id: org.id });
      const sql = getTestDb();
      await sql`UPDATE connector_versions SET compiled_code = ${compiledCode} WHERE connector_key = ${CONNECTOR_KEY}`;
      const owner = await createTestUser({ email: 'admission-owner@example.test' });
      ownerId = owner.id;
      await addUserToOrganization(ownerId, org.id, 'owner');
      await sql`INSERT INTO connections (organization_id, connector_key, slug, display_name, status, visibility, config, created_by)
        VALUES (${org.id}, ${CONNECTOR_KEY}, ${CONNECTION_SLUG}, 'Admission source', 'active', 'org',
          ${sql.json({ base_url: `http://127.0.0.1:${port}` })}, ${ownerId})`;
      await sql`INSERT INTO entity_types (organization_id, slug, name, backing_sql, backing_source, created_at, updated_at)
        VALUES (${org.id}, 'sourced', 'Sourced', 'SELECT slug, name FROM records', ${CONNECTION_SLUG}, NOW(), NOW())`;
    }, 120_000);

    afterAll(async () => {
      releaseHeld();
      if (savedAllowHosts === undefined) delete process.env.LOBU_HTTP_EGRESS_ALLOW_HOSTS;
      else process.env.LOBU_HTTP_EGRESS_ALLOW_HOSTS = savedAllowHosts;
      server?.closeAllConnections();
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    });

    beforeEach(() => {
      source.peak = 0;
      source.calls = [];
      source.delayMs = 250;
    });
    afterEach(() => releaseHeld());

    it('keeps an anonymous burst of distinct record pages within the visitor share of the source', async () => {
      const responses = await Promise.all(
        Array.from({ length: 30 }, (_, n) => render(recordPath(`burst-${n}`)))
      );
      expect(responses.map((response) => response.status)).toEqual(Array(30).fill(200));
      expect(source.peak).toBeLessThanOrEqual(3);
    }, 60_000);

    it('reads the source once for concurrent renders of the same type page', async () => {
      const responses = await Promise.all(
        Array.from({ length: 20 }, () => render(`/${org.slug}/sourced`))
      );
      expect(responses.map((response) => response.status)).toEqual(Array(20).fill(200));
      // The listing is the one read whose limit is the page size; counts read one row.
      expect(source.calls.filter((call) => call.exact === '' && call.limit > 1)).toHaveLength(1);
    }, 60_000);

    it('refuses renders past the wait queue with a retryable 503 and serves the admitted ones', async () => {
      source.hold = true;
      const total = 4 + 32 + 5;
      const settled: Response[] = [];
      const pending = Array.from({ length: total }, (_, n) =>
        render(recordPath(`held-refuse-${n}`)).then((response) => {
          settled.push(response);
          return response;
        })
      );
      try {
        // Three anonymous reads hold the source; 32 wait; the rest are refused.
        await vi.waitFor(() => expect(settled.length).toBeGreaterThanOrEqual(total - 3 - 32), { timeout: 15_000 });
        expect(source.inFlight).toBeLessThanOrEqual(3);
      } finally {
        releaseHeld();
      }
      const responses = await Promise.all(pending);
      const refused = responses.filter((response) => response.status === 503);
      expect(refused.length).toBe(total - 3 - 32);
      expect(responses.filter((response) => response.status === 200)).toHaveLength(3 + 32);
      for (const response of refused) {
        expect(response.headers.get('cache-control')).toBe('no-store');
        const retryAfter = Number(response.headers.get('retry-after'));
        expect(retryAfter).toBeGreaterThanOrEqual(1);
        expect(retryAfter).toBeLessThanOrEqual(30);
      }
      expect(source.peak).toBeLessThanOrEqual(3);
    }, 60_000);

    it('admits a member under anonymous saturation, and an aborted render frees its queue spot', async () => {
      source.hold = true;
      const settled = new Set<string>();
      const visit = (key: string) => {
        const controller = new AbortController();
        const response = render(recordPath(key), controller.signal).finally(() => settled.add(key));
        return { key, controller, response };
      };
      // Three visitors hold the source and 32 wait; the one more is refused.
      const visitors = Array.from({ length: 3 + 32 + 1 }, (_, n) => visit(`held-queue-${n}`));
      try {
        await vi.waitFor(() => expect(settled.size).toBe(1), { timeout: 15_000 });
        const refused = visitors.find((entry) => settled.has(entry.key))!;
        expect((await refused.response).status).toBe(503);

        // A member's read still runs beside the visitors holding the source.
        const member = await querySqlImpl(
          { sql: 'SELECT slug, name FROM records', connection: CONNECTION_SLUG, limit: 3 },
          {},
          ownerToolContext(org.id, ownerId)
        );
        expect(member.error).toBeUndefined();
        expect(member.rows).toHaveLength(3);

        // A queued visitor leaves: the next one waits in its place instead of
        // being refused, which would settle at once.
        const leaving = visitors.filter((entry) => !settled.has(entry.key) && !reachedSource(entry.key)).at(-1)!;
        leaving.controller.abort(new Error('visitor left'));
        await leaving.response.catch(() => undefined);
        const next = visit('held-next');
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(settled.has('held-next')).toBe(false);
        releaseHeld();
        expect((await next.response).status).toBe(200);
        expect(reachedSource(leaving.key)).toBe(false);
      } finally {
        releaseHeld();
        await Promise.allSettled(visitors.map((entry) => entry.response));
      }
    }, 60_000);
  });
});
