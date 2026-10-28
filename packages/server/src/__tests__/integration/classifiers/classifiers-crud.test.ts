/**
 * Classifier CRUD via the post-#348 SDK surface.
 *
 * Also pins the list read path:
 * - `attribute_values` round-trips exactly, and a legacy ARRAY-shaped row never
 *   surfaces as the corrupted `{"0":{}}` numeric-key shape (#2033 item 4);
 * - "delete" is a soft delete to `deprecated`, and `list` defaults to
 *   `status: 'active'` with `deprecated` / `all` as explicit filters (#2051).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';

type ClassifierList = {
  data?: {
    classifiers?: Array<{ id: number; status: string; attribute_values: unknown }>;
  };
};

describe('classifier CRUD', () => {
  let owner: TestApiClient;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Classifier Test Org' });
    const user = await createTestUser({ email: 'cls-owner@test.com' });
    orgId = org.id;
    userId = user.id;
    await addUserToOrganization(user.id, org.id, 'owner');
    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });
  });

  it('creates → reads back → deletes a classifier', async () => {
    const created = (await owner.classifiers.create({
      slug: 'sentiment',
      name: 'Sentiment',
      attribute_key: 'sentiment',
      attribute_values: {
        positive: {
          description: 'positive sentiment',
          examples: ['great'],
        },
        negative: {
          description: 'negative sentiment',
          examples: ['bad'],
        },
      },
    })) as { data?: { classifier_id: number } };
    expect(created.data?.classifier_id).toBeGreaterThan(0);
    const classifierId = created.data!.classifier_id;

    // List with no filter — the classifier is org-level, not entity-scoped,
    // so list({entity_id}) wouldn't include it.
    const list = (await owner.classifiers.list({})) as ClassifierList;
    const row = list.data?.classifiers?.find((c) => c.id === classifierId);
    expect(row).toBeDefined();
    // Rich object-map values survive exactly; keys are the value strings, NOT
    // numeric indices.
    const av = row!.attribute_values as Record<string, { description: string; examples: string[] }>;
    expect(Object.keys(av).sort()).toEqual(['negative', 'positive']);
    expect(av.positive.description).toBe('positive sentiment');
    expect(av.positive.examples).toEqual(['great']);
    expect(av.negative.description).toBe('negative sentiment');

    await owner.classifiers.delete({ classifier_id: classifierId });
  });

  it('soft-deletes to deprecated and lists active classifiers by default', async () => {
    const mkClassifier = async (slug: string): Promise<number> => {
      const created = (await owner.classifiers.create({
        slug,
        name: slug,
        attribute_key: 'sentiment',
        attribute_values: {
          positive: { description: 'p', examples: ['great'] },
        },
      })) as { data?: { classifier_id: number } };
      return created.data!.classifier_id;
    };
    const activeId = await mkClassifier('cls-active');
    const deprecatedId = await mkClassifier('cls-deprecated');
    await owner.classifiers.delete({ classifier_id: deprecatedId });

    const ids = async (status?: string) =>
      (((await owner.classifiers.list(status ? { status } : {})) as ClassifierList).data
        ?.classifiers ?? []
      ).map((c) => c.id);

    const byDefault = await ids();
    expect(byDefault).toContain(activeId);
    expect(byDefault).not.toContain(deprecatedId);

    const deprecated = await ids('deprecated');
    expect(deprecated).toContain(deprecatedId);
    expect(deprecated).not.toContain(activeId);

    const all = await ids('all');
    expect(all).toContain(activeId);
    expect(all).toContain(deprecatedId);
  });

  it('never emits {"0":{}} for a seeded ARRAY-shaped attribute_values row', async () => {
    await owner.entity_schema.createType({ slug: 'company', name: 'Company' });
    const entity = (await owner.entities.create({
      entity_type: 'company',
      name: 'Attr Target',
    })) as { entity: { id: number } };
    const entityId = entity.entity.id;
    const agent = await createTestAgent({ organizationId: orgId, ownerUserId: userId });
    const automation = (await owner.automations.create({
      entity_id: entityId,
      slug: 'attr-automation',
      name: 'Attr Automation',
      prompt: 'gather signals.',
      managed_agent_id: agent.agentId,
    })) as { automation_id: string };

    const sql = getTestDb();
    // Seed a legacy corrupt row directly: attribute_values is a jsonb ARRAY.
    const inserted = await sql`
      INSERT INTO classify_facet (
        organization_id, slug, name, attribute_key, status, created_by,
        entity_id, entity_ids, automation_id, attribute_values, min_similarity
      ) VALUES (
        ${orgId}, 'legacy-array', 'Legacy Array', 'legacy', 'active', ${userId},
        ${entityId}, ARRAY[${entityId}]::bigint[], ${Number(automation.automation_id)},
        ${sql.json([{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }])},
        0.7
      )
      RETURNING id
    `;
    const legacyId = Number(inserted[0].id);

    const list = (await owner.classifiers.list({})) as ClassifierList;
    const row = list.data?.classifiers?.find((c) => c.id === legacyId);
    expect(row).toBeDefined();
    // The read guard rejects the array root → null, NEVER the numeric-keyed
    // `{"0":{},"1":{}}` corruption the old code emitted.
    expect(row!.attribute_values).toBeNull();
  });

  it('creates a classifier whose values carry only descriptions', async () => {
    const created = (await owner.classifiers.create({
      slug: 'topic',
      name: 'Topic',
      attribute_key: 'topic',
      attribute_values: {
        security: { description: 'Security, privacy, vulnerabilities' },
        other: { description: 'Anything else' },
      },
    })) as { data?: { classifier_id: number } };
    expect(created.data?.classifier_id).toBeGreaterThan(0);
  });

  it('blocks a member from creating classifiers (admin-only)', async () => {
    const member = owner.withAuth({ memberRole: 'member' });
    await expect(
      member.classifiers.create({
        slug: 'blocked-cls',
        name: 'Blocked',
        attribute_key: 'sentiment',
        attribute_values: {
          v: { description: 'v', examples: ['v'] },
        },
      })
    ).rejects.toThrow(/admin|owner|access/i);
  });
});
