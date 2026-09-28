/**
 * Classifier CRUD via the post-#348 SDK surface.
 *
 * Replaces the deleted manage_classifiers integration tests.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase } from '../../setup/test-db';

describe('classifier CRUD', () => {
  let owner: TestApiClient;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Classifier Test Org' });
    const user = await createTestUser({ email: 'cls-owner@test.com' });
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
    const list = (await owner.classifiers.list({})) as {
      data?: { classifiers?: Array<{ id: number }> };
    };
    expect(list.data?.classifiers?.some((c) => c.id === classifierId)).toBe(true);

    await owner.classifiers.delete({ classifier_id: classifierId });
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
