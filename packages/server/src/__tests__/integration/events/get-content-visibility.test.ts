/**
 * Integration test: connection-visibility folding in `getContent`.
 *
 * Stream B of the atlas-events-fix plan dropped the two-step "first query
 * private connections, then query visible connections" round trip. Visibility
 * now lives inline in the list/count WHERE clause of every query branch in
 * `get_content.ts` plus the search/text-query path in `content-search.ts`,
 * all using the same `buildConnectionVisibilityClause` helper. This file
 * pins the semantics:
 *
 *   - Authed user sees connections with visibility='org' OR created_by=userId.
 *   - Unauthed sees only visibility='org'.
 *   - Soft-deleted connections (deleted_at IS NOT NULL) are hidden in both
 *     cases, even when they're the user's own.
 *   - Events with connection_id IS NULL (system / non-connection events) are
 *     visible to authed and unauthed callers.
 *   - Pagination count matches list cardinality.
 *   - All five query branches enforce the same predicate:
 *       1. chronological list (sort_by=date, no query)
 *       2. content_ids
 *       3. include_superseded
 *       4. sort_by=score
 *       5. search / text-query (`query` arg set — `searchContentBySingleQuery`)
 *   - `view_url` is populated for entity-scoped requests so LLM agents
 *     reading the response over MCP can include it in chat replies.
 *   - `classification_stats` only appears when the caller explicitly passes
 *     `include_classification: 'summary'`.
 *   - `score` distinguishes an absent score (null) from a recorded zero.
 *
 * NOTE: vitest is not yet wired into CI for this package. Stream C will fix
 * that. Until then, these tests run locally against the dev Postgres.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { type ContentItem, getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { insertEvent } from '../../../utils/insert-event';
import {
  __resetPublicOriginCachesForTests,
  __setLocalFrontendForTests,
} from '../../../utils/public-origin';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('getContent > connection visibility folded into WHERE', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let aliceUser: Awaited<ReturnType<typeof createTestUser>>;
  let bobUser: Awaited<ReturnType<typeof createTestUser>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;

  let orgConnId: number;
  let alicePrivateConnId: number;
  let bobPrivateConnId: number;
  let deletedAlicePrivateConnId: number;

  let orgEventId: number;
  let alicePrivateEventId: number;
  let bobPrivateEventId: number;
  let deletedAlicePrivateEventId: number;
  let systemEventId: number;

  function authedCtx(userId: string): ToolContext {
    return {
      organizationId: org.id,
      userId,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    };
  }

  function unauthedCtx(): ToolContext {
    return {
      organizationId: org.id,
      userId: null,
      memberRole: null,
      isAuthenticated: false,
      tokenType: 'anonymous',
      scopedToOrg: true,
      allowCrossOrg: false,
    };
  }

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Visibility Org' });
    aliceUser = await createTestUser({ email: 'alice-vis@example.com' });
    bobUser = await createTestUser({ email: 'bob-vis@example.com' });
    await addUserToOrganization(aliceUser.id, org.id, 'owner');
    await addUserToOrganization(bobUser.id, org.id, 'owner');

    entity = await createTestEntity({
      name: 'Visibility Entity',
      organization_id: org.id,
    });

    await createTestConnectorDefinition({
      key: 'vis-test-connector',
      name: 'Vis Test',
      organization_id: org.id,
    });

    // Org-visible connection — anyone in the org may read its events.
    const orgConn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'vis-test-connector',
      entity_ids: [entity.id],
      visibility: 'org',
      created_by: aliceUser.id,
      display_name: 'Org-visible',
    });
    orgConnId = orgConn.id;

    // Alice's private connection — only Alice (and presumably admins, but
    // memberRole isn't part of the fold) sees its events when authed; Bob
    // and unauthed callers do not.
    const alicePrivConn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'vis-test-connector',
      entity_ids: [entity.id],
      visibility: 'private',
      created_by: aliceUser.id,
      display_name: 'Alice private',
    });
    alicePrivateConnId = alicePrivConn.id;

    // Bob's private connection — Alice and unauthed should not see its events.
    const bobPrivConn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'vis-test-connector',
      entity_ids: [entity.id],
      visibility: 'private',
      created_by: bobUser.id,
      display_name: 'Bob private',
    });
    bobPrivateConnId = bobPrivConn.id;

    // Soft-deleted version of an Alice-private connection. The fold filters
    // on deleted_at IS NULL, so even Alice should not see its events.
    const deletedAlicePrivConn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'vis-test-connector',
      entity_ids: [entity.id],
      visibility: 'private',
      created_by: aliceUser.id,
      display_name: 'Alice private (deleted)',
    });
    deletedAlicePrivateConnId = deletedAlicePrivConn.id;
    const sql = getTestDb();
    await sql`
      UPDATE connections SET deleted_at = NOW()
      WHERE id = ${deletedAlicePrivateConnId}
    `;

    orgEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: orgConnId,
        content: 'org-visible connection event',
      })
    ).id;

    alicePrivateEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: alicePrivateConnId,
        content: 'event from alice private connection',
      })
    ).id;

    bobPrivateEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: bobPrivateConnId,
        content: 'event from bob private connection',
      })
    ).id;

    deletedAlicePrivateEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: deletedAlicePrivateConnId,
        content: 'event from deleted alice private connection',
      })
    ).id;

    // System event: no connection at all. Must be visible to both authed
    // and unauthed callers under the new fold.
    systemEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: undefined,
        content: 'system event with no connection',
      })
    ).id;
  });

  it('authed user sees their own private connection events plus org events plus system events', async () => {
    const result = await getContent(
      { entity_id: entity.id, limit: 100, sort_by: 'date', sort_order: 'desc' } as never,
      {} as never,
      authedCtx(aliceUser.id)
    );
    const visibleIds = new Set(result.content.map((c) => c.id));

    expect(visibleIds.has(orgEventId)).toBe(true);
    expect(visibleIds.has(alicePrivateEventId)).toBe(true);
    expect(visibleIds.has(systemEventId)).toBe(true);

    // Other user's private connection: hidden.
    expect(visibleIds.has(bobPrivateEventId)).toBe(false);
    // Soft-deleted connection: hidden even though Alice owns it.
    expect(visibleIds.has(deletedAlicePrivateEventId)).toBe(false);
  });

  it('authed user does NOT see other users private connection events', async () => {
    const result = await getContent(
      { entity_id: entity.id, limit: 100, sort_by: 'date', sort_order: 'desc' } as never,
      {} as never,
      authedCtx(bobUser.id)
    );
    const visibleIds = new Set(result.content.map((c) => c.id));

    expect(visibleIds.has(bobPrivateEventId)).toBe(true);
    expect(visibleIds.has(orgEventId)).toBe(true);
    expect(visibleIds.has(systemEventId)).toBe(true);
    expect(visibleIds.has(alicePrivateEventId)).toBe(false);
  });

  it('unauthed caller sees only org-visible connection events plus system events', async () => {
    const result = await getContent(
      { entity_id: entity.id, limit: 100, sort_by: 'date', sort_order: 'desc' } as never,
      {} as never,
      unauthedCtx()
    );
    const visibleIds = new Set(result.content.map((c) => c.id));

    expect(visibleIds.has(orgEventId)).toBe(true);
    expect(visibleIds.has(systemEventId)).toBe(true);
    expect(visibleIds.has(alicePrivateEventId)).toBe(false);
    expect(visibleIds.has(bobPrivateEventId)).toBe(false);
    expect(visibleIds.has(deletedAlicePrivateEventId)).toBe(false);
  });

  it('total count matches list cardinality across cursor-driven pagination', async () => {
    const ctx = authedCtx(aliceUser.id);

    // The chronological feed (sort_by=date + sort_order=desc) uses cursor
    // pagination, not offset, so we walk it via before_occurred_at/before_id
    // the same way the events tab does in production.
    const page1 = await getContent(
      {
        entity_id: entity.id,
        limit: 2,
        sort_by: 'date',
        sort_order: 'desc',
      } as never,
      {} as never,
      ctx
    );
    expect(page1.total).toBe(3);
    expect(page1.content.length).toBe(2);
    expect(page1.page.has_older).toBe(true);

    const last = page1.content[page1.content.length - 1];
    const page2 = await getContent(
      {
        entity_id: entity.id,
        limit: 2,
        sort_by: 'date',
        sort_order: 'desc',
        before_occurred_at: last.occurred_at,
        before_id: last.id,
      } as never,
      {} as never,
      ctx
    );
    expect(page2.total).toBe(3);

    const collected = new Set([
      ...page1.content.map((c) => c.id),
      ...page2.content.map((c) => c.id),
    ]);
    expect(collected.size).toBe(3);
    expect(collected.has(orgEventId)).toBe(true);
    expect(collected.has(alicePrivateEventId)).toBe(true);
    expect(collected.has(systemEventId)).toBe(true);
  });

  it('org-wide cursor pagination keeps total exact on every page', async () => {
    // Org-wide (no entity_id) listings run count + list in parallel; the
    // ContentSearchResponse.total contract must hold on cursor pages too —
    // callers (agents reading read_knowledge) rely on it, not just the UI's
    // first-page display.
    const ctx = authedCtx(aliceUser.id);

    const page1 = await getContent(
      {
        limit: 2,
        sort_by: 'date',
        sort_order: 'desc',
      } as never,
      {} as never,
      ctx
    );
    expect(page1.total).toBe(3);
    expect(page1.content.length).toBe(2);
    expect(page1.page.has_older).toBe(true);

    const last = page1.content[page1.content.length - 1];
    const page2 = await getContent(
      {
        limit: 2,
        sort_by: 'date',
        sort_order: 'desc',
        before_occurred_at: last.occurred_at,
        before_id: last.id,
      } as never,
      {} as never,
      ctx
    );
    // The cursor page must still carry the exact total, never 0.
    expect(page2.total).toBe(3);

    const collected = new Set([
      ...page1.content.map((c) => c.id),
      ...page2.content.map((c) => c.id),
    ]);
    expect(collected.size).toBe(3);
  });
});

describe('getContent > response shape (view_url present, stats opt-in)', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let emptyEntity: Awaited<ReturnType<typeof createTestEntity>>;

  function ctx(): ToolContext {
    return {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    };
  }

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Shape Org' });
    user = await createTestUser({ email: 'shape@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    emptyEntity = await createTestEntity({
      name: 'Empty Entity',
      organization_id: org.id,
    });
  });

  it('empty entity returns content=[], total=0, view_url populated, no classification_stats by default', async () => {
    // Pin "no local frontend" so the URL builder takes the absolute
    // hosted-UI fallback deterministically: with a built
    // packages/owletto/dist on the machine (any owletto build, e.g.
    // make review) hasLocalFrontend() flips and view_url comes back
    // relative — the assertion below is about the URL being usable by
    // an MCP client, not about the machine's build state.
    __setLocalFrontendForTests(false);
    try {
      const result = await getContent(
        { entity_id: emptyEntity.id, limit: 50, sort_by: 'date', sort_order: 'desc' } as never,
        {} as never,
        ctx()
      );

      expect(result.content).toEqual([]);
      expect(result.total).toBe(0);
      // view_url is consumed by LLM agents reading read_knowledge over MCP.
      // It must always be populated when an entity is in scope.
      const viewUrl = (result as { view_url?: string }).view_url;
      expect(typeof viewUrl).toBe('string');
      expect(viewUrl).toMatch(/^https?:\/\//);
      expect(result.classification_stats).toBeUndefined();
    } finally {
      __resetPublicOriginCachesForTests();
    }
  });

  it('classification_stats is populated only when include_classification=summary is set', async () => {
    const withStats = await getContent(
      {
        entity_id: emptyEntity.id,
        limit: 50,
        include_classification: 'summary',
        sort_by: 'date',
        sort_order: 'desc',
      } as never,
      {} as never,
      ctx()
    );
    expect(withStats.classification_stats).toBeDefined();

    const withoutStats = await getContent(
      { entity_id: emptyEntity.id, limit: 50, sort_by: 'date', sort_order: 'desc' } as never,
      {} as never,
      ctx()
    );
    expect(withoutStats.classification_stats).toBeUndefined();
  });

  it('returns null for an unscored event and preserves numeric scores including zero', async () => {
    const note = async (originId: string, score?: number) =>
      (
        await insertEvent({
          entityIds: [emptyEntity.id],
          organizationId: org.id,
          originId,
          title: originId,
          content: `score probe ${originId}`,
          semanticType: 'note',
          ...(score === undefined ? {} : { score }),
        })
      ).id;
    // No score supplied: insertEvent stores an explicit NULL.
    const unscoredId = await note('score-unscored');
    const scoredId = await note('score-scored', 4.5);
    const zeroScoreId = await note('score-zero', 0);

    const result = await getContent(
      { content_ids: [unscoredId, scoredId, zeroScoreId], limit: 10 },
      {} as never,
      ctx()
    );
    const byId = new Map((result.content as ContentItem[]).map((c) => [Number(c.id), c]));
    expect(byId.get(unscoredId)?.score).toBeNull();
    expect(byId.get(scoredId)?.score).toBe(4.5);
    expect(byId.get(zeroScoreId)?.score).toBe(0);
  });
});

describe('getContent > visibility matrix on sibling branches (content_ids/include_superseded/score)', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let aliceUser: Awaited<ReturnType<typeof createTestUser>>;
  let bobUser: Awaited<ReturnType<typeof createTestUser>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;

  let orgEventId: number;
  let alicePrivateEventId: number;
  let bobPrivateEventId: number;
  let systemEventId: number;
  let deletedConnEventId: number;

  function authedCtx(userId: string): ToolContext {
    return {
      organizationId: org.id,
      userId,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    };
  }

  function unauthedCtx(): ToolContext {
    return {
      organizationId: org.id,
      userId: null,
      memberRole: null,
      isAuthenticated: false,
      tokenType: 'anonymous',
      scopedToOrg: true,
      allowCrossOrg: false,
    };
  }

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Sibling Branch Org' });
    aliceUser = await createTestUser({ email: 'alice-branches@example.com' });
    bobUser = await createTestUser({ email: 'bob-branches@example.com' });
    await addUserToOrganization(aliceUser.id, org.id, 'owner');
    await addUserToOrganization(bobUser.id, org.id, 'owner');

    entity = await createTestEntity({
      name: 'Sibling Branch Entity',
      organization_id: org.id,
    });

    await createTestConnectorDefinition({
      key: 'branch-test-connector',
      name: 'Branch Test',
      organization_id: org.id,
    });

    const orgConn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'branch-test-connector',
      entity_ids: [entity.id],
      visibility: 'org',
      created_by: aliceUser.id,
      display_name: 'Branch org-visible',
    });
    const alicePriv = await createTestConnection({
      organization_id: org.id,
      connector_key: 'branch-test-connector',
      entity_ids: [entity.id],
      visibility: 'private',
      created_by: aliceUser.id,
      display_name: 'Branch alice-private',
    });
    const bobPriv = await createTestConnection({
      organization_id: org.id,
      connector_key: 'branch-test-connector',
      entity_ids: [entity.id],
      visibility: 'private',
      created_by: bobUser.id,
      display_name: 'Branch bob-private',
    });
    const deletedConn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'branch-test-connector',
      entity_ids: [entity.id],
      visibility: 'org',
      created_by: aliceUser.id,
      display_name: 'Branch deleted',
    });
    const sql = getTestDb();
    await sql`UPDATE connections SET deleted_at = NOW() WHERE id = ${deletedConn.id}`;

    orgEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: orgConn.id,
        content: 'branch org event',
      })
    ).id;
    alicePrivateEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: alicePriv.id,
        content: 'branch alice-private event',
      })
    ).id;
    bobPrivateEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: bobPriv.id,
        content: 'branch bob-private event',
      })
    ).id;
    // System event: connection_id IS NULL. Must always be visible.
    systemEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: undefined,
        content: 'branch system event',
      })
    ).id;
    // Event from a soft-deleted connection. Must always be hidden, even
    // though the connection is org-visible and Alice owns it.
    deletedConnEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: deletedConn.id,
        content: 'branch deleted-conn event',
      })
    ).id;
  });

  // Branch-shape descriptors: `args` carry only the bits that select a branch
  // (content_ids → content_ids; include_superseded → include_superseded;
  // score → sort_by='score'). Visibility tests assert the same predicate
  // across all three.
  const BRANCH_CASES = [
    {
      branch: 'content_ids',
      makeArgs: (eventIds: number[]) => ({
        entity_id: undefined as number | undefined,
        content_ids: eventIds,
        limit: 100,
      }),
      // content_ids needs the explicit ID set so we pass all candidate IDs.
      includesAllByDefault: false,
    },
    {
      branch: 'include_superseded',
      makeArgs: (_eventIds: number[]) => ({
        entity_id: 'ENTITY' as const,
        include_superseded: true,
        limit: 100,
      }),
      includesAllByDefault: true,
    },
    {
      branch: 'score',
      makeArgs: (_eventIds: number[]) => ({
        entity_id: 'ENTITY' as const,
        sort_by: 'score' as const,
        limit: 100,
      }),
      includesAllByDefault: true,
    },
  ];

  function buildArgs(spec: (typeof BRANCH_CASES)[number], allEventIds: number[]) {
    const args = spec.makeArgs(allEventIds) as Record<string, unknown>;
    if (args.entity_id === 'ENTITY') {
      args.entity_id = entity.id;
    }
    return args;
  }

  it.each(BRANCH_CASES)(
    "$branch: authed user does not see another user's private events",
    async (spec) => {
      const allIds = [orgEventId, alicePrivateEventId, bobPrivateEventId, systemEventId];
      const result = await getContent(
        buildArgs(spec, allIds) as never,
        {} as never,
        authedCtx(aliceUser.id)
      );
      const visibleIds = new Set(result.content.map((c) => c.id));

      expect(visibleIds.has(orgEventId)).toBe(true);
      expect(visibleIds.has(alicePrivateEventId)).toBe(true);
      expect(visibleIds.has(bobPrivateEventId)).toBe(false);
    }
  );

  it.each(BRANCH_CASES)(
    '$branch: events with connection_id IS NULL (system events) are visible to authed callers',
    async (spec) => {
      const allIds = [orgEventId, alicePrivateEventId, bobPrivateEventId, systemEventId];
      const result = await getContent(
        buildArgs(spec, allIds) as never,
        {} as never,
        authedCtx(aliceUser.id)
      );
      const visibleIds = new Set(result.content.map((c) => c.id));

      expect(visibleIds.has(systemEventId)).toBe(true);
    }
  );

  it.each(BRANCH_CASES)(
    '$branch: unauthed caller sees only org-visible + system events; private events hidden',
    async (spec) => {
      // requireReadAccess (organization-access.ts:36-48) lets unauthed
      // callers read entities whose org matches ctx.organizationId, so all
      // three sibling branches are reachable from an unauthed test caller —
      // including include_superseded, which only requires entity_id.
      const allIds = [orgEventId, alicePrivateEventId, bobPrivateEventId, systemEventId];
      const result = await getContent(
        buildArgs(spec, allIds) as never,
        {} as never,
        unauthedCtx()
      );
      const visibleIds = new Set(result.content.map((c) => c.id));

      expect(visibleIds.has(orgEventId)).toBe(true);
      expect(visibleIds.has(systemEventId)).toBe(true);
      expect(visibleIds.has(alicePrivateEventId)).toBe(false);
      expect(visibleIds.has(bobPrivateEventId)).toBe(false);
    }
  );

  it.each(BRANCH_CASES)(
    '$branch: events from soft-deleted connections are excluded',
    async (spec) => {
      const allIds = [
        orgEventId,
        alicePrivateEventId,
        bobPrivateEventId,
        systemEventId,
        deletedConnEventId,
      ];
      const result = await getContent(
        buildArgs(spec, allIds) as never,
        {} as never,
        authedCtx(aliceUser.id)
      );
      const visibleIds = new Set(result.content.map((c) => c.id));

      expect(visibleIds.has(deletedConnEventId)).toBe(false);
      // Sanity: the visible-and-allowed events still show up.
      expect(visibleIds.has(orgEventId)).toBe(true);
      expect(visibleIds.has(systemEventId)).toBe(true);
    }
  );

  it('content_ids branch: total count mirrors visible set, not requested set', async () => {
    const result = await getContent(
      {
        entity_id: entity.id,
        content_ids: [orgEventId, alicePrivateEventId, bobPrivateEventId, systemEventId],
        limit: 100,
      } as never,
      {} as never,
      authedCtx(aliceUser.id)
    );
    // Alice asked for 4 ids; Bob's private one filters out → 3 remain.
    expect(result.total).toBe(3);
    expect(result.content).toHaveLength(3);
  });

  it('score branch: total count matches list cardinality (no leak via count path)', async () => {
    const result = await getContent(
      {
        entity_id: entity.id,
        sort_by: 'score',
        limit: 100,
      } as never,
      {} as never,
      authedCtx(aliceUser.id)
    );
    expect(result.total).toBe(result.content.length);
    const visibleIds = new Set(result.content.map((c) => c.id));
    expect(visibleIds.has(bobPrivateEventId)).toBe(false);
    expect(visibleIds.has(deletedConnEventId)).toBe(false);
  });
});

describe('getContent > visibility on the search / query path', () => {
  // Pi-CLI flagged this as a live security regression: searchContentBySingleQuery
  // (the hybrid text + vector path) was scanning current_event_records without the
  // visibility predicate. Any get_content call with `query` set leaked private
  // events from other users into both the result set and the total count.
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let aliceUser: Awaited<ReturnType<typeof createTestUser>>;
  let bobUser: Awaited<ReturnType<typeof createTestUser>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;

  let orgEventId: number;
  let alicePrivateEventId: number;
  let bobPrivateEventId: number;
  let systemEventId: number;

  // A unique, easy-to-tsquery substring shared by every event so the text
  // search returns all of them when they're allowed.
  const SHARED_TOKEN = 'visibilityqueryprobe';

  function authedCtx(userId: string): ToolContext {
    return {
      organizationId: org.id,
      userId,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    };
  }

  function unauthedCtx(): ToolContext {
    return {
      organizationId: org.id,
      userId: null,
      memberRole: null,
      isAuthenticated: false,
      tokenType: 'anonymous',
      scopedToOrg: true,
      allowCrossOrg: false,
    };
  }

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Search Path Org' });
    aliceUser = await createTestUser({ email: 'alice-search@example.com' });
    bobUser = await createTestUser({ email: 'bob-search@example.com' });
    await addUserToOrganization(aliceUser.id, org.id, 'owner');
    await addUserToOrganization(bobUser.id, org.id, 'owner');

    entity = await createTestEntity({
      name: 'Search Path Entity',
      organization_id: org.id,
    });

    await createTestConnectorDefinition({
      key: 'search-path-connector',
      name: 'Search Path',
      organization_id: org.id,
    });

    const orgConn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'search-path-connector',
      entity_ids: [entity.id],
      visibility: 'org',
      created_by: aliceUser.id,
      display_name: 'Search-path org-visible',
    });
    const alicePriv = await createTestConnection({
      organization_id: org.id,
      connector_key: 'search-path-connector',
      entity_ids: [entity.id],
      visibility: 'private',
      created_by: aliceUser.id,
      display_name: 'Search-path alice-private',
    });
    const bobPriv = await createTestConnection({
      organization_id: org.id,
      connector_key: 'search-path-connector',
      entity_ids: [entity.id],
      visibility: 'private',
      created_by: bobUser.id,
      display_name: 'Search-path bob-private',
    });

    orgEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: orgConn.id,
        content: `${SHARED_TOKEN} org event`,
      })
    ).id;
    alicePrivateEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: alicePriv.id,
        content: `${SHARED_TOKEN} alice private event`,
      })
    ).id;
    bobPrivateEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: bobPriv.id,
        content: `${SHARED_TOKEN} bob private event`,
      })
    ).id;
    systemEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: undefined,
        content: `${SHARED_TOKEN} system event`,
      })
    ).id;
  });

  it('authed user query: another user\'s private events excluded from results AND total', async () => {
    const result = await getContent(
      {
        entity_id: entity.id,
        query: SHARED_TOKEN,
        limit: 100,
      } as never,
      {} as never,
      authedCtx(aliceUser.id)
    );
    const visibleIds = new Set(result.content.map((c) => c.id));

    expect(visibleIds.has(orgEventId)).toBe(true);
    expect(visibleIds.has(alicePrivateEventId)).toBe(true);
    expect(visibleIds.has(systemEventId)).toBe(true);
    expect(visibleIds.has(bobPrivateEventId)).toBe(false);

    // The bug-of-record: total used to count events the user couldn't see.
    expect(result.total).toBe(visibleIds.size);
  });

  it('authed user query (Bob): sees own private events, not Alice\'s', async () => {
    const result = await getContent(
      {
        entity_id: entity.id,
        query: SHARED_TOKEN,
        limit: 100,
      } as never,
      {} as never,
      authedCtx(bobUser.id)
    );
    const visibleIds = new Set(result.content.map((c) => c.id));

    expect(visibleIds.has(bobPrivateEventId)).toBe(true);
    expect(visibleIds.has(orgEventId)).toBe(true);
    expect(visibleIds.has(systemEventId)).toBe(true);
    expect(visibleIds.has(alicePrivateEventId)).toBe(false);
    expect(result.total).toBe(visibleIds.size);
  });

  it('unauthed query: sees only org + system events; private events hidden', async () => {
    const result = await getContent(
      {
        entity_id: entity.id,
        query: SHARED_TOKEN,
        limit: 100,
      } as never,
      {} as never,
      unauthedCtx()
    );
    const visibleIds = new Set(result.content.map((c) => c.id));

    expect(visibleIds.has(orgEventId)).toBe(true);
    expect(visibleIds.has(systemEventId)).toBe(true);
    expect(visibleIds.has(alicePrivateEventId)).toBe(false);
    expect(visibleIds.has(bobPrivateEventId)).toBe(false);
    expect(result.total).toBe(visibleIds.size);
  });

  it('total + result count both match across pagination on the search path', async () => {
    // Page through with offset to confirm total stays accurate when results
    // are paginated. (This is the score-sorted, offset-driven shape — distinct
    // from the chronological cursor-driven path tested elsewhere.)
    const ctx = authedCtx(aliceUser.id);
    const page1 = await getContent(
      {
        entity_id: entity.id,
        query: SHARED_TOKEN,
        limit: 2,
        offset: 0,
        sort_by: 'score',
      } as never,
      {} as never,
      ctx
    );
    expect(page1.total).toBe(3); // org + alicePrivate + system
    expect(page1.content.length).toBeLessThanOrEqual(2);

    const page2 = await getContent(
      {
        entity_id: entity.id,
        query: SHARED_TOKEN,
        limit: 2,
        offset: 2,
        sort_by: 'score',
      } as never,
      {} as never,
      ctx
    );
    expect(page2.total).toBe(3);

    const collected = new Set([
      ...page1.content.map((c) => c.id),
      ...page2.content.map((c) => c.id),
    ]);
    expect(collected.size).toBe(3);
    expect(collected.has(bobPrivateEventId)).toBe(false);
  });
});

describe('getContent > empty-entity short-circuit (perf regression guard)', () => {
  // pi CLI flagged the empty-entity case at 8.4s on real data even after
  // dropping the classification stats CTE. The dominant cost was the
  // enrichment chain — thread_meta (recursive), latest_classifications,
  // parent/root LEFT JOINs — all running BEFORE the planner discovered the
  // candidate set was empty. Fix: when the cheap count returns 0, skip the
  // enrichment query entirely. This pins both halves of the contract:
  //   1. Empty entity hits zero "heavy enrichment" SQL (the chain that
  //      contains `candidate_set`/`thread_meta`/`latest_classifications`).
  //   2. Non-empty entity still issues the enrichment query and returns
  //      content with the same shape as before.
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let emptyEntity: Awaited<ReturnType<typeof createTestEntity>>;
  let populatedEntity: Awaited<ReturnType<typeof createTestEntity>>;

  function ctx(): ToolContext {
    return {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    };
  }

  /**
   * Wrap `sql.unsafe` to capture the SQL text of every query issued during
   * the wrapped function's execution. Restores the original method on the
   * way out so subsequent tests aren't affected.
   */
  async function captureUnsafeSql<T>(fn: () => Promise<T>): Promise<{
    result: T;
    queries: string[];
  }> {
    type Client = {
      unsafe: (...args: unknown[]) => Promise<unknown>;
      begin: (...args: unknown[]) => Promise<unknown>;
    };
    const sql = getDb() as unknown as Client;
    const original = sql.unsafe.bind(sql);
    const originalBegin = sql.begin.bind(sql);
    const queries: string[] = [];
    const recording = (run: Client['unsafe']) =>
      ((query: string, ...rest: unknown[]) => {
        queries.push(query);
        return run(query, ...rest);
      }) as Client['unsafe'];
    sql.unsafe = recording(original);
    // A bounded read issues its statements on the transaction's own client.
    sql.begin = (...args: unknown[]) => {
      const run = args.pop() as (tx: Client) => Promise<unknown>;
      return originalBegin(...args, (tx: Client) => {
        tx.unsafe = recording(tx.unsafe.bind(tx));
        return run(tx);
      });
    };
    try {
      const result = await fn();
      return { result, queries };
    } finally {
      sql.unsafe = original;
      sql.begin = originalBegin;
    }
  }

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Perf Org' });
    user = await createTestUser({ email: 'perf@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    emptyEntity = await createTestEntity({
      name: 'Empty Perf Entity',
      organization_id: org.id,
    });
    populatedEntity = await createTestEntity({
      name: 'Populated Perf Entity',
      organization_id: org.id,
    });

    // Seed a single event on the populated entity so the non-empty branch
    // actually runs the enrichment query.
    await createTestEvent({
      organization_id: org.id,
      entity_id: populatedEntity.id,
      content: 'perf-test event with payload to enrich',
    });
  });

  it('empty entity: skips the heavy enrichment query (no candidate_set/thread_meta/latest_classifications scan)', async () => {
    const { result, queries } = await captureUnsafeSql(() =>
      getContent(
        { entity_id: emptyEntity.id, limit: 50, sort_by: 'date', sort_order: 'desc' } as never,
        {} as never,
        ctx()
      )
    );

    expect(result.content).toEqual([]);
    expect(result.total).toBe(0);

    // The hot enrichment query is identifiable by its CTE names. None of
    // them should appear in any SQL issued for an empty entity.
    const heavyQueries = queries.filter(
      (q) =>
        q.includes('candidate_set') ||
        q.includes('thread_meta') ||
        q.includes('latest_classifications')
    );
    expect(heavyQueries).toEqual([]);
  });

  it('populated entity: still issues the enrichment query and returns full content shape', async () => {
    const { result, queries } = await captureUnsafeSql(() =>
      getContent(
        { entity_id: populatedEntity.id, limit: 50, sort_by: 'date', sort_order: 'desc' } as never,
        {} as never,
        ctx()
      )
    );

    expect(result.total).toBe(1);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].payload_text).toContain('perf-test event');

    // The enrichment query MUST fire for non-empty results — pin it so a
    // future refactor that "optimizes" by skipping enrichment universally
    // doesn't silently regress the response shape.
    const heavyQueries = queries.filter(
      (q) => q.includes('candidate_set') || q.includes('thread_meta')
    );
    expect(heavyQueries.length).toBeGreaterThan(0);
  });
});

describe('getContent > source attribution fields across query branches', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;
  let eventId: number;
  let feedId: number;
  let connId: number;

  function ctx(userId: string): ToolContext {
    return {
      organizationId: org.id,
      userId,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    };
  }

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Attribution Org' });
    user = await createTestUser({ email: 'attr@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    entity = await createTestEntity({
      name: 'Attribution Entity',
      organization_id: org.id,
    });

    await createTestConnectorDefinition({
      key: 'attr-test-connector',
      name: 'Attr Test',
      organization_id: org.id,
    });

    const conn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'attr-test-connector',
      visibility: 'org',
      created_by: user.id,
    });
    connId = conn.id;

    const sql = getTestDb();
    // Feed row the event is attributed to; display_name feeds the join.
    const [feed] = await sql`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, display_name, created_at)
      VALUES (${org.id}, ${connId}, 'home_feed', 'active', 'Attr Home Feed', NOW())
      RETURNING id
    `;
    feedId = feed.id as number;

    // Automation (automations) + the version whose name we attribute to.
    const automationId = 900001;
    await sql`
      INSERT INTO automations (
        id, name, slug, organization_id, entity_ids, schedule, timezone,
        next_run_at, managed_agent_id, model_config, sources, version, tags, status,
        created_by, created_at, updated_at, automation_group_id, triggers
      ) VALUES (
        ${automationId}, 'Attribution Automation', 'attribution-automation',
        ${org.id}, '{}'::bigint[], '0 9 * * *', 'Europe/London', NOW(),
        'attr-agent', '{}'::jsonb, '[]'::jsonb, 1, '{}'::text[],
        'active', ${user.id}, NOW(), NOW(), ${automationId}, '[]'::jsonb
      )
    `;
    const [version] = await sql`
      INSERT INTO automation_versions (
        automation_id, version, name, created_by, prompt, created_at
      ) VALUES (
        ${automationId}, 1, 'Attribution Automation', ${user.id}, 'prompt', NOW()
      )
      RETURNING id
    `;
    const versionId = version.id as number;
    await sql`
      UPDATE automations SET current_version_id = ${versionId} WHERE id = ${automationId}
    `;

    const ev = await createTestEvent({
      entity_id: entity.id,
      connection_id: connId,
      feed_id: feedId,
      feed_key: 'home_feed',
      automation_id: automationId,
      automation_version_id: versionId,
      connector_key: 'attr-test-connector',
      title: 'Attribution event',
      content: 'attribution unique marker payload for source row',
      embedding: Array.from({ length: 768 }, () => Math.random()),
    });
    eventId = ev.id;

    // Divergence probe: bump the automation's CURRENT version after the event was
    // produced. Attribution must keep the producing version's name (version 1,
    // 'Attribution Automation'), not the current version's ('Renamed Automation').
    const [v2] = await sql`
      INSERT INTO automation_versions (
        automation_id, version, name, created_by, prompt, created_at
      ) VALUES (
        ${automationId}, 2, 'Renamed Automation', ${user.id}, 'prompt', NOW()
      )
      RETURNING id
    `;
    await sql`
      UPDATE automations SET current_version_id = ${v2.id} WHERE id = ${automationId}
    `;
  });

  it('carries connection/feed/automation attribution through every branch', async () => {
    const branches = [
      { name: 'list/date', args: { entity_id: entity.id, limit: 100, sort_by: 'date', sort_order: 'desc' } },
      { name: 'content_ids', args: { content_ids: [eventId], limit: 100 } },
      { name: 'include_superseded', args: { entity_id: entity.id, include_superseded: true, limit: 100 } },
      { name: 'score', args: { entity_id: entity.id, sort_by: 'score', limit: 100 } },
      { name: 'search', args: { entity_id: entity.id, query: 'attribution', limit: 100 } },
    ];

    for (const branch of branches) {
      const result = await getContent(branch.args as never, {} as never, ctx(user.id));
      const item = result.content.find((c) => c.id === eventId);
      expect(item, `${branch.name} should surface the attributed event`).toBeTruthy();
      expect(item!.connection_id, `${branch.name}: connection_id`).toBe(connId);
      expect(item!.feed_id, `${branch.name}: feed_id`).toBe(feedId);
      expect(item!.feed_key, `${branch.name}: feed_key`).toBe('home_feed');
      expect(item!.feed_name, `${branch.name}: feed_name`).toBe('Attr Home Feed');
      expect(item!.automation_id, `${branch.name}: automation_id`).toBe(900001);
      expect(item!.automation_name, `${branch.name}: automation_name`).toBe('Attribution Automation');
    }
  });

  it('names version-less automation events without internal vocabulary', async () => {
    const sql = getTestDb();
    // automation_id set, automation_version_id NULL — historical rows pre-versioning.
    const ev = await createTestEvent({
      entity_id: entity.id,
      connection_id: connId,
      automation_id: 900001,
      connector_key: 'attr-test-connector',
      title: 'Versionless automation event',
      content: 'versionless marker payload',
      embedding: Array.from({ length: 768 }, () => Math.random()),
    });
    const result = await getContent(
      { entity_id: entity.id, limit: 100, sort_by: 'date', sort_order: 'desc' } as never,
      {} as never,
      ctx(user.id)
    );
    const item = result.content.find((c) => c.id === ev.id);
    expect(item, 'versionless event should surface').toBeTruthy();
    expect(item!.automation_id).toBe(900001);
    // No producing version to name it — fall back to the automation's own
    // name, never a bare id label.
    expect(item!.automation_name).toBe('Attribution Automation');
    expect(item!.automation_name).not.toContain('automation');
  });
});
