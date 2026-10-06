/**
 * Google Calendar Connector (V1 runtime)
 *
 * Actions are compiled from Calendar's pinned Discovery document — one per
 * API method (see `_google/actions.ts`). The two feeds are declarations over
 * `calendar.events.list` run by the shared syncToken engine
 * (`_google/list-feed.ts`); this file owns only what Google cannot describe:
 * the traversal filters and how an event becomes a memory event.
 */

import {
  type ActionContext,
  type ActionResult,
  ConnectorRuntime,
  createHttpClient,
  type EventEnvelope,
  type HttpClient,
  type RuntimeConnectorDefinition,
} from '@lobu/connector-sdk';
import { compileGoogleActions, executeGoogleAction, oauthScopes } from './_google/actions';
import type { DiscoveryDocument } from './_google/discovery';
import calendarDiscovery from './_google/discovery/calendar_v3.json';
import { type ListRead, listMethod, listRead, type SyncTokenFeed, syncTokenSync } from './_google/list-feed';
import { GOOGLE_API_POLICIES } from './_google/policies';

// ---------------------------------------------------------------------------
// Calendar API types
// ---------------------------------------------------------------------------

interface CalendarEvent {
  id: string;
  status: string;
  htmlLink: string;
  summary?: string;
  description?: string;
  location?: string;
  creator?: { email?: string; displayName?: string };
  organizer?: { email?: string; displayName?: string };
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{
    email: string;
    displayName?: string;
    responseStatus?: string;
  }>;
  created: string;
  updated: string;
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

/**
 * Leading element of the stored checkpoint's `scope`. Bumping it retires every
 * stored checkpoint, because a cursor is only safe to resume when this exact
 * code minted it. Bumped to 2 when the bootstrap became resumable: before that
 * a capped run advanced the sync token after silently discarding the unread
 * tail, so those tokens describe an incomplete window.
 */
const CHECKPOINT_SCOPE_VERSION = 2;

interface CalendarConfig extends Record<string, unknown> {
  calendar_id?: string;
  query?: string;
  lookback_days?: number;
  lookahead_days?: number;
  max_results?: number;
}

const CALENDAR_EVENT_COLUMNS = [
  { name: 'id', type: 'text' },
  { name: 'summary', type: 'text' },
  { name: 'description', type: 'text' },
  { name: 'location', type: 'text' },
  { name: 'status', type: 'text' },
  { name: 'start_time', type: 'text' },
  { name: 'end_time', type: 'text' },
  { name: 'all_day', type: 'boolean' },
  { name: 'organizer', type: 'text' },
  { name: 'attendee_count', type: 'number' },
  { name: 'created_at', type: 'text' },
  { name: 'updated_at', type: 'text' },
  { name: 'url', type: 'text' },
] as const;

function calendarEventToRow(calEvent: CalendarEvent): Record<string, unknown> | null {
  if (calEvent.status === 'cancelled') return null;
  const startTime = calEvent.start.dateTime || calEvent.start.date;
  if (!startTime) return null;
  const endTime = calEvent.end.dateTime || calEvent.end.date || '';
  return {
    id: calEvent.id,
    summary: calEvent.summary || '(no title)',
    description: calEvent.description || '',
    location: calEvent.location || '',
    status: calEvent.status,
    start_time: startTime,
    end_time: endTime,
    all_day: !calEvent.start.dateTime,
    organizer: calEvent.organizer?.displayName || calEvent.organizer?.email || '',
    attendee_count: calEvent.attendees?.length ?? 0,
    created_at: calEvent.created,
    updated_at: calEvent.updated,
    url: calEvent.htmlLink,
  };
}

/** Description, then attendees: the text an event is searched and embedded by. */
function eventPayloadText(calEvent: CalendarEvent): string {
  const attendees = (calEvent.attendees ?? []).map((a) => a.displayName || a.email).join(', ');
  return [calEvent.description, attendees && `Attendees: ${attendees}`].filter(Boolean).join('\n\n');
}

function calendarEventToChangeEnvelope(calEvent: CalendarEvent): EventEnvelope {
  const startTime = calEvent.start?.dateTime || calEvent.start?.date;
  const endTime = calEvent.end?.dateTime || calEvent.end?.date;
  const changedAt = new Date(calEvent.updated || startTime || Date.now());
  const occurredAt = Number.isNaN(changedAt.getTime()) ? new Date() : changedAt;
  const isCancelled = calEvent.status === 'cancelled';

  return {
    origin_id: calEvent.id,
    title: calEvent.summary || (isCancelled ? '(cancelled calendar event)' : '(no title)'),
    payload_text: eventPayloadText(calEvent),
    author_name: calEvent.organizer?.displayName || calEvent.organizer?.email,
    source_url: calEvent.htmlLink,
    occurred_at: occurredAt,
    origin_type: 'calendar_event',
    metadata: {
      status: calEvent.status,
      change_type: isCancelled ? 'cancelled' : 'upserted',
      ...(calEvent.location ? { location: calEvent.location } : {}),
      ...(calEvent.organizer?.email ? { organizer: calEvent.organizer.email } : {}),
      attendee_count: calEvent.attendees?.length ?? 0,
      ...(startTime ? { start_time: startTime } : {}),
      ...(endTime ? { end_time: endTime } : {}),
      all_day: Boolean(startTime && !calEvent.start?.dateTime),
    },
  };
}

function calendarEventToEnvelope(calEvent: CalendarEvent): EventEnvelope | null {
  if (calEvent.status === 'cancelled') return null;

  const startTime = calEvent.start.dateTime || calEvent.start.date;
  if (!startTime) return null;

  const occurredAt = new Date(startTime);
  if (Number.isNaN(occurredAt.getTime())) return null;

  const isAllDay = !calEvent.start.dateTime;
  const endTime = calEvent.end.dateTime || calEvent.end.date;

  return {
    origin_id: calEvent.id,
    title: calEvent.summary || '(no title)',
    payload_text: eventPayloadText(calEvent),
    author_name: calEvent.organizer?.displayName || calEvent.organizer?.email,
    source_url: calEvent.htmlLink,
    occurred_at: occurredAt,
    origin_type: 'calendar_event',
    metadata: {
      status: calEvent.status,
      ...(calEvent.location ? { location: calEvent.location } : {}),
      ...(calEvent.organizer?.email ? { organizer: calEvent.organizer.email } : {}),
      attendee_count: calEvent.attendees?.length ?? 0,
      start_time: startTime,
      ...(endTime ? { end_time: endTime } : {}),
      all_day: isAllDay,
    },
  };
}

// ---------------------------------------------------------------------------
// Discovery-compiled actions and feed declarations
// ---------------------------------------------------------------------------

const CALENDAR_DOC = calendarDiscovery as unknown as DiscoveryDocument;
const CALENDAR_POLICY = GOOGLE_API_POLICIES.calendar_v3;
const CALENDAR = compileGoogleActions(CALENDAR_DOC, CALENDAR_POLICY);
const EVENTS_LIST = listMethod(CALENDAR_DOC, 'calendar.events.list');

const calendarId = (config: CalendarConfig) => config.calendar_id || 'primary';
const lookbackDays = (config: CalendarConfig) => config.lookback_days ?? 30;
const daysFrom = (now: Date, days: number) => new Date(now.getTime() + days * 86_400_000).toISOString();

/** `events`: the calendar as it stands. Cancelled events never surface. */
const EVENTS_FEED: SyncTokenFeed<CalendarConfig> = {
  list: EVENTS_LIST,
  path: (config) => ({ calendarId: calendarId(config) }),
  pageSize: 250,
  scope: (config) => [CHECKPOINT_SCOPE_VERSION, calendarId(config), lookbackDays(config)],
  budget: (config) => Math.min(config.max_results ?? 100, 2500),
  // No `orderBy`: Google omits `nextSyncToken` from any query that orders its
  // results, which left this feed re-listing its whole window every run. A
  // sync has no use for order; live reads (EVENTS_READ) keep `startTime`.
  bootstrap: (config, now) => ({
    singleEvents: 'true',
    timeMin: daysFrom(now, -lookbackDays(config)),
    timeMax: daysFrom(now, 365),
  }),
  // Google binds the bootstrap's non-window parameters to the token it mints.
  incremental: () => ({ singleEvents: 'true' }),
  toEnvelope: (item) => calendarEventToEnvelope(item as unknown as CalendarEvent),
};

/**
 * `changes`: every change, cancellations included, for Automations. Google
 * allows `singleEvents`/`showDeleted` alongside a syncToken, and the feed
 * fails closed rather than finishing a traversal it could not resume from.
 */
const CHANGES_FEED: SyncTokenFeed<CalendarConfig> = {
  ...EVENTS_FEED,
  bootstrap: (config, now) => ({
    singleEvents: 'true',
    showDeleted: 'true',
    timeMin: daysFrom(now, -lookbackDays(config)),
  }),
  incremental: () => ({ singleEvents: 'true', showDeleted: 'true' }),
  requireSyncToken: true,
  toEnvelope: (item) => calendarEventToChangeEnvelope(item as unknown as CalendarEvent),
};

const EVENTS_READ: ListRead<CalendarConfig> = {
  list: EVENTS_LIST,
  path: (config) => ({ calendarId: calendarId(config) }),
  maxPageSize: 250,
  columns: [...CALENDAR_EVENT_COLUMNS],
  toRow: (item) => calendarEventToRow(item as unknown as CalendarEvent),
  params: (ctx) => {
    if (ctx.sort && !(ctx.sort.column === 'start_time' && ctx.sort.order === 'asc')) {
      throw new Error(
        "Google Calendar source reads only support sort {column:'start_time', order:'asc'}."
      );
    }
    if ((ctx.offset ?? 0) > 0) {
      throw new Error(
        'Google Calendar source reads paginate with the returned cursor, not an offset.'
      );
    }
    const requested = Math.min(Math.max(Math.trunc(ctx.limit ?? 50), 1), 2500);
    const configured = Math.min(Math.max(Math.trunc(ctx.config.max_results ?? 100), 1), 2500);
    const now = new Date();
    const q = [ctx.config.query, ctx.query].map((part) => part?.trim()).filter(Boolean).join(' ');
    return {
      maxResults: String(Math.min(250, requested, configured)),
      orderBy: 'startTime',
      singleEvents: 'true',
      timeMin: daysFrom(now, -lookbackDays(ctx.config)),
      timeMax: daysFrom(now, ctx.config.lookahead_days ?? 365),
      ...(q ? { q } : {}),
    };
  },
};

const EVENT_METADATA_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string' },
    location: { type: 'string' },
    organizer: { type: 'string' },
    attendee_count: { type: 'number' },
    start_time: { type: 'string' },
    end_time: { type: 'string' },
    all_day: { type: 'boolean' },
  },
};

function requireToken(credentials: { accessToken?: string } | null): string {
  const token = credentials?.accessToken;
  if (!token) throw new Error('Google Calendar requires Google OAuth credentials.');
  return token;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class GoogleCalendarConnector extends ConnectorRuntime<Record<string, unknown>, CalendarConfig> {
  readonly definition: RuntimeConnectorDefinition<Record<string, unknown>, CalendarConfig> = {
    key: 'google.calendar',
    name: 'Google Calendar',
    description: 'Syncs Google Calendar events and exposes supported Calendar API methods as actions.',
    version: '1.1.2',
    faviconDomain: 'calendar.google.com',
    authSchema: {
      methods: [
        {
          type: 'oauth',
          provider: 'google',
          ...oauthScopes(CALENDAR_POLICY),
          loginScopes: ['openid', 'email', 'profile'],
          clientIdKey: 'GOOGLE_CLIENT_ID',
          clientSecretKey: 'GOOGLE_CLIENT_SECRET',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          tokenEndpointAuthMethod: 'client_secret_post',
          loginProvisioning: {
            autoCreateConnection: true,
          },
        },
      ],
    },
    feeds: {
      events: {
        key: 'events',
        name: 'Events',
        requiredScopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        description:
          'Google Calendar events can sync into memory and be read directly from Google.',
        sync: (ctx) => syncTokenSync(EVENTS_FEED, ctx, this.client(requireToken(ctx.credentials))),
        read: (ctx) => listRead(EVENTS_READ, ctx, this.client(requireToken(ctx.credentials))),
        configSchema: {
          type: 'object',
          properties: {
            calendar_id: {
              type: 'string',
              default: 'primary',
              description: 'Calendar ID to read (default: "primary").',
            },
            query: {
              type: 'string',
              description: 'Optional Google Calendar free-text query applied to live reads.',
            },
            lookback_days: {
              type: 'integer', minimum: 1, maximum: 365, default: 30,
              description: 'Number of past days included in live reads.',
            },
            lookahead_days: {
              type: 'integer', minimum: 1, maximum: 730, default: 365,
              description: 'Number of future days included in live reads.',
            },
            max_results: {
              type: 'integer', minimum: 1, maximum: 2500, default: 100,
              description: 'Maximum events returned per live read.',
            },
          },
        },
        eventKinds: {
          calendar_event: {
            description: 'A Google Calendar event',
            metadataSchema: EVENT_METADATA_SCHEMA,
          },
        },
      },
      changes: {
        key: 'changes',
        name: 'Calendar changes',
        requiredScopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        description:
          'Durable incremental Google Calendar changes for Automations and event-driven workflows.',
        sync: (ctx) => syncTokenSync(CHANGES_FEED, ctx, this.client(requireToken(ctx.credentials))),
        configSchema: {
          type: 'object',
          properties: {
            calendar_id: {
              type: 'string',
              default: 'primary',
              description: 'Calendar ID to watch (default: "primary").',
            },
            lookback_days: {
              type: 'integer', minimum: 1, maximum: 365, default: 30,
              description: 'Number of days to look back on initial collection.',
            },
            max_results: {
              type: 'integer', minimum: 1, maximum: 2500, default: 100,
              description:
                'Soft cap on events per initial collection run: a provider page is never split, and remaining pages resume on the next run. Incremental collections persist every change.',
            },
          },
        },
        eventKinds: {
          calendar_event: {
            description: 'A Google Calendar event change',
            metadataSchema: EVENT_METADATA_SCHEMA,
          },
        },
      },
    },
    actions: CALENDAR.actions,
  };

  async execute(ctx: ActionContext): Promise<ActionResult> {
    const token = ctx.credentials?.accessToken;
    if (!token) {
      return { success: false, error: 'Google Calendar actions require Google OAuth credentials.' };
    }
    return executeGoogleAction(CALENDAR, ctx, this.client(token));
  }

  // Auth-aware client (Bearer + retry/backoff on transient 429/5xx). Built per
  // token so each sync/action uses its own credentials. `.raw()` preserves the
  // existing `response.ok`/status-code branching (e.g. sync-token rejection).
  private client(token: string): HttpClient {
    return createHttpClient({ token, errorPrefix: 'Calendar API' });
  }
}
