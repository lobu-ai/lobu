/**
 * Classifier isolation contracts.
 *
 * These replace broad stale manage_classifiers tests with focused invariants:
 * classifiers are scoped to their workspace for list/read/mutate/classify.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { ClientSdkActionError } from '../../../sandbox/namespaces/action-call';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEvent } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';


type SeededClassifier = {
  workspace: TestWorkspace;
  entityId: number;
  classifierId: number;
  eventId: number;
};

async function seedEntityType(workspace: TestWorkspace, slug: string, name: string) {
  const sql = getTestDb();
  await sql`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${workspace.org.id}, ${slug}, ${name}, NOW(), NOW())
  `;
}

async function seedClassifier(workspace: TestWorkspace, slug: string): Promise<SeededClassifier> {
  await seedEntityType(workspace, 'company', 'Company');
  const entity = (await workspace.owner.entities.create({
    entity_type: 'company',
    name: `${slug} Target`,
  })) as { entity: { id: number } };

  const created = (await workspace.owner.classifiers.create({
    slug,
    name: `${slug} Classifier`,
    attribute_key: slug,
    attribute_values: {
      positive: {
        description: 'positive signal',
        examples: ['great'],
      },
      negative: {
        description: 'negative signal',
        examples: ['bad'],
      },
    },
  })) as { data?: { classifier_id: number } };

  const event = await createTestEvent({
    entity_id: entity.entity.id,
    organization_id: workspace.org.id,
    title: `${slug} event`,
    content: 'A workspace-local event.',
  });

  return {
    workspace,
    entityId: entity.entity.id,
    classifierId: created.data!.classifier_id,
    eventId: event.id,
  };
}

describe('classifier org isolation', () => {
  let orgA: SeededClassifier;
  let orgB: SeededClassifier;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const { a, b } = await TestWorkspace.pair();
    orgA = await seedClassifier(a, 'sentiment');
    orgB = await seedClassifier(b, 'sentiment');
  });

  it('list() only returns classifiers from the caller workspace', async () => {
    const listA = (await orgA.workspace.owner.classifiers.list({})) as {
      data?: { classifiers?: Array<{ id: number }> };
    };
    const listB = (await orgB.workspace.owner.classifiers.list({})) as {
      data?: { classifiers?: Array<{ id: number }> };
    };

    expect(listA.data?.classifiers?.some((c) => c.id === orgA.classifierId)).toBe(true);
    expect(listA.data?.classifiers?.some((c) => c.id === orgB.classifierId)).toBe(false);
    expect(listB.data?.classifiers?.some((c) => c.id === orgB.classifierId)).toBe(true);
    expect(listB.data?.classifiers?.some((c) => c.id === orgA.classifierId)).toBe(false);
  });

  it('delete() cannot archive another workspace classifier', async () => {
    const error = await orgA.workspace.owner.classifiers
      .delete({ classifier_id: orgB.classifierId })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ClientSdkActionError);

    const listB = (await orgB.workspace.owner.classifiers.list({})) as {
      data?: { classifiers?: Array<{ id: number; status: string }> };
    };
    expect(listB.data?.classifiers?.find((c) => c.id === orgB.classifierId)?.status).toBe('active');
  });

  it('classify() cannot write to another workspace event/classifier pair', async () => {
    const error = await orgA.workspace.owner.classifiers
      .classify({
        classifier_slug: 'sentiment',
        content_id: orgB.eventId,
        value: 'positive',
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ClientSdkActionError);
    expect((error as ClientSdkActionError).result.data).toMatchObject({
      failed: 1,
    });
  });
});
