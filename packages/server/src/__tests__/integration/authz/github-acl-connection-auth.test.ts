import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGithubAclSyncTick } from '../../../authz/github-acl-sync';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestConnection, seedOwnerContext } from '../../setup/test-fixtures';

describe('GitHub ACL uses the connection credential', () => {
  beforeEach(cleanupTestDatabase);
  afterEach(() => vi.restoreAllMocks());

  async function fixture() {
    const { org, user } = await seedOwnerContext({ orgName: 'GitHub account ACL fixture' });
    const sql = getTestDb();
    const connections = [];
    for (const name of ['first', 'second']) {
      const conn = await createTestConnection({
        organization_id: org.id,
        connector_key: 'github',
        created_by: user.id,
        visibility: 'private',
        createDefaultFeed: false,
      });
      const accountId = `synthetic-github-${name}`;
      await sql`
        INSERT INTO account (id, "accountId", "providerId", "userId", "accessToken", "accessTokenExpiresAt", scope, "createdAt", "updatedAt")
        VALUES (${accountId}, ${accountId}, 'github', ${user.id}, ${`synthetic-${name}-token`}, now() + interval '1 day', 'repo', now(), now())
      `;
      const profile = await createAuthProfile({
        organizationId: org.id,
        connectorKey: 'github',
        profileKind: 'oauth_account',
        displayName: name,
        provider: 'github',
        accountId,
        status: 'active',
        createdBy: user.id,
      });
      await sql`UPDATE connections SET auth_profile_id = ${profile.id} WHERE id = ${conn.id}`;
      await sql`
        INSERT INTO feeds (organization_id, connection_id, feed_key, status, config)
        VALUES (${org.id}, ${conn.id}, 'issues', 'active', ${sql.json({ repo_owner: 'synthetic-owner', repo_name: name })})
      `;
      connections.push(conn.id);
    }
    return { org, connections };
  }

  it('syncs two OAuth connections with their own tokens without an App installation', async () => {
    const { org, connections } = await fixture();
    const calls: Array<{ url: string; auth: string | null }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get('Authorization') });
      return new Response(JSON.stringify([{ login: 'synthetic-collaborator', id: 12345 }]), {
        status: 200,
      });
    });
    await runGithubAclSyncTick();
    expect(calls).toEqual([
      {
        url: 'https://api.github.com/repos/synthetic-owner/first/collaborators?per_page=100&page=1',
        auth: 'Bearer synthetic-first-token',
      },
      {
        url: 'https://api.github.com/repos/synthetic-owner/second/collaborators?per_page=100&page=1',
        auth: 'Bearer synthetic-second-token',
      },
    ]);
    for (const id of connections) {
      const [state] = await getTestDb()`
        SELECT freshness_state FROM authz_source_acl_state
        WHERE organization_id = ${org.id} AND connection_id = ${String(id)}
      `;
      expect(state?.freshness_state).toBe('fresh');
    }
  });

  it('fails closed when the account cannot enumerate collaborators', async () => {
    const { org, connections } = await fixture();
    const sql = getTestDb();
    for (const id of connections) {
      await sql`
        INSERT INTO authz_source_acl_state (organization_id, connection_id, acl_support, freshness_state, last_synced_at)
        VALUES (${org.id}, ${String(id)}, 'full', 'fresh', now())
      `;
    }
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('Forbidden', { status: 403 }));
    await runGithubAclSyncTick();
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const id of connections) {
      const [state] = await sql`
        SELECT freshness_state FROM authz_source_acl_state
        WHERE organization_id = ${org.id} AND connection_id = ${String(id)}
      `;
      const [connection] = await sql`SELECT error_message FROM connections WHERE id = ${id}`;
      expect(state?.freshness_state).toBe('failed');
      expect(connection?.error_message).toContain('returned 403');
    }
  });
});
