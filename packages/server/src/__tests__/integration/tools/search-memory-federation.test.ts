/**
 * Direct bare-OAuth search federation. These tests use only synthetic tenants
 * and exercise the real grant-membership resolver plus real search SQL.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { Value } from '@sinclair/typebox/value';
import type { Env } from '../../../index';
import { getContent } from '../../../tools/get_content';
import {
  mergeFederatedSearchResults,
  UnifiedSearchResultSchema,
  search,
  highestGrantedRole,
} from '../../../tools/search';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

function expectValidSearchResult(result: unknown): void {
  const schemaErrors = [...Value.Errors(UnifiedSearchResultSchema, result)].map((error) => ({
    path: error.path,
    message: error.message,
    value: error.value,
  }));
  expect(schemaErrors).toEqual([]);
}

describe('search_memory direct OAuth workspace federation', () => {
  let orgA: Awaited<ReturnType<typeof createTestOrganization>>;
  let orgB: Awaited<ReturnType<typeof createTestOrganization>>;
  let orgC: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let atlasA: Awaited<ReturnType<typeof createTestEntity>>;
  let atlasB: Awaited<ReturnType<typeof createTestEntity>>;
  let hiddenC: Awaited<ReturnType<typeof createTestEntity>>;
  let sharedEvent: Awaited<ReturnType<typeof createTestEvent>>;
  let unrelatedEvent: Awaited<ReturnType<typeof createTestEvent>>;

  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    orgA = await createTestOrganization({ name: 'Federation Alpha' });
    orgB = await createTestOrganization({ name: 'Federation Beta' });
    orgC = await createTestOrganization({ name: 'Federation Ungranted' });
    user = await createTestUser({ email: 'federated-search@test.example.com' });
    await Promise.all([
      addUserToOrganization(user.id, orgA.id, 'owner'),
      addUserToOrganization(user.id, orgB.id, 'admin'),
      // A current membership is not enough: C is deliberately absent from the
      // immutable grant snapshot returned by context().
      addUserToOrganization(user.id, orgC.id, 'member'),
    ]);

    atlasA = await createTestEntity({
      name: 'Atlas Project',
      organization_id: orgA.id,
      created_by: user.id,
    });
    atlasB = await createTestEntity({
      name: 'Atlas Project',
      organization_id: orgB.id,
      created_by: user.id,
    });
    hiddenC = await createTestEntity({
      name: 'Atlas Hidden',
      organization_id: orgC.id,
      created_by: user.id,
    });
    const unrelated = await createTestEntity({
      name: 'Other Alpha Entity',
      organization_id: orgA.id,
      created_by: user.id,
    });

    sharedEvent = await createTestEvent({
      organization_id: orgA.id,
      entity_ids: [atlasA.id, atlasB.id],
      content: 'scope needle shared bridge evidence',
    });
    unrelatedEvent = await createTestEvent({
      organization_id: orgA.id,
      entity_id: unrelated.id,
      content: 'scope needle unrelated alpha evidence',
    });

    await createTestConnectorDefinition({
      key: 'federation-provenance',
      name: 'Federation Provenance',
      organization_id: orgA.id,
    });
    await createTestConnection({
      organization_id: orgA.id,
      connector_key: 'federation-provenance',
      entity_ids: [atlasA.id],
      created_by: user.id,
    });
  });

  function context(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      organizationId: orgA.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      clientId: 'synthetic-federation-client',
      scopes: ['mcp:read'],
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      grantedOrganizationIds: [orgA.id, orgB.id],
      directSearchFederation: true,
      ...overrides,
    };
  }

  it('fans out omission, labels every facet, and leaves same-name matches ambiguous', async () => {
    const result = await search(
      {
        query: 'Atlas Project',
        fuzzy: false,
        include_content: false,
        include_public_catalogs: false,
        limit: 10,
      },
      {} as Env,
      context()
    );

    expect(result.matches.map((entity) => entity.id).sort()).toEqual(
      [atlasA.id, atlasB.id].sort()
    );
    expect(result.matches.map((entity) => entity.workspace_slug).sort()).toEqual(
      [orgA.slug, orgB.slug].sort()
    );
    expect(result.entity).toBeNull();
    expect(result.suggestion).toContain('Pass workspace to narrow');
    expect(result.connections?.every((connection) => connection.workspace_slug === orgA.slug)).toBe(
      true
    );
    expect(result.connections?.every((connection) => connection.entity_id === atlasA.id)).toBe(true);
    expect(result.coverage).toMatchObject({ scope: 'all_granted', status: 'complete' });
    expect(result.coverage?.workspaces?.map((entry) => entry.workspace_slug)).toEqual([
      orgA.slug,
      orgB.slug,
    ]);
    expectValidSearchResult(result);
    expect(result).not.toHaveProperty('existing_entities');
  });

  it('preserves every top exact-name tie when the default exact limit is one', async () => {
    const result = await search(
      {
        query: 'Atlas Project',
        fuzzy: false,
        include_content: false,
        include_public_catalogs: false,
      },
      {} as Env,
      context()
    );

    expect(result.entity).toBeNull();
    expect(result.matches.map((entity) => entity.id).sort()).toEqual(
      [atlasA.id, atlasB.id].sort()
    );
    expect(result.matches.map((entity) => entity.workspace_slug).sort()).toEqual(
      [orgA.slug, orgB.slug].sort()
    );
    expect(result.metadata).toMatchObject({ total_matches: 2, page_size: 2 });
    expect(result.suggestion).toContain('Pass workspace to narrow');
  });

  it('never reports a false global miss when one workspace shard is unavailable', async () => {
    const targets = [
      { id: orgA.id, slug: orgA.slug, name: orgA.name, role: 'owner', personal: false },
      { id: orgB.id, slug: orgB.slug, name: orgB.name, role: 'admin', personal: false },
    ];
    const emptyB = await search(
      {
        query: 'definitely absent synthetic entity',
        workspace: orgB.slug,
        include_content: false,
        include_public_catalogs: false,
      },
      {} as Env,
      context()
    );
    const failedReason = new Error(`private backend detail for ${orgC.slug}`);
    const partialEmpty = mergeFederatedSearchResults(
      { query: 'definitely absent synthetic entity', include_content: false },
      targets,
      [{ status: 'rejected', reason: failedReason }, { status: 'fulfilled', value: emptyB }]
    );

    expect(partialEmpty.coverage).toMatchObject({ scope: 'all_granted', status: 'partial' });
    expect(partialEmpty.discovery_status).toBe('discovering');
    expect(partialEmpty.suggestion).toContain('partial results');
    expect(partialEmpty.suggestion).not.toContain('No matches');
    expect(JSON.stringify(partialEmpty)).not.toContain(orgC.slug);
    expectValidSearchResult(partialEmpty);

    const hitB = await search(
      {
        query: 'Atlas Project',
        fuzzy: false,
        workspace: orgB.slug,
        include_content: false,
        include_public_catalogs: false,
      },
      {} as Env,
      context()
    );
    const partialHit = mergeFederatedSearchResults(
      { query: 'Atlas Project', fuzzy: false, include_content: false },
      targets,
      [{ status: 'rejected', reason: failedReason }, { status: 'fulfilled', value: hitB }]
    );

    expect(partialHit.matches.map((entity) => entity.id)).toEqual([atlasB.id]);
    expect(partialHit.discovery_status).toBe('complete');
    expect(partialHit.coverage).toMatchObject({ scope: 'all_granted', status: 'partial' });
    expect(JSON.stringify(partialHit)).not.toContain(orgC.slug);
    expectValidSearchResult(partialHit);
  });

  it('preserves entity-ID retry guidance across workspaces without hiding partial failures', async () => {
    const args = { entity_id: 2147483647 };
    const result = await search(args, {} as Env, context());
    expect(result.discovery_status).toBe('not_found');
    expect(result.coverage).toMatchObject({ scope: 'all_granted', status: 'complete' });
    expect(result.suggestion).toContain('entity_id only accepts entity IDs');
    expect(result.suggestion).toContain('query: "memory 2147483647"');
    expect(result.suggestion).not.toContain('entities.create');
    expectValidSearchResult(result);

    const targets = [
      { id: orgA.id, slug: orgA.slug, name: orgA.name, role: 'owner', personal: false },
      { id: orgB.id, slug: orgB.slug, name: orgB.name, role: 'admin', personal: false },
    ];
    const shard = await search({ ...args, workspace: orgA.slug }, {} as Env, context());
    const partial = mergeFederatedSearchResults(args, targets, [
      { status: 'fulfilled', value: shard },
      { status: 'rejected', reason: new Error('synthetic unavailable workspace') },
    ]);
    expect(partial.discovery_status).toBe('discovering');
    expect(partial.suggestion).toContain('partial results');
    expect(partial.suggestion).not.toContain('not found');
    expectValidSearchResult(partial);
  });

  // The federated arm of the empty-result guidance. `partialEmpty` above covers
  // the degraded case, which deliberately says "partial results" instead — this
  // is the HEALTHY all-granted miss, the one branch of the read guidance that
  // had no test.
  it('gives federated misses the read guidance without naming a single workspace query', async () => {
    const targets = [
      { id: orgA.id, slug: orgA.slug, name: orgA.name, role: 'owner', personal: false },
      { id: orgB.id, slug: orgB.slug, name: orgB.name, role: 'admin', personal: false },
    ];
    // Nonsense token AND fuzzy off. `definitely absent synthetic entity` is NOT
    // empty here — trigram admits "Other Alpha Entity" — which the partial case
    // above never notices because status='partial' short-circuits its
    // suggestion before the match check.
    const args = {
      query: 'zzzz-absent-federated-needle-qqqq',
      fuzzy: false,
      include_content: false,
    };
    const shard = async (slug: string) =>
      await search({ ...args, workspace: slug, include_public_catalogs: false }, {} as Env, context());

    const merged = mergeFederatedSearchResults(args, targets, [
      { status: 'fulfilled', value: await shard(orgA.slug) },
      { status: 'fulfilled', value: await shard(orgB.slug) },
    ]);

    expect(merged.coverage).toMatchObject({ scope: 'all_granted', status: 'complete' });
    expect(merged.discovery_status).toBe('not_found');
    const suggestion = merged.suggestion ?? '';
    // Scope-accurate: a federated miss spans workspaces, so it must NOT echo
    // the query as if one workspace had been searched, and must not pre-fill
    // that query as an entity name to create.
    expect(suggestion).toContain('in the currently accessible workspaces granted to this connection');
    expect(suggestion).not.toContain(`for "${args.query}"`);
    expect(suggestion).toContain("name: '<entity_name>'");
    // …while still carrying the same read-first steps as a local miss.
    expect(suggestion).toContain('client.feeds.readMany');
    expect(suggestion).toContain('query_sql');
    expectValidSearchResult(merged);
  });

  // The federated tier comes from the SHARD roles, not the outer context: a
  // bare cross-workspace grant carries no role on `ctx`, so scoring it directly
  // would floor every federated caller at read, and coercing it to 'owner'
  // offers admin-only type creation to a plain member. Member in both here.
  it('does not offer admin-only type creation to a member of every granted workspace', async () => {
    const targets = [
      { id: orgA.id, slug: orgA.slug, name: orgA.name, role: 'member', personal: false },
      { id: orgB.id, slug: orgB.slug, name: orgB.name, role: 'member', personal: false },
    ];
    const args = {
      query: 'zzzz-absent-federated-tier-probe-qqqq',
      fuzzy: false,
      include_content: false,
    };
    const shard = async (slug: string) =>
      await search({ ...args, workspace: slug, include_public_catalogs: false }, {} as Env, {
        ...context(),
        memberRole: 'member',
        scopes: ['mcp:write'],
      } as ToolContext);

    const merged = mergeFederatedSearchResults(
      args,
      targets,
      [
        { status: 'fulfilled', value: await shard(orgA.slug) },
        { status: 'fulfilled', value: await shard(orgB.slug) },
      ],
      'write'
    );

    expect(merged.discovery_status).toBe('not_found');
    const suggestion = merged.suggestion ?? '';
    expect(suggestion).not.toContain('client.entitySchema.createType(...)');
    expect(suggestion).toContain('Creating a brand-new entity type needs admin access');
    // The write-tier half a member CAN reach is still offered.
    expect(suggestion).toContain('client.entities.create');
    expectValidSearchResult(merged);
  });

  // The tier the federated merge is handed comes from this: strongest role
  // wins, so an admin in ANY granted workspace can still reach createType
  // somewhere, while a member everywhere cannot.
  it('scores the federated tier from the strongest role across granted workspaces', () => {
    const at = (role: string) => ({ id: 1, slug: 's', name: 'n', role, personal: false });
    expect(highestGrantedRole([at('member'), at('admin')])).toBe('admin');
    expect(highestGrantedRole([at('admin'), at('owner')])).toBe('owner');
    expect(highestGrantedRole([at('member'), at('member')])).toBe('member');
    expect(highestGrantedRole([])).toBeNull();
  });

  it('narrows through the grant resolver and makes unknown, ungranted, and revoked identical', async () => {
    const narrowed = await search(
      {
        query: 'Atlas',
        workspace: orgB.slug,
        include_content: false,
        include_public_catalogs: false,
        limit: 10,
      },
      {} as Env,
      context()
    );
    expect(narrowed.matches.map((entity) => entity.id)).toEqual([atlasB.id]);
    expect(narrowed.matches[0]?.workspace_slug).toBe(orgB.slug);

    const messageFor = async (workspace: string) =>
      search(
        { query: 'Atlas', workspace, include_content: false },
        {} as Env,
        context()
      ).catch((error: Error) => error.message);

    const unknown = await messageFor('workspace-that-does-not-exist');
    const ungranted = await messageFor(orgC.slug);
    await getTestDb()`DELETE FROM member WHERE "userId" = ${user.id} AND "organizationId" = ${orgB.id}`;
    const revoked = await messageFor(orgB.slug);
    expect(unknown).toBe('Workspace is not available for this connection.');
    expect(ungranted).toBe(unknown);
    expect(revoked).toBe(unknown);

    const afterRevoke = await search(
      {
        query: 'Atlas',
        include_content: false,
        include_public_catalogs: false,
        limit: 10,
      },
      {} as Env,
      context()
    );
    expect(afterRevoke.matches.map((entity) => entity.id)).toEqual([atlasA.id]);
    expect(afterRevoke.matches.map((entity) => entity.id)).not.toContain(hiddenC.id);
    expect(JSON.stringify(afterRevoke)).not.toContain(orgB.slug);
    expect(JSON.stringify(afterRevoke)).not.toContain(orgC.slug);
  });

  it('deduplicates a bridge-visible exact event while preserving every visible workspace', async () => {
    const betaContext = context({
      organizationId: orgB.id,
      memberRole: 'admin',
      directSearchFederation: false,
    });
    const bridgeRead = await getContent(
      { content_ids: [sharedEvent.id], limit: 10 },
      {} as Env,
      betaContext
    );
    expect(bridgeRead.content.map((item) => item.id)).toContain(sharedEvent.id);
    const foreignRead = await getContent(
      { content_ids: [unrelatedEvent.id], limit: 10 },
      {} as Env,
      betaContext
    );
    expect(foreignRead.content).toEqual([]);

    const exact = await search(
      { query: `event ${sharedEvent.id}`, include_public_catalogs: false },
      {} as Env,
      context()
    );
    expect(exact.content?.map((item) => item.id)).toEqual([sharedEvent.id]);
    expect(exact.content?.[0]?.workspace_slugs).toEqual([orgA.slug, orgB.slug].sort());
    expectValidSearchResult(exact);

    const phrase = await search(
      {
        query: `compare event ${sharedEvent.id} with Atlas`,
        include_public_catalogs: false,
      },
      {} as Env,
      context()
    );
    expect(phrase.content?.map((item) => item.id)).not.toContain(sharedEvent.id);
  });

  it('keeps exact-looking misses exact and makes unknown and ungranted ids indistinguishable', async () => {
    const ungrantedEvent = await createTestEvent({
      organization_id: orgC.id,
      entity_id: hiddenC.id,
      content: 'ungranted exact row',
    });
    const unknownId = 900_000_000;
    const unknownDecoy = await createTestEvent({
      organization_id: orgA.id,
      entity_id: atlasA.id,
      content: `semantic decoy says event ${unknownId}`,
    });
    const ungrantedDecoy = await createTestEvent({
      organization_id: orgA.id,
      entity_id: atlasA.id,
      content: `semantic decoy says event ${ungrantedEvent.id}`,
    });

    const unknown = await search(
      { query: `event ${unknownId}`, include_public_catalogs: false },
      {} as Env,
      context()
    );
    const ungranted = await search(
      { query: `event ${ungrantedEvent.id}`, include_public_catalogs: false },
      {} as Env,
      context()
    );

    expect(unknown).toEqual(ungranted);
    expect(unknown.matches).toEqual([]);
    expect(unknown.content ?? []).toEqual([]);
    expect(JSON.stringify(unknown)).not.toContain(String(unknownDecoy.id));
    expect(JSON.stringify(ungranted)).not.toContain(String(ungrantedDecoy.id));
  });

  it('treats entity_id plus query as conjunctive and starts no recall for an inaccessible id', async () => {
    const scoped = await search(
      {
        entity_id: atlasA.id,
        query: 'scope needle',
        include_public_catalogs: false,
        content_limit: 20,
      },
      {} as Env,
      context()
    );
    expect(scoped.content?.map((item) => item.id)).toContain(sharedEvent.id);
    expect(scoped.content?.map((item) => item.id)).not.toContain(unrelatedEvent.id);

    const inaccessible = await search(
      {
        entity_id: hiddenC.id,
        query: 'scope needle',
        include_public_catalogs: false,
        content_limit: 20,
      },
      {} as Env,
      context()
    );
    expect(inaccessible.matches).toEqual([]);
    expect(inaccessible.content ?? []).toEqual([]);
    expect(JSON.stringify(inaccessible)).not.toContain('unrelated alpha evidence');
  });

  it('never recalls a public catalog tenant event through its entity id', async () => {
    const catalog = await createTestOrganization({
      name: 'Synthetic Public Catalog',
      visibility: 'public',
    });
    const publicEntity = await createTestEntity({
      name: 'Canonical Public Atlas',
      organization_id: catalog.id,
    });
    const publicEvent = await createTestEvent({
      organization_id: catalog.id,
      entity_id: publicEntity.id,
      content: 'foreign public tenant secret needle',
    });
    const localA = await createTestEvent({
      organization_id: orgA.id,
      entity_id: publicEntity.id,
      content: 'foreign public tenant secret needle local alpha',
    });
    const localB = await createTestEvent({
      organization_id: orgB.id,
      entity_id: publicEntity.id,
      content: 'foreign public tenant secret needle local beta',
    });

    const result = await search(
      {
        entity_id: publicEntity.id,
        query: 'foreign public tenant secret needle',
        include_public_catalogs: true,
        content_limit: 20,
      },
      {} as Env,
      context()
    );
    expect(result.matches.map((entity) => entity.id)).toContain(publicEntity.id);
    expect(result.content?.map((item) => item.id)).toEqual(
      expect.arrayContaining([localA.id, localB.id])
    );
    expect(result.content?.map((item) => item.id) ?? []).not.toContain(publicEvent.id);

    const localOnly = await search(
      {
        entity_id: publicEntity.id,
        query: 'foreign public tenant secret needle',
        include_public_catalogs: false,
      },
      {} as Env,
      context()
    );
    expect(localOnly.matches).toEqual([]);
    expect(localOnly.content ?? []).toEqual([]);
  });

  it('keeps agent-bound calls single-workspace and bounds children', async () => {
    const agent = await createTestAgent({
      organizationId: orgA.id,
      ownerUserId: user.id,
    });
    for (let index = 0; index < 25; index++) {
      await createTestEntity({
        name: `Atlas Child ${index}`,
        organization_id: orgA.id,
        parent_id: atlasA.id,
        created_by: user.id,
      });
    }

    const result = await search(
      {
        query: 'Atlas Project',
        fuzzy: false,
        include_content: false,
        include_public_catalogs: false,
        limit: 10,
      },
      {} as Env,
      context({ agentId: agent.agentId })
    );
    expect(result.matches.map((entity) => entity.id)).toEqual([atlasA.id]);
    expect(result.matches.map((entity) => entity.id)).not.toContain(atlasB.id);
    expect(result.children).toHaveLength(20);
    expect(result.children?.every((child) => child.parent_entity_id === atlasA.id)).toBe(true);
    expect(result.children?.every((child) => child.workspace_slug === orgA.slug)).toBe(true);
    expectValidSearchResult(result);
  });

  it('generates one shared recall embedding for all workspace shards', async () => {
    let requests = 0;
    let fail = false;
    const embedding = new Array(768).fill(0);
    embedding[0] = 1;
    const service = createServer((_request, response) => {
      requests += 1;
      if (fail) {
        response.writeHead(503, { 'content-type': 'text/plain' });
        response.end('synthetic outage');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ embeddings: [embedding], dimensions: 768 }));
    });
    await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));

    try {
      const address = service.address();
      if (!address || typeof address === 'string') throw new Error('embedding test server missing');
      await search(
        {
          query: 'Atlas Project',
          include_content: true,
          include_public_catalogs: false,
          content_limit: 5,
        },
        { EMBEDDINGS_SERVICE_URL: `http://127.0.0.1:${address.port}` } as Env,
        context()
      );
      expect(requests).toBe(1);

      // A failed shared attempt also stays single: individual shards fall
      // back to text instead of stampeding the unavailable embedding service.
      requests = 0;
      fail = true;
      await search(
        {
          query: 'Atlas Project',
          include_content: true,
          include_public_catalogs: false,
          content_limit: 5,
        },
        { EMBEDDINGS_SERVICE_URL: `http://127.0.0.1:${address.port}` } as Env,
        context()
      );
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        service.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
