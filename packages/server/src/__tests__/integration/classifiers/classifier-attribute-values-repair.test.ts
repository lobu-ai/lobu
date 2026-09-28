/**
 * #2033 item 4 — classifier `attribute_values` corruption.
 *
 * Covers:
 *  1. Read guard round-trip: rich object-map values survive list() exactly
 *     (description/examples preserved) and a seeded
 *     ARRAY-shaped row NEVER surfaces the corrupted `{"0":{}}` numeric-key shape.
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

describe('classifier attribute_values corruption (item 4)', () => {
  let owner: TestApiClient;
  let orgId: string;
  let userId: string;
  let entityId: number;
  let automationId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Attr Repair Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'attr-repair@test.com' });
    userId = user.id;
    await addUserToOrganization(user.id, org.id, 'owner');
    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });

    await owner.entity_schema.createType({ slug: 'company', name: 'Company' });
    const entity = (await owner.entities.create({
      type: 'company',
      name: 'Attr Target',
    })) as { entity: { id: number } };
    entityId = entity.entity.id;

    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
    const w = (await owner.automations.create({
      entity_id: entityId,
      slug: 'attr-automation',
      name: 'Attr Automation',
      prompt: 'gather signals.',
      managed_agent_id: agent.agentId,
    })) as { automation_id: string };
    automationId = w.automation_id;
  });

  it('round-trips rich object-map values through list() exactly', async () => {
    const created = (await owner.classifiers.create({
      slug: 'quality',
      name: 'Quality',
      attribute_key: 'quality',
      attribute_values: {
        high: { description: 'high quality', examples: ['excellent', 'superb'] },
        low: { description: 'low quality', examples: ['poor'] },
      },
    })) as { data?: { classifier_id: number } };
    const classifierId = created.data!.classifier_id;

    const list = (await owner.classifiers.list({})) as {
      data?: { classifiers?: Array<{ id: number; attribute_values: Record<string, unknown> }> };
    };
    const row = list.data?.classifiers?.find((c) => c.id === classifierId);
    expect(row).toBeDefined();
    const av = row!.attribute_values as Record<string, { description: string; examples: string[] }>;

    // Keys are the value strings — NOT numeric indices.
    expect(Object.keys(av).sort()).toEqual(['high', 'low']);
    expect(av.high.description).toBe('high quality');
    expect(av.high.examples).toEqual(['excellent', 'superb']);
    expect(av.low.description).toBe('low quality');
  });

  it('never emits {"0":{}} for a seeded ARRAY-shaped row', async () => {
    const sql = getTestDb();
    // Seed a legacy corrupt row directly: attribute_values is a jsonb ARRAY.
    const inserted = await sql`
      INSERT INTO classify_facet (
        organization_id, slug, name, attribute_key, status, created_by,
        entity_id, entity_ids, automation_id, attribute_values, min_similarity
      ) VALUES (
        ${orgId}, 'legacy-array', 'Legacy Array', 'legacy', 'active', ${userId},
        ${entityId}, ARRAY[${entityId}]::bigint[], ${Number(automationId)},
        ${sql.json([{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }])},
        0.7
      )
      RETURNING id
    `;
    const legacyId = Number(inserted[0].id);

    const list = (await owner.classifiers.list({})) as {
      data?: { classifiers?: Array<{ id: number; attribute_values: unknown }> };
    };
    const row = list.data?.classifiers?.find((c) => c.id === legacyId);
    expect(row).toBeDefined();
    // The read guard rejects the array root → null, NEVER the numeric-keyed
    // `{"0":{},"1":{}}` corruption the old code emitted.
    expect(row!.attribute_values).toBeNull();
    if (row!.attribute_values !== null) {
      expect(Object.keys(row!.attribute_values as object)).not.toContain('0');
    }
  });

});
