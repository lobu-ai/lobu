import {
	ListAvailableAction,
	type ManageOperationsResult,
} from "../schemas";
import type { Static } from "@sinclair/typebox";
import {
	readGrantedScopesFromAuthData,
	readRequestedScopesFromAuthData,
} from "../../../../auth/oauth/scopes";
import { resolveMaxAccessLevel, type ToolAccessLevel } from "../../../../auth/tool-access";
import { resolveAutomationConnectionVisibilityUserId } from "../../../../authz/automation-connection-visibility";
import { compileConnectionRowVisibility } from "../../../../authz/connection-visibility";
import { resolveActingPrincipal, resolveWriteEffects } from "../../../../authz/entity-policy";
import { authzScopeFromToolContext } from "../../../../authz/scope";
import { getDb } from "../../../../db/client";
import {
	defaultActionModeForOperation,
	getActionModes,
	resolveActionMode,
} from "../../../../operations/action-modes";
import { listOperations } from "../../../../operations/connector-operations";
import { getMissingKnownOAuthScopes } from "../../../../operations/oauth-scope-readiness";
import type { AvailableOperation, OperationDescriptor } from "../../../../operations/types";
import { isChromeNamespaceConnectorKey } from "../../../../utils/connector-execution-placement";
import {
	DEVICE_ONLINE_WINDOW_SECONDS,
	describeDeviceLastSeen,
} from "../../../../utils/device-liveness";
import { buildConnectionsUrl } from "../../../../utils/url-builder";
import {
	DEVICE_CONNECTOR_MANIFEST_UNAVAILABLE,
	describeDeviceConnectorSetupRequired,
	findDeviceConnectorReadiness,
	loadDeviceConnectorReadiness,
	type DeviceConnectorReadiness,
	type DeviceConnectorReadinessIndex,
} from "../../../../worker-api/device-connector-readiness";
import { isSystemContext } from "../../../access-control";
import type { ToolContext } from "../../../registry";
import { getOrgUrlContext } from "../../../view-urls";
import { qualifiedOperationKey } from "./shared";

type ExecutionTarget = {
	connection_id: number;
	slug: string;
	display_name: string;
	status: string;
	executable: boolean;
	reason: string;
};

type InternalExecutionTarget = ExecutionTarget & {
	config: Record<string, unknown> | null;
	auth_profile_kind: string | null;
	auth_profile_slug: string | null;
	granted_scopes: string[];
	granted_scopes_known: boolean;
	requested_scopes: string[];
};

type OperationTargetRow = {
	id: number;
	connector_key: string;
	slug: string;
	display_name: string | null;
	status: string;
	config: Record<string, unknown> | null;
	device_worker_id: string | null;
	device_online: boolean;
	device_last_seen_at: Date | string | null;
	device_bound: boolean;
	device_owner_user_id: string | null;
	connector_version: string | null;
	connector_manifest_backed: boolean;
	connector_manifest_hash: string | null;
	auth_profile_kind: string | null;
	auth_profile_slug: string | null;
	auth_data: Record<string, unknown> | null;
};
function executionTargetFromRow(
	row: OperationTargetRow,
	deviceReadiness?: DeviceConnectorReadiness,
): InternalExecutionTarget {
	const base = {
		connection_id: Number(row.id),
		slug: row.slug,
		display_name: row.display_name ?? row.slug,
		config: row.config,
		auth_profile_kind: row.auth_profile_kind,
		auth_profile_slug: row.auth_profile_slug,
		granted_scopes: readGrantedScopesFromAuthData(row.auth_data),
		granted_scopes_known: Object.hasOwn(row.auth_data ?? {}, "granted_scopes"),
		requested_scopes: readRequestedScopesFromAuthData(row.auth_data),
	};
	if (row.status !== "active") {
		return {
			...base,
			status: row.status,
			executable: false,
			reason: `Connection status is ${row.status}.`,
		};
	}
	if (row.device_worker_id && !row.device_online) {
		// Fleet readiness cannot override an execution pin: dispatch remains
		// restricted to this exact device even when another owner device is ready.
		return {
			...base,
			status: "device_offline",
			executable: false,
			reason: `The connection's paired device is offline (${describeDeviceLastSeen(
				row.device_last_seen_at,
			)}).`,
		};
	}
	if (
		row.connector_manifest_backed &&
		(row.connector_manifest_hash == null || !deviceReadiness)
	) {
		return {
			...base,
			status: "setup_required",
			executable: false,
			reason: DEVICE_CONNECTOR_MANIFEST_UNAVAILABLE,
		};
	}
	if (deviceReadiness?.state === "setup_required") {
		return {
			...base,
			status: "setup_required",
			executable: false,
			reason: describeDeviceConnectorSetupRequired(deviceReadiness),
		};
	}
	if (deviceReadiness?.state === "ready") {
		return {
			...base,
			status: "ready",
			executable: true,
			reason: "Connection is ready for execution.",
		};
	}
	if (deviceReadiness?.state === "device_offline") {
		return {
			...base,
			status: "device_offline",
			executable: false,
			reason: row.device_worker_id
				? "The paired device is not advertising the connector's selected manifest. Update or reconnect that device."
				: "No online device is advertising the connector's selected manifest.",
		};
	}
	if (row.device_bound && !row.device_online) {
		// Say HOW stale, not just "offline". The caller's next question is
		// always "since when" — answering it here is the difference between
		// "my device died 20 minutes ago" and a dispatch that stalls for the
		// queue budget before failing with a guess.
		return {
			...base,
			status: "device_offline",
			executable: false,
			reason: `The connection's paired device is offline (${describeDeviceLastSeen(
				row.device_last_seen_at,
			)}).`,
		};
	}
	return {
		...base,
		status: "ready",
		executable: true,
		reason: "Connection is ready for execution.",
	};
}

function groupExecutionTargets(
	rows: OperationTargetRow[],
	deviceReadiness: DeviceConnectorReadinessIndex,
): Map<string, InternalExecutionTarget[]> {
	const grouped = new Map<string, InternalExecutionTarget[]>();
	for (const row of rows) {
		const targets = grouped.get(row.connector_key) ?? [];
		targets.push(
			executionTargetFromRow(
				row,
				findDeviceConnectorReadiness(deviceReadiness, {
					ownerUserId: row.device_owner_user_id,
					connectorKey: row.connector_key,
					connectorVersion: row.connector_version,
					manifestHash: row.connector_manifest_hash,
					deviceWorkerId: row.device_worker_id,
				}),
			),
		);
		grouped.set(row.connector_key, targets);
	}
	return grouped;
}

function operationReadinessReason(
	readiness: string,
	executable: boolean,
): string {
	if (executable) return "At least one visible connection is ready.";
	if (readiness === "unsupported") {
		return "This connector's installed code does not implement this action (declared in the catalog but not executable).";
	}
	if (readiness === "disconnected") {
		return "No visible connection exists for this connector.";
	}
	if (readiness === "device_offline") {
		return "Every visible active device-bound connection is offline.";
	}
	if (readiness === "setup_required") {
		return "Connector setup is incomplete on every otherwise-available device.";
	}
	if (readiness === "scope_upgrade_required") {
		return "This operation needs OAuth scopes the connection has not granted. Reauthorize to grant them.";
	}
	if (readiness === "session_scope_required") {
		return SESSION_SCOPE_REASON;
	}
	if (readiness === "membership_required") {
		return MEMBERSHIP_REASON;
	}
	if (readiness === "disabled") {
		return "This operation is disabled on every visible connection.";
	}
	return `A visible connection has status ${readiness}.`;
}

function resolveOperationReadiness(targets: ExecutionTarget[]): {
	readyTarget: ExecutionTarget | undefined;
	executable: boolean;
	readiness: string;
} {
	const readyTarget = targets.find((target) => target.executable);
	if (readyTarget) {
		return { readyTarget, executable: true, readiness: "ready" };
	}
	if (targets.length === 0) {
		return {
			readyTarget: undefined,
			executable: false,
			readiness: "disconnected",
		};
	}
	if (targets.every((target) => target.status === "disabled")) {
		return { readyTarget: undefined, executable: false, readiness: "disabled" };
	}
	return {
		readyTarget: undefined,
		executable: false,
		readiness:
			targets.find((target) => target.status !== "disabled")?.status ??
			"inactive",
	};
}

/** Shared copy for the caller-scope gate: executing operations requires an MCP
 * session at write tier (mcp:write / mcp:admin). */
const SESSION_SCOPE_REASON =
	"Executing operations requires an MCP session with write access (mcp:write or mcp:admin). This session has read-only access.";

/** Shared copy for the caller-membership gate: a non-member can't execute even
 * with mcp:write — routeAction denies at the membership check, so readiness
 * must point at joining the workspace, not upgrading scope. */
const MEMBERSHIP_REASON =
	"Executing operations requires workspace membership with write access. This caller is not a member of the organization.";

function operationMatchesQuery(
	operation: AvailableOperation & Record<string, unknown>,
	queryTokens: string[],
): boolean {
	if (queryTokens.length === 0) return true;
	const haystack = [
		operation.connector_key,
		operation.connector_name,
		operation.operation_key,
		operation.name,
		operation.description ?? "",
		JSON.stringify(operation.input_schema ?? {}),
	]
		.join(" ")
		.toLocaleLowerCase();
	return queryTokens.every((token) => haystack.includes(token));
}

function buildOperationNextAction(args: {
	operation: OperationDescriptor;
	readyTarget: ExecutionTarget | undefined;
	readiness: string;
	remediationTarget: ExecutionTarget | undefined;
	remediationConfig: Record<string, unknown> | null | undefined;
	remediationAuthKind: string | null | undefined;
	remediationAuthProfileSlug: string | null | undefined;
	missingScopes: string[];
	requestedScopes: string[];
	viewUrl: string | undefined;
}): Record<string, unknown> {
	const {
		operation,
		readyTarget,
		readiness,
		remediationTarget,
		remediationConfig,
		remediationAuthKind,
		remediationAuthProfileSlug,
		missingScopes,
		requestedScopes,
		viewUrl,
	} = args;
	if (readiness === "session_scope_required") {
		return {
			action: "elevate_session_scope",
			sdk_method: "operations.execute",
			manual: true,
			reason: SESSION_SCOPE_REASON,
			note: "Reconnect the MCP session with write access (mcp:write or mcp:admin) to execute operations.",
		};
	}
	if (readiness === "membership_required") {
		return {
			action: "request_membership",
			sdk_method: "operations.execute",
			manual: true,
			reason: MEMBERSHIP_REASON,
			note: "Join the organization or ask an owner to grant membership before executing operations.",
		};
	}
	if (readyTarget) {
		const requiredInput =
			Array.isArray(operation.input_schema?.required) &&
			operation.input_schema.required.length > 0;
		if (requiredInput) {
			return {
				action: "provide_input",
				sdk_method: "operations.execute",
				requires_input: true,
				input_schema: operation.input_schema,
				arguments: [
					{
						connection_id: readyTarget.connection_id,
						operation_key: operation.operation_key,
					},
				],
			};
		}
		return {
			action: "execute",
			sdk_method: "operations.execute",
			arguments: [
				{
					connection_id: readyTarget.connection_id,
					operation_key: operation.operation_key,
					input: {},
				},
			],
		};
	}
	if (readiness === "disconnected") {
		return {
			action: "connect",
			sdk_method: "connections.connect",
			arguments: [{ connector_key: operation.connector_key }],
		};
	}
	if (readiness === "scope_upgrade_required") {
		return {
			action: "reauthorize",
			sdk_method: "authProfiles.update",
			connection_id: remediationTarget?.connection_id,
			requested_scopes: missingScopes,
			arguments: [
				{
					auth_profile_slug: remediationAuthProfileSlug,
					requested_scopes: Array.from(
						new Set([...requestedScopes, ...missingScopes]),
					),
					reconnect: true,
				},
			],
			...(viewUrl ? { view_url: viewUrl } : {}),
		};
	}
	if (readiness === "disabled") {
		return {
			action: "enable_operation",
			sdk_method: "connections.update",
			arguments: [
				{
					connection_id: remediationTarget?.connection_id,
					config: {
						action_modes: {
							...getActionModes(remediationConfig),
							[operation.operation_key]:
								defaultActionModeForOperation(operation),
						},
					},
				},
			],
		};
	}
	if (readiness === "paused") {
		return {
			action: "resume_connection",
			sdk_method: "connections.update",
			arguments: [
				{ connection_id: remediationTarget?.connection_id, status: "active" },
			],
		};
	}
	if (readiness === "unsupported") {
		// Not a connection/auth problem the caller can fix by wiring — the
		// installed connector code simply lacks an execute() for this action.
		return {
			action: "unsupported",
			manual: true,
			...(viewUrl ? { view_url: viewUrl } : {}),
		};
	}
	if (
		["pending_auth", "error", "revoked"].includes(readiness) &&
		["interactive", "oauth_account"].includes(remediationAuthKind ?? "")
	) {
		return {
			action: "reauthenticate",
			sdk_method: "connections.reauthenticate",
			arguments: [remediationTarget?.connection_id],
			...(viewUrl ? { view_url: viewUrl } : {}),
		};
	}
	return {
		action:
			readiness === "device_offline" ? "bring_device_online" : "open_setup",
		manual: true,
		...(viewUrl ? { view_url: viewUrl } : {}),
	};
}

function buildAvailableOperation(args: {
	operation: OperationDescriptor;
	internalTargets: InternalExecutionTarget[];
	includeInputSchema: boolean;
	viewUrl: string | undefined;
	/** The caller's highest reachable access tier (role × MCP scopes). */
	callerMax: ToolAccessLevel;
	/**
	 * True for authenticated/anonymous non-members (memberRole null) — their
	 * blocker is workspace membership, not MCP scope, so readiness must say so.
	 */
	callerLacksMembership: boolean;
}): AvailableOperation & Record<string, unknown> {
	const { operation, internalTargets, includeInputSchema, viewUrl, callerMax, callerLacksMembership } = args;
	const { backend_config: _privateBackendConfig, ...publicOperation } =
		operation;
	const requiredScopes = operation.required_scopes ?? [];
	const targets = internalTargets.map((target): ExecutionTarget => {
		const {
			config,
			auth_profile_kind: _authProfileKind,
			auth_profile_slug: _authProfileSlug,
			granted_scopes,
			granted_scopes_known,
			requested_scopes: _requestedScopes,
			...publicTarget
		} = target;
		if (resolveActionMode(operation, config) === "disabled") {
			return {
				...publicTarget,
				status: "disabled",
				executable: false,
				reason: "This operation is disabled on the connection.",
			};
		}
		const missing = getMissingKnownOAuthScopes(
			granted_scopes,
			granted_scopes_known,
			requiredScopes,
		);
		if (publicTarget.executable && missing.length > 0) {
			return {
				...publicTarget,
				status: "scope_upgrade_required",
				executable: false,
				reason: `Missing OAuth scope(s): ${missing.join(", ")}. Reauthorize the connection to grant them.`,
			};
		}
		return publicTarget;
	});
	// Capability gate (#2033 item 2): a local_action op whose compiled runtime
	// does NOT override execute() is declared in the catalog but would throw
	// "Actions not supported" at execution. Report it unsupported here so
	// readiness agrees with execution — regardless of connection status.
	const executeUnsupported =
		operation.backend === "local_action" &&
		(operation as OperationDescriptor).supports_execute === false;
	const base = executeUnsupported
		? { readyTarget: undefined as ExecutionTarget | undefined, executable: false, readiness: "unsupported" }
		: resolveOperationReadiness(targets);
	// Caller-awareness: readiness answers "is the TARGET ready", but the same
	// operation must not be advertised as executable to a caller whose session
	// could never invoke it (operations.execute is write-tier). A read-only
	// caller sees the catalog but every op is marked not-executable with a
	// scope-upgrade next_action — the "ready but denied" lie from the
	// prod-readiness review. Execution targets are overridden to match so no
	// per-target row contradicts the top-level verdict.
	const callerCanExecute = callerMax === "write" || callerMax === "admin";
	// Two distinct blockers for a caller who can't execute: missing workspace
	// MEMBERSHIP (authenticated/anon non-member — routeAction denies with
	// "requires workspace membership", not a scope message) vs. a member whose
	// session lacks mcp:write. Emit the right remediation for each.
	const callerBlockedByMembership =
		callerLacksMembership && !callerCanExecute;
	const callerReadiness = callerBlockedByMembership
		? "membership_required"
		: "session_scope_required";
	const callerReason = callerBlockedByMembership
		? MEMBERSHIP_REASON
		: SESSION_SCOPE_REASON;
	// Only a caller-blocked op whose TARGET was ready gets downgraded. An op
	// already not-executable for its own reasons (unsupported/disconnected/
	// disabled) keeps its target-state verdict — the caller override must not
	// replace it. Downgraded targets carry the caller readiness as their status
	// too, so no per-target row contradicts the top-level verdict.
	const shouldOverride = !callerCanExecute && base.executable;
	const readyTarget = shouldOverride ? undefined : base.readyTarget;
	const executable = shouldOverride ? false : base.executable;
	const readiness = shouldOverride ? callerReadiness : base.readiness;
	const effectiveTargets = shouldOverride
		? targets.map((target) =>
				target.executable
					? {
							...target,
							executable: false,
							status: callerReadiness,
							reason: callerReason,
						}
					: target,
			)
		: targets;
	const remediationTarget =
		effectiveTargets.find((target) => target.status === readiness) ??
		effectiveTargets[0];
	const remediationInternalTarget = internalTargets.find(
		(target) => target.connection_id === remediationTarget?.connection_id,
	);
	const missingScopes =
		readiness === "scope_upgrade_required"
			? getMissingKnownOAuthScopes(
					remediationInternalTarget?.granted_scopes ?? [],
					remediationInternalTarget?.granted_scopes_known ?? false,
					requiredScopes,
				)
			: [];
	return {
		...(publicOperation as AvailableOperation),
		...(includeInputSchema ? {} : { input_schema: undefined }),
		executable,
		readiness,
		reason: operationReadinessReason(readiness, executable),
		connection_count: targets.length,
		execution_targets: effectiveTargets,
		next_action: buildOperationNextAction({
			operation,
			readyTarget,
			readiness,
			remediationTarget,
			remediationConfig: remediationInternalTarget?.config,
			remediationAuthKind: remediationInternalTarget?.auth_profile_kind,
			remediationAuthProfileSlug: remediationInternalTarget?.auth_profile_slug,
			missingScopes,
			requestedScopes: remediationInternalTarget?.requested_scopes ?? [],
			viewUrl,
		}),
	};
}

async function loadVisibleOperationTargets(
	args: Static<typeof ListAvailableAction>,
	ctx: ToolContext,
): Promise<OperationTargetRow[]> {
	const sql = getDb();
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
	return (await sql.unsafe(
		`SELECT c.id,
		        c.connector_key,
		        c.slug,
		        c.display_name,
		        c.status,
		        c.config,
		        c.device_worker_id,
		        COALESCE(dw.user_id, (o.metadata::jsonb)->>'personal_org_for_user_id') AS device_owner_user_id,
		        latest.version AS connector_version,
		        COALESCE(latest.manifest_backed, false) AS connector_manifest_backed,
		        latest.artifact_hash AS connector_manifest_hash,
		        ap.profile_kind AS auth_profile_kind,
		        ap.slug AS auth_profile_slug,
		        ap.auth_data AS auth_data,
		        COALESCE(dw.last_seen_at > now() - make_interval(secs => ${DEVICE_ONLINE_WINDOW_SECONDS}), false) AS device_online,
		        dw.last_seen_at AS device_last_seen_at,
		        (c.device_worker_id IS NOT NULL OR latest.runtime IS NOT NULL) AS device_bound
		 FROM connections c
		 JOIN "organization" o ON o.id = c.organization_id
		 LEFT JOIN device_workers dw ON dw.id = c.device_worker_id
		 LEFT JOIN auth_profiles ap ON ap.id = c.auth_profile_id
		 LEFT JOIN LATERAL (
		   SELECT cd.version, cd.runtime,
		          artifact.manifest_backed, artifact.artifact_hash
		   FROM connector_definitions cd
		   LEFT JOIN LATERAL (
		     SELECT
		       (
		         cv.source_path LIKE 'device-manifest://%'
		         AND cv.compiled_code IS NULL
		         AND cv.compile_config_hash IS NULL
		         AND cv.source_code IS NULL
		       ) AS manifest_backed,
		       cv.compiled_code_hash AS artifact_hash
		     FROM connector_versions cv
		     WHERE cv.connector_key = cd.key
		       AND cv.version = cd.version
		       AND (cv.organization_id = cd.organization_id OR cv.organization_id IS NULL)
		     ORDER BY cv.organization_id NULLS LAST
		     LIMIT 1
		   ) artifact ON TRUE
		   WHERE cd.organization_id = c.organization_id
		     AND cd.key = c.connector_key
		     AND cd.status = 'active'
		   ORDER BY cd.updated_at DESC, cd.id DESC
		   LIMIT 1
		 ) latest ON TRUE
		 WHERE c.organization_id = $1
		   AND c.deleted_at IS NULL
		   ${visibility}
		   AND ($2::bigint IS NULL OR c.id = $2)
		   AND ($3::text IS NULL OR c.connector_key = $3)
		   AND ($4::bigint IS NULL OR EXISTS (
		     SELECT 1 FROM feeds f
		     WHERE f.connection_id = c.id
		       AND f.deleted_at IS NULL
		       AND $4 = ANY(f.entity_ids)
		   ))
		 ORDER BY c.connector_key, c.id`,
		[
			ctx.organizationId,
			args.connection_id ?? null,
			args.connector_key ?? null,
			args.entity_id ?? null,
		],
	)) as unknown as OperationTargetRow[];
}

export async function handleListAvailable(
	args: Static<typeof ListAvailableAction>,
	ctx: ToolContext,
): Promise<ManageOperationsResult> {
	const targetRows = await loadVisibleOperationTargets(args, ctx);

	// An explicit connection filter is also an authorization lookup. Fail with
	// execute's exact not-found error instead of a silent empty list: `[]` is
	// indistinguishable from "this connection declares no operations", and the
	// shared message keeps a hidden/private connection's connector key out of
	// the catalog without revealing whether the id exists at all. The
	// existence/visibility check is independent of the secondary filters: a
	// VISIBLE connection excluded by connector_key/entity_id is a normal empty
	// compound-filter match, while a hidden/missing id errors either way — so
	// the same visibility-compiled query is re-run with the secondary filters
	// stripped, only on this already-empty branch.
	if (args.connection_id !== undefined && targetRows.length === 0) {
		const bareRows =
			args.connector_key === undefined && args.entity_id === undefined
				? targetRows
				: await loadVisibleOperationTargets(
						{ ...args, connector_key: undefined, entity_id: undefined },
						ctx,
					);
		if (bareRows.length === 0) {
			return { error: "Connection not found or not visible." };
		}
		return {
			action: "list_available",
			operations: [],
			total: 0,
			limit: args.limit ?? 100,
			offset: args.offset ?? 0,
		};
	}

	const deviceReadiness = await loadDeviceConnectorReadiness({
		sql: getDb(),
		targets: targetRows.flatMap((row) =>
			row.connector_manifest_backed || isChromeNamespaceConnectorKey(row.connector_key)
				? [{
						ownerUserId: row.device_owner_user_id,
						connectorKey: row.connector_key,
						connectorVersion: row.connector_version,
						manifestHash: row.connector_manifest_hash,
						deviceWorkerId: row.device_worker_id,
					}]
				: [],
		),
	});
	const targetsByConnector = groupExecutionTargets(targetRows, deviceReadiness);

  // A `disabled` connector_action effect turns an operation OFF for this principal
  // — it shouldn't be listed at all (Disabled HIDES the action, unlike deny/approval
  // which surface then gate on execute). Two levels now: the BLANKET `execute` rule
  // (operation_key NULL) can disable the whole connector, and a PER-OPERATION rule
  // can disable a single op while the rest stay listed.
  const actor = await resolveActingPrincipal(getDb(), {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    agentId: ctx.agentId,
    sessionAutomationId: ctx.actingAutomationId ?? null,
  });
  // Fetch the FULL filtered set (offset 0, no caller limit), drop per-op-disabled
  // ops across the WHOLE set, THEN paginate. Filtering a single page and subtracting
  // its hidden count from the global total gives an inconsistent `total` across pages
  // and can return a short page while visible ops remain past the offset (a client
  // treating "short page = end" would silently truncate the catalog). Pagination must
  // run on the post-filter list.
	// For an explicit connection, targetRows already performed the visibility and
	// authorization lookup. Query the connector catalog by that row's key instead
	// of applying listOperations' legacy per-connection action-mode filter; the
	// readiness mapper below must retain disabled capabilities and explain how to
	// enable them.
	const catalogConnectorKey =
		args.connection_id !== undefined
			? targetRows[0]?.connector_key
			: args.connector_key;
  const full = await listOperations({
    organizationId: ctx.organizationId,
		connectorKey: catalogConnectorKey,
		connectionId: args.connection_id,
    entityId: args.entity_id,
    kind: args.kind,
    backend: args.backend,
		// Required-input detection still needs the schema when the caller hides the
		// descriptor copy from the public response.
		includeInputSchema: true,
    includeOutputSchema: args.include_output_schema ?? false,
		includeDisabled: true,
    // Fetch the WHOLE filtered set — listOperations defaults to limit 100, which
    // would silently drop ops past index 100 and make them unreachable at any
    // caller offset. We must filter per-op-disabled across the full set BEFORE
    // slicing, so no internal cap here; the caller's limit/offset apply below.
    limit: Number.MAX_SAFE_INTEGER,
    offset: 0,
  });
	const qualifiedWriteKeys = full.operations
		.filter((operation) => operation.kind === "write")
		.map((operation) =>
			qualifiedOperationKey(operation.connector_key, operation.operation_key),
		);
	const policyEffects = await resolveWriteEffects({
		organizationId: ctx.organizationId,
		resourceClass: "connector_action",
		principalKind: actor.kind,
		principalId: actor.id,
		ownerAgentId: actor.ownerAgentId,
		ownerResolved: actor.ownerResolved,
		action: "execute",
		operationKeys: qualifiedWriteKeys,
	});
	const blanketDisabled = policyEffects.get(null) === "disabled";

  // Hide WRITE ops whose per-op (or blanket) policy is disabled. Reads are never
  // filtered by agent write-policy. Humans always resolve auto for policy.
	const visibleFlags = full.operations.map((op) => {
			if (op.kind === "read") return "auto" as const;
			if (blanketDisabled) return "disabled" as const;
			return (
				policyEffects.get(
					qualifiedOperationKey(op.connector_key, op.operation_key),
				) ?? "auto"
  );
		});
	const policyVisible = full.operations.filter(
		(_op, i) => visibleFlags[i] !== "disabled",
  );

	const queryTokens = (args.query ?? "")
		.toLocaleLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	// The caller's own reachable tier (role × MCP scopes) feeds the readiness
	// mapper: operations.execute is write-tier, so a read-only session must not
	// be told an op is ready to execute. System/reaction contexts (userId null,
	// memberRole null) bypass role/scope entirely at routeAction, so they must
	// be treated as fully capable here — downgrading them would hide ready ops
	// from Automation reactions.
	const isSystem = isSystemContext(ctx);
	const callerMax = isSystem
		? "admin"
		: resolveMaxAccessLevel(ctx.memberRole, ctx.scopes);
	// A non-member (memberRole null, and not a system context) is blocked by
	// membership, not by MCP scope — the readiness copy must say so.
	const callerLacksMembership = !isSystem && ctx.memberRole == null;
	const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
	const connectorViewUrl = (connectorKey: string): string | undefined =>
		ownerSlug && baseUrl
			? buildConnectionsUrl(ownerSlug, baseUrl, connectorKey)
			: undefined;
	const publicOperations = policyVisible
		.map((operation) =>
			buildAvailableOperation({
				operation,
				internalTargets: targetsByConnector.get(operation.connector_key) ?? [],
				includeInputSchema: args.include_input_schema !== false,
				viewUrl: connectorViewUrl(operation.connector_key),
				callerMax,
				callerLacksMembership,
			}),
		)
		.filter((operation) => {
			if (args.include_disconnected === false && !operation.executable) {
				return false;
			}
			return operationMatchesQuery(operation, queryTokens);
		});

  const offset = args.offset ?? 0;
	const limit = args.limit ?? 100;
  return {
		action: "list_available",
		operations: publicOperations.slice(offset, offset + limit),
		total: publicOperations.length,
    limit,
    offset,
  };
}
