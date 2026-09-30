/**
 * `manage_classifiers classify` is the only writer of `event_classifications`.
 * These pin its contract:
 *
 * - `is_manual` is derived from `source` (only a `user` label is manual), so
 *   `source='llm'` has one meaning.
 * - `source` follows the acting principal: an Automation or agent writes
 *   `llm` and cannot claim `user`.
 * - a per-item `confidence` is stored as `confidences[value]`; without one a
 *   `user` label stores 1 and an `llm` label stays unscored (`{}`).
 * - `value: null` UNSETS the caller's label. It used to insert `'{}'`, which
 *   violates `event_classifications_values_not_empty`.
 * - a call made by an Automation reaction records that Automation and run, and
 *   the labels are readable through `read_knowledge` with read-time precedence.
 * - the read path resolves a classifier slug inside the caller's organization
 *   only.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { compileReactionScript, executeReaction } from '../../../automations/reaction-executor';
import { parsePgTextArray } from '../../../db/client';
import { manageClassifiers } from '../../../tools/admin/manage_classifiers';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  ownerToolContext,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const ATTRIBUTE_VALUES = {
  positive: { description: 'Positive', examples: ['great'] },
  negative: { description: 'Negative', examples: ['awful'] },
};

async function seed(): Promise<{ orgId: string; userId: string; ctx: ToolContext }> {
  await cleanupTestDatabase();
  await seedSystemEntityTypes();
  const org = await createTestOrganization({ name: 'Classify Contract Org' });
  const user = await createTestUser({ email: 'classify-contract@test.example.com' });
  await addUserToOrganization(user.id, org.id, 'owner');
  const ctx = ownerToolContext(org.id, user.id);
  const sql = getTestDb();
  await sql`
    INSERT INTO classify_facet (organization_id, slug, name, attribute_key, status, created_by, attribute_values)
    VALUES (${org.id}, 'sentiment', 'Sentiment', 'sentiment', 'active', ${user.id}, ${sql.json(ATTRIBUTE_VALUES)})
  `;
  return { orgId: org.id, userId: user.id, ctx };
}

type LabelRow = {
  values: unknown;
  confidences: Record<string, number>;
  source: string;
  is_manual: boolean;
  automation_id: number | null;
  run_id: number | null;
};

async function labels(eventId: number): Promise<LabelRow[]> {
  const sql = getTestDb();
  return (await sql`
    SELECT "values", confidences, source, is_manual, automation_id, run_id
    FROM event_classifications WHERE event_id = ${eventId}
    ORDER BY source
  `) as unknown as LabelRow[];
}

describe('manage_classifiers classify contract', () => {
  beforeEach(async () => {
    await initWorkspaceProvider();
  });

  it('derives is_manual from source and stores the given confidence', async () => {
    const { orgId, ctx } = await seed();
    const event = await createTestEvent({ organization_id: orgId, content: 'great' });

    const asLlm = await manageClassifiers(
      {
        action: 'classify',
        classifier_slug: 'sentiment',
        source: 'llm',
        classifications: [{ content_id: Number(event.id), value: 'positive', confidence: 0.62 }],
      } as never,
      {} as never,
      ctx
    );
    expect(asLlm.success).toBe(true);
    const asUser = await manageClassifiers(
      { action: 'classify', classifier_slug: 'sentiment', content_id: Number(event.id), value: 'negative' } as never,
      {} as never,
      ctx
    );
    expect(asUser.success).toBe(true);

    const rows = await labels(Number(event.id));
    expect(rows.map((r) => [r.source, r.is_manual])).toEqual([
      ['llm', false],
      ['user', true],
    ]);
    expect(rows[0].confidences).toEqual({ positive: 0.62 });
    expect(rows[1].confidences).toEqual({ negative: 1 });
  });

  it.each([
    ['llm', 'single'], ['llm', 'batch'], ['user', 'single'], ['user', 'batch'],
  ] as const)('stores %s confidence defaults and explicit scores in %s mode', async (source, mode) => {
    const { orgId, ctx } = await seed();
    for (const confidence of [undefined, null, 0, 0.62, 1]) {
      const event = await createTestEvent({ organization_id: orgId, content: String(confidence) });
      const item = {
        content_id: Number(event.id),
        value: 'positive',
        ...(confidence === undefined ? {} : { confidence }),
      };
      const result = await manageClassifiers(
        {
          action: 'classify',
          classifier_slug: 'sentiment',
          source,
          ...(mode === 'single' ? item : { classifications: [item] }),
        } as never,
        {} as never,
        ctx
      );
      expect(result.data?.failed).toBe(0);
      const expected = confidence == null ? (source === 'user' ? { positive: 1 } : {}) : { positive: confidence };
      expect((await labels(Number(event.id)))[0].confidences).toEqual(expected);
    }
  });

  it('rejects a confidence outside 0..1', async () => {
    const { orgId, ctx } = await seed();
    const event = await createTestEvent({ organization_id: orgId, content: 'great' });
    await expect(
      manageClassifiers(
        {
          action: 'classify',
          classifier_slug: 'sentiment',
          content_id: Number(event.id),
          value: 'positive',
          confidence: 1.5,
        } as never,
        {} as never,
        ctx
      )
    ).rejects.toThrow();
  });

  it('value: null unsets the caller’s label without touching other sources', async () => {
    const { orgId, ctx } = await seed();
    const event = await createTestEvent({ organization_id: orgId, content: 'great' });
    const classify = (value: string | null, source: 'user' | 'llm') =>
      manageClassifiers(
        { action: 'classify', classifier_slug: 'sentiment', content_id: Number(event.id), value, source } as never,
        {} as never,
        ctx
      );

    expect((await classify('positive', 'user')).success).toBe(true);
    expect((await classify('negative', 'llm')).success).toBe(true);

    const unset = await classify(null, 'user');
    expect(unset.message ?? null).toBeNull();
    expect(unset.success).toBe(true);

    const rows = await labels(Number(event.id));
    expect(rows.map((r) => r.source)).toEqual(['llm']);
    expect(parsePgTextArray(rows[0].values)).toEqual(['negative']);
  });

  it('an Automation reaction records its Automation and run, and read_knowledge shows the label', async () => {
    const { orgId, userId } = await seed();
    const sql = getTestDb();
    const agent = await createTestAgent({ organizationId: orgId, ownerUserId: userId });
    const [automation] = (await sql`
      INSERT INTO automations (organization_id, managed_agent_id, automation_group_id, name, created_by, status)
      VALUES (${orgId}, ${agent.agentId}, 0, 'labeller', ${userId}, 'active')
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const [run] = (await sql`
      INSERT INTO runs (organization_id, run_type, automation_id, status)
      VALUES (${orgId}, 'automation', ${automation.id}, 'running')
      RETURNING id
    `) as unknown as Array<{ id: number }>;

    const labelled = await createTestEvent({ organization_id: orgId, content: 'this is great' });
    const overridden = await createTestEvent({ organization_id: orgId, content: 'meh' });
    // An `llm` label written outside any Automation: the Automation's writes and
    // unsets are keyed to its own automation_id and must leave this one alone.
    const shared = await createTestEvent({ organization_id: orgId, content: 'shared' });
    // A human label already on `overridden`: read-time precedence keeps it
    // over whatever the Automation writes.
    const { ctx } = { ctx: ownerToolContext(orgId, userId) };
    await manageClassifiers(
      { action: 'classify', classifier_slug: 'sentiment', content_id: Number(overridden.id), value: 'negative' } as never,
      {} as never,
      ctx
    );
    await manageClassifiers(
      { action: 'classify', classifier_slug: 'sentiment', source: 'llm', content_id: Number(shared.id), value: 'negative' } as never,
      {} as never,
      ctx
    );

    // The production reaction path: compiled script, isolate, ClientSDK, and
    // the ToolContext the reaction executor builds from the window.
    const compiled = await compileReactionScript(
      'export default async (ctx, client) => {\n' +
        '  const r = await client.classifiers.classify({\n' +
        '    classifier_slug: "sentiment", source: "llm",\n' +
        `    classifications: [{ content_id: ${Number(labelled.id)}, value: "positive", confidence: 0.8 },\n` +
        `                      { content_id: ${Number(overridden.id)}, value: "positive", confidence: 0.7 },\n` +
        `                      { content_id: ${Number(shared.id)}, value: "positive" }],\n` +
        '  });\n' +
        '  if (!r.success || r.data.failed !== 0) throw new Error(JSON.stringify(r));\n' +
        '};'
    );
    const res = await executeReaction({
      compiledScript: compiled,
      context: {
        extracted_data: {},
        entities: [],
        window: {
          id: Number(run.id),
          run_id: Number(run.id),
          automation_id: Number(automation.id),
          window_start: new Date('2026-01-01').toISOString(),
          window_end: new Date('2026-01-02').toISOString(),
          granularity: 'day',
          content_analyzed: 2,
        },
        automation: { id: Number(automation.id), slug: 'labeller', name: 'labeller', version: 1 },
        organization_id: orgId,
      } as never,
      env: process.env as Record<string, string | undefined>,
    });
    expect(res.error ?? null).toBeNull();
    expect(res.success).toBe(true);

    const [row] = (await labels(Number(labelled.id))) as LabelRow[];
    expect(row.source).toBe('llm');
    expect(row.is_manual).toBe(false);
    expect(Number(row.automation_id)).toBe(Number(automation.id));
    expect(Number(row.run_id)).toBe(Number(run.id));
    expect(row.confidences).toEqual({ positive: 0.8 });

    const read = await getContent(
      { classification_filters: { sentiment: ['positive'] }, limit: 50 } as never,
      {} as never,
      ctx
    );
    const byId = new Map(
      read.content.map((item) => [Number(item.id), item as { classifications: Record<string, any> }])
    );
    // The filter matches a value held by ANY source (the existing filter
    // contract), while the displayed label follows read-time precedence.
    expect([...byId.keys()].sort((x, y) => x - y)).toEqual(
      [Number(labelled.id), Number(overridden.id), Number(shared.id)].sort((x, y) => x - y)
    );
    expect(byId.get(Number(labelled.id))?.classifications.sentiment).toMatchObject({
      values: ['positive'],
      source: 'llm',
      is_manual: false,
    });
    expect(byId.get(Number(overridden.id))?.classifications.sentiment).toMatchObject({
      values: ['negative'],
      source: 'user',
      is_manual: true,
    });

    // Unset from the same Automation removes only that Automation's row.
    const unset = await executeReaction({
      compiledScript: await compileReactionScript(
        'export default async (ctx, client) => {\n' +
          `  const r = await client.classifiers.classify({ classifier_slug: "sentiment", source: "llm", classifications: [{ content_id: ${Number(overridden.id)}, value: null }, { content_id: ${Number(shared.id)}, value: null }] });\n` +
          '  if (!r.success || r.data.failed !== 0) throw new Error(JSON.stringify(r));\n' +
          '};'
      ),
      context: {
        extracted_data: {},
        entities: [],
        window: {
          id: Number(run.id),
          run_id: Number(run.id),
          automation_id: Number(automation.id),
          window_start: new Date('2026-01-01').toISOString(),
          window_end: new Date('2026-01-02').toISOString(),
          granularity: 'day',
          content_analyzed: 1,
        },
        automation: { id: Number(automation.id), slug: 'labeller', name: 'labeller', version: 1 },
        organization_id: orgId,
      } as never,
      env: process.env as Record<string, string | undefined>,
    });
    expect(unset.error ?? null).toBeNull();
    expect((await labels(Number(overridden.id))).map((r) => r.source)).toEqual(['user']);
    const sharedRows = await labels(Number(shared.id));
    expect(sharedRows).toHaveLength(1);
    expect(sharedRows[0].automation_id).toBeNull();
    expect(parsePgTextArray(sharedRows[0].values)).toEqual(['negative']);
  });
  it('derives source from the acting principal: only a person writes user labels', async () => {
    const { orgId, userId, ctx } = await seed();
    const sql = getTestDb();
    const agent = await createTestAgent({ organizationId: orgId, ownerUserId: userId });
    const [automation] = (await sql`
      INSERT INTO automations (organization_id, managed_agent_id, automation_group_id, name, created_by, status)
      VALUES (${orgId}, ${agent.agentId}, 0, 'labeller', ${userId}, 'active')
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const [run] = (await sql`
      INSERT INTO runs (organization_id, run_type, automation_id, status)
      VALUES (${orgId}, 'automation', ${automation.id}, 'running')
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const byScript = await createTestEvent({ organization_id: orgId, content: 'script' });
    const claimed = await createTestEvent({ organization_id: orgId, content: 'claimed' });
    const byAgent = await createTestEvent({ organization_id: orgId, content: 'agent' });
    const byPerson = await createTestEvent({ organization_id: orgId, content: 'person' });

    const runScript = (body: string) =>
      compileReactionScript(`export default async (ctx, client) => {\n${body}\n};`).then((compiled) =>
        executeReaction({
          compiledScript: compiled,
          context: {
            extracted_data: {},
            entities: [],
            window: {
              id: Number(run.id),
              run_id: Number(run.id),
              automation_id: Number(automation.id),
              window_start: new Date('2026-01-01').toISOString(),
              window_end: new Date('2026-01-02').toISOString(),
              granularity: 'day',
              content_analyzed: 1,
            },
            automation: { id: Number(automation.id), slug: 'labeller', name: 'labeller', version: 1 },
            organization_id: orgId,
          } as never,
          env: process.env as Record<string, string | undefined>,
        })
      );

    // An Automation that omits source writes a model label, not a manual one.
    const omitted = await runScript(
      `  const r = await client.classifiers.classify({ classifier_slug: "sentiment", content_id: ${Number(byScript.id)}, value: "positive" });\n` +
        '  if (!r.success) throw new Error(JSON.stringify(r));'
    );
    expect(omitted.error ?? null).toBeNull();
    expect((await labels(Number(byScript.id))).map((r) => [r.source, r.is_manual])).toEqual([['llm', false]]);

    // An Automation cannot pass itself off as a person; the refusal fails the script.
    const spoofed = await runScript(
      `  await client.classifiers.classify({ classifier_slug: "sentiment", source: "user", content_id: ${Number(claimed.id)}, value: "positive" });`
    );
    expect(spoofed.success).toBe(false);
    expect(spoofed.error).toContain("Only a person can write source 'user' labels");
    expect(await labels(Number(claimed.id))).toEqual([]);

    // Neither can an agent turn.
    const agentCtx = { ...ctx, agentId: agent.agentId } as ToolContext;
    const agentResult = await manageClassifiers(
      { action: 'classify', classifier_slug: 'sentiment', source: 'user', content_id: Number(byAgent.id), value: 'negative' } as never,
      {} as never,
      agentCtx
    );
    expect(agentResult.success).toBe(false);
    await manageClassifiers(
      { action: 'classify', classifier_slug: 'sentiment', content_id: Number(byAgent.id), value: 'negative' } as never,
      {} as never,
      agentCtx
    );
    expect((await labels(Number(byAgent.id))).map((r) => r.source)).toEqual(['llm']);

    // A person still writes manual labels by default.
    await manageClassifiers(
      { action: 'classify', classifier_slug: 'sentiment', content_id: Number(byPerson.id), value: 'negative' } as never,
      {} as never,
      ctx
    );
    expect((await labels(Number(byPerson.id))).map((r) => [r.source, r.is_manual])).toEqual([['user', true]]);
  });
});

describe('classification filter resolves slugs inside the caller’s organization', () => {
  it('ignores another organization’s classifier with the same slug', async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const sql = getTestDb();
    const mine = await createTestOrganization({ name: 'Mine' });
    const theirs = await createTestOrganization({ name: 'Theirs' });
    const user = await createTestUser({ email: 'slug-scope@test.example.com' });
    await addUserToOrganization(user.id, mine.id, 'owner');

    const seedFacet = async (organizationId: string) => {
      const [row] = (await sql`
        INSERT INTO classify_facet (organization_id, slug, name, attribute_key, status, created_by, attribute_values)
        VALUES (${organizationId}, 'kind', 'Kind', 'kind', 'active', ${user.id},
                ${sql.json({ alpha: { description: 'A', examples: [] } })})
        RETURNING id
      `) as unknown as Array<{ id: number }>;
      return Number(row.id);
    };
    await seedFacet(mine.id);
    const theirFacet = await seedFacet(theirs.id);

    // Visible to `mine` through its entity, labelled with THEIR classifier.
    const entity = await createTestEntity({ name: 'Shared Entity', organization_id: mine.id });
    const bridged = await createTestEvent({
      organization_id: theirs.id,
      entity_id: entity.id,
      content: 'bridged row',
    });
    await sql`
      INSERT INTO event_classifications (event_id, classifier_id, "values", confidences, source, is_manual)
      VALUES (${bridged.id}, ${theirFacet}, ${'{alpha}'}::text[], ${sql.json({ alpha: 1 })}, 'user', true)
    `;

    const ctx = ownerToolContext(mine.id, user.id);
    const orgWide = await getContent(
      { classification_filters: { kind: ['alpha'] }, limit: 50 } as never,
      {} as never,
      ctx
    );
    expect(orgWide.content.map((item) => Number(item.id))).toEqual([]);

    const entityScoped = await getContent(
      { entity_id: entity.id, classification_filters: { kind: ['alpha'] }, limit: 50 } as never,
      {} as never,
      ctx
    );
    expect(entityScoped.content.map((item) => Number(item.id))).toEqual([]);
  });
});
