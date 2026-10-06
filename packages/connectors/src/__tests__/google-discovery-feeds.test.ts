import { describe, expect, test } from 'bun:test';
import type { EventEnvelope } from '@lobu/connector-sdk';
import { type DiscoveryDocument, discoveryMethods } from '../_google/discovery';
import { listMethod, type SyncTokenFeed, syncTokenSync } from '../_google/list-feed';
import { GOOGLE_API_POLICIES } from '../_google/policies';
import { runSync } from './sync-harness';

const docs: Record<string, DiscoveryDocument> = Object.fromEntries(
  await Promise.all(
    Object.keys(GOOGLE_API_POLICIES).map(async (api) => [
      api,
      (await import(`../_google/discovery/${api}.json`)).default as DiscoveryDocument,
    ])
  )
);

describe('feed shape resolved from Discovery alone', () => {
  test('every unambiguous paginated list method resolves its items array and page-size param', () => {
    const rows: Array<Record<string, unknown>> = [];
    const failures: string[] = [];
    for (const doc of Object.values(docs)) {
      for (const method of discoveryMethods(doc)) {
        if (method.httpMethod !== 'GET' || !method.parameters?.pageToken) continue;
        try {
          const list = listMethod(doc, method.id);
          rows.push({
            method: method.id,
            items: list.itemsKey,
            pageSize: list.pageSizeParam,
            syncToken: list.supportsSyncToken,
          });
        } catch (error) {
          failures.push(`${method.id}: ${(error as Error).message}`);
        }
      }
    }
    console.log(`${rows.length} list methods resolved; syncToken-capable:`);
    console.table(rows.filter((r) => r.syncToken));
    // The one ambiguous response (both `results` and `spaces`) is refused, not
    // guessed: a feed over it must name its page array.
    expect(failures).toEqual([
      'chat.spaces.search: chat.spaces.search has 2 record arrays in its response; declare which one is the page',
    ]);

    const byId = Object.fromEntries(rows.map((r) => [r.method, r]));
    expect(byId['calendar.events.list']).toMatchObject({ items: 'items', pageSize: 'maxResults', syncToken: true });
    expect(byId['people.people.connections.list']).toMatchObject({ items: 'connections', pageSize: 'pageSize', syncToken: true });
    expect(byId['drive.changes.list']).toMatchObject({ items: 'changes' });
    expect(byId['gmail.users.history.list']).toMatchObject({ items: 'history' });
    expect(byId['tasks.tasks.list']).toMatchObject({ items: 'items', syncToken: false });
  });
});

/**
 * A feed the platform does not have today, declared in ~15 lines against the
 * same engine Calendar runs on. People's own protocol detail: the bootstrap
 * must ASK for a sync token (`requestSyncToken`), and `personFields` is
 * required on every request, incremental ones included.
 */
const CONTACTS: SyncTokenFeed<Record<string, unknown>> = {
  list: listMethod(docs.people_v1, 'people.people.connections.list'),
  path: () => ({ resourceName: 'people/me' }),
  pageSize: 1000,
  scope: () => [1],
  budget: () => 5000,
  bootstrap: () => ({ personFields: 'names,emailAddresses,metadata', requestSyncToken: 'true' }),
  incremental: () => ({ personFields: 'names,emailAddresses,metadata' }),
  requireSyncToken: true,
  toEnvelope: (person) => {
    const p = person as {
      resourceName: string;
      names?: Array<{ displayName?: string }>;
      emailAddresses?: Array<{ value?: string }>;
      metadata?: { deleted?: boolean };
    };
    return {
      origin_id: p.resourceName,
      origin_type: 'contact',
      title: p.names?.[0]?.displayName ?? p.resourceName,
      payload_text: (p.emailAddresses ?? []).map((e) => e.value).join(', '),
      occurred_at: new Date(0),
      metadata: { change_type: p.metadata?.deleted ? 'deleted' : 'upserted' },
    } satisfies EventEnvelope;
  },
};

function peopleHttp(pages: Array<{ status?: number; body: Record<string, unknown> }>) {
  const urls: URL[] = [];
  let i = 0;
  return {
    urls,
    client: {
      raw: async (url: string) => {
        urls.push(new URL(url));
        const page = pages[i++];
        return new Response(JSON.stringify(page.body), { status: page.status ?? 200 });
      },
    },
  };
}

describe('People contacts feed on the shared syncToken engine', () => {
  test('bootstraps, goes incremental, carries deletions, and recovers an expired token', async () => {
    const http = peopleHttp([
      { body: { connections: [{ resourceName: 'people/c1', names: [{ displayName: 'Ada' }] }], nextPageToken: 'p2' } },
      { body: { connections: [{ resourceName: 'people/c2' }], nextSyncToken: 'S1' } },
      { body: { connections: [{ resourceName: 'people/c1', metadata: { deleted: true } }], nextSyncToken: 'S2' } },
      { status: 410, body: { error: { code: 410, message: 'Sync token is expired.', status: 'FAILED_PRECONDITION' } } },
      { body: { connections: [{ resourceName: 'people/c2' }], nextSyncToken: 'S3' } },
    ]);
    const ctx = { feedKey: 'contacts', config: {}, credentials: { accessToken: 't' } as never, entityIds: [] };
    const run = (checkpoint: Record<string, unknown> | null) =>
      runSync({ sync: (c) => syncTokenSync(CONTACTS, c as never, http.client as never) }, { ...ctx, checkpoint });

    const full = await run(null);
    expect(full.events.map((e) => e.origin_id)).toEqual(['people/c1', 'people/c2']);
    expect(full.checkpoint).toMatchObject({ sync_token: 'S1' });
    expect(http.urls[0].pathname).toBe('/v1/people/me/connections');
    expect(http.urls[0].searchParams.get('requestSyncToken')).toBe('true');
    expect(http.urls[1].searchParams.get('pageToken')).toBe('p2');

    const incremental = await run(full.checkpoint);
    expect(http.urls[2].searchParams.get('syncToken')).toBe('S1');
    expect(http.urls[2].searchParams.get('personFields')).toBe('names,emailAddresses,metadata');
    expect(incremental.events[0].metadata).toMatchObject({ change_type: 'deleted' });

    const recovered = await run(incremental.checkpoint);
    expect(http.urls[3].searchParams.get('syncToken')).toBe('S2');
    expect(http.urls[4].searchParams.has('syncToken')).toBe(false);
    expect(recovered.checkpoint).toMatchObject({ sync_token: 'S3' });
  });
});
