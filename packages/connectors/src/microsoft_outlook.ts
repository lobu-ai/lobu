/**
 * Microsoft Outlook Connector (V1 runtime)
 *
 * Syncs emails and calendar events from Microsoft 365 via the Microsoft Graph API.
 * Auth via OAuth with Microsoft identity platform.
 */

import {
  type ActionContext,
  type ActionResult,
  type RuntimeConnectorDefinition,
  ConnectorRuntime,
  downloadSizeError,
  type EventEnvelope,
  fileDownloadOutput,
  type HttpClient,
  inlineContentBudget,
  inlineMaxBytesSchema,
  paginateByCursor,
  requireBearerClient,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

// ---------------------------------------------------------------------------
// Microsoft Graph API types
// ---------------------------------------------------------------------------

/**
 * One `/messages/{id}/attachments` entry. `contentBytes` is present only on
 * `#microsoft.graph.fileAttachment`; the reference and item subtypes carry a
 * link or an embedded resource instead.
 */
interface GraphAttachment {
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentBytes?: string;
  '@odata.type'?: string;
}

interface GraphMessage {
  id: string;
  conversationId: string;
  subject: string;
  bodyPreview: string;
  body: { contentType: string; content: string };
  from: { emailAddress: { name: string; address: string } };
  toRecipients: Array<{ emailAddress: { name: string; address: string } }>;
  ccRecipients: Array<{ emailAddress: { name: string; address: string } }>;
  receivedDateTime: string;
  sentDateTime: string;
  hasAttachments: boolean;
  importance: string;
  isRead: boolean;
  webLink: string;
  parentFolderId: string;
}

interface GraphEvent {
  id: string;
  subject: string;
  bodyPreview: string;
  body: { contentType: string; content: string };
  organizer: { emailAddress: { name: string; address: string } };
  attendees: Array<{
    emailAddress: { name: string; address: string };
    type: string;
    status: { response: string };
  }>;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  location: { displayName: string };
  isAllDay: boolean;
  isCancelled: boolean;
  webLink: string;
  createdDateTime: string;
}

interface GraphPagedResponse<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

interface OutlookCheckpoint {
  last_sync_at?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRecipients(
  recipients: Array<{ emailAddress: { name: string; address: string } }>
): string {
  return recipients.map((r) => r.emailAddress.name || r.emailAddress.address).join(', ');
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class MicrosoftOutlookConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: 'microsoft.outlook',
    name: 'Microsoft Outlook',
    description: 'Syncs emails and calendar events from Microsoft 365 via Graph API.',
    version: '1.0.0',
    faviconDomain: 'outlook.com',
    authSchema: {
      methods: [
        {
          type: 'oauth',
          provider: 'microsoft',
          requiredScopes: [
            'openid',
            'email',
            'profile',
            'offline_access',
            'Mail.Read',
            'Calendars.Read',
          ],
          optionalScopes: ['Mail.Send'],
          loginScopes: ['openid', 'email', 'profile', 'offline_access', 'User.Read'],
          clientIdKey: 'MICROSOFT_CLIENT_ID',
          clientSecretKey: 'MICROSOFT_CLIENT_SECRET',
          tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
          tokenEndpointAuthMethod: 'client_secret_post',
          loginProvisioning: {
            autoCreateConnection: true,
          },
          setupInstructions:
            'Register an app in the Azure Portal (Entra ID > App registrations). Add {{redirect_uri}} as a redirect URI under "Web", then copy the Application (client) ID and create a client secret under Certificates & secrets.',
        },
      ],
    },
    feeds: {
      messages: {
        key: 'messages',
        name: 'Messages',
        sync: (ctx) => this.syncFeed(ctx),
        requiredScopes: ['Mail.Read'],
        description: 'Syncs email messages from Outlook.',
        configSchema: {
          type: 'object',
          properties: {
            folder: {
              type: 'string',
              default: 'inbox',
              description: 'Mail folder to sync (e.g. "inbox", "sentitems", "drafts").',
            },
            max_results: {
              type: 'integer',
              minimum: 1,
              maximum: 500,
              default: 50,
              description: 'Maximum messages to fetch per sync.',
            },
            lookback_days: {
              type: 'integer',
              minimum: 1,
              maximum: 365,
              default: 30,
              description: 'How many days back to look on initial sync.',
            },
          },
        },
        eventKinds: {
          email: {
            description: 'An email message from Outlook',
            metadataSchema: {
              type: 'object',
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                cc: { type: 'string' },
                importance: { type: 'string' },
                has_attachments: { type: 'boolean' },
                is_read: { type: 'boolean' },
              },
            },
          },
        },
      },
      calendar: {
        key: 'calendar',
        name: 'Calendar Events',
        sync: (ctx) => this.syncFeed(ctx),
        requiredScopes: ['Calendars.Read'],
        description: 'Syncs calendar events from Outlook.',
        configSchema: {
          type: 'object',
          properties: {
            lookback_days: {
              type: 'integer',
              minimum: 0,
              maximum: 365,
              default: 7,
              description: 'How many days back to look for events.',
            },
            lookahead_days: {
              type: 'integer',
              minimum: 1,
              maximum: 365,
              default: 30,
              description: 'How many days ahead to look for events.',
            },
            max_results: {
              type: 'integer',
              minimum: 1,
              maximum: 500,
              default: 100,
              description: 'Maximum events to fetch per sync.',
            },
          },
        },
        eventKinds: {
          calendar_event: {
            description: 'A calendar event from Outlook',
            metadataSchema: {
              type: 'object',
              properties: {
                organizer: { type: 'string' },
                location: { type: 'string' },
                attendee_count: { type: 'number' },
                is_all_day: { type: 'boolean' },
                is_cancelled: { type: 'boolean' },
                start_time: { type: 'string' },
                end_time: { type: 'string' },
              },
            },
          },
        },
      },
    },
    actions: {
      list_attachments: {
        key: 'list_attachments',
        kind: 'read',
        name: 'List Attachments',
        description:
          "List a message's attachments with their IDs, names, types and sizes. The feed only reports `has_attachments`, so this is how an agent learns what to download.",
        requiresApproval: false,
        requiredScopes: ['Mail.Read'],
        inputSchema: {
          type: 'object',
          required: ['message_id'],
          properties: {
            message_id: {
              type: 'string',
              description: 'Message ID (the event\'s origin_id).',
            },
          },
        },
      },
      download_attachment: {
        key: 'download_attachment',
        kind: 'read',
        name: 'Download Attachment',
        description:
          'Download one attachment from an Outlook message. The bytes are published as an attachment with a `download_url` a device can fetch, and small text files are ALSO returned inline as `content`. Get `attachment_id` from `list_attachments`.',
        requiresApproval: false,
        requiredScopes: ['Mail.Read'],
        inputSchema: {
          type: 'object',
          required: ['message_id', 'attachment_id'],
          properties: {
            message_id: {
              type: 'string',
              description: 'Message ID the attachment belongs to.',
            },
            attachment_id: {
              type: 'string',
              description: 'Attachment ID from list_attachments.',
            },
            inline_max_bytes: inlineMaxBytesSchema(),
          },
        },
      },
    },
  };

  private readonly API_BASE = 'https://graph.microsoft.com/v1.0';
  private readonly PAGE_SIZE = 50;
  private readonly MAX_PAGES = 10;

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  private async syncFeed(ctx: SyncContext): Promise<SyncResult> {
    const http = requireBearerClient(ctx.credentials, {
      errorPrefix: 'Microsoft Graph API',
      label: 'Microsoft Outlook',
      headers: { 'Content-Type': 'application/json' },
    });

    switch (ctx.feedKey) {
      case 'messages':
        return this.syncMessages(ctx, http);
      case 'calendar':
        return this.syncCalendar(ctx, http);
      default:
        throw new Error(`Unknown feed: ${ctx.feedKey}`);
    }
  }

  // -------------------------------------------------------------------------
  // execute
  // -------------------------------------------------------------------------

  async execute(ctx: ActionContext): Promise<ActionResult> {
    try {
      const http = requireBearerClient(ctx.credentials, {
        errorPrefix: 'Microsoft Graph API',
        label: 'Microsoft Outlook',
      });

      switch (ctx.actionKey) {
        case 'list_attachments':
          return await this.listAttachments(http, ctx.input);
        case 'download_attachment':
          return await this.downloadAttachment(http, ctx.input);
        default:
          return { success: false, error: `Unknown action: ${ctx.actionKey}` };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * List a message's attachments without their bytes.
   *
   * `$select` is load-bearing, not a micro-optimisation: Graph serialises
   * `contentBytes` into the LIST response by default, so an unfiltered call on
   * a mail with three 5 MB files returns ~20 MB of base64 the caller never
   * asked for — which on the isolate lane is an out-of-memory kill.
   *
   * Reference attachments (a OneDrive link) and item attachments (an embedded
   * mail) carry no `contentBytes` at all. `type` echoes the `@odata.type`
   * annotation that marks which subtype each entry is, so a caller can usually
   * see up front why `download_attachment` will refuse one. It is an annotation
   * rather than a selected property, so treat it as advisory and empty when
   * absent — the authoritative refusal comes from `download_attachment`, whose
   * single-attachment GET is not `$select`ed and always carries the subtype.
   */
  private async listAttachments(
    http: HttpClient,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const messageId = input.message_id as string;
    if (!messageId) return { success: false, error: 'message_id is required.' };

    const response = (await http.get(
      `${this.API_BASE}/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline`
    )) as { value?: GraphAttachment[] };

    return {
      success: true,
      output: {
        message_id: messageId,
        attachments: (response.value ?? []).map((attachment) => ({
          attachment_id: attachment.id,
          filename: attachment.name ?? attachment.id,
          mime_type: attachment.contentType ?? 'application/octet-stream',
          size_bytes: attachment.size ?? 0,
          is_inline: Boolean(attachment.isInline),
          type: attachment['@odata.type'] ?? '',
        })),
      },
    };
  }

  /**
   * Download one attachment's bytes and publish them.
   *
   * Graph returns the bytes base64 inside the attachment resource rather than
   * as a body. The `$value` endpoint would hand back raw bytes, but it 404s for
   * anything that is not a file attachment, so the JSON shape is used for both
   * the bytes and the readable refusal.
   */
  private async downloadAttachment(
    http: HttpClient,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const messageId = input.message_id as string;
    const attachmentId = input.attachment_id as string;
    if (!messageId) return { success: false, error: 'message_id is required.' };
    if (!attachmentId) return { success: false, error: 'attachment_id is required.' };

    const attachment = (await http.get(
      `${this.API_BASE}/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
    )) as GraphAttachment;

    // Refuse on the DECLARED size before decoding, so the decoded bytes and the
    // base64 copy re-encoded for the attachment never join the string in memory.
    const declaredTooBig = downloadSizeError(attachment.size, attachment.name ?? attachmentId);
    if (declaredTooBig) return { success: false, error: declaredTooBig };

    if (!attachment.contentBytes) {
      return {
        success: false,
        error: `Outlook attachment ${attachment.name ?? attachmentId} carries no bytes (${attachment['@odata.type'] ?? 'unknown type'}). Only file attachments can be downloaded; a reference attachment lives in OneDrive and an item attachment is an embedded message.`,
      };
    }

    const bytes = Buffer.from(attachment.contentBytes, 'base64');
    if (bytes.length === 0) {
      return { success: false, error: `Outlook attachment ${attachment.name ?? attachmentId} is empty.` };
    }
    const receivedTooBig = downloadSizeError(bytes.length, attachment.name ?? attachmentId);
    if (receivedTooBig) return { success: false, error: receivedTooBig };

    const filename = attachment.name ?? attachmentId;
    const mimeType = attachment.contentType ?? 'application/octet-stream';

    return {
      success: true,
      output: {
        message_id: messageId,
        attachment_id: attachmentId,
        name: filename,
        mime_type: mimeType,
        ...fileDownloadOutput({
          bytes,
          filename,
          mimeType,
          inlineMaxBytes: inlineContentBudget(input.inline_max_bytes),
        }),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Feed: messages
  // -------------------------------------------------------------------------

  private async syncMessages(ctx: SyncContext, http: HttpClient): Promise<SyncResult> {
    const config = ctx.config as Record<string, unknown>;
    const folder = (config.folder as string) ?? 'inbox';
    const maxResults = (config.max_results as number) ?? 50;
    const lookbackDays = (config.lookback_days as number) ?? 30;
    const encodedFolder = encodeURIComponent(folder);

    const since = new Date();
    since.setDate(since.getDate() - lookbackDays);
    const sinceFilter = since.toISOString();

    const events: EventEnvelope[] = [];
    const firstUrl =
      `${this.API_BASE}/me/mailFolders/${encodedFolder}/messages` +
      `?$top=${Math.min(maxResults, this.PAGE_SIZE)}` +
      '&$orderby=receivedDateTime desc' +
      `&$filter=receivedDateTime ge ${sinceFilter}` +
      '&$select=id,conversationId,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,hasAttachments,importance,isRead,webLink';

    let fetched = 0;

    // Graph paginates via full `@odata.nextLink` URLs, so the cursor is the page URL.
    const pages = paginateByCursor<GraphMessage, string>(
      async (url) => {
        const data = await http.get<GraphPagedResponse<GraphMessage>>(url ?? firstUrl);
        return { items: data.value, nextCursor: data['@odata.nextLink'] };
      },
      { maxPages: this.MAX_PAGES, initialCursor: firstUrl }
    );

    for await (const value of pages) {
      for (const msg of value) {
        if (fetched >= maxResults) break;
        events.push({
          origin_id: `outlook_msg_${msg.id}`,
          title: msg.subject,
          payload_text: msg.bodyPreview || msg.subject,
          author_name: msg.from?.emailAddress?.name || msg.from?.emailAddress?.address,
          source_url: msg.webLink,
          occurred_at: new Date(msg.receivedDateTime),
          origin_type: 'email',
          metadata: {
            from: msg.from?.emailAddress?.address,
            to: formatRecipients(msg.toRecipients ?? []),
            cc: formatRecipients(msg.ccRecipients ?? []),
            importance: msg.importance,
            has_attachments: msg.hasAttachments,
            is_read: msg.isRead,
          },
        });
        fetched++;
      }

      if (ctx.emitEvents) await ctx.emitEvents(events.splice(0));

      if (fetched >= maxResults) break;
    }

    return {
      events,
      checkpoint: {
        last_sync_at: new Date().toISOString(),
      } satisfies OutlookCheckpoint as Record<string, unknown>,
    };
  }

  // -------------------------------------------------------------------------
  // Feed: calendar
  // -------------------------------------------------------------------------

  private async syncCalendar(ctx: SyncContext, http: HttpClient): Promise<SyncResult> {
    const config = ctx.config as Record<string, unknown>;
    const lookbackDays = (config.lookback_days as number) ?? 7;
    const lookaheadDays = (config.lookahead_days as number) ?? 30;
    const maxResults = (config.max_results as number) ?? 100;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - lookbackDays);
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + lookaheadDays);

    const events: EventEnvelope[] = [];
    const firstUrl =
      `${this.API_BASE}/me/calendarView` +
      `?startDateTime=${startDate.toISOString()}` +
      `&endDateTime=${endDate.toISOString()}` +
      `&$top=${Math.min(maxResults, this.PAGE_SIZE)}` +
      '&$orderby=start/dateTime' +
      '&$select=id,subject,bodyPreview,organizer,attendees,start,end,location,isAllDay,isCancelled,webLink,createdDateTime';

    let fetched = 0;

    const pages = paginateByCursor<GraphEvent, string>(
      async (url) => {
        const data = await http.get<GraphPagedResponse<GraphEvent>>(url ?? firstUrl);
        return { items: data.value, nextCursor: data['@odata.nextLink'] };
      },
      { maxPages: this.MAX_PAGES, initialCursor: firstUrl }
    );

    for await (const value of pages) {
      for (const evt of value) {
        if (fetched >= maxResults) break;
        events.push({
          origin_id: `outlook_evt_${evt.id}`,
          title: evt.subject,
          payload_text: evt.bodyPreview || evt.subject,
          author_name: evt.organizer?.emailAddress?.name || evt.organizer?.emailAddress?.address,
          source_url: evt.webLink,
          occurred_at: new Date(evt.start.dateTime),
          origin_type: 'calendar_event',
          metadata: {
            organizer: evt.organizer?.emailAddress?.address,
            location: evt.location?.displayName,
            attendee_count: evt.attendees?.length ?? 0,
            is_all_day: evt.isAllDay,
            is_cancelled: evt.isCancelled,
            start_time: evt.start.dateTime,
            end_time: evt.end.dateTime,
          },
        });
        fetched++;
      }

      if (ctx.emitEvents) await ctx.emitEvents(events.splice(0));

      if (fetched >= maxResults) break;
    }

    return {
      events,
      checkpoint: {
        last_sync_at: new Date().toISOString(),
      } satisfies OutlookCheckpoint as Record<string, unknown>,
    };
  }
}
