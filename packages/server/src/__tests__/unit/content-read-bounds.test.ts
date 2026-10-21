import { describe, expect, it } from 'bun:test';
import {
  CONTENT_JSON_MAX_BYTES,
  CONTENT_TEXT_HEAD_CHARS,
  QUERY_SQL_RESULT_MAX_BYTES,
  finalizeDynamicQueryRows,
} from '../../utils/content-read-bounds';

describe('finalizeDynamicQueryRows', () => {
  it('uses PostgreSQL character semantics and never splits a surrogate pair', () => {
    const full = `${'a'.repeat(CONTENT_TEXT_HEAD_CHARS - 1)}😀tail`;
    const result = finalizeDynamicQueryRows([{ payload_text: full }]);

    expect(result.omittedRows).toBe(0);
    expect(result.sidecarCollisions).toEqual([]);
    expect(result.rows[0].payload_text).toBe(
      `${'a'.repeat(CONTENT_TEXT_HEAD_CHARS - 1)}😀… [truncated]`
    );
    expect(result.rows[0].content_length).toBe(CONTENT_TEXT_HEAD_CHARS + 4);
    expect(result.rows[0].payload_truncated).toBe(true);
  });

  it('replaces oversized nested JSON whole and exposes attachment sidecars', () => {
    const payloadBytes = CONTENT_JSON_MAX_BYTES + 1;
    const result = finalizeDynamicQueryRows([
      {
        payload_data: { body: 'p'.repeat(payloadBytes) },
        attachments: [{ text: 'a'.repeat(payloadBytes) }],
      },
    ]);

    expect(result.rows[0].payload_data).toEqual({
      _truncated: true,
      bytes: expect.any(Number),
    });
    expect(result.rows[0].attachments).toBeNull();
    expect(result.rows[0].attachments_truncated).toBe(true);
    expect(result.rows[0].attachments_bytes).toBeGreaterThan(CONTENT_JSON_MAX_BYTES);
    expect(result.sidecarCollisions).toEqual([]);
  });

  it('reports incompatible caller-projected sidecars without overwriting them', () => {
    const result = finalizeDynamicQueryRows([
      {
        payload_text: 'x'.repeat(CONTENT_TEXT_HEAD_CHARS + 1),
        payload_truncated: false,
        content_length: 7,
      },
    ]);

    expect(result.sidecarCollisions).toEqual(['content_length', 'payload_truncated']);
    expect(result.rows[0].payload_truncated).toBe(false);
    expect(result.rows[0].content_length).toBe(7);
  });

  it('reports generated sidecars that disagree across two truncated text columns', () => {
    const result = finalizeDynamicQueryRows([
      {
        payload_text: 'x'.repeat(CONTENT_TEXT_HEAD_CHARS + 1),
        text_content: 'y'.repeat(CONTENT_TEXT_HEAD_CHARS + 2),
      },
    ]);

    expect(result.sidecarCollisions).toEqual(['content_length']);
    expect(result.rows[0].content_length).toBe(CONTENT_TEXT_HEAD_CHARS + 1);
    expect(result.rows[0].payload_truncated).toBe(true);
  });

  it('names every column with a bounded cell among the kept rows', () => {
    const result = finalizeDynamicQueryRows([
      { id: 1, title: 'fits', body: 'x'.repeat(CONTENT_TEXT_HEAD_CHARS + 1) },
      { id: 2, title: 'fits', metadata: { items: 'm'.repeat(CONTENT_JSON_MAX_BYTES) } },
      { id: 3, title: 'fits', body: 'short', metadata: { items: [] } },
    ]);

    expect(result.truncatedColumns).toEqual(['body', 'metadata']);
    expect(finalizeDynamicQueryRows([{ id: 1, title: 'fits' }]).truncatedColumns).toEqual([]);
  });

  it('does not name a column bounded only in a row the size cap omitted', () => {
    const big = { title: 't'.repeat(CONTENT_TEXT_HEAD_CHARS + 1) };
    const result = finalizeDynamicQueryRows([{ id: 1 }, big], JSON.stringify([{ id: 1 }]).length);

    expect(result.rows).toEqual([{ id: 1 }]);
    expect(result.omittedRows).toBe(1);
    expect(result.truncatedColumns).toEqual([]);
  });

  it('enforces a hard serialized row-list cap after per-cell bounding', () => {
    const rows = Array.from({ length: 500 }, (_, id) => ({
      id,
      body: 'x'.repeat(CONTENT_TEXT_HEAD_CHARS * 2),
    }));
    const result = finalizeDynamicQueryRows(rows);

    expect(result.omittedRows).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result.rows), 'utf8')).toBeLessThanOrEqual(
      QUERY_SQL_RESULT_MAX_BYTES
    );
  });
});
