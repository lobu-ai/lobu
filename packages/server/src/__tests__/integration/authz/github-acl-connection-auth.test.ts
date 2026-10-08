import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGithubAclSyncTick } from '../../../authz/github-acl-sync';
import type { Env } from '../../../index';
import { search } from '../../../tools/search';
import { initWorkspaceProvider } from '../../../workspace';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization, createTestConnection, createTestEntity, createTestEvent,
  createTestUser, ownerToolContext, seedOwnerContext,
} from '../../setup/test-fixtures';

describe('GitHub ACL uses the connection credential', () => {
  beforeAll(initWorkspaceProvider);
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
    return { org, user, connections };
  }

  it('syncs two OAuth connections with their own tokens without an App installation', async () => {
    const { org, connections } = await fixture();
    const calls: Array<{ url: string; auth: string | null }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get('Authorization') });
      if (!String(url).includes('/collaborators')) {
        return Response.json({ full_name: String(url).split('/repos/')[1], private: true, visibility: 'private' });
      }
      return new Response(JSON.stringify([{ login: 'synthetic-collaborator', id: 12345 }]), {
        status: 200,
      });
    });
    await runGithubAclSyncTick();
    expect(calls).toEqual([
      {
        url: 'https://api.github.com/repos/synthetic-owner/first',
        auth: 'Bearer synthetic-first-token',
      },
      {
        url: 'https://api.github.com/repos/synthetic-owner/first/collaborators?per_page=100&page=1',
        auth: 'Bearer synthetic-first-token',
      },
      {
        url: 'https://api.github.com/repos/synthetic-owner/second',
        auth: 'Bearer synthetic-second-token',
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
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).includes('/collaborators')
        ? new Response('Forbidden', { status: 403 })
        : Response.json({ full_name: String(url).split('/repos/')[1], private: true, visibility: 'private' }),
    );
    await runGithubAclSyncTick();
    expect(fetch).toHaveBeenCalledTimes(4);
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

  it('syncs a provider-verified public repository without collaborator-list access', async () => {
    const { org, connections } = await fixture();
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      calls.push(path);
      if (path.includes('/collaborators')) return new Response('Forbidden', { status: 403 });
      return Response.json({
        full_name: path.split('/repos/')[1], private: false, visibility: 'public',
      });
    });
    await runGithubAclSyncTick();
    for (const id of connections) {
      const [state] = await getTestDb()`
        SELECT freshness_state FROM authz_source_acl_state
        WHERE organization_id = ${org.id} AND connection_id = ${String(id)}
      `;
      expect(state?.freshness_state).toBe('fresh');
    }
    expect(calls.some((url) => url.includes('/collaborators'))).toBe(false);
  });

  it('fails closed when every repository feed on a connection was removed', async () => {
    const { connections } = await fixture();
    const sql = getTestDb();
    await sql`UPDATE feeds SET deleted_at = now() WHERE connection_id = ${connections[0]}`;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).includes('/collaborators')
        ? Response.json([])
        : Response.json({ full_name: String(url).split('/repos/')[1], private: true, visibility: 'private' }),
    );
    await runGithubAclSyncTick();
    const [connection] = await sql`SELECT error_message FROM connections WHERE id = ${connections[0]}`;
    expect(connection?.error_message).toContain('no repository feeds configured');
  });

  it('ignores invalid retired names and keeps a repository with another live feed', async () => {
    const { org, connections } = await fixture();
    const sql = getTestDb();
    await sql`UPDATE feeds SET deleted_at = now() WHERE connection_id = ${connections[0]}`;
    for (const [repo_name, deleted_at] of [['FIRST', null], ['invalid/repo', new Date()]] as const) {
      await sql`
        INSERT INTO feeds (organization_id, connection_id, feed_key, status, config, deleted_at)
        VALUES (${org.id}, ${connections[0]}, 'issues', 'active',
          ${sql.json({ repo_owner: 'synthetic-owner', repo_name })}, ${deleted_at})
      `;
    }
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      calls.push(String(url));
      return Response.json({ full_name: String(url).split('/repos/')[1], private: false, visibility: 'public' });
    });
    await runGithubAclSyncTick();
    expect(calls).toHaveLength(2);
    expect(calls.some((url) => url.includes('invalid'))).toBe(false);
    const [state] = await sql`
      SELECT freshness_state FROM authz_source_acl_state
      WHERE organization_id = ${org.id} AND connection_id = ${String(connections[0])}
    `;
    expect(state?.freshness_state).toBe('fresh');
  });

  async function signedInMember(orgId: string, userId: string) {
    const entity = await createTestEntity({
      organization_id: orgId, entity_type: '$member', name: `Synthetic reader ${userId}`, created_by: userId,
    });
    await getTestDb()`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES (${orgId}, ${entity.id}, 'auth_user_id', ${userId}, 'auth:signup')
    `;
  }

  const embedding = [1, ...Array(767).fill(0)];
  async function recall(orgId: string, userId: string) {
    const result = await search({
      query: 'repository-probe', query_embedding: embedding, include_content: true, content_limit: 50,
    }, {} as Env, ownerToolContext(orgId, userId));
    return (result.content ?? []).map((row) => row.id);
  }

  async function repoEvent(orgId: string, connectionId: number, name: string) {
    const [resource] = await getTestDb()`
      SELECT entity_id FROM entity_identities
      WHERE organization_id = ${orgId} AND namespace = 'github_repo_full_name'
        AND identifier = ${`synthetic-owner/${name}`} AND deleted_at IS NULL
    `;
    return createTestEvent({
      organization_id: orgId, connection_id: connectionId, connector_key: 'github',
      content: `repository-probe ${name}`, entity_ids: [Number(resource.entity_id)], embedding,
    });
  }

  it('reuses read gates for mixed repositories, connection privacy, and public-to-private revocation', async () => {
    const { org, user, connections } = await fixture();
    const sql = getTestDb();
    const reader = await createTestUser();
    await addUserToOrganization(reader.id, org.id);
    await signedInMember(org.id, user.id);
    await signedInMember(org.id, reader.id);
    const outsider = await createTestUser();
    // Even an old verified identity does not make an outsider a workspace member.
    await signedInMember(org.id, outsider.id);
    await sql`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, config)
      VALUES (${org.id}, ${connections[0]}, 'issues', 'active',
        ${sql.json({ repo_owner: 'synthetic-owner', repo_name: 'secret' })})
    `;
    let firstIsPublic = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/collaborators')) return Response.json([{ login: 'synthetic-other', id: 98765 }]);
      const fullName = path.split('/repos/')[1];
      const isPublic = !fullName.endsWith('/secret') && (firstIsPublic || !fullName.endsWith('/first'));
      return Response.json({ full_name: fullName, private: !isPublic, visibility: isPublic ? 'public' : 'private' });
    });
    await runGithubAclSyncTick();
    const publicEvent = await repoEvent(org.id, connections[0], 'first');
    const privateEvent = await repoEvent(org.id, connections[0], 'secret');
    const privateConnectionEvent = await repoEvent(org.id, connections[1], 'second');
    expect(await recall(org.id, user.id)).toContain(publicEvent.id);
    expect(await recall(org.id, user.id)).not.toContain(privateEvent.id);
    expect(await recall(org.id, reader.id)).not.toContain(publicEvent.id);
    expect(await recall(org.id, reader.id)).not.toContain(privateConnectionEvent.id);
    expect(await recall(org.id, user.id)).toContain(privateConnectionEvent.id);
    expect(await recall(org.id, outsider.id)).not.toContain(publicEvent.id);

    // Removing a feed must retract its old grant even while another repo on
    // this same connection continues keeping the connection's graph fresh.
    await sql`
      UPDATE feeds SET deleted_at = now(), status = 'paused'
      WHERE connection_id = ${connections[0]} AND config->>'repo_name' = 'first'
    `;
    await runGithubAclSyncTick();
    expect(await recall(org.id, user.id)).not.toContain(publicEvent.id);
    await sql`
      UPDATE feeds SET deleted_at = NULL, status = 'active'
      WHERE connection_id = ${connections[0]} AND config->>'repo_name' = 'first'
    `;
    await runGithubAclSyncTick();
    expect(await recall(org.id, user.id)).toContain(publicEvent.id);

    firstIsPublic = false;
    await runGithubAclSyncTick();
    expect(await recall(org.id, user.id)).not.toContain(publicEvent.id);
    // The other connection's still-public resource remains available to its owner.
    expect(await recall(org.id, user.id)).toContain(privateConnectionEvent.id);
  });

  it.each([
    ['denied', 403, {}],
    ['missing', 404, {}],
    ['outage', 503, {}],
    ['wrong repository', 200, { private: false, visibility: 'public', full_name: 'synthetic-owner/wrong' }],
    ['missing privacy', 200, { visibility: 'public' }],
    ['internal', 200, { private: false, visibility: 'internal' }],
    ['missing visibility', 200, { private: false }],
  ])('does not grant a public audience for %s metadata', async (_name, status, metadata) => {
    const { org, connections } = await fixture();
    const sql = getTestDb();
    for (const id of connections) {
      await sql`
        INSERT INTO authz_source_acl_state (organization_id, connection_id, acl_support, freshness_state, last_synced_at)
        VALUES (${org.id}, ${String(id)}, 'full', 'fresh', now())
      `;
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/collaborators')) return new Response('Forbidden', { status: 403 });
      return Response.json({ full_name: String(url).split('/repos/')[1], ...metadata }, { status });
    });
    await runGithubAclSyncTick();
    for (const id of connections) {
      const [state] = await sql`
        SELECT freshness_state FROM authz_source_acl_state
        WHERE organization_id = ${org.id} AND connection_id = ${String(id)}
      `;
      expect(state?.freshness_state).toBe('failed');
    }
  });
});
