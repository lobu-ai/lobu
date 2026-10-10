import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as db from '../../db/client';
import { autoLinkEvent } from '../../utils/auto-linker';
import * as edgeWrites from '../../utils/edge-writes';
import { MANUAL_RELATIONSHIP_CLAIM_KEY } from '../../utils/relationship-claims';

const entities = [
  { id: 1, name: 'Acme', name_length: 4, entity_type: 'company' },
  { id: 2, name: 'Acme Corp', name_length: 9, entity_type: 'company' },
  { id: 4, name: 'C++', name_length: 3, entity_type: 'skill' },
];

let organizationId: string;
let orgSequence = 0;
const sql = mock(async (..._args: unknown[]) => [...entities]);
const upsert = mock(async (_params: Parameters<typeof edgeWrites.upsertEdges>[0]) => [1]);

function link(content: string, entityIds = [9], org = organizationId) {
  return autoLinkEvent({ eventId: 1, entityIds, content, organizationId: org });
}

beforeEach(() => {
  organizationId = `auto-link-test-${++orgSequence}`;
  sql.mockReset();
  sql.mockImplementation(async () => [...entities]);
  upsert.mockReset();
  upsert.mockImplementation(async () => [1]);
  spyOn(db, 'getDb').mockReturnValue(sql as unknown as db.DbClient);
  spyOn(edgeWrites, 'ensureRelationshipType').mockResolvedValue(7);
  spyOn(edgeWrites, 'upsertEdges').mockImplementation(upsert);
});

afterEach(() => {
  mock.restore();
});

describe('autoLinkEvent', () => {
  it('matches whole words case-insensitively, longest first, with manual claims', async () => {
    await link('Working with acme corp today');
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      organizationId,
      relationshipTypeId: 7,
      pairs: [
        { fromEntityId: 9, toEntityId: 2 },
        { fromEntityId: 9, toEntityId: 1 },
      ],
      claimKey: MANUAL_RELATIONSHIP_CLAIM_KEY,
      source: 'feed',
      confidence: 0.4,
      onConflict: 'ignore',
    }));
  });

  it('does not match partial words or unrelated content', async () => {
    await link('AcmeCorp merged');
    await link('nothing here');
    expect(upsert).not.toHaveBeenCalled();
    expect(edgeWrites.ensureRelationshipType).not.toHaveBeenCalled();
  });

  it('skips source entities and caps edges across multiple sources', async () => {
    const sources = [2, ...Array.from({ length: 25 }, (_, i) => i + 10)];
    await link('Acme Corp', sources);
    expect(upsert.mock.calls[0][0].pairs).toEqual(
      sources.slice(0, 20).map((id) => ({ fromEntityId: id, toEntityId: 1 }))
    );
  });

  it('escapes metacharacters and preserves existing word boundaries', async () => {
    await link('love C++17 stuff');
    expect(upsert.mock.calls[0][0].pairs).toEqual([{ fromEntityId: 9, toEntityId: 4 }]);
    await link('love C++ stuff');
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('breaks equal-length ties by id', async () => {
    sql.mockResolvedValueOnce([
      { id: 6, name: 'Beta', name_length: 4, entity_type: 'company' },
      entities[0],
    ]);
    await link('Beta and Acme');
    expect(upsert.mock.calls[0][0].pairs).toEqual([
      { fromEntityId: 9, toEntityId: 1 },
      { fromEntityId: 9, toEntityId: 6 },
    ]);
  });

  it('preserves PostgreSQL character-length ordering for Unicode names', async () => {
    sql.mockResolvedValueOnce([
      { id: 1, name: 'A😀B', name_length: 3, entity_type: 'company' },
      { id: 2, name: 'Acme', name_length: 4, entity_type: 'company' },
    ]);
    await link('A😀B and Acme');
    expect(upsert.mock.calls[0][0].pairs).toEqual([
      { fromEntityId: 9, toEntityId: 2 },
      { fromEntityId: 9, toEntityId: 1 },
    ]);
  });

  it('does not sort the whole org again on cache hits', async () => {
    await link('Acme');
    const sort = spyOn(Array.prototype, 'sort');
    await link('Acme');
    expect(sql).toHaveBeenCalledTimes(1);
    expect(sort).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent fetches per org without sharing data across orgs', async () => {
    const pending = Promise.withResolvers<typeof entities>();
    sql.mockReturnValueOnce(pending.promise);
    const first = link('Acme');
    const second = link('Acme');
    await link('Acme', [9], 'auto-link-other-org');
    expect(sql).toHaveBeenCalledTimes(2);
    pending.resolve([...entities]);
    await Promise.all([first, second]);
    expect(upsert).toHaveBeenCalledTimes(3);
    expect(upsert.mock.calls.map(([params]) => params.organizationId)).toEqual([
      'auto-link-other-org', organizationId, organizationId,
    ]);
  });

  it('refreshes once after the TTL expires', async () => {
    const now = spyOn(Date, 'now').mockReturnValue(1_000);
    await link('Acme');
    now.mockReturnValue(60_999);
    await link('Acme');
    expect(sql).toHaveBeenCalledTimes(1);
    now.mockReturnValue(61_000);
    const pending = Promise.withResolvers<typeof entities>();
    sql.mockReturnValueOnce(pending.promise);
    const calls = [link('Acme'), link('Acme')];
    expect(sql).toHaveBeenCalledTimes(2);
    pending.resolve([...entities]);
    await Promise.all(calls);
  });

  it('propagates a failed fetch to all waiters and retries the next call', async () => {
    const pending = Promise.withResolvers<typeof entities>();
    sql.mockReturnValueOnce(pending.promise);
    const calls = Promise.allSettled([link('Acme'), link('Acme')]);
    const error = new Error('query failed');
    pending.reject(error);
    expect(await calls).toEqual([
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error },
    ]);
    expect(sql).toHaveBeenCalledTimes(1);
    await link('Acme');
    expect(sql).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
