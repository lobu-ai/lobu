import { beforeAll, describe, expect, it } from 'vitest';
import { saveContent } from '../../../tools/save_content';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('saveContent supported event formats', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let ctx: ToolContext;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Synthetic content formats' });
    user = await createTestUser({ email: 'content-formats@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    ctx = {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:write'],
      // A direct (non-headless) call echoes the render payload below; only a
      // nested SDK save with `headlessResult` keeps the compact receipt.
    };
  });


  it.each([
    { payload_type: 'json_template', payload_template: { root: { type: 'text', content: 'old' } } },
    { payload_type: 'markdown', content: 'Readable', payload_template: { root: { type: 'text' } } },
    { payload_type: 'json_template', payload_data: { score: 42 } },
  ])('rejects retired presentation input before creating an event: %j', async (input) => {
    const sql = getTestDb();
    const before = await sql`SELECT id FROM events WHERE organization_id = ${org.id} ORDER BY id`;
    await expect(saveContent({ ...input, semantic_type: 'content' } as never, {} as never, ctx))
      .rejects.toThrow();
    const after = await sql`SELECT id FROM events WHERE organization_id = ${org.id} ORDER BY id`;
    expect(after).toEqual(before);
  });

  it('preserves typed data, Markdown, attribution and attachments without a template', async () => {
    const data = { score: 42, approved: false, owners: [{ name: 'Ada' }] };
    const attachments = [{ kind: 'image', url: 'https://example.test/chart.png' }];
    const result = await saveContent({
      semantic_type: 'content', payload_type: 'markdown', content: '# Report\n\nScore: **42**',
      title: 'Synthetic report', payload_data: data, attachments,
      author: 'Synthetic author', source_url: 'https://example.test/report',
    }, {} as never, ctx);
    expect(result).toMatchObject({
      payload_type: 'markdown', payload_text: '# Report\n\nScore: **42**',
      payload_data: data, attachments, source_url: 'https://example.test/report',
    });
    const [stored] = await getTestDb()`
      SELECT payload_type, payload_text, payload_data, payload_template, attachments, author_name
      FROM events WHERE id = ${result.id}
    `;
    expect(stored).toMatchObject({
      payload_type: 'markdown', payload_data: data, payload_template: null,
      attachments, author_name: 'Synthetic author',
    });
  });

  it.each(['empty', 'media'] as const)('retains a %s event with no text', async (payload_type) => {
    const result = await saveContent({
      semantic_type: 'content', payload_type, payload_data: { score: 0, selected: false },
      attachments: payload_type === 'media'
        ? [{ kind: 'image', url: 'https://example.test/image.png' }] : [],
    }, {} as never, ctx);
    expect(result).toMatchObject({ payload_type, payload_text: null, payload_data: { score: 0, selected: false } });
  });

  it('returns the original persisted content on an idempotent replay', async () => {
    const first = await saveContent({
      semantic_type: 'content', payload_type: 'markdown', content: 'Original',
      payload_data: { score: 7 }, title: 'Original report', idempotency_key: 'format-replay',
    }, {} as never, ctx);
    const replay = await saveContent({
      semantic_type: 'content', payload_type: 'markdown', content: 'Different retry',
      payload_data: { score: 99 }, title: 'Different retry', idempotency_key: 'format-replay',
    }, {} as never, ctx);
    expect(replay).toMatchObject({
      id: first.id, created: false, title: 'Original report',
      payload_text: 'Original', payload_data: { score: 7 },
    });
  });
});
