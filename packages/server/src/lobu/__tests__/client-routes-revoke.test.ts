import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup.js';
import { authStash, installRouteTestMocks } from './helpers/route-test-mocks';

installRouteTestMocks();

const ORG = 'org-clients';
const USER = 'u1';

beforeAll(async () => {
  await ensureDbForGatewayTests();
}, 60_000);

async function importClientRoutes() {
  const mod = await import('../client-routes.js');
  return mod.clientRoutes;
}

async function seed(): Promise<void> {
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${USER}, 'Test', 'u1@test', true, now(), now())
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG}, ${ORG}, ${ORG})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
    VALUES ('m1', ${ORG}, ${USER}, 'owner', now())
    ON CONFLICT (id) DO NOTHING
  `;

  for (const id of ['mcp_chatgpt_a', 'mcp_chatgpt_b']) {
    await sql`
      INSERT INTO oauth_clients (id, client_name, redirect_uris, user_id, organization_id)
      VALUES (${id}, 'ChatGPT', ARRAY['https://example.test/cb']::text[], ${USER}, ${ORG})
      ON CONFLICT (id) DO NOTHING
    `;
  }
  await sql`
    INSERT INTO oauth_clients (id, client_name, redirect_uris, user_id, organization_id)
    VALUES ('mcp_other', 'Some Other App', ARRAY['https://example.test/cb']::text[], ${USER}, ${ORG})
    ON CONFLICT (id) DO NOTHING
  `;

  for (const id of ['mcp_chatgpt_a', 'mcp_chatgpt_b', 'mcp_other']) {
    await sql`
      INSERT INTO oauth_tokens (
        id, token_type, token_hash, client_id, user_id, organization_id,
        scope, expires_at, created_at
      ) VALUES (
        ${`tok_${id}`}, 'access', ${`hash_${id}`}, ${id}, ${USER}, ${ORG},
        'mcp:read', now() + interval '1 hour', now()
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
}

async function liveTokenIds(): Promise<string[]> {
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();
  const rows = await sql`
    SELECT client_id FROM oauth_tokens
    WHERE organization_id = ${ORG} AND revoked_at IS NULL
    ORDER BY client_id
  `;
  return (rows as Array<{ client_id: string }>).map((r) => r.client_id);
}

describe('DELETE /clients/mcp/:clientId', () => {
  beforeEach(async () => {
    await resetTestDatabase();
    await seed();
    authStash.organizationId = ORG;
    authStash.memberRole = 'owner';
  });

  test('a plain member cannot revoke', async () => {
    authStash.memberRole = 'member';
    const routes = await importClientRoutes();
    const res = await routes.request('/mcp/mcp_chatgpt_a', { method: 'DELETE' });

    expect(res.status).toBe(403);
    expect(await liveTokenIds()).toEqual([
      'mcp_chatgpt_a',
      'mcp_chatgpt_b',
      'mcp_other',
    ]);
  });

  test('a user with no membership role cannot revoke', async () => {
    authStash.memberRole = null;
    const routes = await importClientRoutes();
    const res = await routes.request('/mcp/mcp_chatgpt_a', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  test('a request without an organization is rejected before role authorization', async () => {
    authStash.organizationId = null;
    const routes = await importClientRoutes();
    const res = await routes.request('/mcp/mcp_chatgpt_a', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  test('an admin can revoke, and by default only the one registration', async () => {
    authStash.memberRole = 'admin';
    const routes = await importClientRoutes();
    const res = await routes.request('/mcp/mcp_chatgpt_a', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(await liveTokenIds()).toEqual(['mcp_chatgpt_b', 'mcp_other']);
  });

  test('scope=all revokes every registration of the same client', async () => {
    const { getDb } = await import('../../db/client.js');
    const sql = getDb();
    await sql`
      INSERT INTO oauth_clients (id, client_name, redirect_uris)
      VALUES ('mcp_chatgpt_legacy', 'ChatGPT', ARRAY['https://example.test/cb']::text[])
    `;
    await sql`
      INSERT INTO oauth_tokens (
        id, token_type, token_hash, client_id, user_id, organization_id,
        scope, expires_at, created_at
      ) VALUES (
        'tok_mcp_chatgpt_legacy', 'access', 'hash_mcp_chatgpt_legacy',
        'mcp_chatgpt_legacy', ${USER}, ${ORG}, 'mcp:read',
        now() + interval '1 hour', now()
      )
    `;
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES ('u2', 'Other', 'u2@test', true, now(), now())
    `;
    await sql`
      INSERT INTO oauth_clients (id, client_name, redirect_uris, user_id, organization_id)
      VALUES (
        'mcp_chatgpt_other_user', 'ChatGPT',
        ARRAY['https://example.test/cb']::text[], 'u2', ${ORG}
      )
    `;
    await sql`
      INSERT INTO oauth_tokens (
        id, token_type, token_hash, client_id, user_id, organization_id,
        scope, expires_at, created_at
      ) VALUES (
        'tok_mcp_chatgpt_other_user', 'access', 'hash_mcp_chatgpt_other_user',
        'mcp_chatgpt_other_user', 'u2', ${ORG}, 'mcp:read',
        now() + interval '1 hour', now()
      )
    `;

    const routes = await importClientRoutes();
    const res = await routes.request('/mcp/mcp_chatgpt_a?scope=all', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { revokedClientIds: string[] };
    expect([...body.revokedClientIds].sort()).toEqual([
      'mcp_chatgpt_a',
      'mcp_chatgpt_b',
      'mcp_chatgpt_legacy',
    ]);
    expect(await liveTokenIds()).toEqual([
      'mcp_chatgpt_other_user',
      'mcp_other',
    ]);
  });

  test('scope=all does not reach a different client that shares nothing', async () => {
    const routes = await importClientRoutes();
    const res = await routes.request('/mcp/mcp_other?scope=all', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(await liveTokenIds()).toEqual(['mcp_chatgpt_a', 'mcp_chatgpt_b']);
  });

  test('a client from another org is not revocable', async () => {
    authStash.organizationId = 'org-somewhere-else';
    const routes = await importClientRoutes();
    const res = await routes.request('/mcp/mcp_chatgpt_a', { method: 'DELETE' });

    expect(res.status).toBe(404);
    expect(await liveTokenIds()).toEqual([
      'mcp_chatgpt_a',
      'mcp_chatgpt_b',
      'mcp_other',
    ]);
  });
});

/**
 * One RFC 7591 registration can hold tokens for several users in an org.
 * Revocation is scoped to the resolved owner so bystanders sharing the
 * registration stay connected, and the LISTED owner and the REVOKED owner
 * must be picked by the same ordering.
 */
const SHARED_ORG = 'org-shared';
const ALICE = 'u-alice';
const BOB = 'u-bob';
const SHARED_CLIENT = 'mcp_shared_registration';

async function seedSharedRegistration(): Promise<void> {
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();

  for (const [id, email] of [
    [ALICE, 'alice@test'],
    [BOB, 'bob@test'],
  ] as const) {
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES (${id}, ${id}, ${email}, true, now(), now())
      ON CONFLICT (id) DO NOTHING
    `;
  }
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${SHARED_ORG}, ${SHARED_ORG}, ${SHARED_ORG})
    ON CONFLICT (id) DO NOTHING
  `;

  // ONE registration, no owning user_id — the shared-client shape.
  await sql`
    INSERT INTO oauth_clients (id, client_name, redirect_uris)
    VALUES (${SHARED_CLIENT}, 'Shared App', ARRAY['https://example.test/cb']::text[])
    ON CONFLICT (id) DO NOTHING
  `;

  // Alice and Bob each authorized that same registration.
  // ALICE's token is the NEWEST while BOB sorts lexicographically LAST. That
  // split is deliberate: a MAX(user_id) owner pick lands on Bob and a
  // newest-token pick lands on Alice, so any divergence between the listing
  // and the revoke path shows up as a concrete wrong-person outcome rather
  // than passing by coincidence.
  for (const [uid, ageMinutes] of [
    [BOB, 10],
    [ALICE, 1],
  ] as const) {
    await sql`
      INSERT INTO oauth_tokens (
        id, token_type, token_hash, client_id, user_id, organization_id,
        scope, expires_at, created_at
      ) VALUES (
        ${`tok_${uid}`}, 'access', ${`hash_${uid}`}, ${SHARED_CLIENT}, ${uid}, ${SHARED_ORG},
        'mcp:read', now() + interval '1 hour',
        now() - (${ageMinutes} * interval '1 minute')
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
}

async function liveTokenUsers(): Promise<string[]> {
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();
  const rows = await sql`
    SELECT user_id FROM oauth_tokens
    WHERE organization_id = ${SHARED_ORG} AND revoked_at IS NULL
    ORDER BY user_id
  `;
  return (rows as Array<{ user_id: string }>).map((r) => r.user_id);
}

describe('shared OAuth registration', () => {
  beforeEach(async () => {
    await resetTestDatabase();
    await seedSharedRegistration();
    authStash.organizationId = SHARED_ORG;
    authStash.memberRole = 'owner';
  });

  test('revoking does not take out the other user on the same registration', async () => {
    const routes = await importClientRoutes();
    const res = await routes.request(`/mcp/${SHARED_CLIENT}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);

    // The route resolves the owner from the most recent org token (ALICE) and
    // revokes only that person's grants. Before the user scoping both rows
    // were revoked, so Bob lost access to an app he merely shares.
    expect(await liveTokenUsers()).toEqual([BOB]);
  });

  test('the listed owner is the owner that gets revoked', async () => {
    // BOB sorts lexicographically LAST but ALICE's token is NEWEST. A
    // MAX(user_id) listing would name Bob while a newest-token revoke hits
    // Alice — the row you click would not be the grant you kill. Both sides
    // must pick the same token.
    const routes = await importClientRoutes();

    const listRes = await routes.request('/');
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as {
      clients: Array<{ id: string; linkedUserEmail: string | null }>;
    };
    const row = listed.clients.find((c) => c.id === SHARED_CLIENT);
    expect(row).toBeDefined();

    await routes.request(`/mcp/${SHARED_CLIENT}`, { method: 'DELETE' });

    // Whoever the list named is exactly who lost access.
    const stillLive = await liveTokenUsers();
    const revokedUser = [ALICE, BOB].find((u) => !stillLive.includes(u));
    const expectedEmail = revokedUser === ALICE ? 'alice@test' : 'bob@test';
    expect(row?.linkedUserEmail).toBe(expectedEmail);
  });

  test('a registration owned by one user but last used by another revokes the user it displays', async () => {
    // The registration owner and the person holding the displayed grant can
    // differ when a registration is reused.
    const { getDb } = await import('../../db/client.js');
    await getDb()`
      UPDATE oauth_clients SET user_id = ${BOB} WHERE id = ${SHARED_CLIENT}
    `;

    const routes = await importClientRoutes();
    const listRes = await routes.request('/');
    const listed = (await listRes.json()) as {
      clients: Array<{ id: string; linkedUserEmail: string | null }>;
    };
    const row = listed.clients.find((c) => c.id === SHARED_CLIENT);
    // Display follows the newest token — Alice.
    expect(row?.linkedUserEmail).toBe('alice@test');

    await routes.request(`/mcp/${SHARED_CLIENT}`, { method: 'DELETE' });

    // …and so must the revocation. Bob keeps his grant.
    expect(await liveTokenUsers()).toEqual([BOB]);
  });

  test('prefers a live grant over a newer revoked grant', async () => {
    const { getDb } = await import('../../db/client.js');
    await getDb()`
      UPDATE oauth_tokens SET revoked_at = now() WHERE id = ${`tok_${ALICE}`}
    `;

    const routes = await importClientRoutes();
    const listRes = await routes.request('/');
    const listed = (await listRes.json()) as {
      clients: Array<{ id: string; linkedUserEmail: string | null; status: string }>;
    };
    const row = listed.clients.find((c) => c.id === SHARED_CLIENT);
    expect(row?.status).toBe('connected');
    expect(row?.linkedUserEmail).toBe('bob@test');

    await routes.request(`/mcp/${SHARED_CLIENT}`, { method: 'DELETE' });
    expect(await liveTokenUsers()).toEqual([]);
  });

  test('keeps an organization-owned registration with no tokens visible', async () => {
    const { getDb } = await import('../../db/client.js');
    await getDb()`
      INSERT INTO oauth_clients (id, client_name, redirect_uris, organization_id)
      VALUES ('mcp_registered_only', 'Registered Only', ARRAY['https://example.test/cb']::text[], ${SHARED_ORG})
    `;

    const routes = await importClientRoutes();
    const listRes = await routes.request('/');
    const listed = (await listRes.json()) as {
      clients: Array<{ id: string; status: string }>;
    };
    expect(listed.clients).toContainEqual(
      expect.objectContaining({ id: 'mcp_registered_only', status: 'disconnected' })
    );
  });

  test('scope=all also stays within the resolved owner', async () => {
    const { getDb } = await import('../../db/client.js');
    await getDb()`
      INSERT INTO oauth_clients (id, client_name, redirect_uris, user_id, organization_id)
      VALUES (
        'mcp_shared_sibling', 'Shared App',
        ARRAY['https://example.test/cb']::text[], ${BOB}, ${SHARED_ORG}
      )
    `;
    await getDb()`
      INSERT INTO oauth_tokens (
        id, token_type, token_hash, client_id, user_id, organization_id,
        scope, expires_at, created_at
      ) VALUES (
        'tok_shared_sibling', 'access', 'hash_shared_sibling',
        'mcp_shared_sibling', ${ALICE}, ${SHARED_ORG}, 'mcp:read',
        now() + interval '1 hour', now()
      )
    `;

    const routes = await importClientRoutes();
    const res = await routes.request(`/mcp/${SHARED_CLIENT}?scope=all`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(await liveTokenUsers()).toEqual([BOB]);
  });
});
