import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let GmailConnector: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let isPersonRelevantSender: any;

beforeAll(async () => {
  const mod = await import('../google_gmail');
  GmailConnector = mod.default;
  isPersonRelevantSender = mod.isPersonRelevantSender;
});

interface FakeMessage {
  id: string;
  body?: string;
  labelIds?: string[];
  from?: string;
  to?: string;
  cc?: string;
  listId?: string;
  precedence?: string;
  date?: string;
}

interface FakeThread {
  id: string;
  messages: FakeMessage[];
}

/**
 * Fake Gmail HTTP client: serves paginated threads.list and threads/<id>
 * lookups from the given fixtures. Header values come from the per-message
 * `from`/`date` fields; snippets are constant. `failThreadIds` respond 404.
 */
function fakeHttp(
  threads: FakeThread[],
  onRequest?: (url: string) => void,
  failThreadIds: ReadonlySet<string> = new Set()
) {
  const byId = new Map(threads.map((t) => [t.id, t]));
  return {
    raw: async (url: string) => {
      onRequest?.(url);
      const u = new URL(url);
      const threadMatch = u.pathname.match(/\/threads\/([^/]+)$/);
      if (threadMatch && failThreadIds.has(threadMatch[1])) {
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
          text: async () => '',
        } as unknown as Response;
      }
      const body = threadMatch
        ? toThreadResponse(byId.get(threadMatch[1]))
        : (() => {
            const start = Number(u.searchParams.get('pageToken') ?? 0);
            const limit = Number(u.searchParams.get('maxResults') ?? 100);
            return {
              threads: threads.slice(start, start + limit).map((t) => ({ id: t.id, historyId: '1', snippet: 's' })),
              ...(start + limit < threads.length ? { nextPageToken: String(start + limit) } : {}),
            };
          })();
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => '',
      } as unknown as Response;
    },
  };
}

function toThreadResponse(thread: FakeThread | undefined) {
  if (!thread) return { id: 'missing', historyId: '1', messages: [] };
  return {
    id: thread.id,
    historyId: '1',
    messages: thread.messages.map((m) => ({
      id: m.id,
      threadId: thread.id,
      labelIds: m.labelIds ?? [],
      snippet: 'snippet',
      internalDate: String(Date.parse(m.date ?? '2026-07-01T10:00:00Z')),
      payload: {
        mimeType: 'text/plain',
        ...(m.body ? { body: { data: Buffer.from(m.body).toString('base64url') } } : {}),
        headers: [
          { name: 'Subject', value: `subject ${thread.id}` },
          { name: 'From', value: m.from ?? 'Some One <someone@example.com>' },
          ...(m.to ? [{ name: 'To', value: m.to }] : []),
          ...(m.cc ? [{ name: 'Cc', value: m.cc }] : []),
          ...(m.listId ? [{ name: 'List-Id', value: m.listId }] : []),
          ...(m.precedence ? [{ name: 'Precedence', value: m.precedence }] : []),
          { name: 'Date', value: m.date ?? '2026-07-01T10:00:00Z' },
        ],
      },
    })),
  };
}

async function syncThreads(threads: FakeThread[], config: Record<string, unknown> = {}) {
  const connector = new GmailConnector();
  connector.createClient = () => fakeHttp(threads);
  const result = await connector.sync({
    feedKey: 'threads',
    config,
    credentials: { accessToken: 'tok' },
    checkpoint: {},
  });
  return result.events as Array<{ origin_id: string; metadata: Record<string, unknown> }>;
}

test('the checkpoint precedes sync requests so messages arriving during sync remain eligible', async () => {
  const connector = new GmailConnector();
  let firstRequestAt = Number.POSITIVE_INFINITY;
  connector.createClient = () =>
    fakeHttp([], () => {
      firstRequestAt = Math.min(firstRequestAt, Date.now());
    });

  const result = await connector.sync({
    feedKey: 'threads',
    config: {},
    credentials: { accessToken: 'tok' },
    checkpoint: {},
  });

  expect(firstRequestAt).toBeFinite();
  expect(new Date(result.checkpoint.last_sync_at).getTime()).toBeLessThanOrEqual(firstRequestAt);
});

test('person-building sync requests its label union and attribution headers', async () => {
  const urls: string[] = [];
  const connector = new GmailConnector();
  connector.createClient = () =>
    fakeHttp(
      [
        {
          id: 't-human',
          messages: [
            { id: 'm1', labelIds: ['INBOX'], from: 'Jane Doe <jane@acme.example>' },
          ],
        },
      ],
      (url) => urls.push(url)
    );

  await connector.sync({
    feedKey: 'threads',
    config: { labels: [' INBOX ', 'SENT'], human_senders_only: true },
    credentials: { accessToken: 'tok' },
    checkpoint: {},
  });

  expect(new URL(urls[0]).searchParams.get('q')).toContain('{label:INBOX label:SENT}');
  const threadUrl = urls.find((url) => url.includes('/threads/t-human')) ?? '';
  expect(new URL(threadUrl).searchParams.get('format')).toBe('full');
});

describe('Gmail replied signal (promote-on-interaction)', () => {
  test('an inbound-only thread is NOT replied — a bulk sender/brand never clears the bar', async () => {
    const events = await syncThreads([
      {
        id: 't-brand',
        messages: [
          { id: 'm1', labelIds: ['INBOX'], from: 'Brand <promo@brand.example>' },
          { id: 'm2', labelIds: ['INBOX'], from: 'Brand <promo@brand.example>' },
        ],
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].metadata.replied).toBe(false);
    expect(events[0].metadata.from_email).toBe('promo@brand.example');
  });

  test('a counterparty-started thread the owner replied in IS replied', async () => {
    const events = await syncThreads([
      {
        id: 't-alice',
        messages: [
          { id: 'm1', labelIds: ['INBOX'], from: 'Alice <alice@example.com>' },
          { id: 'm2', labelIds: ['SENT'], from: 'Me <me@example.com>' },
        ],
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].metadata.replied).toBe(true);
    expect(events[0].metadata.from_email).toBe('alice@example.com');
  });

  test('an owner-started thread with a counterparty reply is bidirectional and attributes the counterparty', async () => {
    const events = await syncThreads([
      {
        id: 't-self',
        messages: [
          { id: 'm1', labelIds: ['SENT'], from: 'Me <me@example.com>' },
          { id: 'm2', labelIds: ['INBOX'], from: 'Bob <bob@example.com>' },
        ],
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].metadata.replied).toBe(true);
    expect(events[0].metadata.from_email).toBe('bob@example.com');
  });
});

describe('Gmail person attribution rule', () => {
  test('bumps the connector version for the changed sync contract', () => {
    expect(new GmailConnector().definition.version).toBe('1.0.6');
  });

  test('autoCreate is gated on person_relevant, with a legacy replied rule for pre-refresh payloads', () => {
    const connector = new GmailConnector();
    const rules = connector.definition.feeds.threads.eventKinds.thread.attributions;
    expect(rules).toHaveLength(2);
    const byGate = Object.fromEntries(
      rules.map((rule) => [JSON.stringify(rule.target.createWhen), rule])
    );
    expect(byGate['{"path":"metadata.person_relevant","equals":true}']).toBeDefined();
    expect(byGate['{"path":"metadata.replied","equals":true}']).toBeDefined();
    for (const rule of rules) {
      expect(rule.role).toBe('authored_by');
      expect(rule.autoCreate).toBe(true);
      expect(rule.target.entityType).toBe('person');
      expect(rule.target.identities).toEqual([
        { namespace: 'email', eventPath: 'metadata.from_email' },
      ]);
    }
  });
});

describe('isPersonRelevantSender', () => {
  test('a reply makes a non-role sender relevant but never turns a role mailbox into a person', () => {
    expect(isPersonRelevantSender('promo@brand.example', 'Brand', true)).toBe(true);
    expect(isPersonRelevantSender('noreply@brand.example', 'No Reply', true)).toBe(false);
  });

  test('automated / shared local-parts never pass on receipt alone', () => {
    for (const email of [
      'noreply@brand.example',
      'no-reply@brand.example',
      'noreply+receipt@brand.example',
      'donotreply@brand.example',
      'bounce@mailer.example',
      'mailer-daemon@example.com',
      'postmaster@example.com',
      'info@acme.example',
      'marketing@acme.example',
      'support@acme.example',
      'hello@acme.example',
      'notifications@acme.example',
      'alerts@acme.example',
      'team@acme.example',
      'newsletter@acme.example',
    ]) {
      expect(isPersonRelevantSender(email, 'Acme', false)).toBe(false);
    }
  });

  test('consumer-mail domains pass even without a display name', () => {
    expect(isPersonRelevantSender('jane.doe@gmail.com', null, false)).toBe(true);
    expect(isPersonRelevantSender('bob@proton.me', '', false)).toBe(true);
  });

  test('a human-looking name passes a corporate domain', () => {
    expect(isPersonRelevantSender('john.smith@acme.example', 'John Smith', false)).toBe(true);
  });

  test('single-word brands and unnamed corporate addresses fail', () => {
    expect(isPersonRelevantSender('team@linkedin.example', 'LinkedIn', false)).toBe(false);
    expect(isPersonRelevantSender('john.smith@acme.example', null, false)).toBe(false);
  });

  test('plural role local-parts are rejected too (newsletters, contacts)', () => {
    expect(isPersonRelevantSender('newsletters@acme.example', 'Acme Newsletters', false)).toBe(false);
    expect(isPersonRelevantSender('contacts@acme.example', 'Acme Contacts', false)).toBe(false);
  });

  test('missing / unparseable addresses are never human', () => {
    expect(isPersonRelevantSender(null, 'John Smith', false)).toBe(false);
    expect(isPersonRelevantSender('not-an-email', 'John Smith', false)).toBe(false);
    expect(isPersonRelevantSender('', 'John Smith', false)).toBe(false);
  });
});

describe('Gmail human_senders_only sync mode', () => {
  test('drops brand/automated threads and emits only person-relevant ones', async () => {
    const events = await syncThreads(
      [
        {
          id: 't-brand',
          messages: [
            { id: 'm1', labelIds: ['INBOX'], from: 'Brand <promo@brand.example>' },
          ],
        },
        {
          id: 't-human',
          messages: [
            { id: 'm1', labelIds: ['INBOX'], from: 'Jane Doe <jane@acme.example>' },
          ],
        },
      ],
      { human_senders_only: true }
    );
    expect(events.map((e) => e.origin_id).sort()).toEqual(['t-human']);
    expect(events[0].metadata.person_relevant).toBe(true);
    expect(events[0].metadata.replied).toBe(false);
    expect(events[0].metadata.from_email).toBe('jane@acme.example');
  });

  test('stamps person_relevant on replied threads and keeps them', async () => {
    const events = await syncThreads(
      [
        {
          id: 't-alice',
          messages: [
            { id: 'm1', labelIds: ['INBOX'], from: 'Alice <alice@example.com>' },
            { id: 'm2', labelIds: ['SENT'], from: 'Me <me@example.com>' },
          ],
        },
      ],
      { human_senders_only: true }
    );
    expect(events).toHaveLength(1);
    expect(events[0].metadata.person_relevant).toBe(true);
    expect(events[0].metadata.replied).toBe(true);
  });

  test('an outbound-only thread attributes the recipient via the To header', async () => {
    const events = await syncThreads(
      [
        {
          id: 't-out',
          messages: [
            {
              id: 'm1',
              labelIds: ['SENT'],
              from: 'Me <me@example.com>',
              to: 'Bob Smith <bob@example.com>',
            },
          ],
        },
      ],
      { human_senders_only: true }
    );
    expect(events).toHaveLength(1);
    expect(events[0].metadata.replied).toBe(false);
    expect(events[0].metadata.person_relevant).toBe(true);
    expect(events[0].metadata.from_email).toBe('bob@example.com');
    expect(events[0].metadata.from_name).toBe('Bob Smith');
  });

  test('skips a role recipient and attributes a human beside it', async () => {
    const events = await syncThreads(
      [
        {
          id: 't-mixed',
          messages: [
            {
              id: 'm1',
              labelIds: ['SENT'],
              from: 'Me <me@example.com>',
              to: 'support@vendor.example, Jane Doe <jane@acme.example>',
            },
          ],
        },
      ],
      { human_senders_only: true }
    );
    expect(events).toHaveLength(1);
    expect(events[0].metadata.from_email).toBe('jane@acme.example');
  });

  test('attributes a human reply instead of the automated sender that opened the thread', async () => {
    const events = await syncThreads(
      [
        {
          id: 't-bot-first',
          messages: [
            {
              id: 'm1',
              labelIds: ['INBOX'],
              from: 'Notifications <notifications@vendor.example>',
            },
            {
              id: 'm2',
              labelIds: ['INBOX'],
              from: 'Jane Doe <jane@acme.example>',
            },
            {
              id: 'm3',
              labelIds: ['SENT'],
              from: 'Me <me@example.com>',
              to: 'Jane Doe <jane@acme.example>',
            },
          ],
        },
      ],
      { human_senders_only: true }
    );
    expect(events).toHaveLength(1);
    expect(events[0].metadata.from_email).toBe('jane@acme.example');
  });

  test('does not count a case-varying copy of the mailbox owner as a reply', async () => {
    const events = await syncThreads(
      [
        {
          id: 't-self-copy',
          messages: [
            {
              id: 'm1',
              labelIds: ['SENT'],
              from: 'Me <ME@example.com>',
              to: 'Jane Doe <jane@acme.example>',
            },
            { id: 'm2', labelIds: ['INBOX'], from: 'me@EXAMPLE.com' },
          ],
        },
      ],
      { human_senders_only: true }
    );
    expect(events).toHaveLength(1);
    expect(events[0].metadata.replied).toBe(false);
    expect(events[0].metadata.from_email).toBe('jane@acme.example');
  });

  test('fails closed on outbound attribution when the mailbox address is unknown', async () => {
    const events = await syncThreads(
      [
        {
          id: 't-no-self',
          messages: [
            {
              id: 'm1',
              labelIds: ['SENT'],
              from: '',
              to: 'Jane Doe <jane@acme.example>',
            },
          ],
        },
      ],
      { human_senders_only: true }
    );
    expect(events).toHaveLength(0);
  });

  test('drops list threads and unreplied wide broadcasts', async () => {
    const events = await syncThreads(
      [
        {
          id: 't-list',
          messages: [
            {
              id: 'm1',
              labelIds: ['SENT'],
              from: 'Me <me@example.com>',
              to: 'Jane Doe <jane@acme.example>',
              listId: '<people.vendor.example>',
            },
          ],
        },
        {
          id: 't-blast',
          messages: [
            {
              id: 'm1',
              labelIds: ['SENT'],
              from: 'Me <me@example.com>',
              to: 'Alice One <a@one.example>, Bob Two <b@two.example>',
              cc: 'Carol Three <c@three.example>, David Four <d@four.example>',
            },
          ],
        },
      ],
      { human_senders_only: true }
    );
    expect(events).toHaveLength(0);
  });

  test('default mode keeps replied semantics and stamps person_relevant = replied', async () => {
    const events = await syncThreads([
      {
        id: 't-alice',
        messages: [
          { id: 'm1', labelIds: ['INBOX'], from: 'Alice <alice@example.com>' },
          { id: 'm2', labelIds: ['SENT'], from: 'Me <me@example.com>' },
        ],
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].metadata.replied).toBe(true);
    expect(events[0].metadata.person_relevant).toBe(true);
  });

  test('a Gmail plus-tag copy of the mailbox owner is never treated as external', async () => {
    const events = await syncThreads(
      [
        {
          id: 't-tag-self',
          messages: [
            { id: 'm1', labelIds: ['SENT'], from: 'Me <me+archive@example.com>' },
            {
              id: 'm2',
              labelIds: ['INBOX'],
              from: 'me@example.com',
            },
          ],
        },
      ],
      { human_senders_only: true }
    );
    // The INBOX copy is the owner via a +tag alias, not a reply from a person.
    expect(events).toHaveLength(0);
  });

  test('a self-authored DRAFT is never attributed as the counterparty', async () => {
    const events = await syncThreads(
      [
        {
          id: 't-draft',
          messages: [
            // Role-address INBOX message first, then an unsent self-authored draft.
            { id: 'm1', labelIds: ['INBOX'], from: 'Support <support@vendor.example>' },
            {
              id: 'm2',
              labelIds: ['DRAFT'],
              from: 'Me <me@example.com>',
              to: 'Jane Doe <jane@acme.example>',
            },
          ],
        },
      ],
      { human_senders_only: true }
    );
    // The DRAFT is self-authored — no person-relevant counterparty exists.
    expect(events).toHaveLength(0);
  });

  test('attributes a human Cc recipient when the To is a role address', async () => {
    const events = await syncThreads(
      [
        {
          id: 't-cc',
          messages: [
            {
              id: 'm1',
              labelIds: ['SENT'],
              from: 'Me <me@example.com>',
              to: 'support@vendor.example',
              cc: 'Jane Doe <jane@acme.example>',
            },
          ],
        },
      ],
      { human_senders_only: true }
    );
    expect(events).toHaveLength(1);
    expect(events[0].metadata.from_email).toBe('jane@acme.example');
  });

  test('attributes a human recipient on a later sent message, not the first', async () => {
    const events = await syncThreads(
      [
        {
          id: 't-later-sent',
          messages: [
            {
              id: 'm1',
              labelIds: ['SENT'],
              from: 'Me <me@example.com>',
              to: 'team@vendor.example',
            },
            {
              id: 'm2',
              labelIds: ['SENT'],
              from: 'Me <me@example.com>',
              to: 'Bob Smith <bob@example.com>',
            },
          ],
        },
      ],
      { human_senders_only: true }
    );
    expect(events).toHaveLength(1);
    expect(events[0].metadata.from_email).toBe('bob@example.com');
  });

  test('failed thread GETs consume max_results (cap bounds API calls)', async () => {
    const connector = new GmailConnector();
    const urls: string[] = [];
    connector.createClient = () =>
      fakeHttp(
        [
          {
            id: 't-missing',
            messages: [
              { id: 'm1', labelIds: ['INBOX'], from: 'Bob <bob@acme.example>' },
            ],
          },
          {
            id: 't-ok',
            messages: [
              { id: 'm1', labelIds: ['INBOX'], from: 'Jane Doe <jane@acme.example>' },
            ],
          },
        ],
        (url) => urls.push(url),
        new Set(['t-missing'])
      );

    await connector.sync({
      feedKey: 'threads',
      config: { max_results: 1, human_senders_only: true },
      credentials: { accessToken: 'tok' },
      checkpoint: {},
    });

    // max_results=1: the 404 consumes the cap, so only ONE thread GET runs.
    const threadGets = urls.filter((url) => url.includes('/threads/'));
    expect(threadGets).toHaveLength(1);
    expect(threadGets[0]).toContain('t-missing');
  });
});

describe('Gmail write scope', () => {
  // create_draft POSTs to /drafts, which the Gmail API authorizes only under
  // gmail.compose (or the broader gmail.modify) — gmail.readonly and gmail.send
  // are both insufficient for drafts.create. compose must be REQUIRED, not
  // optional: optional scopes are only sent when the caller explicitly requests
  // them, so an unadorned connect() would omit it and create_draft would 403.
  test('compose is a required scope so create_draft/reply/send_email are authorized', () => {
    const connector = new GmailConnector();
    const oauth = connector.definition.authSchema.methods.find(
      (m: { type: string }) => m.type === 'oauth'
    );
    expect(oauth.requiredScopes).toContain('https://www.googleapis.com/auth/gmail.compose');

    const actions = connector.definition.actions;
    for (const key of ['create_draft', 'reply', 'send_email']) {
      expect(actions[key]).toBeDefined();
      expect(actions[key].key).toBe(key);
    }
  });
});

describe('complete Gmail sync input', () => {
  const context = (checkpoint: Record<string, unknown> = {}, config: Record<string, unknown> = {}) => ({
    feedKey: 'threads', credentials: { accessToken: 'synthetic-token' }, checkpoint, config,
  });

  test('stores full text of every reply and dates the thread by its newest message', async () => {
    const connector = new GmailConnector();
    const urls: string[] = [];
    connector.createClient = () => fakeHttp([{ id: 'thread-full', messages: [
      { id: 'first', date: '2026-07-01T10:00:00Z', body: 'Original request with details past the snippet.' },
      { id: 'reply', date: '2026-07-02T11:00:00Z', body: 'The work is complete. Teşekkürler.' },
    ] }], (url) => urls.push(url));
    const result = await connector.sync(context());
    expect(result.events[0].payload_text).toContain('Original request with details past the snippet.');
    expect(result.events[0].payload_text).toContain('The work is complete. Teşekkürler.');
    expect(result.events[0].occurred_at.toISOString()).toBe('2026-07-02T11:00:00.000Z');
    expect(new URL(urls[1]).searchParams.get('format')).toBe('full');
    expect(result.events[0].origin_id).toBe('thread-full');
  });

  test('honors the already-declared search scope instead of silently using INBOX', async () => {
    const connector = new GmailConnector();
    const urls: string[] = [];
    connector.createClient = () => fakeHttp([], (url) => urls.push(url));
    await connector.sync(context({}, { query: '-in:spam -in:trash', labels: ['INBOX', 'SENT'] }));
    const query = new URL(urls[0]).searchParams.get('q');
    expect(query).toContain('-in:spam -in:trash');
    expect(query).not.toContain('label:INBOX');
  });

  test('resumes the next page without advancing past unprocessed mail', async () => {
    const connector = new GmailConnector();
    const urls: string[] = [];
    connector.createClient = () => ({ raw: async (url: string) => {
      urls.push(url);
      const u = new URL(url);
      const id = u.pathname.match(/\/threads\/([^/]+)$/)?.[1];
      return { ok: true, status: 200, json: async () => id
        ? toThreadResponse({ id, messages: [{ id: 'm-' + id, body: id }] })
        : u.searchParams.get('pageToken') === 'page-two'
          ? { threads: [{ id: 'older' }] }
          : { threads: [{ id: 'newer' }], nextPageToken: 'page-two' },
      };
    } });
    const prior = { last_sync_at: '2026-07-01T00:00:00Z' };
    const first = await connector.sync(context(prior, { max_results: 1 }));
    expect(first.checkpoint.last_sync_at).toBeUndefined();
    expect(first.checkpoint.pending.page_token).toBe('page-two');
    // A different lookback must not re-cut a window that is mid-walk: the stored
    // page token only means anything against the query it was issued for.
    const second = await connector.sync(context(first.checkpoint, { max_results: 1, lookback_days: 1 }));
    expect(first.events.map((event) => event.origin_id)).toEqual(['newer']);
    expect(second.events.map((event) => event.origin_id)).toEqual(['older']);
    const lists = urls.filter((url) => !new URL(url).pathname.match(/\/threads\//)).map((url) => new URL(url));
    expect(lists[1].searchParams.get('pageToken')).toBe('page-two');
    expect(lists[1].searchParams.get('q')).toBe(lists[0].searchParams.get('q'));
    expect(new Date(second.checkpoint.last_sync_at).getTime()).toBeGreaterThan(Date.parse(prior.last_sync_at));
  });

  test('keeps an empty page with a continuation token pending', async () => {
    const connector = new GmailConnector();
    connector.createClient = () => ({ raw: async () => ({
      ok: true, json: async () => ({ threads: [], nextPageToken: 'continue-empty' }),
    }) });
    const prior = { last_sync_at: '2026-07-01T00:00:00Z' };
    const result = await connector.sync(context(prior));
    expect(result.events).toEqual([]);
    expect(result.checkpoint.last_sync_at).toBeUndefined();
    expect(result.checkpoint.pending.page_token).toBe('continue-empty');
  });

  test('rejects a repeated token instead of recording a completed window', async () => {
    const connector = new GmailConnector();
    connector.createClient = () => ({ raw: async () => ({
      ok: true, json: async () => ({ threads: [], nextPageToken: 'same' }),
    }) });
    await expect(connector.sync(context({ schema_version: 3, scope: JSON.stringify(['label:INBOX', false]), pending: {
      query: 'after:1 before:2 (label:INBOX)',
      started_at: '2026-07-02T00:00:00Z', page_token: 'same',
    } }))).rejects.toThrow('repeated page token');
  });

  test('revisits the lookback when replacing snippet checkpoints or widening the filter', async () => {
    const connector = new GmailConnector();
    const urls: string[] = [];
    connector.createClient = () => fakeHttp([], (url) => urls.push(url));
    const old = { last_sync_at: new Date(Date.now() - 60_000).toISOString() };
    const first = await connector.sync(context(old, { lookback_days: 30 }));
    const after = Number(new URL(urls[0]).searchParams.get('q')?.match(/after:(\d+)/)?.[1]);
    expect(after).toBeLessThan(Date.parse(old.last_sync_at) / 1000 - 29 * 86400);
    expect(first.checkpoint.schema_version).toBe(3);
    await connector.sync(context(first.checkpoint, { query: '-in:spam -in:trash', lookback_days: 30 }));
    const widenedAfter = Number(new URL(urls[1]).searchParams.get('q')?.match(/after:(\d+)/)?.[1]);
    expect(widenedAfter).toBeLessThan(Date.parse(old.last_sync_at) / 1000 - 29 * 86400);
  });

  test('preserves a long body including actions beyond an arbitrary preview cap', async () => {
    const connector = new GmailConnector();
    const body = 'x'.repeat(200_000) + ' Please submit the signed agreement.';
    connector.createClient = () => fakeHttp([{ id: 'thread-long', messages: [{ id: 'long', body }] }]);
    const result = await connector.sync(context());
    expect(result.events[0].payload_text).toContain(body);
  });

  test.each(['empty', 'undated'])('does not advance past malformed %s thread data', async (kind) => {
    const connector = new GmailConnector();
    connector.createClient = () => ({ raw: async (url: string) => ({
      ok: true, status: 200, json: async () => url.includes('/threads/')
        ? kind === 'empty' ? { id: kind, messages: [] }
          : toThreadResponse({ id: kind, messages: [{ id: 'm', date: 'invalid-date' }] })
        : { threads: [{ id: kind }] },
    }) });
    await expect(connector.sync(context())).rejects.toThrow(/Gmail returned/);
  });

  test('restarts the window when Gmail retires the stored page token', async () => {
    const connector = new GmailConnector();
    const urls: string[] = [];
    connector.createClient = () => ({
      raw: async (url: string) => {
        urls.push(url);
        const u = new URL(url);
        const id = u.pathname.match(/\/threads\/([^/]+)$/)?.[1];
        if (id) return { ok: true, status: 200, json: async () => toThreadResponse({ id, messages: [{ id: `m-${id}` }] }) };
        if (u.searchParams.get('pageToken') === 'retired') {
          return { ok: false, status: 400, text: async () => 'Invalid pageToken' };
        }
        return { ok: true, status: 200, json: async () => ({ threads: [{ id: 'first-page' }] }) };
      },
    });
    const result = await connector.sync(
      context({
        schema_version: 3,
        scope: JSON.stringify(['label:INBOX', false]),
        pending: { query: 'after:1 before:2 (label:INBOX)', started_at: '2026-07-02T00:00:00Z', page_token: 'retired' },
      })
    );
    // Same window, first page — not a fresh window, and not a wedged run.
    const lists = urls.filter((url) => !url.includes('/threads/'));
    expect(lists).toHaveLength(2);
    expect(new URL(lists[1]).searchParams.get('pageToken')).toBeNull();
    expect(new URL(lists[1]).searchParams.get('q')).toBe('after:1 before:2 (label:INBOX)');
    expect(result.events.map((event) => event.origin_id)).toEqual(['first-page']);
    expect(result.checkpoint.last_sync_at).toBe('2026-07-02T00:00:00Z');
    expect(result.checkpoint.pending).toBeUndefined();
  });

  test('propagates a non-cursor list failure instead of restarting the window', async () => {
    const connector = new GmailConnector();
    connector.createClient = () => ({
      raw: async () => ({ ok: false, status: 429, text: async () => 'rate limited' }),
    });
    await expect(
      connector.sync(
        context({
          schema_version: 3,
          scope: JSON.stringify(['label:INBOX', false]),
          pending: { query: 'after:1 before:2 (label:INBOX)', started_at: '2026-07-02T00:00:00Z', page_token: 'live' },
        })
      )
    ).rejects.toThrow(/429/);
  });

  test('does not checkpoint past a failed thread fetch', async () => {
    const connector = new GmailConnector();
    connector.createClient = () => ({ raw: async (url: string) =>
      url.includes('/threads/')
        ? { ok: false, status: 503, text: async () => 'provider unavailable' }
        : { ok: true, json: async () => ({ threads: [{ id: 'retry-me' }] }) },
    });
    await expect(connector.sync(context())).rejects.toThrow(/503/);
  });
});

describe('Gmail externally stored message bodies', () => {
  const BODY = 'Full body: please sign the agreement.';
  const syncContext = {
    feedKey: 'threads',
    config: {},
    checkpoint: {},
    credentials: { accessToken: 'synthetic-token' },
  };

  function setup(attachmentStatus = 200) {
    const connector = new GmailConnector();
    const urls: string[] = [];
    connector.createClient = () => ({
      raw: async (url: string) => {
        urls.push(url);
        const attachment = url.includes('/attachments/');
        return {
          ok: !attachment || attachmentStatus === 200,
          status: attachment ? attachmentStatus : 200,
          text: async () => 'body fetch failed',
          json: async () => {
            if (attachment) return { data: Buffer.from(BODY).toString('base64url') };
            if (!url.includes('/threads/')) return { threads: [{ id: 'thread-body' }] };
            return {
              id: 'thread-body',
              messages: [
                {
                  id: 'message-body',
                  internalDate: '1783558800000',
                  snippet: 'Short preview',
                  payload: {
                    mimeType: 'multipart/mixed',
                    headers: [],
                    parts: [
                      // An attached text file sits beside the body in the same
                      // container and must not be mistaken for it.
                      { mimeType: 'text/plain', filename: 'notes.txt', body: { attachmentId: 'excluded-file' } },
                      {
                        mimeType: 'multipart/alternative',
                        parts: [{ mimeType: 'text/plain', body: { attachmentId: 'body-ref', size: 43 } }],
                      },
                    ],
                  },
                },
              ],
            };
          },
        };
      },
    });
    return { connector, urls };
  }

  test.each(['sync', 'get_thread'])(
    '%s retrieves the text body reference without treating an attached file as the body',
    async (mode) => {
      const { connector, urls } = setup();
      const body =
        mode === 'sync'
          ? (await connector.sync(syncContext)).events[0].payload_text
          : (
              await connector.execute({
                actionKey: 'get_thread',
                input: { thread_id: 'thread-body' },
                credentials: { accessToken: 'synthetic-token' },
              })
            ).output.messages[0].body;
      expect(body).toContain(BODY);
      expect(urls.filter((url) => url.includes('/attachments/'))).toEqual([
        'https://www.googleapis.com/gmail/v1/users/me/messages/message-body/attachments/body-ref',
      ]);
    }
  );

  test('a failed external body fetch cannot advance the sync checkpoint', async () => {
    const { connector } = setup(503);
    await expect(connector.sync(syncContext)).rejects.toThrow(/503/);
  });
});

describe('Gmail empty MIME alternatives', () => {
  const html = '<p>Please confirm the delivery date.</p>';
  const context = { feedKey: 'threads', config: {}, checkpoint: {}, credentials: { accessToken: 'synthetic-token' } };

  function setup(plainBody: Record<string, unknown>, attachmentStatus = 200) {
    const connector = new GmailConnector();
    const thread = toThreadResponse({ id: 'alternatives', messages: [{ id: 'message' }] });
    const payload = {
      ...thread.messages[0].payload,
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: plainBody },
        { mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64url') } },
      ],
    };
    connector.createClient = () => ({ raw: async (url: string) => ({
      ok: !url.includes('/attachments/') || attachmentStatus === 200,
      status: attachmentStatus,
      text: async () => 'body unavailable',
      json: async () => url.includes('/attachments/') ? { data: '' }
        : url.includes('/threads/') ? { ...thread, messages: [{ ...thread.messages[0], payload }] }
        : { threads: [{ id: 'alternatives' }] },
    }) });
    return connector;
  }

  for (const mode of ['sync', 'get_thread']) {
    test.each([
      ['empty inline', { data: '', size: 0 }],
      ['absent', {}],
      ['whitespace', { data: Buffer.from(' \r\n').toString('base64url') }],
      ['empty external', { attachmentId: 'empty-body', size: 0 }],
    ] as const)(`${mode} falls back to HTML for %s plain text`, async (_name, body) => {
      const connector = setup(body);
      const text = mode === 'sync'
        ? (await connector.sync(context)).events[0].payload_text
        : (await connector.execute({ actionKey: 'get_thread', input: { thread_id: 'alternatives' }, credentials: context.credentials })).output.messages[0].body;
      expect(text).toContain(mode === 'sync' ? 'Please confirm the delivery date.' : html);
    });
  }

  test.each([
    ['missing nonempty body', { size: 12 }, 200],
    ['unavailable external body', { attachmentId: 'unavailable', size: 12 }, 503],
    ['empty external response for nonempty body', { attachmentId: 'nonempty', size: 12 }, 200],
  ] as const)('does not checkpoint past a %s despite a readable HTML alternative', async (_name, body, status) => {
    await expect(setup(body, status).sync(context)).rejects.toThrow(/body/);
  });
});

describe('Gmail multipart body sections', () => {
  const context = { feedKey: 'threads', config: {}, checkpoint: {}, credentials: { accessToken: 'synthetic-token' } };
  const inline = (mimeType: string, text: string) => ({
    mimeType, body: { data: Buffer.from(text).toString('base64url') },
  });

  function setup(externalStatus = 200) {
    const connector = new GmailConnector();
    const urls: string[] = [];
    const thread = toThreadResponse({ id: 'mixed-body', messages: [{ id: 'mixed-message' }] });
    const payload = {
      ...thread.messages[0].payload,
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [inline('text/html', '<p>HTML duplicate</p>'), inline('text/plain', 'Opening section.')],
        },
        {
          mimeType: 'multipart/alternative',
          parts: [inline('text/plain', ''), inline('text/html', '<p>HTML-only middle section.</p>')],
        },
        { mimeType: 'text/plain', body: { attachmentId: 'inline-tail' } },
        { mimeType: 'text/plain', headers: [{ name: 'Content-Disposition', value: 'attachment' }], body: { attachmentId: 'excluded' } },
      ],
    };
    connector.createClient = () => ({ raw: async (url: string) => {
      urls.push(url);
      return {
        ok: !url.includes('/attachments/') || externalStatus === 200,
        status: externalStatus,
        text: async () => 'body unavailable',
        json: async () => url.includes('/attachments/') ? { data: Buffer.from('Please sign the final section.').toString('base64url') }
          : url.includes('/threads/') ? { ...thread, messages: [{ ...thread.messages[0], payload }] }
          : { threads: [{ id: thread.id }] },
      };
    } });
    return { connector, urls };
  }

  test.each(['sync', 'get_thread'])('%s retains every inline section without duplicating alternatives', async (mode) => {
    const { connector, urls } = setup();
    const body = mode === 'sync'
      ? (await connector.sync(context)).events[0].payload_text
      : (await connector.execute({ actionKey: 'get_thread', input: { thread_id: 'mixed-body' }, credentials: context.credentials })).output.messages[0].body;
    expect(body).toContain(mode === 'sync'
      ? 'Opening section.\n\nHTML-only middle section.\n\nPlease sign the final section.'
      : 'Opening section.\n\n<p>HTML-only middle section.</p>\n\nPlease sign the final section.');
    expect(body).not.toContain('HTML duplicate');
    expect(urls.filter((url) => url.includes('/attachments/'))).toEqual([
      'https://www.googleapis.com/gmail/v1/users/me/messages/mixed-message/attachments/inline-tail',
    ]);
  });

  test('does not checkpoint past a failed later inline section', async () => {
    await expect(setup(503).connector.sync(context)).rejects.toThrow(/503/);
  });
});

describe('Gmail MIME syntax', () => {
  const context = { feedKey: 'threads', config: {}, checkpoint: {}, credentials: { accessToken: 'synthetic-token' } };
  const inline = (mimeType: string, text: string) => ({
    mimeType, body: { data: Buffer.from(text).toString('base64url') },
  });

  for (const mode of ['sync', 'get_thread']) {
    test.each([
      ['plain body', inline('TEXT/PLAIN', 'Complete body.')],
      ['HTML body', inline('Text/Html', 'Complete body.')],
      ['alternative preference', {
        mimeType: 'Multipart/Alternative',
        parts: [inline('text/html', 'Unwanted duplicate.'), inline('TEXT/PLAIN', 'Complete body.')],
      }],
      ['attachment whitespace', {
        mimeType: 'multipart/mixed',
        parts: [
          inline('text/plain', 'Complete body.'),
          { ...inline('text/plain', 'Unwanted attachment.'), headers: [{ name: 'Content-Disposition', value: ' ATTACHMENT \r\n\t; size=20' }] },
        ],
      }],
      ['named inline body', {
        ...inline('text/plain', 'Complete body.'),
        filename: 'body.txt',
        headers: [{ name: 'Content-Disposition', value: 'INLINE; filename="body.txt"' }],
      }],
      ['named inline multipart', {
        mimeType: 'multipart/mixed', filename: 'body.mime',
        headers: [{ name: 'Content-Disposition', value: 'inline; filename="body.mime"' }],
        parts: [inline('text/plain', 'Complete body.')],
      }],
      ['unknown attachment disposition', {
        mimeType: 'multipart/mixed',
        parts: [
          inline('text/plain', 'Complete body.'),
          { ...inline('text/plain', 'Unwanted attachment.'), headers: [{ name: 'Content-Disposition', value: 'x-archive' }] },
        ],
      }],
    ])(`${mode} handles valid MIME syntax in %s`, async (_name, payload) => {
      const connector = new GmailConnector();
      const thread = toThreadResponse({ id: 'mime-thread', messages: [{ id: 'mime-message' }] });
      connector.createClient = () => ({ raw: async (url: string) => ({
        ok: true,
        json: async () => url.includes('/threads/')
          ? { ...thread, messages: [{ ...thread.messages[0], payload }] }
          : { threads: [{ id: thread.id }] },
      }) });
      const body = mode === 'sync'
        ? (await connector.sync(context)).events[0].payload_text
        : (await connector.execute({ actionKey: 'get_thread', input: { thread_id: thread.id }, credentials: context.credentials })).output.messages[0].body;
      expect(body).toContain('Complete body.');
      expect(body).not.toContain('Unwanted');
    });
  }
});

describe('Gmail MIME body charset', () => {
  const context = { feedKey: 'threads', config: {}, checkpoint: {}, credentials: { accessToken: 'synthetic-token' } };

  function setup(bytes: Buffer, contentType: string | undefined, external: boolean) {
    const connector = new GmailConnector();
    const thread = toThreadResponse({ id: 'encoded-thread', messages: [{ id: 'encoded-message' }] });
    const payload = {
      mimeType: 'text/plain',
      headers: contentType ? [{ name: 'cOnTeNt-TyPe', value: contentType }] : [],
      body: external ? { attachmentId: 'encoded-body', size: bytes.length }
        : { data: bytes.toString('base64url'), size: bytes.length },
    };
    connector.createClient = () => ({ raw: async (url: string) => ({
      ok: true,
      json: async () => url.includes('/attachments/') ? { data: bytes.toString('base64url') }
        : url.includes('/threads/') ? { ...thread, messages: [{ ...thread.messages[0], payload }] }
        : { threads: [{ id: thread.id }] },
    }) });
    return connector;
  }

  for (const external of [false, true]) {
    for (const mode of ['sync', 'get_thread']) {
      test.each([
        ['Latin-1', Buffer.from('café à Noël', 'latin1'), 'text/plain; CHARSET="ISO-8859-1"', 'café à Noël'],
        ['default UTF-8', Buffer.from('İstanbul — teşekkürler'), undefined, 'İstanbul — teşekkürler'],
      ] as const)(`${mode} decodes %s ${external ? 'external' : 'inline'} bytes`, async (_name, bytes, contentType, expected) => {
        const connector = setup(bytes, contentType, external);
        const body = mode === 'sync'
          ? (await connector.sync(context)).events[0].payload_text
          : (await connector.execute({ actionKey: 'get_thread', input: { thread_id: 'encoded-thread' }, credentials: context.credentials })).output.messages[0].body;
        expect(body).toContain(expected);
        expect(body).not.toContain('\uFFFD');
      });
    }
    test.each([
      ['invalid UTF-8', Buffer.from([0xc3, 0x28]), 'text/plain; charset=utf-8'],
      ['unsupported charset', Buffer.from('body'), 'text/plain; charset=unknown-charset'],
    ] as const)(`does not checkpoint past %s ${external ? 'external' : 'inline'} bytes`, async (_name, bytes, contentType) => {
      await expect(setup(bytes, contentType, external).sync(context)).rejects.toThrow();
    });
  }
});

describe('Gmail readable HTML sync bodies', () => {
  const context = { feedKey: 'threads', config: {}, checkpoint: {}, credentials: { accessToken: 'synthetic-token' } };
  const html = `<html><head><style>${'.layout { color: red; }'.repeat(5000)}</style><title>Layout title</title></head><body>
    <script>trackingCode()</script><template>templateOnly</template>
    <h2>Delivery &amp; payment</h2><p>Confirm café delivery by Friday.</p>
    <table><tr><th>Item</th><th>Amount</th></tr><tr><td>Order 42</td><td>42 TL</td></tr></table>
    <p><a href="https://example.com/confirm?order=42&amp;view=full">Confirm order</a></p>
    <blockquote><p>Earlier reply: address approved.</p></blockquote>
    <img src="https://tracking.example.com/pixel" alt="Invoice attached">
    <img src="data:image/png;base64,unneeded">
    <pre><code>line one\n  line two</code></pre>
    <p>Please submit the signed agreement at the end.</p></body></html>`;

  function setup(external = false) {
    const connector = new GmailConnector();
    const thread = toThreadResponse({ id: 'html-thread', messages: [
      { id: 'later', body: 'I have confirmed the order.', date: '2026-07-02T10:00:00Z' },
      { id: 'earlier', date: '2026-07-01T10:00:00Z' },
    ] });
    thread.messages[1].payload = {
      ...thread.messages[1].payload, mimeType: 'text/html',
      body: external ? { attachmentId: 'html-body' } : { data: Buffer.from(html).toString('base64url') },
    };
    const urls: string[] = [];
    connector.createClient = () => ({ raw: async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => url.includes('/attachments/')
        ? { data: Buffer.from(html).toString('base64url') }
        : url.includes('/threads/') ? thread : { threads: [{ id: thread.id }] } };
    } });
    return { connector, urls };
  }

  test.each([false, true])('stores readable complete HTML content (external body: %s)', async (external) => {
    const { connector } = setup(external);
    const result = await connector.sync(context);
    const text = result.events[0].payload_text;
    expect(text).not.toMatch(/<style>|\.layout|trackingCode|templateOnly|Layout title|tracking\.example|data:image/);
    expect(text).toContain('Delivery & payment');
    expect(text).toContain('Confirm café delivery by Friday.');
    expect(text).toContain('Item | Amount');
    expect(text).toContain('Order 42 | 42 TL');
    expect(text).toContain('[Confirm order](https://example.com/confirm?order=42&view=full)');
    expect(text).toContain('> Earlier reply: address approved.');
    expect(text).toContain('Invoice attached');
    expect(text).toContain('line one\n  line two');
    expect(text).toContain('Please submit the signed agreement at the end.');
    expect(text.indexOf('Message: earlier')).toBeLessThan(text.indexOf('Message: later'));
    expect(text).toContain('\n\n---\n\nMessage: later');
    expect(text).toContain('I have confirmed the order.');
    expect(text.length).toBeLessThan(1000);
    expect(result.events[0].origin_id).toBe('html-thread');
  });

  test('keeps the get_thread operation body in its original representation', async () => {
    const { connector } = setup();
    const result = await connector.execute({ actionKey: 'get_thread', input: { thread_id: 'html-thread' }, credentials: context.credentials });
    expect(result.output.messages.find((message: { id: string }) => message.id === 'earlier').body).toBe(html);
  });

  test('does not checkpoint past a body conversion failure', async () => {
    const { connector } = setup();
    connector.emailBodyConverter.turndown = () => { throw new Error('synthetic conversion failure'); };
    await expect(connector.sync(context)).rejects.toThrow('synthetic conversion failure');
  });

  test('revisits stored HTML on upgrade without changing thread identity', async () => {
    const { connector, urls } = setup();
    const previous = { schema_version: 2, scope: JSON.stringify(['label:INBOX', false]), last_sync_at: new Date(Date.now() - 60_000).toISOString() };
    const result = await connector.sync({ ...context, config: { lookback_days: 30 }, checkpoint: previous });
    const after = Number(new URL(urls[0]).searchParams.get('q')?.match(/after:(\d+)/)?.[1]);
    expect(after).toBeLessThan(Date.parse(previous.last_sync_at) / 1000 - 29 * 86400);
    expect(result.checkpoint.schema_version).toBe(3);
    expect(result.events[0].origin_id).toBe('html-thread');
  });
});
