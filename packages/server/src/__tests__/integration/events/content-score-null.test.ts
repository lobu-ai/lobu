/** Read responses distinguish an absent score from a recorded zero. */
import { beforeAll, describe, expect, it } from 'vitest';
import { type ContentItem, getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { insertEvent } from '../../../utils/insert-event';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('getContent preserves null scores', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let ctx: ToolContext;
  let unscoredId: number;
  let scoredId: number;
  let zeroScoreId: number;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Null Score Org' });
    const user = await createTestUser({ email: 'null-score@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    ctx = {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    } as ToolContext;

    const entity = await createTestEntity({
      name: 'Scored subject',
      organization_id: org.id,
      created_by: user.id,
    });

    // No score supplied: insertEvent stores an explicit NULL.
    unscoredId = (
      await insertEvent({
        entityIds: [entity.id],
        organizationId: org.id,
        originId: 'null-score-unscored',
        title: 'Unscored note',
        content: 'No writer ever scored this.',
        semanticType: 'note',
      })
    ).id;

    scoredId = (
      await insertEvent({
        entityIds: [entity.id],
        organizationId: org.id,
        originId: 'null-score-scored',
        title: 'Scored note',
        content: 'A writer scored this 4.5.',
        semanticType: 'note',
        score: 4.5,
      })
    ).id;

    zeroScoreId = (
      await insertEvent({
        entityIds: [entity.id],
        organizationId: org.id,
        originId: 'null-score-zero',
        title: 'Zero score note',
        content: 'A writer scored this zero.',
        semanticType: 'note',
        score: 0,
      })
    ).id;
  });

  it('returns null for an unscored event and preserves numeric scores including zero', async () => {
    const result = await getContent(
      { content_ids: [unscoredId, scoredId, zeroScoreId], limit: 10 },
      {} as never,
      ctx,
    );
    const byId = new Map(
      (result.content as ContentItem[]).map((c) => [Number(c.id), c]),
    );
    expect(byId.get(unscoredId)?.score).toBeNull();
    expect(byId.get(scoredId)?.score).toBe(4.5);
    expect(byId.get(zeroScoreId)?.score).toBe(0);
  });
});
