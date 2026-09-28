/**
 * An Automation must be able to DEFINE a classifier, not just use one.
 *
 * `manage_classifiers` create/classify/delete sit in `OWNER_ADMIN_ACTIONS`,
 * but `action-router.ts` returns early for a system context — so an Automation
 * reaction (`userId: null`, `memberRole: null`, `isAuthenticated: true`, exactly
 * what `automations/reaction-executor.ts` builds) is NOT stopped by the admin gate.
 * It got all the way to the INSERT and died there instead:
 *
 *     null value in column "created_by" of relation "classify_facet"
 *     violates not-null constraint
 *
 * `created_by` was resolved as `args.created_by ?? ctx.userId`, and an Automation
 * has no user identity, so `create` was the verb blocking an agent from
 * inventing a classifier to automate its own work. The failure surfaced as a
 * raw Postgres 23502, not a ToolUserError, so the agent got a constraint dump
 * instead of guidance.
 *
 * `classify_facet.created_by` carries no foreign key (the table has none), so a
 * sentinel is valid — this does not smuggle a fake row into `user`.
 */

import { describe, expect, it } from 'vitest';
import { manageClassifiers } from '../../../tools/admin/manage_classifiers';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const ATTRIBUTE_VALUES = {
  positive: { description: 'Positive', examples: ['great'] },
  negative: { description: 'Negative', examples: ['awful'] },
};

/**
 * Mirrors the reaction context in `automations/reaction-executor.ts`: no user, no
 * member role, authenticated, scope check not applicable. Deliberately sets no
 * `agentId` — the reaction executor doesn't either.
 */
function automationCtx(organizationId: string): ToolContext {
  return {
    organizationId,
    userId: null,
    memberRole: null,
    isAuthenticated: true,
    tokenType: 'session',
    scopes: ['*'],
    scopedToOrg: true,
    allowCrossOrg: false,
  } as unknown as ToolContext;
}

describe('an Automation can define and use its own classifier', () => {
  it('creates one with no user identity, then labels with it', async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({ name: 'Automation Author Org' });
    const ctx = automationCtx(org.id);
    const sql = getTestDb();

    const created = await manageClassifiers(
      {
        action: 'create',
        slug: 'agent-invented',
        name: 'Agent invented',
        attribute_key: 'agent-invented',
        attribute_values: ATTRIBUTE_VALUES,
      } as never,
      {} as never,
      ctx
    );
    expect(created.success).toBe(true);

    // NOT NULL satisfied without inventing a user row.
    const rows = (await sql`
      SELECT created_by, automation_id FROM classify_facet
      WHERE slug = 'agent-invented' AND organization_id = ${org.id}
    `) as unknown as Array<{ created_by: string; automation_id: number | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].created_by).toBe('system');
    // Org-level: `create` never makes an Automation-scoped classifier.
    expect(rows[0].automation_id).toBeNull();

    // The point of defining it: the same Automation can immediately use it.
    const event = await createTestEvent({ organization_id: org.id, content: 'great' });
    const labelled = await manageClassifiers(
      {
        action: 'classify',
        classifier_slug: 'agent-invented',
        source: 'llm',
        content_id: Number(event.id),
        value: 'positive',
      } as never,
      {} as never,
      ctx
    );
    expect(labelled.success).toBe(true);
    const [label] = (await sql`
      SELECT source, is_manual FROM event_classifications WHERE event_id = ${event.id}
    `) as unknown as Array<{ source: string; is_manual: boolean }>;
    expect(label).toEqual({ source: 'llm', is_manual: false });
  });

  it('still prefers a real user id when one is available', async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({ name: 'Human Author Org' });
    const user = await createTestUser({ email: 'human-author@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const sql = getTestDb();

    // The sentinel must be a LAST resort — a human-authored classifier keeps
    // real attribution, otherwise the fix would erase authorship org-wide.
    const created = await manageClassifiers(
      {
        action: 'create',
        slug: 'human-made',
        name: 'Human made',
        attribute_key: 'human-made',
        attribute_values: ATTRIBUTE_VALUES,
      } as never,
      {} as never,
      {
        organizationId: org.id,
        userId: user.id,
        memberRole: 'owner',
        isAuthenticated: true,
        tokenType: 'oauth',
        scopedToOrg: false,
        scopes: ['mcp:admin'],
      } as ToolContext
    );
    expect(created.success).toBe(true);

    const rows = (await sql`
      SELECT created_by FROM classify_facet WHERE slug = 'human-made' AND organization_id = ${org.id}
    `) as unknown as Array<{ created_by: string }>;
    expect(rows[0].created_by).toBe(user.id);
  });

  it('honours an explicit created_by over both', async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({ name: 'Explicit Author Org' });
    const sql = getTestDb();

    const created = await manageClassifiers(
      {
        action: 'create',
        slug: 'explicit',
        name: 'Explicit',
        attribute_key: 'explicit',
        attribute_values: ATTRIBUTE_VALUES,
        created_by: 'importer-job',
      } as never,
      {} as never,
      automationCtx(org.id)
    );
    expect(created.success).toBe(true);

    const rows = (await sql`
      SELECT created_by FROM classify_facet WHERE slug = 'explicit' AND organization_id = ${org.id}
    `) as unknown as Array<{ created_by: string }>;
    expect(rows[0].created_by).toBe('importer-job');
  });
});
