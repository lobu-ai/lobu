import { describe, expect, it } from 'bun:test';
import type { DbClient } from '../../db/client';
import { formatToolResult } from '../../formatting/markdown-formatter';
import { buildContentItems } from '../../tools/get_content/render';
import { type ContentRow, toNullableScore } from '../../tools/get_content/types';

describe('toNullableScore', () => {
  it('preserves null and undefined as unscored', () => {
    expect(toNullableScore(null)).toBeNull();
    expect(toNullableScore(undefined)).toBeNull();
  });

  it('passes real scores through, including zero', () => {
    expect(toNullableScore(4.5)).toBe(4.5);
    expect(toNullableScore(0)).toBe(0);
  });

  it('accepts the raw numeric strings pg returns for numeric columns', () => {
    expect(toNullableScore('3.25')).toBe(3.25);
    expect(toNullableScore('0')).toBe(0);
  });

  it('normalizes non-numeric input to unscored rather than NaN', () => {
    expect(toNullableScore('not-a-number')).toBeNull();
  });
});

describe('read_knowledge score rendering', () => {
  it.each([null, 0, '4.50'] as const)(
    'preserves score %s on content and hydrated parent context',
    async (score) => {
      const row: ContentRow = {
        id: 1,
        entity_ids: [],
        platform: 'test',
        origin_id: 'reply',
        origin_parent_id: 'parent',
        semantic_type: 'note',
        title: 'Reply',
        score,
        client_name: 'Test client',
        metadata: {},
        classifications: {},
        created_at: '2026-01-01T00:00:00Z',
      };
      const sql = (async () => [{ origin_id: 'parent', score }]) as unknown as DbClient;
      const [item] = await buildContentItems({
        sql,
        rawContent: [row],
        organizationId: 'test-org',
        ownerSlug: null,
        baseUrl: undefined,
        includePrivateAttribution: false,
      });
      const expected = score === null ? null : Number(score);
      expect(item.score).toBe(expected);
      expect(item.parent_context?.score).toBe(expected);

      const markdown = formatToolResult('read_knowledge', {
        content: [item],
        total: 1,
      });
      if (expected === null) {
        expect(markdown).not.toContain('Score:');
      } else {
        expect(markdown).toContain(`Score: ${expected.toFixed(2)}`);
      }
    },
  );
});
