import { Actions, Button, Card, CardText, LinkButton } from "chat";
import { getDb } from "../db/client";
import { emit } from "../events/emitter";
import type { McpActivityAttribution } from "../lobu/stores/mcp-client-conversations";
import {
	BROWSER_SESSION_EXPIRED_KIND,
	CONNECTION_AUTHORIZATION_KIND,
	CONNECTOR_OPERATION_APPROVAL_KIND,
	ENTITY_CHANGE_APPROVAL_KIND,
	INVITATION_RECEIVED_KIND,
} from "../utils/platform-notification-kinds";
import { buildResourcePermalink } from "../utils/url-builder";
import { resolveAskAffordance } from "./ask-schema";
import type { ActionOrigin } from "./action-card-state";
import { createNotificationForUsers, getOrgSlug } from "./service";

/** Notification content minus the org id (the dispatch helpers stamp it). */
type OrgNotification = Omit<
	Parameters<typeof createNotificationForUsers>[1],
	"organizationId"
>;

type FieldChangeApprovalDetails = {
	kind: "entity_field_change";
	actorLabel?: string | null;
	entityId?: number | null;
	entityType?: string | null;
	entityName?: string | null;
	entityUrl?: string | null;
	fields: Record<string, unknown>;
	current?: Record<string, unknown> | null;
	reason?: string | null;
};

type EntityChangeApprovalDetails = {
	kind: "entity_change";
	operation: "create" | "delete" | "merge";
	actorLabel?: string | null;
	entityId?: number | null;
	entityType?: string | null;
	entityName?: string | null;
	entityUrl?: string | null;
	proposal?: Record<string, unknown> | null;
	current?: Record<string, unknown> | null;
	reason?: string | null;
};

export type ActionApprovalDetails =
	| FieldChangeApprovalDetails
	| EntityChangeApprovalDetails;

/**
 * Escape user/agent-controlled text for the in-app Markdown body (GFM, so
 * strikethrough and autolinks are live too). These strings are entity names,
 * actor labels, and JSON values, and they get interpolated INTO our own
 * `**bold**` and `[label](url)` chrome — so anything that could terminate that
 * chrome early, or start markup of its own, has to be neutralised:
 *  - `` \ ` * _ ~ `` — emphasis/strikethrough/code delimiters. Missing `~` let
 *    an actor named `~~trusted agent~~` render struck-through.
 *  - `[` and `]` — a stray `]` closes our link label early, letting the rest of
 *    the name escape the anchor. Escaping is unconditional: a lookahead rule
 *    (only before `(`) missed unmatched brackets. The renderer strips the
 *    backslashes, so `[ 886 ]` still displays literally.
 *  - `<` and `>` — GFM autolinks. `<https://evil.example>` became a real
 *    attacker-controlled anchor inside a trusted-looking card.
 *  - Leading block marks — reasons render as their own paragraph, so headings,
 *    quotes, lists, and setext underlines must stay literal text there.
 */
function escapeMarkdownText(value: string): string {
	return value
		.replace(/([\\`*_~[\]<>])/g, "\\$1")
		// Setext underlines and thematic breaks: ANY run length turns the line
		// above into a heading ("Trusted line\n=" renders as <h1>), so this is not
		// limited to the 3+ runs that form a `---` rule.
		.replace(/^([ \t]{0,3})([-=]+)(?=[ \t]*$)/gm, "$1\\$2")
		.replace(/^([ \t]{0,3})(?=[#>+-](?:\s|$))/gm, "$1\\")
		.replace(/^([ \t]{0,3}\d{1,9})([.)])(?=\s|$)/gm, "$1\\$2");
}

/** Raw display text; each emitter applies its own escaping. */
function displayNotificationValue(value: unknown): string {
	if (value === undefined || value === null || value === "") return "Not set";
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2);
}

function truncateNotificationLine(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > 480
		? `${normalized.slice(0, 477)}...`
		: normalized;
}


/** "$parent_id" → "Parent id", "entity_type" → "Entity type". */
export function formatLabel(value: string): string {
	return value
		.replace(/^\$/, "")
		.replace(/[_-]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^./, (char) => char.toUpperCase());
}

/** "Update topic fields: Severity, Name" — shared with the propose path. */
export function formatFieldChangeAction(
	entityType: string | null | undefined,
	fields: string[],
): string {
	const fieldList = fields.map(formatLabel).join(", ") || "field";
	const fieldNoun = fields.length === 1 ? "field" : "fields";
	const entityLabel = entityType
		? formatLabel(entityType).toLowerCase()
		: "entity";
	return `Update ${entityLabel} ${fieldNoun}: ${fieldList}`;
}

function formatReviewLink(url: string): string {
	return `[Review in Lobu](${url})`;
}

/**
 * Raw before/after pair. Kept UNASSEMBLED so each emitter can escape the two
 * values without touching the `~old~` strikethrough delimiters it adds itself —
 * escaping a pre-assembled string turned our own markup into literal `\~`.
 */
function compactDiffValues(
	currentValue: unknown,
	proposedValue: unknown,
): { current: string; proposed: string } {
	return {
		current: truncateNotificationLine(displayNotificationValue(currentValue)),
		proposed: truncateNotificationLine(displayNotificationValue(proposedValue)),
	};
}

function formatWhyApprovalNeeded(reason: string | null | undefined): string {
	// Neutral fallback: this card also fires for org-policy gates (admin said
	// "updates need approval"), not only the human-owned-field guard.
	const fallback =
		"This change needs a human approval before it is applied.";
	if (!reason) return fallback;
	return reason.replace(/^Automation proposes updating /i, "Field is protected: ");
}

export function formatActionApprovalTitle(
	actionKey: string,
	details?: ActionApprovalDetails,
): string {
	if (details?.kind === "entity_field_change") {
		return formatFieldChangeAction(
			details.entityType,
			Object.keys(details.fields),
		).replace(/^Update /, "Review ");
	}
	if (details?.kind === "entity_change") {
		const entityLabel = details.entityType
			? formatLabel(details.entityType).toLowerCase()
			: "entity";
		return details.operation === "delete"
			? `Review deleting ${entityLabel}`
			: details.operation === "merge"
				? `Review merging ${entityLabel}`
				: `Review creating ${entityLabel}`;
	}
	return `Action "${actionKey}" needs approval`;
}

/**
 * Format-neutral content of an approval card, computed ONCE for both surfaces
 * (in-app Markdown body and Slack mrkdwn card): truncation, labels, diff lines,
 * and the "why" sentence live here. Each emitter applies the escaping required
 * by its own markup syntax.
 */
interface ApprovalRenderModel {
	requestedBy: string | null;
	entityName: string | null;
	entityUrl: string | null;
	entityId: number | null;
	/** formatLabel(entityType), for the body's entity-link fallback. */
	entityTypeLabel: string | null;
	/**
	 * Field-change diffs (null for entity_change — kinds render differently).
	 * Values stay unassembled so emitters escape them without mangling the
	 * strikethrough delimiters they wrap around `current`.
	 */
	diffs: Array<{ label: string; current: string; proposed: string }> | null;
	/** entity_change action sentence ("Create/Delete this entity"). */
	action: string | null;
	proposal: Array<{ label: string; value: string }>;
	/** Fully formatted "why" text; null omits the section. */
	why: string | null;
}

function buildApprovalRenderModel(
	details: ActionApprovalDetails,
): ApprovalRenderModel {
	const base = {
		// Collapsed to one line: these are interpolated into a single summary
		// sentence, and an embedded newline would split it across Markdown
		// paragraphs — leaving the card preview (first block only) showing a
		// truncated half-sentence.
		requestedBy: details.actorLabel
			? truncateNotificationLine(details.actorLabel)
			: null,
		entityName: details.entityName
			? truncateNotificationLine(details.entityName)
			: null,
		entityUrl: details.entityUrl ?? null,
		entityId: details.entityId ?? null,
		entityTypeLabel: details.entityType ? formatLabel(details.entityType) : null,
	};
	if (details.kind === "entity_field_change") {
		const current = details.current ?? {};
		return {
			...base,
			diffs: Object.entries(details.fields).map(([field, proposed]) => ({
				label: formatLabel(field),
				...compactDiffValues(current[field], proposed),
			})),
			action: null,
			proposal: [],
			why: formatWhyApprovalNeeded(details.reason),
		};
	}
	return {
		...base,
		diffs: null,
		action:
			details.operation === "delete"
				? "Delete this entity"
				: details.operation === "merge"
					? "Merge these entities"
					: "Create this entity",
		proposal: Object.entries(details.proposal ?? {}).map(([field, value]) => ({
			label: formatLabel(field),
			value: truncateNotificationLine(displayNotificationValue(value)),
		})),
		why: details.reason ?? null,
	};
}

/**
 * In-app Markdown body. Kept tight — the structured approval card (with the
 * Approve/Reject buttons) is the primary surface; this body is the scannable
 * one-glance summary above it: WHO wants to do WHAT to WHICH entity, the diff,
 * and one review link. No "Requested by:/Proposed action:/Why approval is
 * needed:" scaffolding — a single natural sentence carries it.
 */
function renderApprovalBody(
	model: ApprovalRenderModel,
	approvalUrl?: string,
): string {
	const lines: string[] = [];
	const label = escapeMarkdownText(
		model.entityName ?? model.entityTypeLabel ?? "this entity",
	);
	// Only the label is escaped — the URL is ours (buildResourcePermalink), and
	// escaping it would break the link target.
	const entityLink = model.entityUrl
		? `[${label}](${model.entityUrl})`
		: model.entityId
			? `${label} (#${model.entityId})`
			: label;
	const who = escapeMarkdownText(model.requestedBy ?? "An automation");

	// One summary line: "<Automation> wants to <verb> <entity>."
	if (model.diffs) {
		lines.push(`**${who}** wants to update ${entityLink}:`);
		for (const d of model.diffs)
			lines.push(
				`- ${d.label}: ~${escapeMarkdownText(d.current)}~\n→ ${escapeMarkdownText(d.proposed)}`,
			);
	} else {
		const verb =
			model.action === "Delete this entity"
				? "delete"
				: model.action === "Merge these entities"
					? "merge"
					: "create";
		lines.push(`**${who}** wants to ${verb} ${entityLink}.`);
		if (model.proposal.length > 0) {
			for (const p of model.proposal)
				lines.push(`- ${p.label}: ${escapeMarkdownText(p.value)}`);
		}
	}
	// The proposer's own reason, inline and unlabeled (it reads as a sentence).
	if (model.why) lines.push("", escapeMarkdownText(model.why));
	if (approvalUrl) lines.push("", formatReviewLink(approvalUrl));
	return lines.join("\n");
}

export function formatActionApprovalBody(params: {
	connectionName?: string;
	approvalUrl?: string;
	details?: ActionApprovalDetails;
}): string {
	if (
		params.details?.kind === "entity_field_change" ||
		params.details?.kind === "entity_change"
	) {
		return renderApprovalBody(
			buildApprovalRenderModel(params.details),
			params.approvalUrl,
		);
	}

	// Escaped like every other interpolation into this Markdown body — a
	// connection named "X](https://evil) [y" would otherwise forge an anchor.
	const connLabel = params.connectionName
		? ` on ${escapeMarkdownText(truncateNotificationLine(params.connectionName))}`
		: "";
	const urlLine = params.approvalUrl
		? `\n\nReview: ${formatReviewLink(params.approvalUrl)}`
		: "";
	return `A queued action${connLabel} is waiting for your review.${urlLine}`;
}

/**
 * The chat card for an ask, on the SAME affordance rule the web row uses.
 *
 * Sharing `resolveAskAffordance` is the point: the decision "can this be
 * settled in one click, or does it need real input?" is derived once from the
 * schema and answered identically on every surface. Decision-only asks get
 * Approve/Reject; anything needing input gets the review link ONLY — a button
 * that cannot carry the human's input would report success while discarding it.
 *
 * Entity and operation approvals never come through here: they render through
 * their platform notification kinds in `notifyActionApprovalNeeded`.
 */
export function buildActionApprovalCard(params: {
	runId?: number;
	approvalUrl?: string;
	/** The card body — for an ask, the question being put to the approver. */
	summary?: string | null;
	/**
	 * The interaction's answer schema. `null` asserts "this decision takes no
	 * input"; OMITTING it means the caller does not know, which is NOT the same
	 * thing and must not render decision buttons — a family that quietly takes
	 * input would get an Approve button that discards it.
	 */
	inputSchema?: Record<string, unknown> | null;
}) {
	// Only a no-input decision is decidable from chat. Without buttons the card
	// would carry a review link and nothing else, which the markdown body
	// already says — so fall back to the body rather than repeat it.
	if (
		params.inputSchema === undefined ||
		resolveAskAffordance(params.inputSchema).kind !== "binary"
	) {
		return undefined;
	}

	const actions = [];
	if (params.runId) {
		actions.push(
			Button({
				id: `run-approval:${params.runId}:approve`,
				label: "Approve",
				style: "primary",
				value: "approve",
			}),
		);
		actions.push(
			Button({
				id: `run-approval:${params.runId}:reject`,
				label: "Reject",
				style: "danger",
				value: "reject",
			}),
		);
	}
	if (params.approvalUrl) {
		actions.push(
			LinkButton({ url: params.approvalUrl, label: "Review in Lobu" }),
		);
	}

	const cardText = params.summary?.trim() ?? "";
	return Card({
		children: [
			...(cardText ? [CardText(cardText)] : []),
			...(actions.length > 0 ? [Actions(actions)] : []),
		],
	});
}

async function getOrgAdminUserIds(organizationId: string): Promise<string[]> {
	const sql = getDb();
	const rows = await sql<{ userId: string }>`
    SELECT "userId"
    FROM "member"
    WHERE "organizationId" = ${organizationId}
      AND role IN ('admin', 'owner')
  `;
	return rows.map((r) => r.userId);
}

/**
 * Shared trigger tail: write the notification for the resolved recipients and
 * poke the org's SSE keys so inboxes refresh. Every trigger below ends here;
 * what varies is recipient resolution — admins (with the org slug fetched for
 * URL building) vs an explicit user — kept explicit per trigger.
 */
async function sendNotification(
	orgId: string,
	userIds: string[],
	notification: OrgNotification,
): Promise<void> {
	await createNotificationForUsers(userIds, {
		organizationId: orgId,
		...notification,
	});
	emit(orgId, { keys: ["notifications", "notifications-unread-count"] });
}

/**
 * Admin-recipient triggers: resolve the org's admins/owners (no-op when there
 * are none — the slug isn't fetched either), then build the notification with
 * the org slug available for resource URLs.
 */
async function notifyOrgAdmins(
	orgId: string,
	build: (orgSlug: string | null) => OrgNotification,
): Promise<void> {
	const adminIds = await getOrgAdminUserIds(orgId);
	if (adminIds.length === 0) return;

	const orgSlug = await getOrgSlug(orgId);
	await sendNotification(orgId, adminIds, build(orgSlug));
}

/**
 * Which user, if any, should get the approval as a Slack DM.
 *
 * `deliverToBotConnections` tries the DM tier BEFORE the channel tier and
 * returns on success, so this is a real precedence decision and not a
 * preference: hand it the requester while a chat origin is also set and an
 * approval asked for in a channel silently lands in the asker's DM instead,
 * inverting the documented conversation → DM → inbox order.
 *
 * A field owner always wins — they own the change under review, and routing it
 * to them is the point of the tier. The requester is the fallback that gives an
 * MCP-initiated approval (no chat coordinates at all) somewhere to go.
 */
export function resolveApprovalDmTarget(params: {
	ownerUserId?: string | null;
	requesterUserId?: string | null;
	connectionId?: string | null;
	channelId?: string | null;
}): string | null {
	if (params.ownerUserId) return params.ownerUserId;
	if (params.connectionId || params.channelId) return null;
	return params.requesterUserId ?? null;
}

export async function notifyActionApprovalNeeded(params: {
	orgId: string;
	runId: number;
	actionKey: string;
	connectionName?: string;
	eventId: number;
	approvalUrl?: string;
	connectionId?: string | null;
	channelId?: string | null;
	teamId?: string | null;
	/** Field owner — routes the Slack card to their DM before the channel tier. */
	ownerUserId?: string | null;
	/**
	 * The human whose turn queued this approval. Used as the DM tier when there
	 * is no field owner AND no chat origin — an MCP-initiated approval (Claude
	 * Code, claude.ai) carries no chat coordinates at all, so without this it
	 * would have no chat destination and land in the inbox alone.
	 */
	requesterUserId?: string | null;
	mcpActivity?: McpActivityAttribution | null;
	actionOrigin?: ActionOrigin | null;
	details?: ActionApprovalDetails;
	/**
	 * Set ONLY for a connector operation (`run_type = 'action'`). Its presence
	 * is what routes the notification through the platform notification kind and puts
	 * Approve/Reject on the chat card — builder runs (`manage_automations`,
	 * `manage_agents`) also arrive without `details`, but the chat click handler
	 * cannot decide them, so they must not be inferred into this family.
	 */
	operation?: {
		/** Human-readable operation name. */
		name: string;
		/** The operation's input, rendered so the decision can be made from chat. */
		input: Record<string, unknown>;
	} | null;
}): Promise<void> {
	const operation = params.operation ?? null;
	// The render model is already the shape a template wants — a couple of
	// scalars plus `diffs` / `proposal` lists — so the kind's `each` walks it
	// directly rather than a formatter flattening it into one paragraph.
	const entityChange = params.details
		? (buildApprovalRenderModel(params.details) as unknown as Record<string, unknown>)
		: null;
	await notifyOrgAdmins(params.orgId, (orgSlug) => {
		// Run-scoped, via the shared permalink resolver — same reasoning as the
		// approval_url: the pending event is superseded on approve→complete, but the
		// run link stays valid across the chain. (baseUrl omitted → relative link,
		// which the inbox resolves against the current origin.)
		const resourceUrl = buildResourcePermalink(orgSlug, {
			kind: "run",
			runId: params.runId,
		});
		return {
			type: "action_approval_needed",
			title: formatActionApprovalTitle(params.actionKey, params.details),
			body: formatActionApprovalBody(params),
			// Both approval families render through a platform notification kind, so the
			// chat post, the Memory view and MCP apps all show the SAME table from
			// one declaration instead of each surface formatting the payload again.
			...(operation
				? {
						semanticType: CONNECTOR_OPERATION_APPROVAL_KIND,
						payloadData: {
							operation: operation.name,
							connection: params.connectionName ?? null,
							input: operation.input,
						},
						decisionRunId: params.runId,
					}
				: {}),
			...(entityChange
				? {
						semanticType: ENTITY_CHANGE_APPROVAL_KIND,
						payloadData: entityChange,
						decisionRunId: params.runId,
					}
				: {}),
			resourceType: "event",
			resourceId: String(params.eventId),
			resourceUrl,
			connectionId: params.connectionId,
			channelId: params.channelId,
			teamId: params.teamId,
			// Never org-wide. An approval with no resolved chat target reaches its
			// admins through the inbox + approval URL; broadcasting it into every
			// bound channel is noise, not reach. See CreateNotificationParams.
			deliveryScope: "targeted",
			ownerUserId: resolveApprovalDmTarget(params),
			mcpActivity: params.mcpActivity,
			actionOrigin: params.actionOrigin,
		};
	});
}

/** Deep-link into a single connection (settings / re-auth), not the connectors list. */
function connectionDetailUrl(
	orgSlug: string | null | undefined,
	connectorKey: string,
	connectionId: number,
): string | undefined {
	if (!orgSlug) return undefined;
	return `/${orgSlug}/connectors/${connectorKey}/${connectionId}`;
}

export async function notifyConnectionPermissionRequest(params: {
	orgId: string;
	connectionId: number;
	connectorKey: string;
}): Promise<void> {
	const sql = getDb();
	const [connection] = await sql`
		SELECT c.created_by, c.display_name
		FROM connections c
		JOIN "member" m ON m."organizationId" = c.organization_id AND m."userId" = c.created_by
		WHERE c.organization_id = ${params.orgId} AND c.id = ${params.connectionId} AND c.deleted_at IS NULL
	`;
	if (!connection?.created_by) return;
	const orgSlug = await getOrgSlug(params.orgId);
	await sendNotification(params.orgId, [connection.created_by], {
		type: "connection_permission_request",
		title: `Connection "${connection.display_name ?? params.connectorKey}" needs authorization`,
		body: "Connect your account to finish setting up this connection.",
		ownerUserId: connection.created_by,
		deliveryScope: "targeted",
		semanticType: CONNECTION_AUTHORIZATION_KIND,
		payloadData: {
			connector: params.connectorKey,
			status: "Waiting for OAuth authorization",
		},
		resourceType: "connection",
		resourceId: String(params.connectionId),
		resourceUrl: connectionDetailUrl(
			orgSlug,
			params.connectorKey,
			params.connectionId,
		),
	});
}

export async function notifyBrowserAuthExpired(params: {
	orgId: string;
	connectionId: number;
	connectorKey: string;
	/**
	 * Set for connectors that store a `browser_session` auth profile (the CLI /
	 * Mac browser-auth capture flow). Omitted for extension-scrape connectors
	 * (e.g. Revolut, LinkedIn) that reuse the live browser session and have no
	 * stored auth profile — those just need the user to re-login on the site.
	 */
	authProfileSlug?: string | null;
}): Promise<void> {
	await notifyOrgAdmins(params.orgId, (orgSlug) => ({
		type: "browser_auth_expired",
		title: `${params.connectorKey} needs sign-in`,
		body: "Syncing has stopped until the session is renewed.",
		semanticType: BROWSER_SESSION_EXPIRED_KIND,
		payloadData: {
			connector: params.connectorKey,
			status: "Session expired — syncing stopped",
			fix: params.authProfileSlug
				? `Run: lobu memory browser-auth --connector ${params.connectorKey} --auth-profile-slug ${params.authProfileSlug}`
				: `Open ${params.connectorKey} in the browser where your Owletto extension runs and sign in.`,
		},
		resourceType: "connection",
		resourceId: String(params.connectionId),
		// Connection detail is where re-auth / browser profile is managed —
		// not Infrastructure (devices) or a bare connectors list.
		resourceUrl: connectionDetailUrl(
			orgSlug,
			params.connectorKey,
			params.connectionId,
		),
	}));
}

export async function notifyInvitationReceived(params: {
	orgId: string;
	userId: string;
	orgName: string;
	inviterName?: string;
	/** Invitation row id — required for the accept deep-link. */
	invitationId: string;
}): Promise<void> {
	const inviterLabel = params.inviterName ? ` by ${params.inviterName}` : "";
	// Same path the invite email uses — members list is NOT the accept UI.
	const acceptPath = `/auth/accept-invitation?invitationId=${encodeURIComponent(params.invitationId)}`;
	await sendNotification(params.orgId, [params.userId], {
		type: "invitation_received",
		title: `You've been invited to ${params.orgName}`,
		semanticType: INVITATION_RECEIVED_KIND,
		payloadData: {
			organization: params.orgName,
			invitedBy: params.inviterName ?? null,
		},
		body: `You were invited${inviterLabel} to join the organization.`,
		resourceType: "invitation",
		resourceId: params.invitationId,
		resourceUrl: acceptPath,
	});
}
