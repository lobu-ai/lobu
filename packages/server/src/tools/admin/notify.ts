/**
 * Tool: notify
 *
 * Send notifications to organization members from agents.
 *
 * Actions:
 * - send: Send a notification to org members
 */

import { type Static, Type } from '@sinclair/typebox';
import type { CardElement } from 'chat';
import { getDb, parsePgTextArray, pgTextArray } from '../../db/client';
import { emit } from '../../events/emitter';
import { currentMcpActivityAttribution } from '../../lobu/stores/mcp-client-conversations';
import { resolveActionOrigin } from '../../notifications/action-origin';
import { queueAgentAsk } from '../../notifications/ask';
import {
  createNotificationForUsers,
  findNotificationByIdempotencyKey,
  getOrgSlug,
} from '../../notifications/service';
import { buildActionApprovalCard } from '../../notifications/triggers';
import { ToolUserError } from '../../utils/errors';
import { validateSaveContentSemanticType } from '../../utils/event-kind-validation';
import logger from '../../utils/logger';
import { buildResourcePermalink } from '../../utils/url-builder';
import { trackAutomationReaction } from '../../utils/automation-reactions';
import { loadConfiguredAutomationDeliveryTarget } from '../../automations/delivery-target';
import { normalizePageActivationUrl } from '../../runs/page-activation';
import type { ToolContext } from '../registry';
import { action, defineActionTool } from './action-tool';

// ============================================
// Schema
// ============================================

const SendAction = Type.Object({
  action: Type.Literal('send'),
  title: Type.String({ description: 'Notification title', maxLength: 200 }),
  body: Type.Optional(Type.String({ description: 'Notification body text', maxLength: 1000 })),
  recipients: Type.Optional(
    Type.Union(
      [
        Type.Literal('admins'),
        Type.Literal('all'),
        Type.Array(Type.String({ description: 'User ID' })),
      ],
      {
        default: 'admins',
        description:
          "Who to notify. 'admins' (default): org admins/owners. 'all': all org members. Or an array of specific user IDs.",
      }
    )
  ),
  resource_url: Type.Optional(
    Type.String({ description: 'Relative URL to link the notification to (e.g. /acme/entities)' })
  ),
  browser_url: Type.Optional(
    Type.String({
      format: 'uri',
      description: 'HTTP(S) page for an explicit browser-side "Open" action in the current user tab.',
    })
  ),
  browser_handoff_run_id: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        'Page-activated operation run that will populate browser_url when its owner visits the page. The run must belong to the same workspace, target the same normalized URL, and be owned by one of the resolved recipients; delivery then narrows to that owner, since nobody else can activate it.',
    })
  ),
  idempotency_key: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 300,
      description:
        'Stable producer key. Repeating a send with the same key returns success without creating or delivering a duplicate.',
    })
  ),
  connection_id: Type.Optional(
    Type.String({
      description:
        'Connection ID for targeted delivery (e.g. Telegram bot connection). When set, notification is delivered through this specific bot connection.',
    })
  ),
  data: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description:
        'Structured payload. With `semantic_type`, this becomes the event\'s render data (bound to the kind\'s `jsonTemplate` in the Memory view) instead of being appended to the body. Without `semantic_type`, it is stored in the notification body as formatted JSON (legacy).',
    })
  ),
  semantic_type: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        'Event semantic type (kind) for this notification\'s content, validated against the org\'s `$member.event_kinds`. When set, the notification renders through the event-kind pipeline: `data` feeds the kind\'s `jsonTemplate` in the Memory/Events view, and the inbox keeps the markdown `body`. Mutually exclusive with `input_schema`.',
    })
  ),
  card: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description:
        'A `chat` CardElement (built with the card primitives) for rich bot-connection delivery. When set, the bound channel gets this card instead of the markdown body.',
    })
  ),
  input_schema: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description:
        'Turn this notification into a QUESTION the recipient answers, instead of an FYI. Pass {} for a plain yes/no decision; a single required string-enum property for one-click options; or a flat object of primitive fields, scalar enums, string/scalar-enum arrays, and optional nullable anyOf wrappers for a form. Give each property a `title`. Nested objects, references, other combinators, constants, formats, patterns, and string/number/array constraints are unsupported and fail with HTTP 422 before a run is created. Read the answer with manage_operations get_run.',
    })
  ),
  automation_source: Type.Optional(
    Type.Object(
      {
        automation_id: Type.Number({ description: 'Automation that triggered this notification' }),
        run_id: Type.Number({ description: 'Automation run that triggered this notification' }),
      },
      { description: 'Attribution source when notification is triggered by an Automation reaction' }
    )
  ),
});

// ============================================
// Handler
// ============================================

const notifyTool = defineActionTool('notify', {
  send: action(SendAction, handleSend),
});

export const NotifySchema = notifyTool.schema;
export const notify = notifyTool.run;

async function handleSend(
  args: Static<typeof SendAction>,
  ctx: ToolContext
): Promise<{
  notified_count: number;
  event_id: number | null;
  url: string | null;
  run_id?: number;
}> {
  const sql = getDb();
  const kind = args.semantic_type ?? null;

  if (kind && args.input_schema) {
    throw new ToolUserError(
      'notify: `semantic_type` and `input_schema` are mutually exclusive — a notification is either content (kind + data) or a question (input_schema), not both.'
    );
  }
  if (args.browser_url) {
    let browserUrl: URL;
    try {
      browserUrl = new URL(args.browser_url);
    } catch {
      throw new ToolUserError('notify: `browser_url` must be a valid HTTP(S) URL.', 422);
    }
    if (browserUrl.protocol !== 'http:' && browserUrl.protocol !== 'https:') {
      throw new ToolUserError('notify: `browser_url` must be a valid HTTP(S) URL.', 422);
    }
  }
  if (args.browser_handoff_run_id != null && !args.browser_url) {
    throw new ToolUserError(
      'notify: `browser_handoff_run_id` requires `browser_url`.',
      422
    );
  }

  // Validate the request even when recipient resolution later produces no rows.
  if (kind) {
    const kindValidation = await validateSaveContentSemanticType(
      kind,
      args.data,
      ctx.organizationId
    );
    if (!kindValidation.valid) {
      throw new ToolUserError(kindValidation.errors.join('\n'), 422);
    }
  }

  const recipients = args.recipients ?? 'admins';

  let userIds: string[];
  if (Array.isArray(recipients)) {
    // Validate that the provided user IDs are actual members of the org
    const rows = await sql<{ userId: string }>`
      SELECT "userId"
      FROM "member"
      WHERE "organizationId" = ${ctx.organizationId}
        AND "userId" = ANY(${pgTextArray(recipients)}::text[])
    `;
    userIds = rows.map((r) => r.userId);
  } else if (recipients === 'all') {
    const rows = await sql<{ userId: string }>`
      SELECT "userId"
      FROM "member"
      WHERE "organizationId" = ${ctx.organizationId}
    `;
    userIds = rows.map((r) => r.userId);
  } else {
    // 'admins' (default)
    const rows = await sql<{ userId: string }>`
      SELECT "userId"
      FROM "member"
      WHERE "organizationId" = ${ctx.organizationId}
        AND role IN ('admin', 'owner')
    `;
    userIds = rows.map((r) => r.userId);
  }

  if (userIds.length === 0) {
    return { notified_count: 0, event_id: null, url: null };
  }

  if (args.browser_handoff_run_id != null && args.browser_url) {
    const handoffRows = await sql<{
      id: number;
      created_by_user_id: string | null;
      activation_target_urls: string | string[] | null;
    }>`
      SELECT id, created_by_user_id, activation_target_urls
      FROM runs
      WHERE id = ${args.browser_handoff_run_id}
        AND organization_id = ${ctx.organizationId}
        AND run_type = 'action'
        AND approval_status IN ('auto', 'approved')
        AND activation_kind = 'page_visit'
      LIMIT 1
    `;
    const handoffRun = handoffRows[0];
    if (!handoffRun) {
      throw new ToolUserError(
        'notify: `browser_handoff_run_id` must reference a page-activated action in this workspace.',
        422
      );
    }
    const normalizedBrowserUrl = normalizePageActivationUrl(args.browser_url);
    if (
      !parsePgTextArray(handoffRun.activation_target_urls).includes(
        normalizedBrowserUrl
      )
    ) {
      throw new ToolUserError(
        'notify: `browser_url` must match the linked page-activation run.',
        422
      );
    }
    if (
      handoffRun.created_by_user_id == null ||
      !userIds.includes(handoffRun.created_by_user_id)
    ) {
      throw new ToolUserError(
        'notify: the page-activation run owner must be one of the notification recipients.',
        422
      );
    }
    // Only the run owner can activate this draft. A broader informational
    // audience would receive dead cards, so materialize the handoff solely in
    // the actionable owner's inbox even when recipients was "admins"/"all".
    userIds = [handoffRun.created_by_user_id];
  }

  // Kind data renders separately; legacy untyped data remains appended to body.
  let body = args.body ?? null;
  if (args.data && !kind) {
    const dataStr = JSON.stringify(args.data, null, 2);
    body = body ? `${body}\n\n${dataStr}` : dataStr;
  }

  // Provenance for the notification row itself. Read from the SERVER-set acting
  // context (the reaction executor stamps it), never from `args.automation_source`
  // — that is caller input, and `automation_id` decides what an Automation's own
  // window excludes, so a chosen id would let one Automation blind another.
  // `automation_source` is caller input and never supplies trusted provenance.
  //
  // The version comes from the RUN, not from `automations.current_version_id`.
  // current_version_id is the version that is current *now*, at send time — a
  // version bump between dispatch and this notification would attribute the
  // output to a prompt that never produced it. Since the whole point of this
  // column is attributing output quality to a prompt version, a plausible wrong
  // answer is worse than none: when there is no acting run to read (agent tool
  // calls carry `actingRunId = null`), this stays NULL rather than guessing.
  // Same source the backfill trusts, and the same choice entity-field-approval
  // already makes.
  const actingAutomationId = ctx.actingAutomationId ?? null;
  const actingRunId = ctx.actingRunId ?? null;
  // A repeat performs no new delivery, so resolve it before rejecting a route
  // that may have become stale after the original notification was created.
  const priorNotificationId =
    args.idempotency_key && (args.input_schema || actingAutomationId !== null)
      ? await findNotificationByIdempotencyKey(
          ctx.organizationId,
          args.idempotency_key
        )
      : null;
  if (actingAutomationId !== null && priorNotificationId === null) {
    const configuredDelivery = await loadConfiguredAutomationDeliveryTarget(
      getDb(),
      ctx.organizationId,
      actingAutomationId
    );
    if (configuredDelivery.configured && !configuredDelivery.target) {
      throw new ToolUserError(
        'This Automation\'s delivery channel is no longer available. Re-link the private channel or choose another delivery channel before retrying.',
        422
      );
    }
  }
  const actingVersionRows =
    actingAutomationId && actingRunId
      ? await getDb()<{ version_id: string | null }>`
          SELECT approved_input->>'version_id' AS version_id
          FROM runs
          WHERE id = ${actingRunId}
            AND organization_id = ${ctx.organizationId}
            AND automation_id = ${actingAutomationId}
          LIMIT 1
        `
      : [];
  const rawVersionId = actingVersionRows[0]?.version_id;
  const actingVersionId =
    rawVersionId != null && /^[0-9]{1,9}$/.test(rawVersionId)
      ? Number(rawVersionId)
      : null;

  const orgSlug = await getOrgSlug(ctx.organizationId);
  const actionOrigin = args.input_schema
    ? await resolveActionOrigin(ctx)
    : null;

  // Feedback is learned from server-stamped execution provenance only.
  // Caller input must never choose another Automation's learning history.
  const reactionAutomationId = ctx.actingAutomationId ?? null;
  const reactionRunId = ctx.actingRunId ?? null;
  const trackNotificationReaction = async (runId?: number): Promise<void> => {
    if (reactionAutomationId === null || reactionRunId === null) return;
    await trackAutomationReaction({
      organizationId: ctx.organizationId,
      automationId: reactionAutomationId,
      sourceRunId: reactionRunId,
      reactionType: 'notification_sent',
      toolName: 'notify',
      toolArgs: { title: args.title, recipients: args.recipients },
      ...(runId != null ? { runId } : {}),
    });
  };

  // An idempotent repeat of an ASK must resolve before anything is queued: the
  // pending run + interaction event are durable, so queueing first and letting
  // the notification insert dedupe would strand an orphan pending run — and
  // hand the agent a run_id no inbox points at, which it would poll forever
  // while the human answers the original.
  if (args.input_schema && priorNotificationId !== null) {
    const priorRunId = await findAskRunForNotification(
      ctx.organizationId,
      priorNotificationId
    );
    if (priorRunId !== null) {
      // The notification can commit before this feedback edge. A failed first
      // attempt therefore reconciles here on retry instead of returning early
      // forever with an ask the Automation cannot learn from.
      await trackNotificationReaction(priorRunId);
    }
    return {
      notified_count: 0,
      event_id: priorNotificationId,
      url:
        buildResourcePermalink(orgSlug, {
          kind: 'event',
          eventId: priorNotificationId,
        }) ?? null,
      ...(priorRunId !== null ? { run_id: priorRunId } : {}),
    };
  }

  // An `input_schema` turns this from an FYI into a QUESTION: queue the pending
  // run + interaction event first, then point the notification at it. That
  // pointer (`action_approval_needed` + resource_type='event') is what the
  // inbox, activity feed, and chat bridge already resolve to a live decision —
  // so an ask needs no new rendering path on any surface.
  const ask = args.input_schema
    ? await queueAgentAsk({
        ctx,
        question: args.title,
        body,
        inputSchema: args.input_schema as Record<string, unknown>,
      })
    : null;

  // An ask needs a REVIEW destination, not just an inbox row: it is where a
  // field-shaped answer gets typed, and where the peek pane resolves to. Point
  // it at the run permalink — run-scoped so it survives the supersede chain
  // when the decision lands — matching every other approval trigger. Without
  // one, the notification href degrades to the workspace memory index and the
  // pane can only show title + body.
  const askReviewUrl = ask
    ? buildResourcePermalink(orgSlug, { kind: 'run', runId: ask.runId })
    : undefined;

  const notification = await createNotificationForUsers(userIds, {
    organizationId: ctx.organizationId,
    type: ask ? 'action_approval_needed' : 'agent_message',
    title: args.title,
    body,
    semanticType: kind ?? undefined,
    payloadData: kind ? args.data : undefined,
    resourceType: ask ? 'event' : null,
    resourceId: ask ? String(ask.interactionEventId) : null,
    resourceUrl: args.resource_url ?? askReviewUrl ?? null,
    browserUrl: args.browser_url ?? null,
    browserRunId: args.browser_handoff_run_id ?? null,
    idempotencyKey: args.idempotency_key ?? null,
    connectionId: args.connection_id ?? null,
    // Explicit inbox recipients are not consent to the default org-wide chat
    // broadcast. An explicit connection or configured Automation destination
    // still routes normally; an unavailable target must not widen the audience.
    deliveryScope: Array.isArray(recipients) ? 'targeted' : undefined,
    // An ask builds its chat card from the SAME schema the web row reads, via
    // the shared approval-card builder — so a yes/no question gets working
    // Slack buttons and a question needing input gets a link instead of
    // buttons that could not carry the answer. An explicit `card` still wins.
    card:
      (args.card as CardElement | undefined) ??
      (ask
        ? (buildActionApprovalCard({
            runId: ask.runId,
            approvalUrl: askReviewUrl,
            summary: body ?? args.title,
            inputSchema: args.input_schema as Record<string, unknown>,
          }) ?? null)
        : null),
    mcpActivity: currentMcpActivityAttribution(ctx),
    actionOrigin,
    automationId: actingAutomationId,
    automationVersionId: actingVersionId,
    runId: actingRunId,
  });

  if (notification.created) {
    emit(ctx.organizationId, { keys: ['notifications', 'notifications-unread-count'] });
  }

  // Two replicas can race past the idempotency preflight above; the loser's
  // notification insert resolves to the winner's event, so the run WE queued is
  // an orphan nothing points at. Resolve the delivered run before reaction
  // tracking so automation_reactions always points at the decision the human sees.
  let askRunId = ask?.runId ?? null;
  if (ask && !notification.created && notification.eventId !== null) {
    askRunId = await findAskRunForNotification(
      ctx.organizationId,
      notification.eventId
    );
    logger.warn(
      { orphanRunId: ask.runId, eventId: notification.eventId, askRunId },
      '[notify] Concurrent duplicate ask; returning the delivered run, orphan left to the approval expiry sweep'
    );
  }

  if (askRunId !== null) {
    // The ask-to-Automation edge is required and idempotent: if it fails, surface
    // the failure so the caller retries and the preflight above repairs it.
    await trackNotificationReaction(askRunId);
  } else if (notification.created) {
    // Plain FYI notifications have no run handle to use as a durable dedupe
    // key, so retain their historical best-effort tracking semantics.
    await trackNotificationReaction().catch((err) => {
      logger.warn(
        { err, automationId: reactionAutomationId, runId: reactionRunId },
        'trackAutomationReaction failed'
      );
    });
  }

  // The event id IS the notification id — there is no second identifier — so an
  // agent that just sent a notification can cite it, link a human to it, or read
  // it back without guessing. Populated on an idempotent repeat too: the send
  // did not create anything, but the durable notification it collapsed into is
  // still the right thing to hand back.
  const url =
    notification.eventId === null
      ? null
      : (buildResourcePermalink(orgSlug, {
          kind: 'event',
          eventId: notification.eventId,
        }) ?? null);

  return {
    notified_count: notification.created ? userIds.length : 0,
    event_id: notification.eventId,
    url,
    // Present only for an ask. This is the handle the agent polls to read the
    // human's answer back (`manage_operations get_run`), so it must come back
    // from the send that created it — there is no other way to find it.
    ...(askRunId !== null ? { run_id: askRunId } : {}),
  };
}

/**
 * The run behind an ask notification: notification event → its interaction
 * event (`resource_id`) → that event's run. Used to answer an idempotent
 * repeat with the run the human actually sees, instead of a fresh orphan.
 * Null when the key belongs to a plain FYI notification — the repeat then
 * correctly reports "already sent" with no run to poll.
 */
async function findAskRunForNotification(
  organizationId: string,
  notificationEventId: number
): Promise<number | null> {
  const sql = getDb();
  // MATERIALIZED is load-bearing, not style: `resource_id` is only an event id
  // when `resource_type` says 'event' — an invitation notification stores a
  // UUID there. Casting inside a JOIN lets the planner reach the cast before
  // that filter and raise `invalid input syntax for type bigint`. The fence
  // guarantees the row is narrowed first, and it costs nothing on a PK lookup.
  const rows = await sql<{ run_id: string | number | null }>`
    WITH target AS MATERIALIZED (
      SELECT metadata->>'resource_id' AS interaction_event_id
      FROM events
      WHERE id = ${notificationEventId}
        AND organization_id = ${organizationId}
        AND metadata->>'resource_type' = 'event'
    )
    SELECT i.run_id
    FROM target
    JOIN events i
      ON i.id = target.interaction_event_id::bigint
     AND i.organization_id = ${organizationId}
    WHERE i.interaction_type = 'approval'
    LIMIT 1
  `;
  const runId = rows[0]?.run_id;
  return runId == null ? null : Number(runId);
}
