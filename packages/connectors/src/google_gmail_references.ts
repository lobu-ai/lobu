/** Gmail mailbox additions, retained as references rather than email content. */
import { createHash } from 'node:crypto';
import type {
  EventEnvelope,
  HttpClient,
  SyncContext,
  SyncResult,
} from '@lobu/connector-sdk';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const REQUEST_BUDGET = 20;

export interface GmailReferenceState {
  version: 1;
  account: string;
  history_id: string;
  inventory?: { page_token?: string; recent_tokens?: string[] };
  partial?: { record_id: string; after_message_id: string; digest: string };
  history_page?: { token: string; recent_tokens?: string[] };
}

interface ReferenceCheckpoint {
  references?: GmailReferenceState;
}
interface ReferenceConfig {
  max_results?: number;
}
interface MessageIdentity {
  id: string;
  threadId: string;
}
interface HistoryRecord {
  id: string;
  messagesAdded?: Array<{ message: MessageIdentity }>;
}
interface HistoryPage {
  historyId: string;
  history?: HistoryRecord[];
  nextPageToken?: string;
}

function historyId(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,128}$/.test(value))
    throw new Error('Gmail returned an invalid history identity');
  return value;
}

function nativeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(value))
    throw new Error('Gmail returned an invalid message identity');
  return value;
}

async function profile(
  http: HttpClient,
): Promise<{ account: string; history: string }> {
  const result = await http.raw(
    `${BASE}/profile?fields=emailAddress,historyId`,
  );
  if (!result.ok) throw new Error(`Gmail profile error (${result.status})`);
  const data = (await result.json()) as {
    emailAddress?: string;
    historyId?: string;
  };
  const account = data.emailAddress?.trim().toLowerCase();
  if (!account || !/^[^\s@]+@[^\s@]+$/.test(account))
    throw new Error('Gmail returned an invalid account identity');
  return { account, history: historyId(data.historyId) };
}

function gap(
  account: string,
  key: string,
  metadata: Record<string, unknown>,
): EventEnvelope {
  return {
    origin_id: `gmail_gap:${encodeURIComponent(account)}:${key}`,
    origin_type: 'source_gap',
    payload_text: '',
    // A gap has no provider occurrence timestamp. The epoch keeps retries of
    // this same source discontinuity identical; arrival reads use created_at.
    occurred_at: new Date(0),
    metadata: {
      ...metadata,
      source_occurred_at: null,
      timestamp_basis: 'unknown',
    },
  };
}

function messageReference(
  state: GmailReferenceState,
  stub: MessageIdentity,
): EventEnvelope {
  const id = nativeId(stub.id);
  const thread = nativeId(stub.threadId);
  return {
    // Thread content uses bare thread IDs, which may equal the first message ID.
    // Scope native identity to the authenticated account, independently of feeds.
    origin_id: `gmail_message:${encodeURIComponent(state.account)}:${id}`,
    origin_type: 'message_reference',
    payload_text: '',
    source_url: `https://mail.google.com/mail/u/${encodeURIComponent(state.account)}/#all/${thread}`,
    // List/history stubs do not include provider occurrence time. This stable
    // transport sentinel is NOT the email date: use created_at for arrival
    // previews and source_occurred_at for provider-time rendering. Never infer
    // a first contact from it. Omitting title/text also avoids empty embeddings.
    occurred_at: new Date(0),
    metadata: {
      source_id: id,
      thread_id: thread,
      source_occurred_at: null,
      timestamp_basis: 'unknown',
    },
  };
}

function identities(stubs: MessageIdentity[]): MessageIdentity[] {
  const messages = new Map<string, MessageIdentity>();
  for (const stub of stubs) {
    const id = nativeId(stub?.id);
    const threadId = nativeId(stub?.threadId);
    const previous = messages.get(id);
    if (previous && previous.threadId !== threadId)
      throw new Error('Gmail message identity conflicts');
    messages.set(id, { id, threadId });
  }
  return [...messages.values()];
}

function additions(record: HistoryRecord): MessageIdentity[] {
  const entries =
    record.messagesAdded === undefined ? [] : record.messagesAdded;
  if (!Array.isArray(entries))
    throw new Error('Gmail returned invalid history additions');
  return identities(entries.map((entry) => entry?.message)).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

function pageToken(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value || value.length > 8192)
    throw new Error('Gmail returned an invalid page token');
  return value;
}

// Remember only a bounded set of exact recent cursors. Empty advancing pages
// are legitimate source progress; the per-pass request budget bounds work.
// Reject actual short cursor cycles without imposing an item-arrival deadline.
function nextTokens(
  next: string,
  current: string | undefined,
  recent: string[] = [],
): string[] {
  if (next === current || recent.includes(next))
    throw new Error('Gmail cursor did not advance');
  return [
    ...recent,
    ...(current && !recent.includes(current) ? [current] : []),
    next,
  ].slice(-8);
}

/**
 * Initial available-message inventory, then Gmail messageAdded history,
 * including spam/trash. This is not a current-state mailbox mirror, an
 * edit/deletion archive or an observer capture subscription.
 * Every durable position travels with exactly the references it covers.
 */
export async function syncGmailReferences(
  ctx: SyncContext<ReferenceCheckpoint, ReferenceConfig>,
  createClient: (token: string) => HttpClient,
): Promise<SyncResult> {
  const token = ctx.credentials?.accessToken;
  if (!token) throw new Error('Gmail requires Google OAuth credentials.');
  const maximum = ctx.config.max_results ?? 500;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 500)
    throw new Error('Gmail reference max_results must be between 1 and 500');
  const http = createClient(token);
  const identity = await profile(http);
  const saved = ctx.checkpoint?.references;
  if (saved && saved.account !== identity.account)
    throw new Error(
      'Gmail reference account does not match its saved checkpoint',
    );
  if (saved && saved.version !== 1)
    throw new Error('Gmail reference checkpoint version is unsupported');
  if (saved) historyId(saved.history_id);
  let state: GmailReferenceState = saved
    ? { ...saved }
    : {
        version: 1,
        account: identity.account,
        history_id: identity.history,
        inventory: {},
      };
  const commit = async (events: EventEnvelope[], next: GmailReferenceState) => {
    if ((await profile(http)).account !== state.account)
      throw new Error('Gmail reference account changed during capture');
    await ctx.commit(events, { references: next });
    state = next;
  };
  // Commit the history boundary before the first inventory page so arrivals
  // during a long scan are reconciled after available history has been listed.
  if (!saved) {
    await commit([], {
      version: 1,
      account: identity.account,
      history_id: identity.history,
      inventory: {},
    });
  }
  let inspected = 0;
  let found = 0;
  const recover = async (reason: string) => {
    const baseline = await profile(http);
    if (baseline.account !== state.account)
      throw new Error('Gmail reference account changed during recovery');
    const event = gap(
      state.account,
      `${reason}:${state.history_id}:${baseline.history}`,
      {
        reason,
        from_history_id: state.history_id,
        to_history_id: baseline.history,
        recovery: 'available_message_inventory',
      },
    );
    await commit([event], {
      version: 1,
      account: state.account,
      history_id: baseline.history,
      inventory: {},
    });
    return {
      status: 'more',
      metadata: { items_found: found + 1, continuity_gap: true },
    } satisfies SyncResult;
  };

  for (let requests = 0; requests < REQUEST_BUDGET; requests++) {
    if (state.inventory) {
      const params = new URLSearchParams({
        includeSpamTrash: 'true',
        maxResults: String(maximum - inspected),
        fields: 'messages(id,threadId),nextPageToken',
      });
      if (state.inventory.page_token)
        params.set('pageToken', state.inventory.page_token);
      const result = await http.raw(`${BASE}/messages?${params}`);
      if (!result.ok) {
        if (
          state.inventory.page_token &&
          (result.status === 400 || result.status === 404)
        ) {
          // Retain this generation's original pre-inventory history baseline.
          await commit([], { ...state, inventory: {} });
          return {
            status: 'more',
            metadata: { items_found: found, inventory_restarted: true },
          };
        }
        throw new Error(`Gmail reference inventory error (${result.status})`);
      }
      const data = (await result.json()) as {
        messages?: MessageIdentity[];
        nextPageToken?: string;
      };
      const messages = data.messages === undefined ? [] : data.messages;
      if (!Array.isArray(messages))
        throw new Error('Gmail returned invalid inventory messages');
      const token = pageToken(data.nextPageToken);
      if (messages.length > maximum - inspected)
        throw new Error(
          'Gmail inventory exceeded its requested message budget',
        );
      const recent = token
        ? nextTokens(
            token,
            state.inventory.page_token,
            state.inventory.recent_tokens,
          )
        : undefined;
      const events: EventEnvelope[] = [];
      for (const message of identities(messages))
        events.push(messageReference(state, message));
      inspected += messages.length;
      found += events.length;
      const next = { ...state };
      if (token) next.inventory = { page_token: token, recent_tokens: recent };
      else delete next.inventory;
      await commit(events, next);
    } else {
      const params = new URLSearchParams({
        startHistoryId: state.history_id,
        historyTypes: 'messageAdded',
        maxResults: '1',
        fields:
          'history(id,messagesAdded(message(id,threadId))),historyId,nextPageToken',
      });
      if (state.history_page) params.set('pageToken', state.history_page.token);
      const result = await http.raw(`${BASE}/history?${params}`);
      if (!result.ok) {
        if (
          state.history_page &&
          (result.status === 400 || result.status === 404)
        ) {
          // A retired page token does not prove the history boundary expired.
          // Replay from that boundary, retaining any partially consumed record.
          const next = { ...state };
          delete next.history_page;
          await commit([], next);
          return { status: 'more', metadata: { items_found: found } };
        }
        if (result.status === 404) return recover('history_expired');
        throw new Error(`Gmail reference history error (${result.status})`);
      }
      const page = (await result.json()) as HistoryPage;
      const head = historyId(page.historyId);
      if (BigInt(head) < BigInt(state.history_id))
        throw new Error('Gmail history moved backwards');
      const records = page.history === undefined ? [] : page.history;
      if (!Array.isArray(records))
        throw new Error('Gmail returned invalid history records');
      const token = pageToken(page.nextPageToken);
      if (records.length > 1)
        throw new Error('Gmail history exceeded its requested record budget');
      const record = records[0];
      if (records.length === 0) {
        if (token) {
          const recent = nextTokens(
            token,
            state.history_page?.token,
            state.history_page?.recent_tokens,
          );
          await commit([], {
            ...state,
            history_page: { token, recent_tokens: recent },
          });
          continue;
        }
        if (state.partial) return recover('history_anchor_missing');
        const next = { ...state, history_id: head };
        delete next.history_page;
        await commit([], next);
        return { status: 'complete', metadata: { items_found: found } };
      }
      const recordId = historyId(record?.id);
      if (
        BigInt(recordId) <= BigInt(state.history_id) ||
        BigInt(recordId) > BigInt(head)
      )
        throw new Error('Gmail returned an invalid history boundary');
      if (state.partial && recordId !== state.partial.record_id)
        return recover('history_anchor_missing');
      const messages = additions(record);
      const digest = createHash('sha256')
        .update(JSON.stringify(messages))
        .digest('hex');
      if (
        state.partial &&
        (state.partial.digest !== digest ||
          !messages.some(
            (message) => message.id === state.partial?.after_message_id,
          ))
      )
        return recover('history_anchor_changed');
      const unread = state.partial
        ? messages.filter(
            (message) => message.id > state.partial!.after_message_id,
          )
        : messages;
      const batch = unread.slice(0, maximum - inspected);
      const events: EventEnvelope[] = [];
      for (const message of batch) {
        events.push(messageReference(state, message));
        inspected++;
      }
      found += events.length;
      const next = { ...state };
      if (batch.length < unread.length) {
        next.partial = {
          record_id: recordId,
          after_message_id: batch[batch.length - 1].id,
          digest,
        };
      } else {
        next.history_id = token ? recordId : head;
        delete next.partial;
        delete next.history_page;
      }
      await commit(events, next);
      if (!next.partial && !token)
        return { status: 'complete', metadata: { items_found: found } };
    }
    if (inspected >= maximum)
      return { status: 'more', metadata: { items_found: found } };
  }
  return { status: 'more', metadata: { items_found: found } };
}
