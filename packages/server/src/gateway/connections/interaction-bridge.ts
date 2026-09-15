import { createHash, randomUUID } from "node:crypto";
import { createLogger } from "@lobu/core";
import {
	Actions,
	Button,
	Card,
	type CardElement,
	CardText,
	LinkButton,
} from "chat";
import { SCOPE_CHECK_NOT_APPLICABLE } from "../../auth/tool-access.js";
import { getDb, pgTextArray } from "../../db/client.js";
import type { Env } from "../../index.js";
import { ENTITY_CHANGE_ACTION_KEYS } from "../../tools/admin/entity-field-approval.js";
import { manageOperations } from "../../tools/admin/manage_operations.js";
import type { ToolContext } from "../../tools/registry.js";
import {
	actionResolutionText,
	type ActionOrigin,
	actionOriginSubtitle,
	settleActionCard,
} from "../../notifications/action-card-state.js";
import { resolveInteractionActionOrigin } from "../../notifications/action-origin.js";
import {
	claimPendingTool,
	pairAdminGrant,
  type PendingToolClaim,
	type PendingToolClaimant,
} from "../auth/mcp/pending-tool-store.js";
import type { DirectToolExecutionOptions } from "../auth/mcp/proxy.js";
import type {
  InteractionService,
  PostedLinkButton,
  PostedQuestion,
  PostedSuggestion,
  PostedToolApproval,
} from "../interactions.js";
import type { GrantStore } from "../permissions/grant-store.js";
import type { ChatInstanceManager } from "./chat-instance-manager.js";
import {
  claimPendingQuestion,
  deletePendingQuestion,
  readPendingSuggestion,
  storePendingQuestion,
  storePendingSuggestion,
} from "./pending-interaction-store.js";
import { resolveChatTarget } from "./platforms/shared.js";
import type { PlatformConnection } from "./types.js";
import { resolveChatUserIdentity } from "../../lobu/stores/chat-identity.js";
import {
	invokeTemplateEventAction,
	parseTemplateEventActionId,
} from "../../interactions/template-event-actions.js";
import { ToolUserError } from "../../utils/errors.js";

const logger = createLogger("chat-interaction-bridge");

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
		.join(",")}}`;
}

/**
 * Exact webhook retries must converge on one Automation delivery id. Platforms
 * normally put a per-delivery timestamp/id in `raw`, so intentional taps with
 * distinct envelopes remain distinct without branching on provider fields. If
 * a provider repeats an identical envelope, the server has no honest signal
 * that can distinguish a retry from another tap. An adapter that surfaces no
 * `raw` at all gives nothing to hash, so each delivery gets a fresh id and is
 * treated as a distinct tap rather than silently collapsing unrelated clicks.
 */
export function interactionDeliveryId(event: any): string {
	if (!event?.raw) return `interaction-${randomUUID()}`;
	const digest = createHash("sha256")
		.update(
			canonicalJson({
				actionId: event.actionId,
				messageId: event.messageId,
				userId: event.user?.userId,
				raw: event.raw,
			}),
		)
		.digest("hex");
	return `interaction-${digest}`;
}

/** Signature for the direct tool execution function injected from the MCP proxy. */
type ExecuteToolDirectFn = (
  agentId: string,
  userId: string,
  mcpId: string,
  toolName: string,
	args: Record<string, unknown>,
	options: DirectToolExecutionOptions,
) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}>;

/**
 * SentMessage returned by thread.post — we care about .edit() for updating cards
 * after a button click to remove the now-stale action buttons. Typed as `any`
 * because the chat SDK's full type surface isn't imported here.
 */
type SentMessage = { edit: (newContent: any) => Promise<unknown> };

async function postWithFallback(
  thread: any,
  primary: { card: any; fallbackText: string },
  connectionId: string,
	context: string,
): Promise<SentMessage | null> {
  try {
    return (await thread.post(primary)) as SentMessage;
  } catch (error) {
    logger.warn(
      { connectionId, error: String(error) },
			`Failed to post ${context}`,
    );
    try {
      return (await thread.post(primary.fallbackText)) as SentMessage;
    } catch {
      return null;
    }
  }
}

function resolveGrantExpiresAt(duration: string): number | null {
  switch (duration) {
    case "1h":
      return Date.now() + 3_600_000;
    case "24h":
      return Date.now() + 86_400_000;
    case "always":
      return null;
    default:
      return null;
  }
}

/**
 * Atomically claim the pending invocation. The PG-backed `pending-tool` row is
 * consumed in a single statement so the first click wins and subsequent webhook
 * retries report `missing` and no-op. A click by someone other than the
 * requester reports `forbidden`, leaving the row live for the real requester.
 */
async function takePendingToolInvocation(
	requestId: string,
	claimant: PendingToolClaimant,
): Promise<PendingToolClaim> {
  return claimPendingTool(requestId, claimant);
}

function actionEventTeamId(
	event: any,
	connection: PlatformConnection,
): string | null {
	const raw = event?.raw as Record<string, any> | undefined;
	const teamId =
		event?.teamId ??
		raw?.team_id ??
		raw?.team?.id ??
		event?.user?.teamId ??
		event?.user?.team_id ??
		connection.metadata?.teamId ??
		(connection.settings?.previewMode === true ? "" : undefined);
	return typeof teamId === "string" ? teamId : null;
}

/**
 * Map the clicking chat user to a Lobu member allowed to decide this run:
 * exactly ONE identity for (team, platform user) that joins to an org member,
 * AND that member is an admin/owner OR the run's recorded field owner
 * (`ownerUserId`). A non-admin member who is not the owner resolves null, same
 * as an unverified account.
 *
 * Platform-generic by dispatch, not by branch. `resolveChatUserIdentity` already
 * takes the platform and looks up that connector's `ChatUserIdentity`, whose
 * `buildUserKey` owns the scoping rule: Slack's needs a team id because two
 * workspaces can both contain `U12345`, Google's ignores one because Chat events
 * carry no workspace id. So this must NOT pre-check `teamId` itself — a blanket
 * `teamId == null` guard here is Slack's rule applied to every platform, and it
 * is what used to make approval-from-chat Slack-only. A platform with no
 * registered identity still resolves null, the correct fail-closed answer.
 */
async function resolveActionReviewer(params: {
	connection: PlatformConnection;
	platformUserId: string | undefined;
	teamId: string | null;
	ownerUserId?: string | null;
}): Promise<{ userId: string; role: string } | null> {
	const { connection, platformUserId, teamId, ownerUserId } = params;
	if (!connection.organizationId || !platformUserId) return null;
	const userId = await resolveChatUserIdentity(
		connection.platform,
		teamId ?? undefined,
		platformUserId,
	);
	if (!userId) return null;
	const sql = getDb();
	const rows = await sql<{ role: string }>`
    SELECT m.role
    FROM "member" m
    WHERE m."userId" = ${userId}
      AND m."organizationId" = ${connection.organizationId}
    LIMIT 2
  `;
	if (rows.length !== 1) return null;
	const { role } = rows[0];
	const isAdmin = role === "admin" || role === "owner";
	const isOwner = ownerUserId != null && userId === ownerUserId;
	if (!isAdmin && !isOwner) return null;
	return { userId, role };
}

/**
 * Look up a run this Slack card is allowed to decide.
 *
 * Two families qualify, and NOTHING else — the query is the allowlist:
 *
 * 1. Entity field/entity changes (`run_type = 'internal'`, one of
 *    ENTITY_CHANGE_ACTION_KEYS). Their proposal lives in `action_input`.
 * 2. Connector operations (`run_type = 'action'`). The card now names the
 *    operation, connection and input, so the decision is informed — which is
 *    what previously made deciding from chat unsafe, not the execution path:
 *    the click already runs through `manage_operations approve|reject` with a
 *    Slack identity verified against an org admin/owner and real `process.env`,
 *    exactly as the web approval does.
 *
 * A run outside both families reports `not_found`, so its card falls back to
 * the "Review in Lobu" link rather than acting on something unrecognised.
 *
 * Exported for testing: this query IS the authorization boundary for deciding
 * a run from chat, so it is tested directly against a real DB rather than
 * inferred from the click handler.
 */
export async function resolveEntityApprovalRun(
	runId: number,
	organizationId: string,
): Promise<{
	state: "pending" | "approved" | "rejected" | "not_found";
	/**
	 * action_input.owner_user_id — the field owner allowed to decide an entity
	 * change. Always null for a connector operation: there `action_input` is the
	 * agent-authored operation input, so reading an owner out of it would let
	 * the agent nominate its own approver.
	 */
	ownerUserId: string | null;
}> {
	const actionKeys = pgTextArray([...ENTITY_CHANGE_ACTION_KEYS]);
	const rows = await getDb()<{
		id: number;
		approval_status: string | null;
		owner_user_id: string | null;
	}>`
    SELECT id, approval_status,
      CASE WHEN run_type = 'internal'
        THEN action_input->>'owner_user_id'
      END AS owner_user_id
    FROM runs
    WHERE id = ${runId}
      AND organization_id = ${organizationId}
      AND (
        (run_type = 'internal' AND action_key = ANY(${actionKeys}::text[]))
        OR run_type = 'action'
      )
    LIMIT 1
  `;
	if (rows.length !== 1) return { state: "not_found", ownerUserId: null };
	const status = rows[0].approval_status;
	const state =
		status === "pending" || status === "approved" || status === "rejected"
			? status
			: "not_found";
	return { state, ownerUserId: rows[0].owner_user_id ?? null };
}

function formatToolArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      return `  ${k}: ${val}`;
    })
    .join("\n");
}

function questionCard(
	question: string,
	options: string[],
	id: string,
	origin: ActionOrigin,
) {
	return Card({
		subtitle: actionOriginSubtitle(origin),
		children: [
			CardText(question),
			Actions(
				options.map((option, index) =>
					Button({
						id: `question:${id}:${index}`,
						label: option,
						value: option,
					}),
				),
			),
		],
	});
}

function toolApprovalCard(
	pending: {
		mcpId: string;
		toolName: string;
		args: Record<string, unknown>;
	},
	id: string,
	origin: ActionOrigin,
) {
	return Card({
		subtitle: actionOriginSubtitle(origin),
		children: [
			CardText(
				`*Tool Approval*\n${pending.mcpId} → ${pending.toolName}\n${formatToolArgs(pending.args)}`,
			),
			Actions([
				Button({
					id: `tool:${id}:1h`,
					label: "Allow 1h",
					style: "primary",
					value: "1h",
				}),
				Button({
					id: `tool:${id}:24h`,
					label: "Allow 24h",
					style: "primary",
					value: "24h",
				}),
				Button({
					id: `tool:${id}:always`,
					label: "Allow always",
					style: "primary",
					value: "always",
				}),
				Button({
					id: `tool:${id}:deny`,
					label: "Deny always",
					style: "danger",
					value: "deny",
				}),
			]),
		],
	});
}

async function editClickedCard(event: any, card: CardElement): Promise<boolean> {
	const threadId =
		typeof event.threadId === "string"
			? event.threadId
			: typeof event.thread?.id === "string"
				? event.thread.id
				: null;
	const messageId = typeof event.messageId === "string" ? event.messageId : null;
	if (!threadId || !messageId || !event.adapter?.editMessage) return false;
	try {
		await event.adapter.editMessage(threadId, messageId, {
			card,
			fallbackText: "Action updated",
		});
		return true;
	} catch {
		return false;
	}
}

/** Context tracked per posted question so the click handler can feed the
 *  clicked value back into the worker with the same routing as the original
 *  message (userId/conversationId/channelId/teamId). Also holds the SentMessage
 *  for the card so buttons can be stripped after a click. */
interface PendingQuestionEntry {
  question: PostedQuestion;
  sent?: SentMessage;
}

export function registerInteractionBridge(
  interactionService: InteractionService,
  manager: ChatInstanceManager,
  connection: PlatformConnection,
  chat: any,
  grantStore?: GrantStore,
	executeToolDirect?: ExecuteToolDirectFn,
): () => void {
  const { id: connectionId, platform } = connection;

  // Per-connection state (avoids cross-contamination between connections)
  const handledEvents = new Set<string>();
  const activeTimers = new Set<NodeJS.Timeout>();
  // Slack retries event_callback webhooks at ~1s/2s/5s/30s/60s/3min on
  // missed acks; a 30s dedup window let late retries through and
  // double-processed the event. 5min covers the full retry envelope.
  const HANDLED_EVENT_TTL_MS = 5 * 60_000;
  function markHandled(id: string): void {
    handledEvents.add(id);
    const timer = setTimeout(() => {
      handledEvents.delete(id);
      activeTimers.delete(timer);
    }, HANDLED_EVENT_TTL_MS);
    activeTimers.add(timer);
  }

  // Tracks posted tool-approval cards so we can edit them on click to strip
  // the buttons. Keyed by requestId (== PostedToolApproval.id == pending-tool
  // store key). Auto-expire window matches the pending-tool TTL (24h) so a
  // late click can still find the card to strip.
  const APPROVAL_CARD_TTL_MS = 24 * 60 * 60 * 1000;
  const pendingApprovalCards = new Map<string, SentMessage>();
  const pendingApprovalTimers = new Map<string, NodeJS.Timeout>();
  function trackApprovalCard(requestId: string, sent: SentMessage): void {
    pendingApprovalCards.set(requestId, sent);
    const timer = setTimeout(() => {
      pendingApprovalCards.delete(requestId);
      pendingApprovalTimers.delete(requestId);
    }, APPROVAL_CARD_TTL_MS);
    pendingApprovalTimers.set(requestId, timer);
  }
  function claimApprovalCard(requestId: string): SentMessage | undefined {
    const sent = pendingApprovalCards.get(requestId);
    pendingApprovalCards.delete(requestId);
    const timer = pendingApprovalTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      pendingApprovalTimers.delete(requestId);
    }
    return sent;
  }

  // Pending questions are persisted in `public.pending_interactions` so a
  // click landing on a different pod can still claim the entry. The local
  // `pendingSentMessages` map holds the non-serializable platform
  // `SentMessage` (used to strip card buttons on click) — losing it
  // cross-pod is best-effort UX, not correctness.
  //
  // DB-row sweeping is owned globally by `coreServices.sweepEphemeralTables`
  // (scheduled every 5 minutes in `packages/server/src/scheduled/jobs.ts`).
  // We do NOT call `sweepStalePendingInteractions` per-bridge — N bridges
  // hitting the same table N times is wasted work. The local sweep below
  // is in-memory only: it evicts cache entries past their TTL so the Map
  // doesn't grow unbounded for questions that are never clicked.
  const PENDING_SENT_TTL_MS = 24 * 60 * 60 * 1000;
  const PENDING_SENT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
  interface CachedSent {
    sent: SentMessage;
    registeredAt: number;
  }
  const pendingSentMessages = new Map<string, CachedSent>();
  const pendingSentSweepTimer = setInterval(() => {
    const ttlCutoff = Date.now() - PENDING_SENT_TTL_MS;
    for (const [id, entry] of pendingSentMessages) {
      if (entry.registeredAt <= ttlCutoff) {
        pendingSentMessages.delete(id);
      }
    }
  }, PENDING_SENT_SWEEP_INTERVAL_MS);
  pendingSentSweepTimer.unref?.();
  /**
   * Persist a pending question row, then cache its SentMessage handle so a
   * click on this pod can edit the card. The persist happens first — see
   * `onQuestionCreated` for the post-then-persist policy that wraps the
   * card-post; this function is invoked only after the row is durable.
   */
  function rememberSentMessage(
    questionId: string,
		sent: SentMessage | undefined,
  ): void {
    if (!sent) return;
    pendingSentMessages.set(questionId, {
      sent,
      registeredAt: Date.now(),
    });
  }
  async function claimQuestion(
    questionId: string,
    organizationId: string,
		expectedUserId: string,
  ): Promise<PendingQuestionEntry | undefined> {
    const stored = await claimPendingQuestion(
      questionId,
      organizationId,
      connectionId,
			expectedUserId,
    ).catch((error) => {
      logger.error(
        { connectionId, questionId, error: String(error) },
				"Failed to claim pending question",
      );
      return null;
    });
    if (!stored) return undefined;
    const cached = pendingSentMessages.get(questionId);
    pendingSentMessages.delete(questionId);
    return { question: stored.question, sent: cached?.sent };
  }

  /**
   * Shared preamble for every InteractionService handler: platform/tenant
   * guard, per-connection dedup (Slack retries the same webhook for up to
   * 5min), thread resolution, and a catch-all so one handler's failure never
   * escapes into the event emitter. `handler` runs only once per event id with
   * a resolved thread; org/user sub-checks stay inline in each body.
   */
  function withResolvedThread<
    E extends {
      id: string;
      channelId: string;
      conversationId: string;
      platform?: string;
    },
  >(
    eventName: string,
    handler: (event: E, thread: any) => Promise<void>,
  ): (event: E) => Promise<void> {
    return async (event: E) => {
      try {
        if (!shouldHandle(event, platform, connectionId, manager)) return;
        if (handledEvents.has(event.id)) return;
        markHandled(event.id);

        const thread = await resolveThread(
          manager,
          connectionId,
          event.channelId,
          event.conversationId,
        );
        if (!thread) return;

        await handler(event, thread);
      } catch (error) {
        logger.error(
          { connectionId, error: String(error) },
          `Unhandled error in ${eventName} handler`,
        );
      }
    };
  }

  const onQuestionCreated = withResolvedThread<PostedQuestion>(
    "question:created",
    async (event, thread) => {
      // Cross-tenant scoping: every pending row must carry the bridge's
      // org. Without a known org we can't safely persist or claim, so
      // drop the event rather than write an un-scoped row.
      const organizationId = connection.organizationId;
      if (!organizationId) {
        logger.warn(
          { connectionId, questionId: event.id },
					"Skipping question:created — connection has no organizationId",
        );
        return;
      }
      if (!event.userId) {
        logger.warn(
          { connectionId, questionId: event.id },
					"Skipping question:created — event has no userId",
        );
        return;
      }

      // Persist the pending row BEFORE posting the card. If the persist
      // fails we never show buttons that would no-op on click. If the row
      // is written but the post fails, we delete it on the way out so a
      // stale row doesn't sit waiting for a click that will never arrive.
      try {
        await storePendingQuestion(
          event.id,
          organizationId,
          connectionId,
          event.userId,
					{ question: event },
        );
      } catch (error) {
        logger.error(
          { connectionId, questionId: event.id, error: String(error) },
					"Failed to persist pending question — not posting card",
        );
        return;
      }

			const actionOrigin = await resolveInteractionActionOrigin({
				organizationId,
				platform: event.platform,
				conversationId: event.conversationId,
				agentId: connection.agentId,
				source: event.source,
			});
			const card = questionCard(
				event.question,
				event.options,
				event.id,
				actionOrigin,
			);
      const fallbackText = `${event.question}\n${event.options.map((o, i) => `${i + 1}. ${o}`).join("\n")}`;
      const sent = await postWithFallback(
        thread,
        { card, fallbackText },
        connectionId,
				"question interaction",
      );
      if (!sent) {
        // Post failed entirely. The row exists but no card was rendered,
        // so a click can never come — DELETE the row to keep the table
        // clean. Pre-fix used `claimPendingQuestion` (UPDATE setting
        // claimed_at), which leaves a phantom row sitting around with
        // claimed_at set until the 24h sweep. Hard-delete is the
        // semantically correct end state, and the four-field scoping
        // matches the claim path's safety invariant: a leaked id alone
        // cannot delete another tenant's row.
        try {
          await deletePendingQuestion(
            event.id,
            organizationId,
            connectionId,
						event.userId,
          );
        } catch (error) {
          logger.debug(
            { connectionId, questionId: event.id, error: String(error) },
						"Failed to drop pending row after post failure",
          );
        }
        return;
      }
      rememberSentMessage(event.id, sent);
    },
  );

  const onToolApprovalNeeded = withResolvedThread<PostedToolApproval>(
    "tool:approval-needed",
    async (event, thread) => {
			const text = `Tool Approval\n${event.mcpId} → ${event.toolName}\n${formatToolArgs(event.args)}`;
      const tid = event.id;

			const actionOrigin = await resolveInteractionActionOrigin({
				organizationId: connection.organizationId,
				platform: event.platform,
				conversationId: event.conversationId,
				agentId: event.agentId,
				source: event.source,
			});
			const card = toolApprovalCard(event, tid, actionOrigin);
      const sent = await postWithFallback(
        thread,
        { card, fallbackText: text },
        connectionId,
				"tool approval interaction",
      );
      if (sent) {
        trackApprovalCard(tid, sent);
      }
    },
  );

  const onLinkButtonCreated = withResolvedThread<PostedLinkButton>(
    "link-button:created",
    async (event, thread) => {
      const linkButton = LinkButton({
        url: event.url,
        label: event.label,
      });
      // The button itself carries the label — only render an extra line of
      // card-body text when the caller supplied a distinct `body` explaining
      // *why* (e.g. for OAuth, "Authorize {mcp} to continue."). Falling back
      // to `label` again would produce the "Connect sentry / [Connect sentry]"
      // duplication we saw in Slack.
      const bodyText = event.body?.trim();
      const cardChildren =
        bodyText && bodyText !== event.label
          ? [CardText(bodyText), Actions([linkButton])]
          : [Actions([linkButton])];
      const card = Card({ children: cardChildren });
      const fallbackText = bodyText
        ? `${bodyText} ${event.label}: ${event.url}`
        : `${event.label}: ${event.url}`;
      await postWithFallback(
        thread,
        { card, fallbackText },
        connectionId,
				"link button interaction",
      );
    },
  );

  const onSuggestionCreated = withResolvedThread<PostedSuggestion>(
    "suggestion:created",
    async (event, thread) => {
      if (event.prompts.length === 0) return;
      const organizationId = connection.organizationId;
      if (!organizationId) {
        logger.warn(
          { connectionId, suggestionId: event.id },
          "Skipping suggestion:created — connection has no organizationId",
        );
        return;
      }

      // Stash the ROUTING row before posting (same durable-before-card policy
      // as questions). A click must route with the conversation the card was
      // posted for — rebuilding routing from the click event's thread forks a
      // Slack DM (the card posts channel-level, so the click's thread id keys
      // to the card's own ts) and loses history/teamId. The buttons therefore
      // carry only `suggestion:<id>:<i>`; the prompt text and routing live in
      // this row, which also keeps Telegram's 64-byte callback_data budget.
      // Read-not-claim on click: chips stay multi-clickable by design. A row
      // that is never tapped is swept with the shared 24h TTL.
      await storePendingSuggestion(
        event.id,
        organizationId,
        connectionId,
        event.userId,
        { suggestion: event },
      );

      const buttons = event.prompts.map((prompt, i) =>
        Button({
          id: `suggestion:${event.id}:${i}`,
          label: prompt.title,
        })
      );
      const card = Card({ children: [Actions(buttons)] });
      // Platforms without card support get a numbered list. Each line shows the
      // title only — the message can be a full sentence and would bury the list.
      const fallbackText = event.prompts
        .map((prompt, i) => `${i + 1}. ${prompt.title}`)
        .join("\n");
      await postWithFallback(
        thread,
        { card, fallbackText },
        connectionId,
        "suggestion interaction"
      );
    }
  );

  interactionService.on("question:created", onQuestionCreated);
  interactionService.on("suggestion:created", onSuggestionCreated);
  interactionService.on("tool:approval-needed", onToolApprovalNeeded);
  interactionService.on("link-button:created", onLinkButtonCreated);

  registerActionHandlers(
    chat,
    connection,
    grantStore,
    executeToolDirect,
    claimApprovalCard,
    async (questionId, value, thread, author, actionEvent) => {
      // Fast path — Slack's block_actions webhook requires a <3s response.
      // The claim is a single `UPDATE … RETURNING` on a PK and stays well
      // under the budget; the slow platform API calls (post receipt, edit
      // card, enqueue worker turn) still fire-and-forget below.
      //
      // Authorisation lives INSIDE the SQL claim: the row only matches when
      // `(organization_id, connection_id, expected_user_id)` line up with
      // the clicker's context. Wrong-user / cross-connection / cross-tenant
      // clicks return null without consuming the row — no claim-then-auth
      // race, no restash needed.
      const organizationId = connection.organizationId;
      if (!organizationId) {
        logger.warn(
          { connectionId, questionId },
					"Question click on connection with no organizationId — ignoring",
        );
        return;
      }
      if (!author?.userId) {
        logger.debug(
          { connectionId, questionId },
					"Question click without author.userId — ignoring",
        );
        return;
      }

      const entry = await claimQuestion(
        questionId,
        organizationId,
				author.userId,
      );
      if (!entry) {
        logger.debug(
          { connectionId, questionId, clickerUserId: author.userId },
					"Question click did not match any pending row — ignoring",
        );
        return;
      }

      const instance = manager.getInstance(connectionId);
      if (!instance) {
        logger.warn(
          { connectionId },
					"Question click: no instance for connection",
        );
        return;
      }

      const { question } = entry;
      const receiptText = value
        ? `*You submitted:* ${value}`
        : "*You submitted a response.*";

      void (async () => {
				const resolution = {
					status: "answered" as const,
					actorName: author?.fullName ?? author?.userName ?? null,
					resolvedAt: new Date(),
					detail: value ? `Response: ${value}` : "Response submitted.",
				};
				const actionOrigin = await resolveInteractionActionOrigin({
					organizationId,
					platform: question.platform,
					conversationId: question.conversationId,
					agentId: connection.agentId,
					source: question.source,
				});
				const settledCard = settleActionCard(
					questionCard(
						question.question,
						question.options,
						questionId,
						actionOrigin,
					),
					resolution,
				);
				const edited = await editClickedCard(actionEvent, settledCard);
				if (!edited && entry.sent) {
					try {
						await entry.sent.edit({
							card: settledCard,
							fallbackText: actionResolutionText(resolution),
						});
					} catch {
						// best effort — card may be stale or un-editable
					}
				}
				if (!edited && !entry.sent) {
					// The durable claim already won, but this host cannot address the
					// original platform message. Leave a receipt instead of making the
					// click appear to have done nothing.
					try {
						await thread.post(receiptText);
					} catch {
						// best effort
					}
				}

        // MUST route with question.userId (the original message's user), not
        // author.userId (who physically clicked). The worker session is keyed
        // on the original userId and will reject SSE deliveries that don't match.
        await instance.messageBridge.ingestClick({
          userId: question.userId,
          channelId: question.channelId,
          conversationId: question.conversationId,
          teamId: question.teamId,
          authorName: author?.fullName,
          authorUsername: author?.userName,
          value,
          thread,
          responseThreadId:
            typeof thread?.id === "string" ? thread.id : undefined,
          interactionId: interactionDeliveryId(actionEvent),
        });
      })().catch((error) => {
        logger.error(
          { connectionId, questionId, error: String(error) },
					"Background question-click processing failed",
        );
      });
    },
    async (channelId, conversationId) =>
			resolveThread(manager, connectionId, channelId, conversationId),
    async (suggestionId, promptIndex, thread, author, actionEvent) => {
      // A suggestion click is just a new user message — no claim, no receipt,
      // no card edit. The chips intentionally stay clickable: nothing is
      // suspended on their response, so a second tap is a legitimate follow-up
      // question rather than a double-submit against a blocked turn.
      const organizationId = connection.organizationId;
      if (!organizationId) {
        logger.warn(
          { connectionId, suggestionId },
					"Suggestion click on connection with no organizationId — ignoring",
        );
        return;
      }
      if (!author?.userId) {
        logger.debug(
          { connectionId, suggestionId },
					"Suggestion click without author.userId — ignoring",
        );
        return;
      }

      // Route with the PERSISTED conversation context, never the click event's
      // thread: a Slack DM card posts channel-level, so the click's thread id
      // keys to the card's own ts — using it would enqueue the turn with zero
      // history and fork the agent's reply into a thread under the card. The
      // stored row carries the same conversationId/channelId/teamId the
      // original turn ran under. Row gone (swept after 24h) → the chip is
      // inert, matching expired approvals.
      const stored = await readPendingSuggestion(
        suggestionId,
        organizationId,
        connectionId,
      ).catch(() => null);
      const prompt = stored?.suggestion.prompts[promptIndex];
      if (!stored || !prompt) {
        logger.debug(
          { connectionId, suggestionId, promptIndex },
					"Suggestion click with no routable row — likely expired",
        );
        return;
      }

      const instance = manager.getInstance(connectionId);
      if (!instance) {
        logger.warn(
          { connectionId },
					"Suggestion click: no instance for connection",
        );
        return;
      }
      const { suggestion } = stored;
      const routedThread = await resolveThread(
        manager,
        connectionId,
        suggestion.channelId,
        suggestion.conversationId,
      ).catch(() => null);
      // Routed with the CLICKER's userId, unlike question clicks. A question
      // resumes a specific suspended session keyed on the original asker; a
      // suggestion starts a fresh turn, so whoever tapped it is the author.
      await instance.messageBridge.ingestClick({
        userId: author.userId,
        channelId: suggestion.channelId,
        conversationId: suggestion.conversationId,
        teamId: suggestion.teamId,
        authorName: author?.fullName,
        authorUsername: author?.userName,
        value: prompt.message,
        thread: routedThread ?? thread,
        responseThreadId: suggestion.conversationId,
        interactionId: interactionDeliveryId(actionEvent),
      });
    },
		async (sourceEventId, action, value, actionEvent) => {
			const organizationId = connection.organizationId;
			const platformUserId = actionEvent.user?.userId;
			if (!organizationId || !platformUserId) {
				throw new Error("A verified chat actor and workspace are required.");
			}
			return invokeTemplateEventAction({
				organizationId,
				sourceEventId,
				action,
				value,
				interactionId: interactionDeliveryId(actionEvent),
				surface: connection.platform,
				actor: {
					platform: connection.platform,
					platformUserId,
					name:
						actionEvent.user?.fullName ?? actionEvent.user?.userName ?? null,
				},
				source: {
					connectionId: connection.id,
					messageId: actionEvent.messageId,
					threadId: actionEvent.threadId,
				},
			});
		},
  );

  logger.info({ connectionId, platform }, "Interaction bridge registered");

  return () => {
    interactionService.off("question:created", onQuestionCreated);
    interactionService.off("suggestion:created", onSuggestionCreated);
    interactionService.off("tool:approval-needed", onToolApprovalNeeded);
    interactionService.off("link-button:created", onLinkButtonCreated);
    for (const timer of activeTimers) {
      clearTimeout(timer);
    }
    activeTimers.clear();
    handledEvents.clear();
    for (const timer of pendingApprovalTimers.values()) {
      clearTimeout(timer);
    }
    pendingApprovalTimers.clear();
    pendingApprovalCards.clear();
    clearInterval(pendingSentSweepTimer);
    pendingSentMessages.clear();
    logger.info({ connectionId, platform }, "Interaction bridge unregistered");
  };
}

/**
 * Callback invoked when a user clicks a `question:*` button. The interaction
 * bridge owns pending-question tracking, receipt-card rendering, and the
 * enqueue-into-worker pipeline; `registerActionHandlers` just dispatches
 * the raw click through.
 */
type OnQuestionClickFn = (
  questionId: string,
  value: string,
  thread: any,
	author: { userId?: string; userName?: string; fullName?: string } | undefined,
	actionEvent: any,
) => Promise<void>;

/**
 * Dispatches a `suggestion:<id>:<i>` click. The button carries NO value — the
 * prompt text and the conversation routing both live in the pending row stashed
 * at card-post time (see `onSuggestionCreated`), so the handler receives the
 * parsed id + prompt index and resolves everything else from the row.
 */
type OnSuggestionClickFn = (
  suggestionId: string,
  promptIndex: number,
  thread: any,
	author: { userId?: string; userName?: string; fullName?: string } | undefined,
	actionEvent: any,
) => Promise<void>;

type OnTemplateEventActionFn = (
	sourceEventId: number,
	action: string,
	value: string | null,
	actionEvent: any,
) => Promise<unknown>;

/**
 * Exported for testing. Wires chat.onAction to tool-approval and question flows.
 *
 * `claimApprovalCard` (optional) returns the SentMessage for a given
 * requestId if one was tracked by this bridge, and atomically removes it
 * from tracking. Used to edit the card after a click so the buttons go
 * away. Absent in tests.
 *
 * `onQuestionClick` (optional) handles the `question:*` click path. Absent
 * in tests that only exercise tool-approval flows.
 *
 * `onSuggestionClick` (optional) handles the `suggestion:*` click path. Absent
 * in tests that only exercise tool-approval flows.
 */
export function registerActionHandlers(
  chat: any,
  connection: PlatformConnection,
  grantStore: GrantStore | undefined,
  executeToolDirect?: ExecuteToolDirectFn,
  claimApprovalCard?: (requestId: string) => SentMessage | undefined,
  onQuestionClick?: OnQuestionClickFn,
  resolveApprovalTarget?: (
    channelId: string,
		conversationId: string,
	) => Promise<any | null>,
  onSuggestionClick?: OnSuggestionClickFn,
	onTemplateEventAction?: OnTemplateEventActionFn,
): void {
	chat.onAction(async (event: any) => {
		const actionId: string = event.actionId ?? "";
		const value: string = event.value ?? "";
		const thread = event.thread;

		if (!thread || !actionId) return;

		const templateAction = parseTemplateEventActionId(actionId);
		if (templateAction) {
			if (!onTemplateEventAction) return;
			try {
				const result = (await onTemplateEventAction(
					templateAction.sourceEventId,
					templateAction.action,
					event.value === undefined || event.value === null
						? null
						: String(event.value),
					event,
				)) as { created?: boolean } | undefined;
				// Exact webhook retries are silent; the first accepted click gets a
				// compact receipt without routing through the agent/LLM.
				if (result?.created !== false) {
					await thread.post("Recorded.");
				}
			} catch (error) {
				logger.info(
					{ connectionId: connection.id, actionId, error: String(error) },
					"Template event action rejected",
				);
				try {
					await thread.post(
						error instanceof ToolUserError
							? error.message
							: "I couldn’t record that interaction.",
					);
				} catch {
					// best effort
				}
			}
			return;
		}

		// Handle durable run approvals from notification cards. Scope is enforced
		// by resolveEntityApprovalRun's query, not here.
		if (actionId.startsWith("run-approval:")) {
			const [, runIdPart, decisionPart] = actionId.split(":");
			const runId = Number(runIdPart);
			const decision =
				decisionPart === "approve" || decisionPart === "reject"
					? decisionPart
					: null;
			const organizationId = connection.organizationId;
			if (!Number.isFinite(runId) || !decision || !organizationId) return;

			const { state: runState, ownerUserId } = await resolveEntityApprovalRun(
				runId,
				organizationId,
			).catch(() => ({ state: "not_found" as const, ownerUserId: null }));
			if (runState !== "pending") {
				// Distinguish "already decided" (double-click, stale card, webhook
				// retry) from "not an entity approval in this org" — the old single
				// message blamed Slack support for both.
				const message =
					runState === "approved"
						? "This change was already approved."
						: runState === "rejected"
							? "This change was already rejected."
							: "I couldn’t find a pending approval for this card in this workspace. Use the Review in Lobu link.";
				try {
					await thread.post(message);
				} catch {
					// best effort
				}
				return;
			}

			const reviewer = await resolveActionReviewer({
				connection,
				platformUserId: event.user?.userId,
				teamId: actionEventTeamId(event, connection),
				ownerUserId,
			}).catch(() => null);
			if (!reviewer) {
				try {
					// Names no platform: the card renders on every chat connection, so
					// a Slack-worded refusal was simply wrong on Google Chat.
					await thread.post(
						"I couldn’t verify that your chat account maps to a Lobu admin for this workspace. Use the Review in Lobu link.",
					);
				} catch {
					// best effort
				}
				return;
			}

			const ctx: ToolContext = {
				organizationId,
				userId: reviewer.userId,
				memberRole: reviewer.role,
				isAuthenticated: true,
				clientId: null,
				// Session-caller sentinel: the reviewer is authorized by verified
				// Slack identity + role/ownership above, not by MCP token scopes —
				// a null scope set would fail closed at the action tier.
				scopes: [...SCOPE_CHECK_NOT_APPLICABLE],
				tokenType: "session",
				scopedToOrg: true,
				allowCrossOrg: false,
				grantedOrganizationIds: null,
				directSearchFederation: false,
				sourceContext: {
					platform: connection.platform,
					connectionId: connection.id,
					channelId: event.channelId,
					conversationId: event.conversationId,
					teamId: actionEventTeamId(event, connection) ?? undefined,
					userId: event.user?.userId,
				},
			};
			// Real process env, not {}: approving a create runs entity hooks that
			// are env-gated (e.g. $member invite email needs RESEND_API_KEY) — an
			// empty env silently skips them, diverging from web approvals.
			const result = await manageOperations(
				decision === "approve"
					? { action: "approve", run_id: runId }
					: { action: "reject", run_id: runId, reason: "Rejected from Slack" },
				process.env as unknown as Env,
				ctx,
			).catch((error) => ({ error: String(error) }));
			const resultRecord = result as Record<string, unknown>;
			// Keep the terse thread receipt for cards delivered before card payloads
			// were persisted. New cards also settle in place via manage_operations.
			const message =
				typeof resultRecord.message === "string"
					? resultRecord.message
					: typeof resultRecord.error === "string"
						? resultRecord.error
						: decision === "approve"
							? "Approved."
							: "Rejected.";
			try {
				await thread.post(message);
			} catch {
				// best effort
			}
			return;
		}

		// Handle tool approval — store grant, execute tool, post result
		if (actionId.startsWith("tool:")) {
			const parts = actionId.split(":");
			const requestId = parts[1];
			const decision = parts[2] ?? "deny";

			if (!requestId) return;

			// The claim atomically consumes the pending invocation. On Slack retries
			// of the same block_actions webhook the second claim reports `missing`
			// and we silently no-op (the first click already won). But if the card
			// was never claimed before — i.e. the in-memory approval card is still
			// tracked — this is a real first click landing on an expired/missing
			// pending key, and we MUST surface that to the user. Otherwise the
			// click looks like it did nothing. A `forbidden` claim is different
			// again: the row is live for someone else, so it is handled below
			// without touching the card.
			const clickerUserId = event.user?.userId;
			const organizationId = connection.organizationId;
			if (!clickerUserId || !organizationId) return;
			const claim = await takePendingToolInvocation(requestId, {
				userId: clickerUserId,
				organizationId,
			}).catch((): PendingToolClaim => ({ status: "missing" }));
			// A bystander click: the row is still live for the requester, so we must
			// NOT claim or settle the card — the buttons stay actionable for them.
			// Only the clicker gets a receipt explaining why nothing happened.
			if (claim.status === "forbidden") {
				logger.info(
					{ requestId, decision, clickerUserId },
					"Tool approval click by a non-requester — leaving the approval live",
				);
				try {
					await thread.post("Only the requester can act on this approval.");
				} catch {
					// best effort
				}
				return;
			}
			const pending = claim.status === "taken" ? claim.invocation : null;
      if (!pending) {
        const sent = claimApprovalCard?.(requestId);
        if (sent) {
          logger.info(
            { requestId, decision },
						"Tool approval click with no pending invocation — likely expired",
          );
					const expiredResolution = {
						status: "expired" as const,
						detail:
							"Re-send your last message to create a new approval request.",
					};
					const expiredCard = settleActionCard(
						Card({ children: [CardText("*Tool Approval*")] }),
						expiredResolution,
					);
					const edited = await editClickedCard(event, expiredCard);
					try {
						if (!edited) {
							await sent.edit({
								card: expiredCard,
								fallbackText: actionResolutionText(expiredResolution),
							});
						}
					} catch {
						// best effort
					}
          try {
            await thread.post(
							"This tool approval request expired before it could be acted on. Re-send your last message to retry.",
            );
          } catch {
            // best effort
          }
        } else {
          logger.debug(
            { requestId, decision },
						"Tool approval click with no pending invocation and no tracked card — ignoring (already handled)",
          );
        }
        return;
      }

      const pattern = `/mcp/${pending.mcpId}/tools/${pending.toolName}`;

			const resolution = {
				status:
					decision === "deny" ? ("denied" as const) : ("approved" as const),
				actorName: event.user?.fullName ?? event.user?.userName ?? null,
				resolvedAt: new Date(),
				detail:
					decision === "deny"
						? "Tool access denied."
						: `Tool access allowed ${decision === "always" ? "until revoked" : `for ${decision}`}.`,
			};
			const actionOrigin = await resolveInteractionActionOrigin({
				organizationId: pending.organizationId ?? connection.organizationId,
				platform: pending.platform,
				conversationId: pending.conversationId,
				agentId: pending.agentId,
				source: pending.source,
			});
			const settledCard = settleActionCard(
				toolApprovalCard(pending, requestId, actionOrigin),
				resolution,
			);
			const sent = claimApprovalCard?.(requestId);
			const edited = await editClickedCard(event, settledCard);
			if (!edited && sent) {
				try {
					await sent.edit({
						card: settledCard,
						fallbackText: actionResolutionText(resolution),
					});
				} catch {
					// Best effort: durable grant/deny state remains authoritative.
				}
			}

      // Resolve the post target. Prefer the original conversation captured at
      // the time the tool call was blocked (saved alongside the pending
      // record) so the result lands in the same Slack/Telegram thread the
      // user originally pinged the bot in. Fall back to the click event's
      // thread (the card the user just clicked) only if we don't have the
      // original context — that fallback can be wrong on Slack when the card
      // ended up posted at channel level.
      let postTarget: any = thread;
      if (
        resolveApprovalTarget &&
        (pending.conversationId || pending.channelId)
      ) {
        const resolved = await resolveApprovalTarget(
          pending.channelId ?? "",
					pending.conversationId ?? "",
        ).catch(() => null);
        if (resolved) postTarget = resolved;
      }

      if (decision === "deny") {
        if (grantStore) {
          await grantStore
            .grant(
              pending.agentId,
              pattern,
              null,
              true,
							pending.organizationId ?? connection.organizationId,
            )
            .catch(() => undefined);
        }
        try {
          await postTarget.post(
						"Tool call denied. Let me know if you'd like me to try a different approach.",
          );
        } catch {
          // best effort
        }
        return;
      }

      // Approved — store grant, execute, post result
      const expiresAt = resolveGrantExpiresAt(decision);

      if (grantStore) {
        try {
          await grantStore.grant(
            pending.agentId,
            pattern,
            expiresAt,
            undefined,
						pending.organizationId ?? connection.organizationId,
          );
          logger.info(
            {
              requestId,
              agentId: pending.agentId,
              pattern,
              decision,
              expiresAt,
            },
						"Grant stored via tool approval",
          );
        } catch (error) {
          logger.error(
            { requestId, error: String(error) },
						"Failed to store grant",
          );
        }
      }

      // Execute the pending tool call
      if (executeToolDirect) {
        try {
					const organizationId = pending.organizationId;
					if (!organizationId) {
						logger.error(
							{ requestId, mcpId: pending.mcpId, toolName: pending.toolName },
							"Refusing to execute approved MCP tool without organizationId",
						);
						await postTarget.post(
							"This tool approval is missing organization context. Re-send your request to retry.",
						);
						return;
					}
          const result = await executeToolDirect(
            pending.agentId,
            pending.userId,
            pending.mcpId,
            pending.toolName,
						pending.args,
						{
							organizationId,
							conversationId: pending.conversationId,
							channelId: pending.channelId,
							teamId: pending.teamId,
							connectionId: pending.connectionId,
							platform: pending.platform,
							source: pending.source,
							...pairAdminGrant(pending.adminTools, pending.adminActorUserId),
							deploymentName: pending.deploymentName,
						},
          );

          const resultText = result.content.map((c) => c.text).join("\n");
          await postTarget.post(
						result.isError ? `Tool error: ${resultText}` : resultText,
          );
          logger.info(
            {
              requestId,
              mcpId: pending.mcpId,
              toolName: pending.toolName,
              isError: result.isError,
            },
						"Tool executed after approval",
          );
        } catch (error) {
          logger.error(
            { requestId, error: String(error) },
						"Failed to execute tool after approval",
          );
          try {
            await postTarget.post(`Failed to execute tool: ${String(error)}`);
          } catch {
            // best effort
          }
        }
      } else {
        try {
          await postTarget.post("approve");
        } catch {
          // best effort
        }
      }
      return;
    }

    if (actionId.startsWith("suggestion:")) {
      // The button carries only `suggestion:<id>:<i>` — no value. The prompt
      // text and routing live in the pending row (kept out of the button so
      // Telegram's 64-byte callback_data budget holds), so all this branch
      // does is parse and dispatch. A malformed id means the platform mangled
      // the payload and there is nothing safe to send.
      const parts = actionId.split(":");
      const suggestionId = parts[1] ?? "";
      // `Number("")` is 0 — an explicit empty-segment check keeps a truncated
      // `suggestion:<id>:` from dispatching as prompt index 0.
      const promptIndex = parts[2] ? Number(parts[2]) : Number.NaN;
      if (
        parts.length !== 3 ||
        !suggestionId ||
        !Number.isInteger(promptIndex) ||
        promptIndex < 0
      ) {
        logger.debug(
          { connectionId: connection.id, actionId },
					"Suggestion click with malformed action id — ignoring",
        );
        return;
      }
      if (!onSuggestionClick) {
        // Tests / minimal registrations without a click pipeline — nothing to
        // post either, since the prompt text lives in the pending row.
        return;
      }
      try {
        await onSuggestionClick(
          suggestionId,
          promptIndex,
          thread,
          event.user,
          event,
        );
      } catch (error) {
        logger.error(
          { connectionId: connection.id, error: String(error) },
					"Failed to handle suggestion click",
        );
      }
      return;
    }

    if (actionId.startsWith("question:")) {
      const parts = actionId.split(":");
      const questionId = parts[1] ?? "";
      const responseText = value || parts[2] || "";
      if (!questionId) return;
      if (!onQuestionClick) {
        // Tests / minimal registrations without a click pipeline — best-effort
        // post the value so the click is at least visible.
        try {
          await thread.post(responseText);
        } catch {
          // best effort
        }
        return;
      }
      try {
				await onQuestionClick(
					questionId,
					responseText,
					thread,
					event.user,
					event,
				);
      } catch (error) {
        logger.error(
          { connectionId: connection.id, error: String(error) },
					"Failed to handle question click",
        );
      }
    }
  });
}

export function shouldHandle(
  event: {
    teamId?: string;
    channelId: string;
    connectionId?: string;
    platform?: string;
  },
  platform: string,
  connectionId: string,
	manager: ChatInstanceManager,
): boolean {
  // Platform isolation: a bridge only handles events posted for its own
  // platform. This is what makes connectionless `platform: "api"` events
  // (API sessions have no Chat SDK connection) safe — without it, the
  // connectionId fall-through below would let any chat bridge pick them up.
  if (event.platform && event.platform !== platform) {
    return false;
  }
  if (!manager.has(connectionId)) {
    logger.debug(
      { connectionId, eventConnectionId: event.connectionId },
			"shouldHandle: manager does not have connection",
    );
    return false;
  }
  if (event.connectionId && event.connectionId !== connectionId) {
    return false;
  }
  const instance = manager.getInstance(connectionId);
  if (!instance) {
    logger.debug({ connectionId }, "shouldHandle: no instance found");
    return false;
  }
  const matches = instance.connection.platform === platform;
  logger.debug({ connectionId, platform, matches }, "shouldHandle: result");
  if (!matches) {
    logger.debug(
      {
        connectionId,
        instancePlatform: instance.connection.platform,
        eventPlatform: platform,
      },
			"shouldHandle: platform mismatch",
    );
  }
  return matches;
}

async function resolveThread(
  manager: ChatInstanceManager,
  connectionId: string,
  channelId: string,
	conversationId: string,
): Promise<any | null> {
  const instance = manager.getInstance(connectionId);
  if (!instance) {
    logger.debug({ connectionId }, "resolveThread: no instance for connection");
    return null;
  }

  try {
    // No `currentMessage` / `responseThreadId` for interactions — the bridge
    // resolves the post target purely from channelId + the canonical
    // conversation thread id.
    return await resolveChatTarget(
      instance.chat,
      instance.connection.platform,
      { channelId, conversationId },
    );
  } catch (error) {
    logger.debug(
      { connectionId, channelId, conversationId, error: String(error) },
			"Failed to resolve thread for interaction",
    );
    return null;
  }
}
