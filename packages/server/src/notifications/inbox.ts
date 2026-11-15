/** Published, send-only workspace intake. Recipient authority stays in $member. */
import { createHash } from 'node:crypto';
import type { DbClient } from '../db/client';
import { getDb } from '../db/client';
import type { ToolContext } from '../tools/registry';
import { isInProcessSystemCall } from '../tools/access-control';
import { ToolUserError } from '../utils/errors';
import { getAjv } from '../utils/ajv-singleton';
import { exceedsValidationLimits } from '../utils/metadata-limits';
import type { EventKindDefinition } from '../utils/event-kind-validation';
import { getRateLimiter } from '../utils/rate-limiter';
import { stableJson } from '../utils/insert-event';
import { enqueueWorkspaceEventActivations } from '../automations/workspace-event-enqueue';
import { createNotificationForUsers, findNotificationByIdempotencyKey } from './service';

export interface InboxSubmitInput {
  organization: string;
  inbox: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  idempotency_key: string;
}
export interface InboxReceipt { status: 'received'; receipt: string }
export interface InboxListing {
  inboxes: Array<{ key: string; description: string; input_schema: Record<string, unknown> }>;
}

function requireSender(ctx: ToolContext): void {
  if (!ctx.isAuthenticated || !(ctx.userId && ctx.memberRole ||
    isInProcessSystemCall(ctx) && ctx.actingAutomationId)) {
    throw new ToolUserError('An authenticated sending workspace member or Automation is required', 403, 'PERMISSION');
  }
}

async function loadInboxKinds(organization: string, db: DbClient, lock = false) {
  const rows = await db<{ organization_id: string; event_kinds: Record<string, EventKindDefinition> }>`
    SELECT et.organization_id, et.event_kinds FROM entity_types et
    JOIN "organization" o ON o.id = et.organization_id
    WHERE o.slug = ${organization} AND et.slug = '$member' AND et.deleted_at IS NULL
    LIMIT 1 ${lock ? db`FOR SHARE OF et` : db``}
  `;
  return rows[0];
}

function published(kind: EventKindDefinition | undefined): boolean {
  return kind?.inbox?.accept_from === 'authenticated_workspaces' && kind.inbox.recipients === 'admins';
}

export async function listNotificationInboxes(organization: string, ctx: ToolContext): Promise<InboxListing> {
  requireSender(ctx);
  const row = await loadInboxKinds(organization, getDb());
  return { inboxes: Object.entries(row?.event_kinds ?? {}).filter(([, kind]) => published(kind))
    .map(([key, kind]) => ({ key, description: kind.description ?? '', input_schema: kind.metadataSchema ?? { type: 'object' } })) };
}

export async function submitNotificationInbox(input: InboxSubmitInput, ctx: ToolContext): Promise<InboxReceipt> {
  requireSender(ctx);
  const data = input.data ?? {};
  if (exceedsValidationLimits(data, { maxDepth: 32, maxNodes: 10000, maxBytes: 16384 }) ||
    Buffer.byteLength(JSON.stringify(data), 'utf8') > 16384) {
    throw new ToolUserError('Inbox data must not exceed 16 KiB', 422, 'VALIDATION');
  }
  const sql = getDb();
  return sql.begin(async (tx) => {
    // Share the owning registry row's lock with schema updates: revocation and
    // acceptance serialize across replicas, without a cached permission window.
    const receiver = await loadInboxKinds(input.organization, tx, true);
    const kind = receiver?.event_kinds?.[input.inbox];
    if (!receiver || !published(kind)) throw new ToolUserError('Published inbox not found', 404, 'NOT_FOUND');
    const validate = getAjv().compile(kind.metadataSchema ?? { type: 'object' });
    if (!validate(data)) throw new ToolUserError('Report data does not match the published inbox schema', 422, 'VALIDATION');
    // AJV can coerce primitive fields; enforce the persisted byte size too.
    if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 16384)
      throw new ToolUserError('Inbox data must not exceed 16 KiB', 422, 'VALIDATION');
    const sender = { organization_id: ctx.organizationId, user_id: ctx.userId,
      agent_id: ctx.agentId ?? null, automation_id: ctx.actingAutomationId ?? null,
      run_id: ctx.actingRunId ?? null, inbox: input.inbox };
    // Scope the producer key to the authenticated sending actor and inbox.
    // A receiver's other producers cannot collide with caller-selected keys.
    const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');
    const key = `inbox:${digest([ctx.organizationId, ctx.userId, ctx.agentId ?? null,
      ctx.actingAutomationId ?? null, input.inbox, input.idempotency_key])}`;
    const fingerprint = digest([input.title, input.body ?? '', data]);
    const prior = await findNotificationByIdempotencyKey(receiver.organization_id, key, tx);
    if (prior !== null) {
      const [stored] = await tx<{ metadata: Record<string, unknown> }>`SELECT metadata FROM events
        WHERE id = ${prior} AND organization_id = ${receiver.organization_id}`;
      if (stored?.metadata.inbox_fingerprint !== fingerprint) {
        throw new ToolUserError('Idempotency key already belongs to a different report', 409, 'PRECONDITION_FAILED');
      }
      return { status: 'received' as const, receipt: String(prior) };
    }
    const limit = await getRateLimiter().consume(`notification-inbox:${ctx.organizationId}:${receiver.organization_id}`, {
      limit: 30, windowSeconds: 60, errorMessage: 'Inbox submission rate limit exceeded',
    });
    if (!limit.countedInDb) throw new ToolUserError('Inbox admission is temporarily unavailable', 503, 'UPSTREAM_UNAVAILABLE');
    if (!limit.allowed) {
      const error = new ToolUserError('Inbox submission rate limit exceeded', 429, 'RATE_LIMITED');
      error.retryAfterSeconds = limit.resetInSeconds;
      throw error;
    }
    const admins = await tx<{ userId: string }>`SELECT "userId" FROM "member"
      WHERE "organizationId" = ${receiver.organization_id} AND role IN ('owner', 'admin')`;
    if (!admins.length) throw new ToolUserError('Published inbox has no available administrators', 404, 'NOT_FOUND');
    const notification = await createNotificationForUsers(admins.map((admin) => admin.userId), {
      organizationId: receiver.organization_id, type: 'agent_message', title: input.title,
      body: input.body, semanticType: input.inbox, payloadData: data,
      idempotencyKey: key, deliveryScope: 'targeted',
      inboxSubmission: sender, inboxFingerprint: fingerprint,
    }, tx);
    if (notification.eventId === null) throw new Error('Inbox event was not persisted');
    if (!notification.created) {
      const [stored] = await tx<{ metadata: Record<string, unknown> }>`SELECT metadata FROM events
        WHERE id = ${notification.eventId} AND organization_id = ${receiver.organization_id}`;
      if (stored?.metadata.inbox_fingerprint !== fingerprint)
        throw new ToolUserError('Idempotency key already belongs to a different report', 409, 'PRECONDITION_FAILED');
    }
    // Event, admin targets and Automation activation commit together. The
    // existing queue and trigger delivery ids make all downstream retries safe.
    await enqueueWorkspaceEventActivations(tx, [{ organizationId: receiver.organization_id,
      eventId: notification.eventId, rootEventIds: [notification.eventId], causalAutomationIds: [], depth: 1 }]);
    return { status: 'received' as const, receipt: String(notification.eventId) };
  });
}
