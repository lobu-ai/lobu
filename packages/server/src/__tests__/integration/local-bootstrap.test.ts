/**
 * Integration test for `local-bootstrap.ts` — the shared `lobu run`
 * provisioning hooks (issue #1180).
 *
 * Pins two contracts against a real Postgres:
 *
 *   1. With LOBU_RUN_OWNS_DB=1 (the CLI-set local-install marker), running
 *      the external-DB bootstrap hooks on a fresh, migrated database
 *      provisions the install operator and its personal org — i.e.
 *      `/api/local-init` has a first user to mint a session for — but NO
 *      agents (agents are created explicitly by the user).
 *   2. WITHOUT the flag (every cloud/prod deployment), the external-DB
 *      branch gets ZERO hooks and the database stays empty — prod must
 *      never auto-provision users/orgs.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { INSTALL_OPERATOR_KIND } from '../../auth/install-operator';
import { externalDbBootstrapHooks } from '../../local-bootstrap';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';

async function countRows(table: 'user' | 'organization'): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT count(*)::int AS count FROM ${sql(table)}
  `) as unknown as Array<{ count: number }>;
  return rows[0]?.count ?? 0;
}

describe('externalDbBootstrapHooks', () => {
  // Canonical 32-byte hex key so ensureInstallOperator's assertEncryptionKey
  // passes (same convention as install-operator.test.ts).
  const VALID_KEY = 'a'.repeat(64);

  beforeEach(async () => {
    // Truncates every table — the suite starts from the exact fresh-install
    // state the bug report describes (SELECT count(*) FROM "user" → 0).
    await cleanupTestDatabase();
    process.env.ENCRYPTION_KEY = VALID_KEY;
  });

  it('with LOBU_RUN_OWNS_DB=1: provisions operator + personal org but NO agents on an empty DB', async () => {
    expect(await countRows('user')).toBe(0);
    expect(await countRows('organization')).toBe(0);

    const hooks = externalDbBootstrapHooks({
      LOBU_RUN_OWNS_DB: '1',
    });
    expect(hooks.length).toBeGreaterThan(0);
    for (const hook of hooks) await hook();

    const sql = getTestDb();
    const operators = (await sql`
      SELECT id FROM "user" WHERE principal_kind = ${INSTALL_OPERATOR_KIND}
    `) as unknown as Array<{ id: string }>;
    expect(operators).toHaveLength(1);

    const orgs = (await sql`
      SELECT id FROM "organization"
      WHERE (metadata::jsonb)->>'personal_org_for_user_id' = ${operators[0]!.id}
    `) as unknown as Array<{ id: string }>;
    expect(orgs).toHaveLength(1);

    // Auto-provisioning is gone: bootstrap must not create any agents.
    const agents = (await sql`
      SELECT id FROM agents WHERE organization_id = ${orgs[0]!.id}
    `) as unknown as Array<unknown>;
    expect(agents).toHaveLength(0);
  });

  it('with LOBU_RUN_OWNS_DB=1: re-running the hooks is idempotent', async () => {
    const hooks = externalDbBootstrapHooks({
      LOBU_RUN_OWNS_DB: '1',
    });
    for (const hook of hooks) await hook();
    for (const hook of hooks) await hook();

    expect(await countRows('user')).toBe(1);
    expect(await countRows('organization')).toBe(1);
  });

  it('WITHOUT the flag: returns no hooks and the DB stays empty (prod safety)', async () => {
    for (const env of [{}, { LOBU_RUN_OWNS_DB: '0' }, { LOBU_RUN_OWNS_DB: 'true' }]) {
      const hooks = externalDbBootstrapHooks(env);
      expect(hooks).toHaveLength(0);
    }

    expect(await countRows('user')).toBe(0);
    expect(await countRows('organization')).toBe(0);
  });
});


describe('production authentication bootstrap', () => {
  // Cold processes exercise Better Auth's production validation rather than
  // Vitest's test-mode bypass or a previously cached auth instance.
  async function probe(secretEnv: Record<string, string>) {
    const script = `
      const { createServerLifecycle } = await import('./src/server-lifecycle.ts');
      const { app } = await import('./src/index.ts');
      const { createAuth } = await import('./src/auth/index.tsx');
      let reachedPreListen = false;
      let status;
      let requestOrigin;
      const stop = new Error('bootstrap probe complete');
      try {
        await createServerLifecycle({
          mode: 'postgres', env: process.env, host: '127.0.0.1', port: 0,
          databaseReadiness: async () => {},
          preListenHooks: [async () => {
            reachedPreListen = true;
            const auth = await createAuth(process.env, new Request('https://synthetic-auth.example/mcp'));
            requestOrigin = auth.options.baseURL;
            const response = await app.fetch(new Request('http://127.0.0.1/mcp', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}})
            }), process.env);
            status = response.status;
            throw stop;
          }]
        }).start();
      } catch (error) {
        console.log('__BOOT_PROBE__' + JSON.stringify({
          reachedPreListen, status, requestOrigin, error: error === stop ? null : error.message
        }));
        process.exit(0);
      }
    `;
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: process.cwd(), timeout: 45_000, maxBuffer: 2 * 1024 * 1024,
        env: {
          PATH: process.env.PATH!, DATABASE_URL: process.env.DATABASE_URL!,
          ENCRYPTION_KEY: process.env.ENCRYPTION_KEY!, NODE_ENV: 'production',
          LOBU_SINGLE_USER: 'false', LOBU_DISABLE_EMBEDDED_WORKER: '1',
          WORKER_PROXY_PORT: '0', JWT_SECRET: 'synthetic-bootstrap-jwt-secret',
          BETTER_AUTH_SECRET: '', AUTH_SECRET: '', BETTER_AUTH_SECRETS: '',
          ...secretEnv,
        },
      });
    const marker = stdout.split('\n').find(line => line.startsWith('__BOOT_PROBE__'));
    expect(marker, stdout).toBeDefined();
    return JSON.parse(marker!.slice('__BOOT_PROBE__'.length));
  }

  it('refuses missing production auth secrets before the listener can start', async () => {
    const result = await probe({});
    expect(result.reachedPreListen).toBe(false);
    expect(result.error).toContain('BETTER_AUTH_SECRET');
  }, 60_000);

  it('rejects malformed secret rotation before the listener can start', async () => {
    const result = await probe({ BETTER_AUTH_SECRETS: 'invalid-rotation-entry' });
    expect(result.reachedPreListen).toBe(false);
    expect(result.error).toContain('BETTER_AUTH_SECRETS');
  }, 60_000);

  it.each([
    { BETTER_AUTH_SECRET: 'synthetic-production-primary-secret-32-characters' },
    { AUTH_SECRET: 'synthetic-production-legacy-secret-32-characters' },
    { BETTER_AUTH_SECRETS: '2:synthetic-current-rotation-secret-32-characters,1:synthetic-previous-rotation-secret-32-characters' },
  ])('accepts the existing configured auth secret forms: %j', async secretEnv => {
    expect(await probe(secretEnv)).toEqual({ reachedPreListen: true, status: 401, requestOrigin: 'https://synthetic-auth.example', error: null });
  }, 60_000);
});
