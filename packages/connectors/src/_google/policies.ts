/**
 * What Discovery cannot say about each Google API.
 *
 * Kept as data so a change in coverage is a reviewable one-line diff. A method
 * absent from every list below is exposed exactly as Discovery describes it.
 */
import type { GoogleApiPolicy } from './actions';

const auth = (scope: string) => `https://www.googleapis.com/auth/${scope}`;

export const GOOGLE_API_POLICIES: Record<string, GoogleApiPolicy> = {
  calendar_v3: {
    scopeLadder: [
      auth('calendar.readonly'),
      auth('calendar.events'),
      auth('calendar.calendarlist'),
      auth('calendar.acls'),
      auth('calendar.calendars'),
      auth('calendar'),
    ],
    // Hands the calendar to another account; not reversible by this user.
    blockedMethods: ['calendar.calendars.transferOwnership'],
    readMethods: ['calendar.freebusy.query'],
    destructiveMethods: ['calendar.calendars.clear'],
    defaults: { calendarId: 'primary' },
  },
  gmail_v1: {
    scopeLadder: [
      auth('gmail.readonly'),
      auth('gmail.labels'),
      auth('gmail.send'),
      auth('gmail.compose'),
      auth('gmail.insert'),
      auth('gmail.modify'),
      auth('gmail.settings.basic'),
      // Not `gmail.settings.sharing`: Google grants it only to service accounts
      // with domain-wide delegation, so the sendAs/forwarding methods that
      // accept nothing else cannot be authorized by a user's OAuth consent.
      'https://mail.google.com/',
    ],
    // compose covers drafts.create AND messages.send, so it is the single write
    // scope for the hand-written create_draft/reply/send_email. It must be
    // granted at connect: an upgrade is requested only when a caller asks.
    connectScopes: [auth('gmail.readonly'), auth('gmail.compose')],
    // Delegation grants another account full mailbox access.
    blockedPrefixes: ['gmail.users.settings.delegates.'],
    // Permanent, bypassing the trash (`trash`/`untrash` are reversible).
    destructiveMethods: ['gmail.users.messages.batchDelete'],
    defaults: { userId: 'me' },
  },
  drive_v3: {
    scopeLadder: [auth('drive.readonly'), auth('drive.file'), auth('drive')],
    blockedPrefixes: ['drive.apps.'],
    readMethods: ['drive.files.download'],
    // Without these, a file in a shared drive answers 404 and lists omit it.
    defaults: { supportsAllDrives: true, includeItemsFromAllDrives: true },
  },
  sheets_v4: {
    scopeLadder: [auth('spreadsheets.readonly'), auth('spreadsheets')],
    readMethods: [
      'sheets.spreadsheets.getByDataFilter',
      'sheets.spreadsheets.values.batchGetByDataFilter',
      'sheets.spreadsheets.developerMetadata.search',
    ],
    destructiveMethods: [
      'sheets.spreadsheets.values.clear',
      'sheets.spreadsheets.values.batchClear',
      'sheets.spreadsheets.values.batchClearByDataFilter',
    ],
  },
  docs_v1: {
    scopeLadder: [auth('documents.readonly'), auth('documents')],
  },
  people_v1: {
    scopeLadder: [
      auth('contacts.readonly'),
      auth('contacts.other.readonly'),
      auth('directory.readonly'),
      auth('contacts'),
    ],
    destructiveMethods: ['people.people.batchDeleteContacts'],
  },
  tasks_v1: {
    scopeLadder: [auth('tasks.readonly'), auth('tasks')],
    defaults: { tasklist: '@default' },
  },
  youtube_v3: {
    scopeLadder: [
      auth('youtube.readonly'),
      auth('youtube.upload'),
      auth('youtube'),
      auth('youtube.force-ssl'),
    ],
    blockedMethods: ['youtube.abuseReports.insert', 'youtube.tests.insert'],
    blockedPrefixes: ['youtube.thirdPartyLinks.'],
  },
  // User-authorized Chat only. Methods that accept nothing but app (`chat.app.*`,
  // `chat.bot`) or admin (`chat.admin.*`) scopes fall outside the ladder.
  chat_v1: {
    scopeLadder: [
      'spaces.readonly',
      'memberships.readonly',
      'messages.readonly',
      'messages.reactions.readonly',
      'customemojis.readonly',
      'spaces.pins.readonly',
      'users.readstate.readonly',
      'users.sections.readonly',
      'users.availability.readonly',
      'messages.create',
      'messages.reactions.create',
      'spaces.create',
      'messages',
      'messages.reactions',
      'memberships',
      'spaces',
      'customemojis',
      'spaces.pins',
      'users.readstate',
      'users.spacesettings',
      'users.sections',
      'users.availability',
      'delete',
    ].map((scope) => auth(`chat.${scope}`)),
    blockedMethods: ['chat.spaces.completeImport'],
  },
};
