/**
 * T2 — a default-scope PAT minted via the REAL token-creation route does NOT
 * carry `connections:token`.
 *
 * `connections:token` is the least-privilege scope that mints managed-connector
 * access tokens (POST /oauth/connection-token). It must NEVER be in the default
 * scope set: a broad CI/member PAT created without an explicit scope would
 * otherwise be able to mint managed-connection tokens, defeating the endpoint
 * gate.
 *
 * This drives the actual `POST /:orgSlug/tokens` route (the same handler the CLI
 * `lobu token create` and the web UI hit), authenticated with a real OAuth
 * `mcp:admin` bearer, and reads the STORED scope back from
 * `personal_access_tokens`. (`createTestPAT` takes an explicit scope, so it
 * can't prove the route's DEFAULT — only the real mint path can.)
 */

import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../../../auth/oauth/utils';
import { credentialRoutes } from '../../../auth/routes';
import type { Env } from '../../../index';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
  RATE_LIMIT_ENABLED: 'false',
} as unknown as Env;

const ORIGIN = 'http://localhost';

function buildApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/', credentialRoutes);
  return app;
}

beforeAll(async () => {
  await initWorkspaceProvider();
});

afterAll(async () => {
  // app is in-process; nothing to tear down
});

describe('T2 — default PAT scope omits connections:token (real mint route)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('a PAT created with NO explicit scope stores the default scope without connections:token', async () => {
    const sql = getTestDb();
    const app = buildApp();

    const org = await createTestOrganization({ name: 'PAT Org' });
    const owner = await createTestUser({ name: 'PAT Owner' });
    await addUserToOrganization(owner.id, org.id, 'owner');

    // A real OAuth bearer carrying mcp:admin (token creation requires it).
    const client = await createTestOAuthClient({ client_name: 'Lobu CLI' });
    const oauth = await createTestAccessToken(owner.id, org.id, client.client_id, {
      scope: 'mcp:read mcp:write mcp:admin',
    });

    // The REAL route — no `scope` in the body, so the handler applies its default.
    const res = await app.fetch(
      new Request(`${ORIGIN}/${org.slug}/tokens`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${oauth.token}`,
        },
        body: JSON.stringify({ name: 'default-scope-pat' }),
      }),
      TEST_ENV
    );

    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      token: { id: number; token: string; scope: string | null };
    };
    expect(created.token.token.startsWith('owl_pat_')).toBe(true);
    // The advertised scope is the default and excludes connections:token.
    expect((created.token.scope ?? '').split(' ')).not.toContain('connections:token');

    // The STORED scope (what the connection-token endpoint introspects) also
    // excludes it — proving the default mint path can't mint managed tokens.
    const rows = (await sql`
      SELECT scope FROM personal_access_tokens
      WHERE token_hash = ${hashToken(created.token.token)}
      LIMIT 1
    `) as unknown as Array<{ scope: string | null }>;
    expect(rows.length).toBe(1);
    const storedScopes = (rows[0].scope ?? '').split(' ').filter(Boolean);
    expect(storedScopes).not.toContain('connections:token');
    // Sanity: the default mcp scopes are present.
    expect(storedScopes).toContain('mcp:read');
    expect(storedScopes).toContain('mcp:write');

    // The mint is in the workspace audit trail, attributed to its creator.
    let audit: Array<{ organization_id: string; created_by: string | null }> = [];
    for (let i = 0; i < 60 && audit.length === 0; i++) {
      audit = (await sql`
        SELECT organization_id, created_by FROM events
        WHERE origin_type = 'access_token_created'
          AND metadata->>'entity_id' = ${String(created.token.id)}
      `) as unknown as typeof audit;
      if (audit.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(audit).toEqual([{ organization_id: org.id, created_by: owner.id }]);
  });
});
