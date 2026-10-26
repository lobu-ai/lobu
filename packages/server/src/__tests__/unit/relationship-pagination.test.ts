import { describe, expect, it } from 'bun:test';
import { nextRelationshipCursor, parseRelationshipCursor } from '../../utils/relationship-reads';

describe('authored and native relationship pagination', () => {
  it('keeps a failed native stream retryable after authored links finish', () => {
    const first = parseRelationshipCursor(undefined, 'caller-and-record');
    const token = nextRelationshipCursor(first, { hasMore: false, lastId: 42 }, {
      next_cursor: 'native-position', failures: [{ feed_id: 12, error: 'unavailable' }],
    });
    const retry = parseRelationshipCursor(token, 'caller-and-record');
    expect(retry).toMatchObject({ after: 42, localDone: true, sourceDone: false, sourceCursor: 'native-position' });
    expect(nextRelationshipCursor(retry, { hasMore: false, lastId: 42 }, { failures: [], next_cursor: undefined })).toBeUndefined();
  });

  it('does not restart a finished native stream while authored pages remain', () => {
    const first = parseRelationshipCursor(null, 'caller-and-record');
    const token = nextRelationshipCursor(first, { hasMore: true, lastId: 42 }, { failures: [], next_cursor: undefined });
    expect(parseRelationshipCursor(token, 'caller-and-record')).toMatchObject({
      after: 42, localDone: false, sourceDone: true, sourceCursor: null,
    });
  });

  it('rejects replay for another caller or record and invalid positions', () => {
    const first = parseRelationshipCursor(undefined, 'caller-and-record');
    const token = nextRelationshipCursor(first, { hasMore: true, lastId: 42 }, { failures: [], next_cursor: undefined });
    expect(() => parseRelationshipCursor(token, 'different-caller')).toThrow(/does not match/);
    for (const after of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '42']) {
      const invalid = Buffer.from(JSON.stringify({ ...first, after })).toString('base64url');
      expect(() => parseRelationshipCursor(invalid, 'caller-and-record')).toThrow(/does not match/);
    }
    expect(() => parseRelationshipCursor(Buffer.from('null').toString('base64url'), 'caller-and-record')).toThrow(/Invalid relationship cursor/);
  });
});
