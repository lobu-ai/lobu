/**
 * Regression: `search_memory` must not silently lie about what it recalled.
 *
 * THREE defects were reproduced and fixed on this branch, all in the
 * agent-facing memory READ hot path (`tools/search.ts`):
 *
 *  A. The `content` facet vanished entirely (key absent) whenever the recall
 *     produced zero rows, so an agent could not distinguish "nothing matched"
 *     from "content search never ran".
 *  B. `min_similarity` was INERT. `fetchContentSnippets` hardcoded 0.4 and
 *     discarded the caller's value, and the entity fuzzy-name predicate
 *     hardcoded `similarity(...) > 0.3` and never read `args.min_similarity`
 *     at all — so the documented 0.0-1.0 knob changed nothing on EITHER path
 *     it claims to govern. Both now read the caller's value.
 *  C. A valid `agent_id` was applied as an ENTITY metadata filter, so an
 *     exact-name lookup for an entity that DOES exist returned `not_found`
 *     plus coaching to call `client.entities.create()` — turning a read-filter
 *     into duplicate writes.
 *
 * NOT a defect, but pinned here anyway: content-snippet ORDERING. An earlier
 * pass on this branch claimed `content_limit` truncated an unsorted set. That
 * was WRONG — `fetchContentSnippets` already passes `sort_by: 'score'` on
 * `origin/main`, and the "red" run that appeared to prove it actually failed on
 * an uninitialized WorkspaceProvider in the harness, not on the ordering. The
 * ordering test below is retained as a genuine regression guard (nothing else
 * pins that `sort_by`), but it guards semantics that was never broken and must
 * not be described as a fix.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { search } from '../../../tools/search';
import { saveContent } from '../../../tools/save_content';
import { getDb } from '../../../db/client';
import type { Env } from '../../../index';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
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

const EMBEDDING_DIM = 768;

/**
 * A unit vector in the 0/1 plane at `angle` radians from axis 0. The query is
 * angle 0, so cosine similarity against the query is exactly cos(angle) —
 * letting each fixture event be given an EXACT, known similarity score.
 */
function planeVec(angle: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[0] = Math.cos(angle);
  v[1] = Math.sin(angle);
  return v;
}

/** Similarity → the angle that produces it. */
const atSimilarity = (sim: number) => planeVec(Math.acos(sim));

describe('search_memory > recall contract', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let ctx: ToolContext;
  const env = {} as Env;
  const queryEmbedding = planeVec(0);

  // Six low-scoring decoys (~0.54) and two strong hits (~0.80) — the exact
  // shape of the prod "Cognitive Links" reproduction, where content_limit:6
  // returned only the six 0.54 rows and the two 0.80 rows appeared at ranks
  // 7-8 only once content_limit was raised to 12.
  const STRONG_SIM = 0.8;
  const WEAK_SIM = 0.54;
  const strongIds: number[] = [];
  let exactMemoryId: number;

  // Fuzzy-name fixture for the ENTITY-side min_similarity floor. Nonsense words
  // so nothing else in the org can match them. Trigram similarities against
  // FUZZY_QUERY were MEASURED against this schema's pg_trgm, not guessed:
  //   NEAR_NAME 0.75, MID_NAME 0.56.
  // Both are invisible to the other three arms of the fuzzy OR (LIKE-substring,
  // exact equality, websearch_to_tsquery), so only similarity() can admit them.
  const FUZZY_QUERY = 'Zarquon Bittersweet';
  const NEAR_NAME = 'Zarquonn Bittersweett';
  const MID_NAME = 'Zarqu0n Bttersweet';

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    await initWorkspaceProvider();

    org = await createTestOrganization({ name: 'Recall Contract Org' });
    user = await createTestUser({ email: 'recall-contract@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    const entity = await createTestEntity({
      name: 'Cognitive Links',
      organization_id: org.id,
    });

    for (const name of [NEAR_NAME, MID_NAME]) {
      await createTestEntity({ name, organization_id: org.id });
    }

    await createTestConnectorDefinition({
      key: 'recall-test-connector',
      name: 'Recall Test',
      organization_id: org.id,
    });
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'recall-test-connector',
      entity_ids: [entity.id],
    });

    // Six weak decoys first (older), then the two strong hits.
    for (let i = 0; i < 6; i++) {
      await createTestEvent({
        entity_id: entity.id,
        connection_id: connection.id,
        content: `Weak decoy note number ${i}`,
        occurred_at: new Date(`2025-04-0${i + 1}T10:00:00Z`),
        organization_id: org.id,
        embedding: atSimilarity(WEAK_SIM),
      });
    }
    for (let i = 0; i < 2; i++) {
      const ev = await createTestEvent({
        entity_id: entity.id,
        connection_id: connection.id,
        content: `Strong match about cognitive links ${i}`,
        occurred_at: new Date(`2025-04-1${i}T10:00:00Z`),
        organization_id: org.id,
        embedding: atSimilarity(STRONG_SIM),
      });
      strongIds.push(ev.id);
    }

    const exactMemory = await createTestEvent({
      entity_id: entity.id,
      connection_id: connection.id,
      content: 'Exact reviewer checklist memory',
      organization_id: org.id,
    });
    exactMemoryId = exactMemory.id;

    // The fixture user is an org OWNER (see addUserToOrganization above), and
    // the empty-result guidance is tier-aware, so the shared context must carry
    // the role it actually has.
    ctx = {
      organizationId: org.id,
      userId: user.id,
      tokenType: 'session',
      memberRole: 'owner',
    } as ToolContext;
  });

  it('opens an exact content id from reviewer-style "memory <id>" language', async () => {
    const result = await search(
      {
        title: '  Exact memory heading  ',
        query: 'memory ' + exactMemoryId,
        include_content: true,
      },
      env,
      ctx
    );

    expect(result.discovery_status).toBe('complete');
    expect(result.title).toBe('Exact memory heading');
    expect(result.content?.map((item) => item.id)).toContain(exactMemoryId);
    expect(result.content?.find((item) => item.id === exactMemoryId)?.text_content).toBe(
      'Exact reviewer checklist memory'
    );
    expect(result.suggestion ?? '').not.toContain('entities.create');
  });

  it('suggests text-search wording when an exact content id is not readable', async () => {
    const result = await search(
      {
        query: '2147483647',
        include_content: true,
      },
      env,
      ctx
    );

    expect(result.discovery_status).toBe('not_found');
    expect(result.suggestion).toBe(
      'No readable memory record matches id 2147483647 in this workspace. ' +
        'To run a text search instead, add words around the number.'
    );
  });

  // ── ORDERING GUARD (never-broken semantics, pinned) ──────────────────────
  it('sorts content by similarity DESC so content_limit truncates the WORST, not the best', async () => {
    const result = await search(
      {
        query: 'cognitive links',
        query_embedding: queryEmbedding,
        include_content: true,
        content_limit: 2,
        min_similarity: 0.3,
      },
      env,
      ctx
    );

    const sims = (result.content ?? []).map((c) => Number(c.similarity));
    // Monotonically non-increasing — the ordering contract itself.
    for (let i = 1; i < sims.length; i++) {
      expect(sims[i - 1]).toBeGreaterThanOrEqual(sims[i]);
    }
    // A limit of 2 against 8 candidates must return the two BEST, never two
    // of the six 0.54 decoys.
    const ids = (result.content ?? []).map((c) => c.id);
    expect(ids.sort()).toEqual([...strongIds].sort());
  });

  // ── DEFECT A ────────────────────────────────────────────────────────────
  it('always emits the content facet when include_content is true, even with zero hits', async () => {
    // A query that matches NOTHING — neither lexically nor by vector. This is
    // the shape that produced the prod symptom: the response carried no
    // `content` key at all, so the agent could not tell recall had run.
    const result = await search(
      {
        query: 'zzzz-nonexistent-topic-qqqq',
        include_content: true,
        content_limit: 5,
        min_similarity: 0.3,
      },
      env,
      ctx
    );

    // The KEY must be present. Absent-vs-empty is the whole defect: an agent
    // on the JSON path reads a missing key as "recall never ran" and answers
    // from nothing.
    expect(result).toHaveProperty('content');
    expect(Array.isArray(result.content)).toBe(true);
  });

  // ── DEFECT B (content path) ─────────────────────────────────────────────
  it('honors min_similarity as a real floor on recalled content', async () => {
    const common = {
      query: 'cognitive links',
      query_embedding: queryEmbedding,
      include_content: true,
      content_limit: 50,
    } as const;

    const permissive = await search({ ...common, min_similarity: 0.3 }, env, ctx);
    const strict = await search({ ...common, min_similarity: 0.7 }, env, ctx);

    // 0.3 admits the 0.54 decoys AND the 0.80 hits; 0.7 excludes the decoys.
    // Before the fix both calls returned the identical 8 rows, because the
    // floor was hardcoded to 0.4 and the caller's value was discarded.
    expect((permissive.content ?? []).length).toBeGreaterThan(
      (strict.content ?? []).length
    );
    // Every row the strict call kept clears the requested vector floor. (A
    // lexical hit can still enter on the text branch of the hybrid match — the
    // floor governs the VECTOR branch — so assert on the vector-matched set.)
    expect((strict.content ?? []).map((c) => c.id).sort()).toEqual(
      [...strongIds].sort()
    );
    for (const c of strict.content ?? []) {
      expect(Number(c.similarity)).toBeGreaterThanOrEqual(0.7);
    }

    // Omitting the arg must equal an explicit 0.3. `fetchContentSnippets`
    // forwards `undefined` rather than re-defaulting, so this pins that the
    // ONE surviving copy of the constant (search-path.ts) is the documented
    // one. Note 0.3 vs the old hardcoded 0.4 is itself observable here: the
    // 0.54 decoys clear 0.3 and 0.4 alike, but the constant is now single-
    // sourced instead of duplicated.
    const defaulted = await search({ ...common }, env, ctx);
    expect((defaulted.content ?? []).map((c) => c.id).sort()).toEqual(
      (permissive.content ?? []).map((c) => c.id).sort()
    );
  });

  // ── DEFECT B (entity fuzzy-name path) ───────────────────────────────────
  it('honors min_similarity as a real floor on fuzzy ENTITY name matching', async () => {
    const common = {
      query: FUZZY_QUERY,
      fuzzy: true,
      include_content: false,
      limit: 50,
    } as const;

    const permissive = await search({ ...common, min_similarity: 0.3 }, env, ctx);
    const strict = await search({ ...common, min_similarity: 0.7 }, env, ctx);

    const namesOf = (r: Awaited<ReturnType<typeof search>>) =>
      (r.matches ?? []).map((m) => m.name).sort();

    // Measured trigram similarities against FUZZY_QUERY (pg_trgm, this schema):
    //   NEAR_NAME  0.75  — clears BOTH floors
    //   MID_NAME   0.56  — clears 0.3, must be CUT by 0.7
    // Both names are built so the trigram arm is the ONLY arm that can admit
    // them: neither is a substring of the query nor the query a substring of
    // them (LIKE '%…%' false), neither equals it, and neither shares an English
    // lexeme with it (websearch_to_tsquery false). So a change in the result set
    // is attributable to the similarity() threshold and nothing else.
    expect(namesOf(permissive)).toEqual([MID_NAME, NEAR_NAME].sort());

    // THE BITE: before the fix this predicate was hardcoded `similarity(...) >
    // 0.3` and never read args.min_similarity, so raising the floor to 0.7
    // returned the identical two rows.
    expect(namesOf(strict)).toEqual([NEAR_NAME]);
    expect(namesOf(strict).length).toBeLessThan(namesOf(permissive).length);

    // OMITTING min_similarity must behave as the schema's documented 0.3 —
    // this is what lets `fetchContentSnippets` forward `undefined` instead of
    // keeping its own copy of the constant. If either path ever stops applying
    // 0.3 on the omitted-value branch, this diverges from `permissive`.
    const defaulted = await search({ ...common }, env, ctx);
    expect(namesOf(defaulted)).toEqual(namesOf(permissive));

    // A non-empty strict result also proves the query itself still works —
    // the row count did not collapse to zero for some unrelated reason, and
    // the zero-result fallback expansion (searchImpl) never had to fire.
    expect(strict.matches?.length).toBe(1);
  });

  // ── DEFECT C ────────────────────────────────────────────────────────────
  it('does not let agent_id filter ENTITY resolution into a false not_found', async () => {
    const result = await search(
      {
        query: 'Cognitive Links',
        fuzzy: false,
        include_content: false,
        agent_id: 'some-agent-id',
      },
      env,
      ctx
    );

    // The entity exists. Returning not_found here is what drove agents to
    // call client.entities.create() and write a duplicate.
    expect(result.discovery_status).toBe('complete');
    expect(result.entity?.name).toBe('Cognitive Links');
    expect(result.suggestion ?? '').not.toContain('entities.create');
  });

  // ── Accepted-vs-advertised coherence ────────────────────────────────────
  it('does not advertise server-internal args in its unknown-argument error', async () => {
    const err = await search(
      { query: 'Cognitive Links', not_a_real_arg: 1 } as never,
      env,
      ctx
    ).catch((e: Error) => e.message);

    // The error must enumerate the PUBLIC surface only. Naming these here is
    // how an agent discovered args that `tools/list` deliberately hides.
    expect(err).toContain('unknown argument(s): not_a_real_arg');
    expect(err).not.toContain('query_embedding');
    expect(err).not.toContain('agent_id');
    // …while still listing the genuinely public ones.
    expect(err).toContain('min_similarity');
  });

  // ── Actionable read guidance on empty results ───────────────────────────
  it('provides actionable read steps in suggestion when search finds no results', async () => {
    const result = await search(
      {
        query: 'nonexistent-query-for-empty-guidance',
        entity_type: 'ticket',
        include_content: true,
      },
      env,
      ctx
    );

    expect(result.discovery_status).toBe('not_found');
    expect(result.matches).toEqual([]);
    expect(result.content ?? []).toEqual([]);

    const suggestion = result.suggestion ?? '';
    expect(suggestion).toContain('No matches found for "nonexistent-query-for-empty-guidance"');
    expect(suggestion).toContain('Additional steps to read relevant data:');
    expect(suggestion).toContain('client.feeds.readMany');
    expect(suggestion).toContain('query_sql');
    expect(suggestion).toContain('audit');
    expect(suggestion).toContain("remove entity_type='ticket'");
    expect(suggestion).toContain('min_similarity');
    expect(suggestion).toContain('save_memory');
    expect(suggestion).toContain('client.entities.create');
  });

  it('reports memory content recalled without entity-create coaching when recall matches', async () => {
    await createTestEvent({
      organization_id: org.id,
      title: 'Infrastructure migration notes',
      content: 'Discussion on database migration and deployment infrastructure roadmap',
    });

    const result = await search(
      {
        query: 'deployment infrastructure roadmap',
        fuzzy: false,
        include_content: true,
      },
      env,
      ctx
    );

    expect(result.discovery_status).toBe('complete');
    expect(result.matches).toEqual([]);
    expect(result.content?.length).toBeGreaterThan(0);
    expect(result.suggestion).toContain('related memory content was recalled below');
    expect(result.suggestion).not.toContain('entities.create');
  });

  // Its own org, so a read-capable feed cannot leak into `coverage` for the
  // cases above and test order stays irrelevant. The step-1 wording asserted
  // earlier is the no-feeds variant because THIS suite's main fixture
  // connector declares no feeds_schema, not because this case runs last.
  it('names the discovered source feeds and their feed_id when the org has read-capable feeds', async () => {
    const feedOrg = await createTestOrganization({ name: 'Recall Feed Coverage Org' });
    const feedUser = await createTestUser({ email: 'recall-feed-coverage@example.com' });
    await addUserToOrganization(feedUser.id, feedOrg.id, 'owner');
    await createTestConnectorDefinition({
      key: 'readable-feed-connector',
      name: 'Readable Feed',
      organization_id: feedOrg.id,
      feeds_schema: { default: { operations: ['read', 'sync'] } },
    });
    await createTestConnection({
      organization_id: feedOrg.id,
      connector_key: 'readable-feed-connector',
      slug: 'readable-feed',
    });

    const result = await search(
      { query: 'zzzz-no-such-thing-with-feeds-present' },
      env,
      {
        organizationId: feedOrg.id,
        userId: feedUser.id,
        tokenType: 'session',
      } as ToolContext
    );

    const discovered = result.coverage?.source_feeds ?? [];
    expect(discovered.map((feed) => feed.connection_slug)).toContain('readable-feed');

    const suggestion = result.suggestion ?? '';
    // The feeds-present branch must name the handle `feeds.readMany` actually
    // keys on, not just the human-readable slug/key pair.
    expect(suggestion).toContain('Check unqueried source feeds');
    expect(suggestion).toContain('`readable-feed/default`');
    expect(suggestion).toContain('feed_id');
    expect(suggestion).toContain('client.feeds.readMany({ reads: [{ feed_id }] })');
  });

  // ── Tier-aware persist guidance ─────────────────────────────────────────
  // `entitySchema.createType` is admin-tier, `entities.create` is write, and
  // `run_sdk`/`save_memory` are write-tier. The guidance must name only what
  // the caller can reach. The admin and member variants both still name
  // `entities.create`, which is why the general empty-result case above cannot
  // tell those two apart.
  it('offers createType only to an admin-tier caller', async () => {
    const result = await search(
      { query: 'zzzz-tier-probe-admin' },
      env,
      {
        organizationId: org.id,
        userId: user.id,
        tokenType: 'session',
        memberRole: 'owner',
        scopes: ['*'],
      } as ToolContext
    );

    const suggestion = result.suggestion ?? '';
    expect(suggestion).toContain('client.entitySchema.createType(...)');
    expect(suggestion).not.toContain('needs admin access');
  });

  it('sends a member to the existing types instead of a call that would deny', async () => {
    const result = await search(
      { query: 'zzzz-tier-probe-member' },
      env,
      {
        organizationId: org.id,
        userId: user.id,
        tokenType: 'session',
        memberRole: 'member',
        scopes: ['*'],
      } as ToolContext
    );

    const suggestion = result.suggestion ?? '';
    expect(suggestion).not.toContain('client.entitySchema.createType(...)');
    expect(suggestion).toContain('Creating a brand-new entity type needs admin access');
    // The reachable half is still offered — a member CAN create an entity of a
    // type that already exists.
    expect(suggestion).toContain('client.entitySchema.listTypes()');
    expect(suggestion).toContain('client.entities.create');
  });

  it('names the boundary instead of write calls for a read-only caller', async () => {
    const result = await search(
      { query: 'zzzz-tier-probe-read' },
      env,
      {
        organizationId: org.id,
        userId: user.id,
        tokenType: 'session',
        memberRole: 'member',
        scopes: ['mcp:read'],
      } as ToolContext
    );

    const suggestion = result.suggestion ?? '';
    // The read steps above the persist block stay — they are all read-tier.
    expect(suggestion).toContain('Additional steps to read relevant data:');
    expect(suggestion).toContain('this caller has read-only access to the workspace');
    expect(suggestion).not.toContain('client.entities.create');
    expect(suggestion).not.toContain('client.entitySchema.createType(...)');
  });
  // An automation reaction has no user identity, so the tier resolver floors it
  // at read — but `save_content` bypasses its write gate for exactly this
  // context (`isSystemContext`), so read-only copy would be a lie to a caller
  // that CAN persist. It gets the write-tier block, minus the admin-only hop.
  it('does not call an in-process system caller read-only when it can write', async () => {
    const result = await search(
      { query: 'zzzz-tier-probe-system' },
      env,
      {
        organizationId: org.id,
        userId: null,
        memberRole: null,
        isAuthenticated: true,
        tokenType: 'session',
        scopes: ['*'],
      } as ToolContext
    );

    const suggestion = result.suggestion ?? '';
    expect(suggestion).not.toContain('this caller has read-only access to the workspace');
    expect(suggestion).toContain('save_memory');
    expect(suggestion).toContain('client.entities.create');
    // Still not admin: type creation stays behind the admin gate.
    expect(suggestion).not.toContain('client.entitySchema.createType(...)');
  });
  /**
   * The round trip an agent actually performs: save a memory through the tool,
   * then recall it. `search_memory` fences content recall to
   * `events.metadata->>'agent_id' = ctx.agentId`, and `ContentSearchFilters`
   * documents that axis as "populated automatically by Lobu-owned save paths"
   * — so the save path has to be the thing that stamps it.
   *
   * It did not. Only the memory plugin's auto-capture passed `agent_id` as
   * caller metadata, so a model's own `save_memory` call landed with `{}` and
   * the agent could not recall what it had just written. Live symptom: a PAT
   * search found the row, the agent's own search returned `content: []`.
   */
  it('recalls a memory the calling agent saved through the tool', async () => {
    const agentCtx = {
      organizationId: org.id,
      userId: user.id,
      agentId: 'recall-contract-agent',
      tokenType: 'session',
      memberRole: 'owner',
      isAuthenticated: true,
      scopes: ['*'],
    } as ToolContext;

    const saved = await saveContent(
      {
        content: 'Zaphod prefers the second-best coffee on deck seven',
        semantic_type: 'observation',
      },
      env,
      agentCtx
    );
    expect(saved.id).toBeGreaterThan(0);

    const recalled = await search(
      { query: 'second-best coffee deck seven', include_content: true },
      env,
      agentCtx
    );

    expect(recalled.content?.map((c) => c.id)).toContain(saved.id);
  });

  /**
   * The other half of the fence: the stamp must scope to the agent that wrote
   * the row, not merely exist. A different agent recalling the same query must
   * not see it, or the fix would have widened memory across agents instead of
   * making one agent's own memory reachable.
   */
  it('does not leak an agent-saved memory to a different agent', async () => {
    const writer = {
      organizationId: org.id,
      userId: user.id,
      agentId: 'memory-writer-agent',
      tokenType: 'session',
      memberRole: 'owner',
      isAuthenticated: true,
      scopes: ['*'],
    } as ToolContext;

    const saved = await saveContent(
      {
        content: 'Marvin catalogued the diodes on his left side',
        semantic_type: 'observation',
      },
      env,
      writer
    );

    const other = await search(
      { query: 'diodes left side catalogue', include_content: true },
      env,
      { ...writer, agentId: 'memory-reader-agent' } as ToolContext
    );

    expect(other.content?.map((c) => c.id) ?? []).not.toContain(saved.id);
  });
  /**
   * The control for the stamp: an UNBOUND caller (a PAT, a session, an
   * automation with no agent) must leave `metadata.agent_id` unset. Workspace
   * nouns and connector ingest have no writing agent, so stamping one would
   * put ordinary org writes inside some agent's private recall scope and hide
   * them from everyone else.
   *
   * Worth pinning because `proxy-rest-routes.ts` derives its own routing id as
   * `tokenData.agentId || tokenData.userId`. That fallback is for MCP session
   * keying only — `ToolContext.agentId` comes from `tokenData.agentId` alone
   * (`multi-tenant.ts`) — and this test fails loudly if the two are ever
   * conflated, which would file a user id as an agent scope.
   */
  it('leaves the memory scope unset for a caller with no bound agent', async () => {
    const saved = await saveContent(
      {
        content: 'Trillian logged the improbability drive readings',
        semantic_type: 'observation',
      },
      env,
      {
        organizationId: org.id,
        userId: user.id,
        tokenType: 'pat',
        memberRole: 'owner',
        isAuthenticated: true,
        scopes: ['*'],
      } as ToolContext
    );

    const [row] = await getDb()`
      SELECT metadata FROM events WHERE id = ${saved.id}
    `;
    expect((row?.metadata as Record<string, unknown>)?.agent_id).toBeUndefined();
  });
});
