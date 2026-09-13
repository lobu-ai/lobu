import { connectorRunEnv } from "@lobu/connector-worker/env";
import { executeCompiledConnector } from "@lobu/connector-worker/executor/runtime";
import {
	deepRedactSecrets,
	getErrorMessage,
	isSecretKey,
	REDACTED_SENTINEL,
} from "@lobu/core";
import { ExecuteAction, type ManageOperationsResult } from "../schemas";
import type { Static } from "@sinclair/typebox";
import { readGrantedScopesFromAuthData } from "../../../../auth/oauth/scopes";
import { resolveAutomationConnectionVisibilityUserId } from "../../../../authz/automation-connection-visibility";
import { compileConnectionRowVisibility } from "../../../../authz/connection-visibility";
import { resolveActingPrincipal, resolveWritePolicyDecision } from "../../../../authz/entity-policy";
import { authzScopeFromToolContext } from "../../../../authz/scope";
import { getDb } from "../../../../db/client";
import type { Env } from "../../../../index";
import {
	isDelegatedBrowserAffinityConnector,
} from "../../../../utils/connector-execution-placement";
import { currentMcpActivityAttribution, currentMcpActivityEventMetadata } from "../../../../lobu/stores/mcp-client-conversations";
import { callTool as callProxyTool } from "../../../../mcp-proxy/client";
import { resolveActionOrigin } from "../../../../notifications/action-origin";
import { notifyActionApprovalNeeded } from "../../../../notifications/triggers";
import { resolveApprovalChatOrigin } from "../../approval-delivery";
import { resolveActionMode } from "../../../../operations/action-modes";
import { getOperationForConnection } from "../../../../operations/connector-operations";
import { LOST_LEASE_MESSAGE, runLeaseFence } from "../../../../runs/run-lease";
import { executeHttpOperation } from "../../../../operations/execute-http-operation";
import { prepareOperationFiles, resolveRunFiles } from "../../../../operations/file-inputs";
import { validateOperationInput } from "../../../../operations/input-validation";
import { getMissingKnownOAuthScopes } from "../../../../operations/oauth-scope-readiness";
import type { OperationDescriptor } from "../../../../operations/types";
import {
	DEFAULT_PAGE_ACTIVATION_SECONDS,
	normalizePageActivationUrls,
} from "../../../../runs/page-activation";
import { createConnectorOperationRun } from "../../../../runs/queue-service";
import { getAuthProfileById } from "../../../../utils/auth-profiles";
import { isCloudMode } from "../../../../utils/cloud-mode";
import { findBundledConnectorFile } from "../../../../utils/connector-catalog";
import { resolveConnectorCodeForKey } from "../../../../utils/ensure-connector-installed";
import { ToolUserError } from "../../../../utils/errors";
import { resolveExecutionAuth } from "../../../../utils/execution-context";
import {
	ApprovalKind,
	approvalContext,
	highApprovalImpact,
	normalApprovalImpact,
} from "../../../../utils/approval-context";
import { insertEvent } from "../../../../utils/insert-event";
import logger from "../../../../utils/logger";
import { stripNul, stripNulDeep } from "../../../../utils/strip-nul";
import { buildResourcePermalink } from "../../../../utils/url-builder";
import { trackAutomationReaction } from "../../../../utils/automation-reactions";
import { dispatchChromeActionToExtension } from "../../../../worker-api/dispatch-chrome-action";
import {
	deriveBrowserActionContext,
	deriveSdkBrowserActionContext,
} from "../../../../worker-api/browser-action-context";
import { resolveRunInitiator } from "../../../initiator";
import type { ToolContext } from "../../../registry";
import { getOrgUrlContext } from "../../../view-urls";
import { waitForDeviceActionRun } from "../../device-action-wait";
import {
	qualifiedOperationKey,
	type ConnectionRow,
	type InlineExecutionResult,
} from "./shared";
// Update the run to failed status and return the error result in one call.
// When `deferTerminalWrite` is set the runs write is skipped — the caller
// (approve's phase 2) persists the terminal state AND the card event in one
// transaction, so the executor must not commit the run terminal state first.
async function failRunInline(
	runId: number,
	organizationId: string,
	errorMsg: string,
	deferTerminalWrite: boolean,
	claimedBy: string,
): Promise<InlineExecutionResult> {
	// Connector code, scraped pages and upstream MCP servers all reach here as
	// raw text, so the message can carry NUL (0x00) that Postgres rejects (see
	// streamContent). Strip it at the terminal write the local_action and
	// mcp_tool backends share; executeHttpOperation sanitizes its own response.
	const message = stripNul(errorMsg);
	if (!deferTerminalWrite) {
		const sql = getDb();
		const rows = await sql`UPDATE runs SET status = 'failed', completed_at = NOW(), error_message = ${message} WHERE id = ${runId} AND organization_id = ${organizationId} ${runLeaseFence(sql, claimedBy)} RETURNING id`;
		if (rows.length === 0)
			return { status: "failed", error_message: LOST_LEASE_MESSAGE };
	}
	return { status: "failed", error_message: message };
}

// Update the run to completed status and return the output in one call.
async function completeRunInline(
	runId: number,
	organizationId: string,
	output: Record<string, unknown>,
	deferTerminalWrite: boolean,
	claimedBy: string,
): Promise<InlineExecutionResult> {
	// Same NUL strip as failRunInline — `output` is connector- or upstream-MCP-
	// produced and lands in the jsonb `action_output` column. Sanitize before
	// returning too: approve's deferred phase 2 persists this value itself.
	const sanitized = stripNulDeep(output) as Record<string, unknown>;
	if (!deferTerminalWrite) {
		const sql = getDb();
		const rows = await sql`UPDATE runs SET status = 'completed', completed_at = NOW(), action_output = ${sql.json(sanitized)} WHERE id = ${runId} AND organization_id = ${organizationId} ${runLeaseFence(sql, claimedBy)} RETURNING id`;
		if (rows.length === 0)
			return { status: "failed", error_message: LOST_LEASE_MESSAGE };
	}
	return { status: "completed", output: sanitized };
}

/**
 * Build the `config` an inline connector action sees. Precedence low → high:
 * the connector run env (`connectorRunEnv`, the same whitelist a fleet worker
 * gets), then resolved connection credentials, then the connection's own
 * `config` (authoritative — mirrors the sync path's
 * `mergeEnv(env, connectionCredentials, feedConfig)`). Connection config is
 * last so an action can read e.g. a Deliveroo connection's `restaurants_url`.
 * Exported for unit testing the merge precedence.
 */
export function buildActionConfig(
	envStrings: Record<string, string | undefined>,
	connectionCredentials: Record<string, unknown>,
	connectionConfig: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
	return {
		...envStrings,
		...connectionCredentials,
		...(connectionConfig ?? {}),
	};
}

/**
 * Review rows for a connector approval card: what is being run and where,
 * ahead of the operation input. Prefix every user argument with `input_` so
 * trusted routing context and arbitrary input keys stay in separate namespaces.
 */
function connectorApprovalReviewFields(
	connectionName: string,
	operationName: string,
	input: Record<string, unknown>,
): Array<{ key: string; value: unknown }> {
	const inputFields = Object.entries(input).map(([key, value]) => ({
		key: `input_${key}`,
		value:
			value != null && isSecretKey(key)
				? REDACTED_SENTINEL
				: deepRedactSecrets(value),
	}));
	return [
		{ key: "resource", value: "Connector operation" },
		{ key: "connection", value: connectionName },
		{ key: "operation", value: operationName },
		...inputFields,
	];
}

async function executeLocalActionInline(
	runId: number,
	organizationId: string,
	connection: ConnectionRow,
	operation: OperationDescriptor,
	actionInput: Record<string, unknown>,
	requesterUserId: string | null,
	abortSignal: AbortSignal | undefined,
	deferTerminalWrite: boolean,
	claimedBy: string,
): Promise<InlineExecutionResult> {
	const sql = getDb();

	const runRows =
		await sql`SELECT connector_version FROM runs WHERE id = ${runId} AND organization_id = ${organizationId} AND run_type = 'action' LIMIT 1`;
	const connectorVersion = (
		runRows[0] as { connector_version: string | null } | undefined
	)?.connector_version;

	let compiledCode: string;
	try {
		compiledCode = await resolveConnectorCodeForKey(
			connection.connector_key,
			organizationId,
			connectorVersion ?? null,
		);
	} catch (err) {
		return failRunInline(
			runId,
			organizationId,
			getErrorMessage(err),
			deferTerminalWrite,
			claimedBy,
		);
	}

	const { credentials, connectionCredentials, sessionState } =
		await resolveExecutionAuth({
			organizationId,
			connectionId: connection.id,
			authProfileId: Number(connection.auth_profile_id) || null,
			appAuthProfileId: Number(connection.app_auth_profile_id) || null,
			credentialDb: getDb(),
			logContext: { run_id: runId },
			logMessage: "Failed to resolve action credentials",
		});

	try {
		// The same whitelist a fleet worker hands connector code — never the
		// gateway's own env, which would expose ENCRYPTION_KEY, DATABASE_URL and
		// WORKER_API_TOKEN to whatever code this run executes.
		const envStrings = connectorRunEnv({
			organizationSupplied:
				findBundledConnectorFile(connection.connector_key) === null,
			cloud: isCloudMode(),
		});
		const result = await executeCompiledConnector({
			compiledCode,
			job: {
				mode: "action",
				actionKey:
					operation.backend_config.backend === "local_action"
						? operation.backend_config.actionKey
						: operation.operation_key,
				actionInput,
				// Merge the connection's own config (e.g. a Deliveroo connection's
				// `restaurants_url`) into the action config, the way a sync merges its
				// feed config. See buildActionConfig for the precedence.
				config: buildActionConfig(
					envStrings,
					connectionCredentials,
					connection.config as Record<string, unknown> | null,
				),
				env: envStrings,
				sessionState,
				credentials,
			},
			hooks: {
				// Let an inline connector action drive the paired Owletto Chrome
				// extension (the Lobu Team Deliveroo connector scrapes restaurant
				// search + menu pages this way). The connector calls
				// `ctx.sessionState.chrome_dispatcher.dispatch(...)`; that surfaces here
				// and we resolve a chrome worker + run the device action in-process,
				// the same bridge syncs use over HTTP.
				onChromeDispatch: async (actionKey, actionInput) => {
					const dispatchResult = await dispatchChromeActionToExtension({
						organizationId,
						actionKey,
						actionInput,
						parentRunId: runId,
						// Browser affinity: data connection pin to a chrome-extension
						// selects which Owletto browser receives scrapes.
						parentConnectionId: connection.id,
						visibilityUserId: requesterUserId,
						abortSignal,
					});

					if (dispatchResult.status !== "completed") {
						throw new Error(
							dispatchResult.error_message ??
								`chrome action '${actionKey}' ${dispatchResult.status}`,
						);
					}
					return dispatchResult.output ?? {};
				},
			},
		});

		if (result.mode !== "action") {
			throw new Error(`Expected action result, got mode=${result.mode}`);
		}
		return completeRunInline(
			runId,
			organizationId,
			result.output,
			deferTerminalWrite,
			claimedBy,
		);
	} catch (error) {
		return failRunInline(
			runId,
			organizationId,
			getErrorMessage(error),
			deferTerminalWrite,
			claimedBy,
		);
	}
}

async function executeMcpToolInline(
	runId: number,
	organizationId: string,
	connection: ConnectionRow,
	operation: OperationDescriptor,
	actionInput: Record<string, unknown>,
	deferTerminalWrite: boolean,
	claimedBy: string,
): Promise<InlineExecutionResult> {
	if (operation.backend_config.backend !== "mcp_tool") {
		return {
			status: "failed",
			error_message: "Invalid MCP operation backend config",
		};
  }

	let result: Awaited<ReturnType<typeof callProxyTool>>;
	try {
		result = await callProxyTool(
    connection.connector_key,
    {
      upstream_url: operation.backend_config.upstreamUrl,
				tool_prefix: "",
    },
    organizationId,
    operation.backend_config.toolName,
			actionInput,
			connection.id,
  );
	} catch (error) {
		return failRunInline(
			runId,
			organizationId,
			getErrorMessage(error),
			deferTerminalWrite,
			claimedBy,
		);
	}

  if (result.isError) {
    const errorText =
      (result.content as Array<{ type: string; text?: string }>).find(
				(item) => item?.type === "text",
			)?.text ?? "Upstream MCP error";
    return failRunInline(
      runId,
      organizationId,
      errorText,
      deferTerminalWrite,
      claimedBy,
    );
  }

	return completeRunInline(
		runId,
		organizationId,
		{
			content: result.content,
		} as Record<string, unknown>,
		deferTerminalWrite,
		claimedBy,
	);
}

/**
 * Options for {@link executeOperationInline}.
 */
interface InlineExecutionOptions {
	/**
	 * Skip the executor's terminal `runs` write. Used by approve's phase 2:
	 * the terminal run state and its card event must commit together, so the
	 * executor cannot commit the run terminal state on the pool first (that
	 * would leave a terminal run with no card when the card INSERT fails).
	 */
	deferTerminalWrite?: boolean;
	/**
	 * The owner this request claimed the run under. Required: every inline
	 * terminal write fences on it, and an optional fence value is a fence the
	 * next caller can forget.
	 */
	claimedBy: string;
}

export async function executeOperationInline(
	runId: number,
	organizationId: string,
	connection: ConnectionRow,
	operation: OperationDescriptor,
	actionInput: Record<string, unknown>,
	requesterUserId: string | null,
	abortSignal: AbortSignal | undefined,
	options: InlineExecutionOptions,
): Promise<InlineExecutionResult> {
	const deferTerminalWrite = options.deferTerminalWrite ?? false;
	try {
		actionInput = await resolveRunFiles(runId, organizationId, actionInput);
	} catch (error) {
		return failRunInline(runId, organizationId, getErrorMessage(error), deferTerminalWrite, options.claimedBy);
	}
	if (operation.backend === "local_action") {
		return executeLocalActionInline(
			runId,
			organizationId,
			connection,
			operation,
			actionInput,
			requesterUserId,
			abortSignal,
			deferTerminalWrite,
			options.claimedBy,
		);
	}
	if (operation.backend === "mcp_tool") {
		return executeMcpToolInline(
			runId,
			organizationId,
			connection,
			operation,
			actionInput,
			deferTerminalWrite,
			options.claimedBy,
		);
	}
	return executeHttpOperation(
		runId,
		organizationId,
		connection,
		operation,
		actionInput,
		abortSignal,
		deferTerminalWrite,
		options.claimedBy,
	);
}
/** Return the durable outcome of a run claimed by an earlier request. */
async function replayExistingOperationRun(
	claim: Awaited<ReturnType<typeof createConnectorOperationRun>>,
	operationName: string,
	ctx: ToolContext,
): Promise<ManageOperationsResult> {
	const sql = getDb();
	if (claim.approvalStatus === "pending" && claim.status === "pending") {
		const eventRows = await sql<{ id: number }>`
			SELECT id
			FROM events
			WHERE organization_id = ${ctx.organizationId}
			  AND run_id = ${claim.runId}
			  AND interaction_type = 'approval'
			ORDER BY id DESC
			LIMIT 1
		`;
		const { ownerSlug: orgSlug, baseUrl } = await getOrgUrlContext(ctx);
		const approvalUrl = buildResourcePermalink(
			orgSlug,
			{ kind: "run", runId: claim.runId },
			baseUrl,
		);
		return {
			action: "execute",
			run_id: claim.runId,
			...(eventRows[0] ? { event_id: Number(eventRows[0].id) } : {}),
			approval_url: approvalUrl,
			status: "pending_approval",
			message: `Operation '${operationName}' requires approval. Share the approval_url with the user to confirm.`,
		};
	}

	if (claim.status === "completed") {
		return {
			action: "execute",
			run_id: claim.runId,
			status: "completed",
			output: claim.actionOutput ?? {},
		};
	}
	if (claim.status === "timeout") {
		return {
			action: "execute",
			run_id: claim.runId,
			status: "timeout",
			error_message: claim.errorMessage ?? `Run ${claim.runId} timed out.`,
		};
	}
	if (["pending", "claimed", "running"].includes(claim.status)) {
		return {
			action: "execute",
			run_id: claim.runId,
			status: "in_progress",
			message: `Idempotent operation run ${claim.runId} is already in progress.`,
		};
	}
	return {
		action: "execute",
		run_id: claim.runId,
		status: "failed",
		error_message:
			claim.errorMessage ??
			`Run ${claim.runId} ended with status '${claim.status}'.`,
	};
}

// Device-bound execution inserts a pending run and waits for the device worker
// (Chrome extension / Mac bridge / etc.) to claim it and post completion.
export async function handleExecute(
	args: Static<typeof ExecuteAction>,
	ctx: ToolContext,
	_env: Env,
): Promise<ManageOperationsResult> {
	const sql = getDb();
	const browserContext = deriveBrowserActionContext(ctx);
	const sdkBrowserContext = browserContext
		? undefined
		: deriveSdkBrowserActionContext(ctx);
	let runMetadata: Record<string, unknown> | undefined = browserContext
		? { browser_context: browserContext }
		: undefined;
	if (
		args.idempotency_key != null &&
		args.idempotency_key !== args.idempotency_key.trim()
	) {
		throw new ToolUserError(
			"idempotency_key must not have leading or trailing whitespace.",
			422,
		);
	}
	const visibilityUserId = await resolveAutomationConnectionVisibilityUserId(
		ctx,
		sql,
	);
	const visibility = compileConnectionRowVisibility(
		{
			...authzScopeFromToolContext(ctx),
			principal: visibilityUserId,
		},
		"c",
	);
	const visibleRows = await sql.unsafe(
		`SELECT 1
		 FROM connections c
		 WHERE c.organization_id = $1
		   AND c.id = $2
		   AND c.deleted_at IS NULL
		   ${visibility}
		 LIMIT 1`,
		[ctx.organizationId, args.connection_id],
	);
	if (visibleRows.length === 0) {
		return {
			error: "Connection not found or not visible.",
		};
	}
	const resolved = await getOperationForConnection(
		ctx.organizationId,
		args.connection_id,
		args.operation_key,
	);
	if (!resolved) {
		return {
			error: `Invalid operation_key '${args.operation_key}' for this connection.`,
		};
	}

	const { connection, operation } = resolved;
	if (connection.status !== "active") {
		return { error: `Connection is ${connection.status}, must be active` };
	}

	const requiredScopes = operation.required_scopes ?? [];
	if (requiredScopes.length > 0) {
		const authProfile = await getAuthProfileById(
			ctx.organizationId,
			connection.auth_profile_id,
		);
		const missingScopes = getMissingKnownOAuthScopes(
			readGrantedScopesFromAuthData(authProfile?.auth_data),
			Object.hasOwn(authProfile?.auth_data ?? {}, "granted_scopes"),
			requiredScopes,
		);
		if (missingScopes.length > 0) {
			return {
				error: `Operation '${operation.operation_key}' requires additional OAuth consent for scope(s): ${missingScopes.join(", ")}. Reauthorize the connection and complete consent, then retry operations.execute with the same arguments. The operation will not resume automatically.`,
			};
		}
	}

	let input = args.input ?? {};
	// A caller-provided automation_source is only an attribution hint. Durable
	// feedback must follow the server-stamped Automation execution context.
	const reactionAutomationId = ctx.actingAutomationId ?? null;
	const reactionSourceRunId = ctx.actingRunId ?? null;
	const trackOperationReaction = async (runId: number): Promise<void> => {
		if (reactionAutomationId === null || reactionSourceRunId === null) return;
		await trackAutomationReaction({
			organizationId: ctx.organizationId,
			automationId: reactionAutomationId,
			sourceRunId: reactionSourceRunId,
			reactionType: "action_executed",
			toolName: "manage_operations",
			toolArgs: {
				operation_key: args.operation_key,
				connection_id: args.connection_id,
				input,
			},
			runId,
		});
	};
	const validationError = validateOperationInput(operation, input);
	if (validationError) {
		return {
			error: `Invalid input for operation '${operation.operation_key}': ${validationError}`,
		};
	}

	const mode = resolveActionMode(operation, connection.config);
	if (mode === "disabled") {
		return {
			error: `Operation '${operation.operation_key}' is disabled on this connection.`,
		};
	}

	// Org-level connector-action policy, from the SAME write-gate the entity and
	// agent_config classes use. It folds with the per-connection action_modes by
	// restrictive-wins: a `deny` blocks outright; an `approval` upgrades a
	// connection that would auto-run to queued. A human applies immediately (the
	// policy governs non-human principals); with no policy row, the class default
	// is auto, so the connection mode alone decides — existing semantics remain intact.
	// Resolve WHO is acting through the single seam — merges the explicit
	// automation_source and the reaction session's own automation, looks up the owning
	// agent, and pins autonomous mode for an automation. Persisted with the run so the
	// approve-time recheck re-evaluates in the SAME mode/principal.
	const actor = await resolveActingPrincipal(sql, {
		organizationId: ctx.organizationId,
		userId: ctx.userId,
		agentId: ctx.agentId,
		explicitAutomationId: args.automation_source?.automation_id ?? null,
		sessionAutomationId: ctx.actingAutomationId ?? null,
	});
	// Agent write-policy applies to WRITE ops only. Reads stay available under
	// connection action_modes alone (default auto) — same idea as MCP readOnlyHint.
	const policyDecision =
		operation.kind === "read"
			? "allow"
			: await resolveWritePolicyDecision({
					organizationId: ctx.organizationId,
					resourceClass: "connector_action",
					principalKind: actor.kind,
					principalId: actor.id,
					ownerAgentId: actor.ownerAgentId,
					ownerResolved: actor.ownerResolved,
					action: "execute",
					// A per-operation rule (e.g. deliveroo::place_order = approval) tightens the
					// blanket execute for this op alone; the blanket applies to every other op. The
					// key is connector-qualified so the rule can't leak to another connector that
					// exposes the same bare operation key.
					operationKey: qualifiedOperationKey(
						connection.connector_key,
						operation.operation_key,
					),
				});
	if (policyDecision === "deny") {
		return {
			error: `Policy denies '${operation.operation_key}' for this principal.`,
		};
	}
	const preparedFiles = await prepareOperationFiles(input, operation.input_schema, ctx);
	input = preparedFiles.input;
	if (preparedFiles.claims.length > 0) {
		const fileValidationError = validateOperationInput(operation, input);
		if (fileValidationError) throw new ToolUserError(`Invalid stored file metadata: ${fileValidationError}`, 422);
		runMetadata = { ...runMetadata, input_files: preparedFiles.claims };
	}
	const shouldQueue =
		mode === "approval" || policyDecision === "require_approval";
	if (args.activation && shouldQueue) {
		throw new ToolUserError(
			"Page-activated operations cannot also require human approval.",
			422,
		);
	}
	const activation = args.activation
		? {
				kind: args.activation.kind,
				urls: normalizePageActivationUrls(args.activation.urls),
				expiresInSeconds:
					args.activation.expires_in_seconds ??
					DEFAULT_PAGE_ACTIVATION_SECONDS,
			}
		: undefined;
	// Activation is claimed by the owning user's own browser; a run with no
	// resolvable owner could never match a worker and would park until timeout.
	if (activation && !visibilityUserId) {
		throw new ToolUserError(
			"Page activation requires an operation owned by a resolvable user.",
			422,
		);
	}

	// Intrinsically device-only connectors always execute on their connector
	// runtime. Otherwise, a physical connection pin is exact operation
	// placement. The sole exception is a connector that does not execute natively
	// in the extension but is pinned to one: that pin selects delegated scrape
	// affinity for inline connector work; it does not move the parent operation
	// onto the extension.
	// Native extension execution and delegated browser affinity share the same
	// narrow classification as worker polling and scheduled sync admission.
	const isChromeScrapeAffinity = isDelegatedBrowserAffinityConnector(
		connection.device_platform,
		connection.connector_key,
	);
	const executesOnDevice =
		!isChromeScrapeAffinity &&
		(connection.device_worker_id != null || connection.connector_runtime != null);
	if (activation && (operation.backend !== "local_action" || executesOnDevice)) {
		throw new ToolUserError(
			"Page activation requires a server-executed local connector operation.",
			422,
		);
	}

	const approvalMode: "inline" | "queued" | "device" = shouldQueue
		? "queued"
		: executesOnDevice
			? "device"
			: "inline";

	// Queued (approval) runs bind run creation to the pending approval EVENT in
	// ONE transaction (#2033 item 16): if the event write fails, the run must
	// not exist — otherwise the run is durably pending but the /memory approval
	// page (events-only) shows nothing and the agent can never approve it.
	// Device/inline runs have no approval event, so they create the run on the
	// pool as before.
	if (shouldQueue) {
		const feedRows = await sql`
      SELECT entity_ids FROM feeds
      WHERE connection_id = ${args.connection_id} AND deleted_at IS NULL AND entity_ids IS NOT NULL
      LIMIT 1
    `;
		const rawEntityIds =
			(feedRows[0] as { entity_ids: string | number[] } | undefined)
				?.entity_ids ?? null;
		const entityIdsLiteral = rawEntityIds
			? typeof rawEntityIds === "string"
				? rawEntityIds
				: `{${(rawEntityIds as number[]).join(",")}}`
			: null;
		const entityIds =
			entityIdsLiteral && typeof entityIdsLiteral === "string"
				? entityIdsLiteral
						.replace(/[{}]/g, "")
						.split(",")
						.filter(Boolean)
						.map(Number)
				: [];

		// Atomic: run + approval event commit together or not at all. Both writes
		// run on `tx`; insertEvent threads it via options.sql, and
		// createConnectorOperationRun via its db param (which also carries its
		// connector-version read into the same tx — safe, it is a read).
		const { claim, eventId } = await sql.begin(async (tx) => {
			// Serialize approval queueing against connection deletion: take a SHARE
			// lock on the connection row and re-verify it is still live. A delete's
			// tombstone+expiry tx holds FOR UPDATE on the same row, so an in-flight
			// delete blocks this tx until it commits, then this predicate sees the
			// tombstone and refuses — an approval can never commit into the gap
			// between a delete's expiry scan and its tombstone. (The runs
			// FK key-share lock alone would only serialize, not refuse.)
			const liveConnection = await tx`
				SELECT 1 FROM connections
				WHERE id = ${connection.id}
					AND organization_id = ${ctx.organizationId}
					AND deleted_at IS NULL
				FOR SHARE
			`;
			if (liveConnection.length === 0) {
				throw new ToolUserError(
					`Connection ${args.connection_id} was deleted while this operation was being queued.`,
					409,
				);
			}
			const createdRun = await createConnectorOperationRun({
				organizationId: ctx.organizationId,
				connectionId: connection.id,
				connectorKey: connection.connector_key,
				operationKey: operation.operation_key,
				operationInput: input,
				approvalMode,
				requireCompiledCode: operation.backend === "local_action",
				// Persist the TRUSTED principal so a queued run's policy is
				// re-evaluated at approve time against who queued it, not who
				// approves it (sol #5) — and in the SAME acting mode, so an
				// autonomous run's tighter autonomous rule isn't lost to an
				// attended recheck.
				policyPrincipalKind: actor.kind,
				policyPrincipalId: actor.id,
				createdByUserId: ctx.userId,
				automationId: ctx.actingAutomationId,
				parentRunId: ctx.actingRunId,
				runMetadata,
				sdkBrowserContext,
				idempotencyKey: args.idempotency_key,
				db: tx,
			});
			if (!createdRun.created) {
				return { claim: createdRun, eventId: null };
			}
			const createdRunId = createdRun.runId;
			const initiator = resolveRunInitiator(ctx);
			const event = await insertEvent(
				{
				entityIds,
				organizationId: ctx.organizationId,
				originId: `run_${createdRunId}_pending`,
				title: `${operation.name} — pending approval`,
				content: `Agent requested operation: ${operation.name}`,
				semanticType: "operation",
				connectorKey: connection.connector_key,
				connectionId: args.connection_id,
				runId: createdRunId,
				interactionType: "approval",
				interactionStatus: "pending",
				interactionInputSchema:
					(operation.input_schema as Record<string, unknown> | undefined) ??
					null,
				interactionInput: input,
				metadata: {
					operation_key: operation.operation_key,
					operation_name: operation.name,
					action_key: operation.operation_key,
					action_name: operation.name,
					operation_input: input,
					action_input: input,
					input_schema: operation.input_schema ?? null,
					...approvalContext(
						ApprovalKind.Connector,
						operation.annotations?.destructiveHint === true
							? highApprovalImpact(
									"This action can remove or irreversibly change data in the connected service.",
									["Lobu may not be able to undo the external change."],
								)
							: normalApprovalImpact(),
					),
					review_fields: connectorApprovalReviewFields(
						connection.display_name ?? connection.connector_key,
						operation.name,
						input,
					),
					status: "pending_approval",
					connection_name:
						connection.display_name ?? connection.connector_key,
					run_id: createdRunId,
					initiator: {
						kind: initiator.initiatorKind,
						...initiator.initiatorRef,
					},
					...currentMcpActivityEventMetadata(ctx),
				},
				authorName: ctx.clientId ?? "agent",
				clientId: ctx.tokenType === "oauth" ? (ctx.clientId ?? null) : null,
			},
				{ sql: tx },
			);
			return { claim: createdRun, eventId: Number(event.id) };
		});
		if (!claim.created) {
			await trackOperationReaction(claim.runId);
			return replayExistingOperationRun(claim, operation.name, ctx);
		}
		if (eventId == null) {
			throw new Error("Created approval action run has no approval event.");
		}
		const runId = claim.runId;

		// Telemetry + notification run AFTER the run+event are durably committed,
		// so they never reference a rolled-back run and stay off the hot path.
		await trackOperationReaction(runId);

		const { ownerSlug: orgSlug, baseUrl } = await getOrgUrlContext(ctx);
		// Run-scoped, not event-scoped: the pending event is superseded on
		// approve→complete and drops out of the live view, but a run_ids permalink
		// reads the whole chain and stays valid across the lifecycle. (The read-side
		// content_ids resolver also covers already-minted event-scoped links.)
		const approvalUrl = buildResourcePermalink(
			orgSlug,
			{ kind: "run", runId },
			baseUrl,
		);

		// One destination, never the org-wide fan-out: the conversation that asked
		// when there is one, else the requesting human's DM, else the inbox alone.
		const chatOrigin = await resolveApprovalChatOrigin(ctx);
		const actionOrigin = await resolveActionOrigin(ctx);
		notifyActionApprovalNeeded({
			orgId: ctx.organizationId,
			runId,
			actionKey: operation.operation_key,
			connectionName: connection.display_name ?? connection.connector_key,
			// The decision needs the arguments, not just the verb: "run" says
			// nothing, "run · rm -rf /" says everything.
			operation: { name: operation.name, input },
			eventId,
			approvalUrl,
			connectionId: chatOrigin.connectionId,
			channelId: chatOrigin.channelId,
			teamId: chatOrigin.teamId,
			requesterUserId: visibilityUserId ?? ctx.userId ?? null,
			mcpActivity: currentMcpActivityAttribution(ctx),
			actionOrigin,
		}).catch((error) =>
			logger.error(error, "Failed to send operation approval notification"),
		);

		return {
			action: "execute",
			run_id: runId,
			event_id: eventId,
			approval_url: approvalUrl,
			status: "pending_approval",
			message: `Operation '${operation.name}' requires approval. Share the approval_url with the user to confirm.`,
		};
	}

	// Non-queued (device / inline) runs carry no approval event, so there is no
	// second write to bind atomically — create the run on the pool.
	const claim = await createConnectorOperationRun({
		organizationId: ctx.organizationId,
		connectionId: connection.id,
		connectorKey: connection.connector_key,
		operationKey: operation.operation_key,
		operationInput: input,
		approvalMode,
		requireCompiledCode: operation.backend === "local_action",
		policyPrincipalKind: actor.kind,
		policyPrincipalId: actor.id,
		createdByUserId: activation ? visibilityUserId : ctx.userId,
		automationId: ctx.actingAutomationId,
		parentRunId: ctx.actingRunId,
		runMetadata,
		sdkBrowserContext,
		idempotencyKey: args.idempotency_key,
		activation,
	});
	if (!claim.created) {
		await trackOperationReaction(claim.runId);
		return replayExistingOperationRun(claim, operation.name, ctx);
	}
	const runId = claim.runId;
	if (activation) {
		await trackOperationReaction(runId);
		return {
			action: "execute",
			run_id: runId,
			status: "in_progress",
			message: `Operation '${operation.name}' is waiting for an eligible page visit.`,
		};
	}

	// Device-bound branch: the run is pending; a device worker (chrome
	// extension, mac bridge, ...) will claim it via /api/workers/poll and
	// post completion to /api/workers/complete-action. Poll runs.status
	// here until it flips to completed/failed/timeout, or we hit the
	// device-action timeout. Returns action_output on success.
	if (approvalMode === "device") {
		const result = await waitForDeviceActionRun(
			runId,
			ctx.organizationId,
			ctx.abortSignal,
		);
		await trackOperationReaction(runId);
		if (result.status === "completed") {
			return {
				action: "execute",
				run_id: runId,
				status: "completed",
				output: result.output ?? {},
			};
		}
		if (result.status === "timeout") {
			return {
				action: "execute",
				run_id: runId,
				status: "timeout",
				error_message: result.error_message ?? "Device action run timed out.",
			};
		}
		return {
			action: "execute",
			run_id: runId,
			status: "failed",
			error_message: result.error_message ?? "Device action run failed.",
		};
	}

	if (claim.claimedBy === null) {
		// Every inline run is claimed in the INSERT that creates it. A null owner
		// means this row was not created for inline execution, and running it
		// would write the outcome back with no lease to fence against.
		return {
			action: "execute",
			run_id: runId,
			status: "failed",
			error_message: "Inline execution requires a claimed run.",
		};
	}
	const result = await executeOperationInline(
		runId,
		ctx.organizationId,
		connection,
		operation,
		input,
		visibilityUserId,
		ctx.abortSignal,
		{ claimedBy: claim.claimedBy },
	);
	await trackOperationReaction(runId);
	if (result.status === "completed") {
		return {
			action: "execute",
			run_id: runId,
			status: "completed",
			output: result.output,
			...(result.metadata ? { metadata: result.metadata } : {}),
		};
	}
	return {
		action: "execute",
		run_id: runId,
		status: "failed",
		error_message: result.error_message,
	};
}
