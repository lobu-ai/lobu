import { describe, expect, it } from 'bun:test';
import type { DbClient } from '../../db/client';
import { buildContentItems } from '../../tools/get_content/render';
import type { ContentRow } from '../../tools/get_content/types';

async function render(
  row: Partial<ContentRow>,
  includePrivateAttribution: boolean
) {
  const [item] = await buildContentItems({
    sql: (async () => []) as unknown as DbClient,
    rawContent: [{
      id: 1,
      semantic_type: 'audit',
      origin_type: 'tool_invocation',
      payload_type: 'text',
      metadata: { token_type: 'pat', token_name: 'nightly-export', other: 'preserved' },
      ...row,
    } as ContentRow],
    organizationId: '00000000-0000-4000-8000-000000000001',
    ownerSlug: 'test-workspace',
    baseUrl: undefined,
    includePrivateAttribution,
  });
  return item;
}

describe('PAT audit attribution rendering', () => {
  it('shows the PAT name only to members without mutating the source metadata', async () => {
    const metadata = { token_type: 'pat', token_name: 'nightly-export', other: 'preserved' };
    const publicItem = await render({ metadata }, false);
    expect(publicItem.client_name).toBeNull();
    expect(publicItem.metadata).toEqual({ token_type: 'pat', other: 'preserved' });
    expect(metadata.token_name).toBe('nightly-export');

    const memberItem = await render({ metadata }, true);
    expect(memberItem.client_name).toBe('nightly-export');
    expect(memberItem.metadata).toEqual(metadata);
  });

  it.each([
    { semantic_type: 'content' },
    { origin_type: 'other' },
    { metadata: { token_type: 'oauth', token_name: 'ordinary-field' } },
  ])('preserves unrelated token_name metadata without attributing it: %j', async (row) => {
    for (const includePrivateAttribution of [false, true]) {
      const item = await render(row, includePrivateAttribution);
      expect(item.client_name).toBeNull();
      expect(item.metadata.token_name).toBe(row.metadata?.token_name ?? 'nightly-export');
    }
  });

  it('preserves the registered OAuth client name', async () => {
    const item = await render({
      client_name: 'Registered client',
      metadata: { token_type: 'oauth' },
    }, true);
    expect(item.client_name).toBe('Registered client');
  });
});
