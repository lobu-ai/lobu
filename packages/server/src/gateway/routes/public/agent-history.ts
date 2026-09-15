/**
 * Agent history routes — proxy session data from worker HTTP server,
 * with direct session-file fallback for embedded dev mode, plus
 * per-thread list/message endpoints for the web-panel chat UI.
 * Auth: settings session cookie (verifySettingsSession).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentConfigStore, ParsedMessage } from "@lobu/core";
import {
	AGENT_ERRORS,
	createLogger,
	entryToMessage,
	parseSessionEntries,
	toAgentErrorCode,
} from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { getDb } from "../../../db/client.js";
import { resolveOrgId } from "../../../lobu/stores/org-context.js";
import { readCurrentSuggestion } from "../../suggestions/persist-suggestion.js";
import type { UserAgentsStore } from "../../auth/user-agents-store.js";
import type { ArtifactStore } from "../../files/artifact-store.js";
import {
	isConversationVisible,
	listAgentThreads,
	readConversationMessages,
	readThreadMessages,
	resolveChannelVisibility,
} from "../../services/agent-thread-list.js";
import { isAdminOrOwnerRole } from "../../../tools/access-control.js";
import { getMembershipRole } from "../../../workspace/multi-tenant.js";
import { buildApiConversationId } from "../../services/api-conversation-id.js";
import { findConversationById } from "../../services/conversations-store.js";
import { readAutomationRunThreads } from "../../services/automation-run-thread.js";
import {
	createOwnershipResolver,
	resolveSettingsLookupUserId,
	sessionMatchesMetadataOwner,
} from "../shared/agent-ownership.js";
import {
	authorizeOrgAgentMemberInProvenOrg,
	isRestrictedOrgAgentMember,
} from "../shared/org-agent-access.js";
import { errorResponse } from "../shared/helpers.js";
import { verifySettingsSession } from "./settings-auth.js";

/**
 * Read the latest completed transcript snapshot for an agent's most-recent
 * conversation. Returns the raw JSONL content + sessionId-equivalent, or
 * null when no snapshot exists.
 */
export async function readLatestSnapshotJsonl(
	agentId: string,
	organizationId: string | undefined
): Promise<string | null> {
	if (!organizationId) return null;
	const sql = getDb();
	const snapshotRows = await sql<{ snapshot_jsonl: string }>`
    SELECT snapshot_jsonl
    FROM public.agent_transcript_snapshot
    WHERE organization_id = ${organizationId}
      AND agent_id = ${agentId}
      AND terminal_status = 'completed'
    ORDER BY run_id DESC
    LIMIT 1
  `;
	return snapshotRows[0]?.snapshot_jsonl ?? null;
}

const logger = createLogger("agent-history-routes");

type ToolApprovalHistoryInteraction = {
	type: "tool-approval";
	eventId: number;
	runId: number;
	action: string | null;
	proposal: Record<string, unknown> | null;
	current: Record<string, unknown> | null;
	fields: Record<string, unknown> | null;
	attribution: string | null;
	/** Discriminator: "agent" | "automation" | "entity". */
	resourceKind: string | null;
	reason: string | null;
};

type AgentErrorHistoryInteraction = {
	type: "agent-error";
	runId: number;
	error: string;
	errorCode: string | null;
	errorContext: { provider?: string; model?: string } | null;
};

type SuggestionHistoryInteraction = {
	type: "suggestion";
	prompts: Array<{ title: string; message: string }>;
};

type HistoryInteraction =
	| ToolApprovalHistoryInteraction
	| AgentErrorHistoryInteraction
	| SuggestionHistoryInteraction;

/**
 * Rehydrate the latest non-silent terminal agent error for a conversation.
 * This interaction is supplemental to transcript history, so storage or legacy
 * payload parsing failures log and degrade to no interaction instead of
 * failing the messages endpoint.
 */
async function readLatestAgentErrorInteraction(
	organizationId: string,
	conversationId: string
): Promise<AgentErrorHistoryInteraction | null> {
	try {
		const rows = await getDb()<{
			id: number;
			payload: Record<string, unknown> | null;
		}>`
			WITH response_rows AS (
				SELECT id,
				       CASE
				         WHEN jsonb_typeof(action_input) = 'string'
				           THEN (action_input #>> '{}')::jsonb
				         ELSE action_input
				       END AS payload
				FROM public.runs
				WHERE organization_id = ${organizationId}
				  AND run_type = 'chat_message'
				  AND queue_name = 'thread_response'
				  AND status IN ('pending', 'completed', 'failed')
				  AND action_input IS NOT NULL
			)
			SELECT id, payload
			FROM response_rows
			WHERE payload->>'conversationId' = ${conversationId}
			  AND (payload ? 'error' OR payload ? 'processedMessageIds')
			ORDER BY id DESC
			LIMIT 1
		`;
		const row = rows[0];
		if (!row?.payload || typeof row.payload !== "object") return null;

		// A newer successful terminal row supersedes any older error for the thread.
		if (typeof row.payload.error !== "string") return null;
		const code = toAgentErrorCode(row.payload.errorCode);
		const spec = code ? AGENT_ERRORS[code] : undefined;
		if (spec?.silent) return null;
		const error = spec?.message ?? row.payload.error;
		if (!error) return null;

		const rawContext =
			row.payload.errorContext &&
			typeof row.payload.errorContext === "object" &&
			!Array.isArray(row.payload.errorContext)
				? (row.payload.errorContext as Record<string, unknown>)
				: null;
		const provider =
			typeof rawContext?.provider === "string"
				? rawContext.provider
				: undefined;
		const model =
			typeof rawContext?.model === "string" ? rawContext.model : undefined;
		const errorContext =
			provider || model
				? {
						...(provider ? { provider } : {}),
						...(model ? { model } : {}),
					}
				: null;

		return {
			type: "agent-error",
			runId: Number(row.id),
			error,
			errorCode: code ?? null,
			errorContext,
		};
	} catch (error) {
		logger.warn("Failed to read latest agent error interaction", {
			error,
			organizationId,
			conversationId,
		});
		return null;
	}
}

// Tokenless artifact references persisted in the transcript by the message-send
// path (`[name](/api/v1/files/:id)`). They carry no expiring credential, so the
// history read path re-signs them with a fresh, absolute download URL on every
// load — keeping links live across reloads without ever persisting a token.
// Matches the path only when NOT already followed by a query string (so an
// already-signed link is left untouched).
const TOKENLESS_FILE_REF =
	/\/api\/v1\/files\/([A-Za-z0-9._~-]+)(?![A-Za-z0-9._~?-])/g;

/**
 * Recursively rewrite tokenless `/api/v1/files/:id` references in a user
 * message's persisted content into fresh, absolute, signed download URLs.
 * Exported for unit testing.
 */
export function resignFileRefs(
	content: unknown,
	artifactStore: ArtifactStore,
	publicGatewayUrl: string
): unknown {
	if (typeof content === "string") {
		return content.replace(TOKENLESS_FILE_REF, (_match, artifactId: string) =>
			artifactStore.buildDownloadUrl(publicGatewayUrl, artifactId)
		);
	}
	if (Array.isArray(content)) {
		return content.map((entry) =>
			resignFileRefs(entry, artifactStore, publicGatewayUrl)
		);
	}
	if (content && typeof content === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(content)) {
			out[key] = resignFileRefs(value, artifactStore, publicGatewayUrl);
		}
		return out;
	}
	return content;
}

const SAFE_AGENT_ID = /^[a-zA-Z0-9_-]+$/;
const SAFE_THREAD_ID = /^[a-zA-Z0-9_-]+$/;

function isSafeAgentId(id: string): boolean {
	return SAFE_AGENT_ID.test(id);
}

function isSafeThreadId(id: string): boolean {
	return SAFE_THREAD_ID.test(id);
}

async function findSessionFile(agentId: string): Promise<string | null> {
	if (!isSafeAgentId(agentId)) return null;
	const workspacesRoot = resolve("workspaces");
	const workspaceDir = resolve(workspacesRoot, agentId);
	if (!workspaceDir.startsWith(`${workspacesRoot}/`)) return null;

	const directPath = join(workspaceDir, ".lobu", "session.jsonl");
	try {
		await stat(directPath);
		return directPath;
	} catch {
		// Not found
	}

	try {
		const search = async (
			dir: string,
			depth: number
		): Promise<string | null> => {
			if (depth > 3) return null;
			const entries = await readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
				const sessionPath = join(dir, entry.name, ".lobu", "session.jsonl");
				try {
					await stat(sessionPath);
					return sessionPath;
				} catch {
					const deeper = await search(join(dir, entry.name), depth + 1);
					if (deeper) return deeper;
				}
			}
			return null;
		};
		return await search(workspaceDir, 0);
	} catch {
		// Workspace dir doesn't exist
	}

	return null;
}

async function readSessionMessages(
	agentId: string,
	cursorParam: string,
	limit: number,
	organizationId: string | undefined
) {
	let content: string | null = await readLatestSnapshotJsonl(
		agentId,
		organizationId
	);
	if (content === null) {
		const sessionPath = await findSessionFile(agentId);
		if (!sessionPath) {
			return {
				messages: [],
				nextCursor: null,
				hasMore: false,
				sessionId: "none",
			};
		}
		content = await readFile(sessionPath, "utf-8");
	}
	const { entries, sessionId } = parseSessionEntries(content);

	const allMessages: ParsedMessage[] = [];
	for (const entry of entries) {
		const msg = entryToMessage(entry);
		if (msg) allMessages.push(msg);
	}

	let startIndex = 0;
	if (cursorParam) {
		const idx = allMessages.findIndex((m) => m.id === cursorParam);
		if (idx >= 0) startIndex = idx + 1;
	}

	const pageMessages = allMessages.slice(startIndex, startIndex + limit);
	const hasMore = startIndex + limit < allMessages.length;
	const nextCursor = hasMore ? pageMessages[pageMessages.length - 1]?.id : null;

	return {
		messages: pageMessages,
		nextCursor,
		hasMore,
		sessionId: sessionId || "unknown",
	};
}

async function readSessionStats(
	agentId: string,
	organizationId: string | undefined
) {
	let content: string | null = await readLatestSnapshotJsonl(
		agentId,
		organizationId
	);
	if (content === null) {
		const sessionPath = await findSessionFile(agentId);
		if (!sessionPath) {
			return {
				sessionId: "none",
				messageCount: 0,
				userMessages: 0,
				assistantMessages: 0,
				totalInputTokens: 0,
				totalOutputTokens: 0,
			};
		}
		content = await readFile(sessionPath, "utf-8");
	}
	const { entries, sessionId } = parseSessionEntries(content);

	let messageCount = 0;
	let userMessages = 0;
	let assistantMessages = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let currentModel: string | undefined;

	for (const entry of entries) {
		if (entry.type === "message" && entry.message) {
			messageCount++;
			if (entry.message.role === "user") userMessages++;
			if (entry.message.role === "assistant") assistantMessages++;
			if (entry.message.usage) {
				const u = entry.message.usage as {
					inputTokens?: number;
					input?: number;
					outputTokens?: number;
					output?: number;
				};
				totalInputTokens += u.inputTokens || u.input || 0;
				totalOutputTokens += u.outputTokens || u.output || 0;
			}
		}
		if (entry.type === "model_change") {
			currentModel = `${entry.provider}/${entry.modelId}`;
		}
	}

	return {
		sessionId: sessionId || "unknown",
		messageCount,
		userMessages,
		assistantMessages,
		totalInputTokens,
		totalOutputTokens,
		currentModel,
	};
}

export function createAgentHistoryRoutes(deps: {
	agentConfigStore?: Pick<AgentConfigStore, "getMetadata">;
	userAgentsStore?: UserAgentsStore;
	artifactStore?: ArtifactStore;
	publicGatewayUrl?: string;
}) {
	const app = new Hono();
	const { artifactStore, publicGatewayUrl } = deps;
	const resolveOwnership = createOwnershipResolver({
		userAgentsStore: deps.userAgentsStore,
		agentMetadataStore: deps.agentConfigStore,
	});

	async function getAuthorizedAgentScope(c: Context): Promise<{
		agentId: string;
		organizationId: string | undefined;
		userId: string;
		isAdmin: boolean;
		/**
		 * The caller's org role, set ONLY when they do not OWN the agent and were
		 * authorized by org membership alone; undefined on the ownership path.
		 *
		 * Every route below is already keyed on `scope.userId` (thread ids are
		 * rebuilt from it), so a member reads only their own conversations. The
		 * routes that are NOT so keyed — the widened `?scope=all` list, the
		 * automation transcripts, and the two live worker-session proxies, which
		 * expose whoever is driving the agent right now — are narrowed or refused
		 * for a member without org oversight (`isRestrictedOrgAgentMember`).
		 */
		memberRole?: string;
	} | null> {
		const session = await verifySettingsSession(c);
		if (!session) return null;
		const agentId = c.req.param("agentId") || session.agentId || null;
		if (!agentId || !isSafeAgentId(agentId)) return null;
		const userId = resolveSettingsLookupUserId(session);
		const ambientOrgId = resolveOrgId();

		// Apply the resolver's admin bypass and agent-binding restriction before
		// selecting a tenant from the ambient request.
		if (session.isAdmin) {
			if (!ambientOrgId) return null;
			return {
				agentId,
				organizationId: ambientOrgId,
				userId,
				isAdmin: true,
			};
		}
		if (session.agentId && session.agentId !== agentId) return null;

		// The SPA sends x-lobu-org for the workspace being viewed. Its
		// membership-verified ambient org must win over ownership-first resolution
		// because the same agent id string can exist in every organization.
		if (ambientOrgId) {
			const ownsHere =
				(await deps.userAgentsStore?.ownsAgent(
					session.platform,
					userId,
					agentId,
					ambientOrgId,
				)) ?? false;
			if (ownsHere) {
				return {
					agentId,
					organizationId: ambientOrgId,
					userId,
					isAdmin: false,
				};
			}
			// An agent-scoped settings session is bound to its own ownership rule;
			// it must not borrow the underlying human's org membership.
			if (session.agentId) return null;
			const member = await authorizeOrgAgentMemberInProvenOrg({
				organizationId: ambientOrgId,
				agentId,
				userId,
			});
			if (member) {
				return {
					agentId,
					organizationId: member.organizationId,
					userId: member.userId,
					isAdmin: false,
					memberRole: member.role,
				};
			}
			return null;
		}

		// History DB reads and worker/file fallbacks all require a proven tenant.
		// Metadata can be org-less here, so resolve the tenant independently from
		// the authoritative per-org owner mapping.
		const result = await resolveOwnership(session, agentId);
		if (!result.authorized) return null;
		const ownerOrganizations =
			await deps.userAgentsStore?.findAgentOrganizations(
				result.ownerPlatform ?? session.platform,
				result.ownerUserId ?? userId,
				agentId,
			);
		if (ownerOrganizations?.length !== 1) return null;
		return {
			agentId,
			organizationId: ownerOrganizations[0],
			userId,
			isAdmin: false,
		};
	}

	/**
	 * Platform transcripts belong to an org/channel audience, not only to the
	 * user who owns the agent. The outer Lobu middleware establishes this
	 * ambient org only after verifying Better Auth membership (and pins PATs),
	 * then the route intersects the agent's channel bindings with the source ACL.
	 * Agent owners retain the legacy bound-channel access semantics; everyone else needs
	 * a fresh enforced ACL that proves channel membership.
	 * Keep the owner resolver above for every other history surface.
	 */
	async function getAuthorizedPlatformConversationScope(
		c: Context,
	): Promise<{
		agentId: string;
		organizationId: string;
		userId: string;
		allowNotGraphed: boolean;
		/**
		 * Platform admin. Distinct from `allowNotGraphed`, which an agent OWNER
		 * also gets: owning an agent must not confer read access to every user's
		 * private conversation with it.
		 */
		isAdmin: boolean;
	} | null> {
		const session = await verifySettingsSession(c);
		if (!session) return null;
		const agentId = c.req.param("agentId") || session.agentId || null;
		if (!agentId || !isSafeAgentId(agentId)) return null;
		const userId = resolveSettingsLookupUserId(session);

		// A shared agent-id string can resolve to an ownership row in another org.
		// Keep both the transcript lookup and owner check in the ambient org.
		const ambientOrgId = resolveOrgId();
		if (!ambientOrgId) return null;

		// Preserve the ownership resolver's platform-admin bypass, scoped to the
		// ambient org. Runs before the agent-binding check so an admin's request
		// isn't rejected by a session bound to another agent.
		if (session.isAdmin) {
			return {
				agentId,
				organizationId: ambientOrgId,
				userId,
				allowNotGraphed: true,
				isAdmin: true,
			};
		}
		if (session.agentId && session.agentId !== agentId) return null;

		const ownsHere =
			(await deps.userAgentsStore?.ownsAgent(
				session.platform,
				userId,
				agentId,
				ambientOrgId,
			)) ?? false;
		if (ownsHere) {
			return {
				agentId,
				organizationId: ambientOrgId,
				userId,
				allowNotGraphed: true,
				isAdmin: false,
			};
		}

		// `ownsAgent` reads `agent_users`, but legacy ownership can survive only
		// in agent metadata (`agents.owner_*`) that was never reconciled into the
		// mapping. Mirror the ownership resolver's metadata fallback so those
		// owners keep the legacy bound-channel path. `getMetadata` is ALS-scoped to
		// the ambient org, so a match proves ambient-org ownership: a shared-agent
		// id with no per-user owner in this org (owner column is NULL) falls
		// through to the enforced ACL below, unchanged. Reconcile into
		// `agent_users` so the next read hits the fast path.
		const metadata = await deps.agentConfigStore?.getMetadata(agentId);
		if (
			metadata?.owner &&
			metadata.organizationId === ambientOrgId &&
			sessionMatchesMetadataOwner(
				session,
				metadata.owner.platform,
				metadata.owner.userId,
			)
		) {
			deps.userAgentsStore
				?.addAgent(session.platform, userId, agentId, ambientOrgId)
				.catch(() => {
					/* best-effort reconciliation */
				});
			return {
				agentId,
				organizationId: ambientOrgId,
				userId,
				allowNotGraphed: true,
				isAdmin: false,
			};
		}

		return {
			agentId,
			organizationId: ambientOrgId,
			userId,
			allowNotGraphed: false,
			isAdmin: false,
		};
	}


	/**
	 * Read a transcript view for an agent.
	 *
	 * This used to try the worker's own HTTP server first and fall back to the
	 * session file. That proxy arm is gone with the subprocess lane's worker SSE
	 * channel: nothing has registered a worker connection since
	 * `WorkerGateway.handleStreamConnection` was deleted, so the lookup could
	 * only ever return `undefined` and every call already took the fallback.
	 */
	async function readTranscript<T>(
		agentId: string,
		fallback: (agentId: string) => Promise<T>
	): Promise<{ data: T } | null> {
		try {
			return { data: await fallback(agentId) };
		} catch (e) {
			logger.debug("Session file fallback failed", {
				error: e,
				agentId,
			});
			return null;
		}
	}

	app.get("/threads", async (c) => {
		const scope = await getAuthorizedAgentScope(c);
		if (!scope) return errorResponse(c, "Unauthorized", 401);

		// `?scope=all` widens the list to every conversation for the agent across
		// platforms (Slack, Telegram, …), not just the requesting user's threads.
		// A member without org oversight never gets that widening: their `use`
		// grant covers their own conversations, so the query param is ignored
		// rather than refused (the narrowed list is still a valid answer).
		const restrictedMember = isRestrictedOrgAgentMember(scope.memberRole);
		const listScope =
			!restrictedMember && c.req.query("scope") === "all" ? "all" : "user";
		// DM conversations gate on explicit admin access, not channel membership.
		// Resolve the org-role half only for the widened list; the existing
		// platform-admin bypass is already carried on the authorized scope.
		const isAdmin =
			listScope === "all" && scope.organizationId
				? scope.isAdmin ||
					isAdminOrOwnerRole(
						scope.memberRole ??
							(await getMembershipRole(
								scope.organizationId,
								scope.userId,
							)),
					)
				: false;
		const threads = await listAgentThreads({
			agentId: scope.agentId,
			organizationId: scope.organizationId,
			userId: scope.userId,
			scope: listScope,
			isAdmin,
		});
		return c.json({ threads });
	});

	app.get("/threads/:threadId/messages", async (c) => {
		const scope = await getAuthorizedAgentScope(c);
		if (!scope) return errorResponse(c, "Unauthorized", 401);

		const threadId = c.req.param("threadId") || "";
		if (!isSafeThreadId(threadId)) {
			return errorResponse(c, "Invalid thread id", 400);
		}

		const cursor = c.req.query("cursor") || "";
		const limit = Math.min(parseInt(c.req.query("limit") || "200", 10), 200);

		const data = await readThreadMessages({
			agentId: scope.agentId,
			threadId,
			cursor,
			limit,
			organizationId: scope.organizationId,
			userId: scope.userId,
		});

		// Re-sign tokenless attachment references in user messages so their
		// download links are valid for this session (the transcript stores them
		// tokenless and portable; see `resignFileRefs`).
		if (artifactStore && publicGatewayUrl && Array.isArray(data.messages)) {
			data.messages = data.messages.map((message) =>
				message.role === "user"
					? {
							...message,
							content: resignFileRefs(
								message.content,
								artifactStore,
								publicGatewayUrl
							),
						}
					: message
			);
		}

		// Replay durable interaction cards the transcript doesn't carry (today the
		// manage_agents write-gate approval). Reconstruct the session
		// conversationId the worker stamped (same parts), then read the still-
		// pending approval events. Self-cleaning: a resolved approval is
		// superseded out of current_event_records. Without this the interactive
		// approval card is lost on reload — only the model's text + link survive.
		let interactions: HistoryInteraction[] = [];
		if (scope.organizationId) {
			const conversationId = buildApiConversationId({
				agentId: scope.agentId,
				userId: scope.userId,
				organizationId: scope.organizationId,
				threadId,
			});
			const rows = await getDb()<{
				event_id: number;
				run_id: number;
				action: string | null;
				proposal: Record<string, unknown> | null;
				current: Record<string, unknown> | null;
				fields: Record<string, unknown> | null;
				attribution: string | null;
				resource_kind: string | null;
				reason: string | null;
				tool: string | null;
			}>`
				SELECT id AS event_id,
				       run_id,
				       metadata->>'action' AS action,
				       metadata->'proposal' AS proposal,
				       metadata->'current' AS current,
				       -- entity_field_change (manage_entity) carries the
				       -- human-owned-field diff + attribution; manage_agents
				       -- leaves these null and replays its agent-row proposal.
				       metadata->'fields' AS fields,
				       metadata->>'attribution' AS attribution,
				       metadata->>'resourceKind' AS resource_kind,
				       metadata->>'reason' AS reason,
				       metadata->>'tool' AS tool
				FROM current_event_records
				WHERE organization_id = ${scope.organizationId}
				  AND interaction_type = 'approval'
				  AND interaction_status = 'pending'
				  AND metadata->>'conversationId' = ${conversationId}
				ORDER BY run_id
			`;
			interactions = rows.map((r) => {
				const resourceKind =
					r.resource_kind ??
					(r.tool === "manage_automations"
						? "automation"
						: r.tool === "manage_agents"
							? "agent"
							: r.tool === "entity_field_change" || r.tool === "entity_change"
								? "entity"
								: null);
				// manage_automations stores proposal as `{ args }`; SPA expects flat fields.
				const rawProposal = r.proposal ?? null;
				const proposal =
					resourceKind === "automation" &&
					rawProposal &&
					typeof rawProposal === "object" &&
					(rawProposal as { args?: unknown }).args &&
					typeof (rawProposal as { args: unknown }).args === "object"
						? (rawProposal as { args: Record<string, unknown> }).args
						: rawProposal;
				return {
					type: "tool-approval" as const,
					eventId: Number(r.event_id),
					runId: Number(r.run_id),
					action: r.action,
					proposal,
					current: r.current ?? null,
					fields: r.fields ?? null,
					attribution: r.attribution ?? null,
					resourceKind,
					reason: r.reason ?? null,
				};
			});
			const errorInteraction = await readLatestAgentErrorInteraction(
				scope.organizationId,
				conversationId
			);
			if (errorInteraction) interactions.push(errorInteraction);

			// Replay the conversation's current suggestion chips (a live-streamed
			// `complete` payload carries them, but they're lost on reload without
			// this). Separate branch — NOT the approval query, which maps every row
			// to tool-approval.
			const currentSuggestion = await readCurrentSuggestion(
				scope.organizationId,
				conversationId
			);
			if (currentSuggestion) {
				interactions.push({
					type: "suggestion",
					prompts: currentSuggestion.prompts,
				});
			}
		}
		return c.json({ ...data, interactions });
	});

	// Read ANY conversation the listing handed out, by its STORED id.
	//
	// The fence comes from the `conversations` row, not from the shape of the id.
	// Previously this route accepted only `{platform}:{...}` ids and the owned
	// read path re-derived its id from the caller's own userId — which meant an
	// owned conversation could be listed and then never opened, because no
	// handler accepted the id the listing returned.
	app.get("/conversations/:conversationId/messages", async (c) => {
		const scope = await getAuthorizedPlatformConversationScope(c);
		if (!scope) return errorResponse(c, "Unauthorized", 401);

		const conversationId = decodeURIComponent(
			c.req.param("conversationId") || ""
		);
		// Platform ids carry colons; owned ids are underscore-delimited. Both are
		// alnum plus `._:-`, so one charset covers them without implying a shape.
		if (!conversationId || !/^[a-zA-Z0-9._:-]+$/.test(conversationId)) {
			return errorResponse(c, "Invalid conversation id", 400);
		}

		// Fail closed (404, not 403) throughout, so an unauthorized id is
		// indistinguishable from a non-existent one.
		// A row is the only thing that can prove a conversation is OWNED. Platform
		// transcripts are readable without one — federated channel ACL admits a
		// non-owner org member whose access comes from the channel, not from a
		// conversations row — so a miss falls through to the channel gate rather
		// than 404ing, which is what the row-mandatory version got wrong.
		const row = await findConversationById({
			organizationId: scope.organizationId,
			agentId: scope.agentId,
			conversationId,
		});

		if (row?.kind === "owned") {
			// An owned conversation belongs to the user who started it. Admins keep
			// the bypass the scope resolver already granted them.
			if (!scope.isAdmin && row.userId !== scope.userId) {
				return errorResponse(c, "Conversation not found", 404);
			}
		} else {
			let bypassChannelFence = false;
			if (row?.isDirect === true) {
				// Same DM rule the listing applies: explicit admin access can open
				// an unbound DM. A non-admin still takes the normal channel fence so
				// explicitly bound DMs (for example Preview `/link`) remain readable.
				bypassChannelFence =
					scope.isAdmin ||
					isAdminOrOwnerRole(
						await getMembershipRole(scope.organizationId, scope.userId),
					);
			}
			if (!bypassChannelFence) {
				// Platform conversations stay behind the per-agent fence ∩ per-user
				// channel gate. The channel segment is still parsed out of the id: the
				// `conversations` row carries no channel column, so there is nothing
				// else to read it from.
				const channelVis = await resolveChannelVisibility(getDb(), {
					organizationId: scope.organizationId,
					agentId: scope.agentId,
					userId: scope.userId,
					allowNotGraphed: scope.allowNotGraphed,
				});
				if (!isConversationVisible(conversationId, channelVis)) {
					return errorResponse(c, "Conversation not found", 404);
				}
			}
		}

		const cursor = c.req.query("cursor") || "";
		const limit = Math.min(parseInt(c.req.query("limit") || "200", 10), 200);

		const data = await readConversationMessages({
			agentId: scope.agentId,
			organizationId: scope.organizationId,
			conversationId,
			cursor,
			limit,
		});
		if (artifactStore && publicGatewayUrl && Array.isArray(data.messages)) {
			data.messages = data.messages.map((message) =>
				message.role === "user"
					? {
							...message,
							content: resignFileRefs(
								message.content,
								artifactStore,
								publicGatewayUrl
							),
						}
					: message
			);
		}
		return c.json(data);
	});

	// An automation's recent completed runs as ready-to-stitch transcripts — the
	// read-only run history rendered as one conversation. Automation conversation
	// ids are org-less but the snapshot row carries the org; the service bridges
	// that, so we just hand it the requester's resolved org.
	app.get("/automations/:automationId/thread", async (c) => {
		const scope = await getAuthorizedAgentScope(c);
		if (!scope) return errorResponse(c, "Unauthorized", 401);
		// An automation belongs to the org, not to the caller: its runs are keyed
		// on automationId alone, with no `scope.userId` half to confine them. A
		// member without org oversight would read a colleague's automation
		// transcripts wholesale, so this route stays owner/admin.
		if (isRestrictedOrgAgentMember(scope.memberRole)) {
			return errorResponse(c, "Unauthorized", 401);
		}
		if (!scope.organizationId) return c.json({ runs: [] });

		const automationId = Number(c.req.param("automationId"));
		if (!Number.isFinite(automationId)) {
			return errorResponse(c, "Invalid automation id", 400);
		}
		const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 50);

		const data = await readAutomationRunThreads({
			agentId: scope.agentId,
			automationId,
			organizationId: scope.organizationId,
			limit,
		});
		if (artifactStore && publicGatewayUrl) {
			for (const run of data.runs) {
				run.messages = run.messages.map((message) =>
					message.role === "user"
						? {
								...message,
								content: resignFileRefs(
									message.content,
									artifactStore,
									publicGatewayUrl
								),
							}
						: message
				);
			}
		}
		return c.json(data);
	});

	app.get("/status", async (c) => {
		const scope = await getAuthorizedAgentScope(c);
		if (!scope) return errorResponse(c, "Unauthorized", 401);

		const resolvedAgentId = scope.agentId;

		let hasSessionFile =
			(await readLatestSnapshotJsonl(resolvedAgentId, scope.organizationId)) !==
			null;
		if (!hasSessionFile) {
			hasSessionFile = !!(await findSessionFile(resolvedAgentId));
		}

		// `hasHttpServer` and `deploymentCount` described the subprocess lane's
		// worker SSE channel. Nothing has registered a worker connection since
		// `WorkerGateway.handleStreamConnection` was deleted, so both answers were
		// already constant on every request. They stay in the response as the
		// constants they had become rather than changing this route's shape.
		return c.json({
			connected: hasSessionFile,
			hasHttpServer: false,
			deploymentCount: 0,
		});
	});

	app.get("/session/messages", async (c) => {
		const scope = await getAuthorizedAgentScope(c);
		if (!scope) return errorResponse(c, "Unauthorized", 401);
		// The live worker session belongs to whoever is driving the agent right
		// now, which for an org-shared agent need not be this caller. The agent's
		// owner and org owner/admins keep it; a member without oversight reads
		// their own threads through /threads/* instead.
		if (isRestrictedOrgAgentMember(scope.memberRole)) {
			return errorResponse(c, "Unauthorized", 401);
		}

		const cursor = c.req.query("cursor") || "";
		const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);

		const result = await readTranscript(scope.agentId, (resolved) =>
			readSessionMessages(resolved, cursor, limit, scope.organizationId)
		);

		if (!result) {
			return c.json(
				{
					error: "Agent offline",
					connected: false,
					messages: [],
					nextCursor: null,
					hasMore: false,
				},
				503
			);
		}

		return c.json(result.data);
	});

	app.get("/session/stats", async (c) => {
		const scope = await getAuthorizedAgentScope(c);
		if (!scope) return errorResponse(c, "Unauthorized", 401);
		// Same live-session reasoning as /session/messages above.
		if (isRestrictedOrgAgentMember(scope.memberRole)) {
			return errorResponse(c, "Unauthorized", 401);
		}

		const result = await readTranscript(scope.agentId, (resolved) =>
			readSessionStats(resolved, scope.organizationId)
		);

		if (!result) {
			return c.json({ error: "Agent offline", connected: false }, 503);
		}

		return c.json(result.data);
	});

	return app;
}
