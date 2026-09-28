/**
 * Classifier list excludes deprecated rows by default (#2051).
 *
 * Classifier "delete" is a soft delete: it flips status to 'deprecated', it does
 * not remove the row. Before this change `list` had no default status filter, so
 * deprecated classifiers stayed visible in the ordinary list — repeated E2E runs
 * accumulated permanent, visible configuration rows. The list now defaults to
 * `status: 'active'` (mirroring the automations list), with `status: 'all'` as the
 * explicit escape hatch and `status: 'deprecated'` to see archived ones.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase } from '../../setup/test-db';

type ClassifierList = { data?: { classifiers?: Array<{ id: number; status: string }> } };

describe('classifier list — default excludes deprecated', () => {
  let owner: TestApiClient;
  let activeId: number;
  let deprecatedId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Classifier List Default Org' });
    const user = await createTestUser({ email: 'cls-list-default@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });

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

    activeId = await mkClassifier('cls-active');
    deprecatedId = await mkClassifier('cls-deprecated');
    // Soft-delete the second one → status becomes 'deprecated'.
    await owner.classifiers.delete({ classifier_id: deprecatedId });
  });

  it('omits the deprecated classifier from the default list', async () => {
    const list = (await owner.classifiers.list({})) as ClassifierList;
    const ids = (list.data?.classifiers ?? []).map((c) => c.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(deprecatedId);
  });

  it('includes the deprecated classifier when status: "deprecated"', async () => {
    const list = (await owner.classifiers.list({ status: 'deprecated' })) as ClassifierList;
    const ids = (list.data?.classifiers ?? []).map((c) => c.id);
    expect(ids).toContain(deprecatedId);
    expect(ids).not.toContain(activeId);
  });

  it('includes every classifier when status: "all"', async () => {
    const list = (await owner.classifiers.list({ status: 'all' })) as ClassifierList;
    const ids = (list.data?.classifiers ?? []).map((c) => c.id);
    expect(ids).toContain(activeId);
    expect(ids).toContain(deprecatedId);
  });
});
