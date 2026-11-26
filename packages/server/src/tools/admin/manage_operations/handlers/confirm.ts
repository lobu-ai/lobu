import type { Static } from "@sinclair/typebox";
import { resolveAutomationConnectionVisibilityUserId } from "../../../../authz/automation-connection-visibility";
import { leasedAutomationOfHeldRun } from "../../../../automations/automation-source";
import {
	allowlistRefusal,
	POLICY_CHECK_METADATA_KEY,
	connectorPolicyNoteSuffix,
	explainConnectorPolicy,
	requesterPolicyExplanation,
} from "../../../../authz/connector-policy";
import { chatAccessOfToolContext, DEVICE_ACCESS_REFUSED, decideDeviceAccess } from "../../../../authz/device-access";
import { resolveActingPrincipal, resolveConnectorPolicy } from "../../../../authz/entity-policy";
import { storedPolicyClassify } from "../../../../authz/policy-classify";
import { classifyRunDestination, resolveRunConnectorPolicy } from "../../../../authz/operation-run-policy";
import { resolvePolicyPrincipal } from "../../../../authz/policy-principal";
import { writeEffectRank } from "../../../../authz/write-action-manifest";
import { DEVICE_ACTION_QUEUE_BUDGET_MS, DEVICE_BACKGROUND_ACTION_QUEUE_BUDGET_MS } from "../../../../config/intervals";
import { getDb } from "../../../../db/client";
import { getOperationForConnection } from "../../../../operations/connector-operations";
import { newGatewayInlineOwner } from "../../../../runs/run-lease";
import { notifyWorkerWork } from "../../../../runs/worker-wakeup";
import { isDelegatedBrowserAffinityConnector } from "../../../../utils/connector-execution-placement";
import { withFailureCode } from "../../../../utils/errors";
import { isAutomationScriptCall } from "../../../access-control";
import type { ToolContext } from "../../../registry";
import type { ConfirmAction, ManageOperationsResult } from "../schemas";
import { dispatchAdmittedRun, insertDispatchCard, resolveConnectionCardEntityIds } from "./execute";
import { heldRunContractError, loadHeldOperationRun } from "./held-run";

const noReactionTracking = async (): Promise<void> => {};

/**
 * Release a run a Check held. Only the principal that requested it may
 * confirm, with the input it was held with; the policy is re-read first, so a
 * rule tightened since the hold still wins. An external processor confirms as
 * the Automation it held the run for while it still holds that Automation's
 * window lease. The release, its statement and the run's ledger card commit
 * together, then the run dispatches as an Auto run would have.
 */
export async function handleConfirm(
	args: Static<typeof ConfirmAction>,
	ctx: ToolContext,
): Promise<ManageOperationsResult> {
	// Execute never holds a script's write for a Check; it has no judgment to record.
	if (isAutomationScriptCall(ctx)) {
		return withFailureCode({ error: "An Automation script cannot confirm a check." }, "PERMISSION");
	}
	const sql = getDb();
	const statement = args.statement.trim();
	if (!statement) return withFailureCode({ error: "statement must not be blank." }, "VALIDATION");
	const actor = await resolveActingPrincipal(sql, {
		organizationId: ctx.organizationId,
		userId: ctx.userId,
		agentId: ctx.agentId,
		explicitAutomationId: await leasedAutomationOfHeldRun(sql, ctx, args.run_id),
		sessionAutomationId: ctx.actingAutomationId,
		appId: ctx.appPrincipalId ?? null,
	});
	const visibilityUserId = await resolveAutomationConnectionVisibilityUserId(ctx, sql);
	// Ask who sees the destination before the transaction locks the run.
	const destination = await classifyRunDestination(ctx.organizationId, args.run_id);

	const decided = await sql.begin(async (tx) => {
		// Take the connection lock first, as delete does. Otherwise delete
		// could hold the connection while confirm holds the run and waits to
		// insert a dispatch event that references the connection.
		const [connection] = await tx`
			SELECT c.id
			FROM connections c
			JOIN runs r ON r.connection_id = c.id AND r.organization_id = c.organization_id
			WHERE r.id = ${args.run_id} AND r.organization_id = ${ctx.organizationId}
				AND r.run_type = 'action' AND r.approval_status = 'check' AND r.status = 'pending'
				AND c.deleted_at IS NULL
			FOR SHARE OF c
		`;
		const run = connection
			? await loadHeldOperationRun(tx, ctx.organizationId, args.run_id, "check", true)
			: null;
		if (!run) {
			const [exists] = await tx`
				SELECT 1 FROM runs
				WHERE id = ${args.run_id} AND organization_id = ${ctx.organizationId} AND run_type = 'action'
			`;
			return exists
				? withFailureCode({
						error: `Run ${args.run_id} is not held by a check. Read operations.getRun(${args.run_id}) for its state.`,
						reason: "not_pending_check" as const,
					}, "PRECONDITION_FAILED")
				: withFailureCode({ error: "Operation run not found" }, "NOT_FOUND");
		}
		// The statement is the requester's own account of its action. An app key
		// is shared by every user of the app, so an app run also needs its user.
		const ownsRun = actor.ownerResolved && actor.id != null &&
			run.policy_principal_kind === actor.kind && run.policy_principal_id === actor.id &&
			(actor.kind !== "app" || (ctx.userId != null && run.created_by_user_id === ctx.userId));
		if (!ownsRun) {
			return withFailureCode({ error: "Only the requester of a held operation can confirm it." }, "PERMISSION");
		}
		if (!run.unexpired) {
			return withFailureCode({
				error: `The check on run ${args.run_id} expired. Execute the operation again.`,
				reason: "check_expired" as const,
			}, "PRECONDITION_FAILED");
		}
		const resolved = await getOperationForConnection(ctx.organizationId, run.connection_id, run.action_key, tx);
		if (!resolved) {
			return withFailureCode({
				error: `Operation '${run.action_key}' is no longer available for this connection.`,
			}, "NOT_FOUND");
		}
		const contractError = await heldRunContractError(tx, ctx.organizationId, run, resolved);
		if (contractError) return withFailureCode({ error: contractError.message }, contractError.code);

		const settle = (approvalStatus: "rejected" | "withdrawn", why: string) => tx`
			UPDATE runs
			SET approval_status = ${approvalStatus}, status = 'cancelled',
				error_message = ${why}, completed_at = current_timestamp
			WHERE id = ${run.id}
		`;
		const executesOnDevice =
			!isDelegatedBrowserAffinityConnector(run.target_device_platform, run.connector_key) &&
			(run.target_device_worker_id != null || resolved.connection.connector_runtime != null);
		const deviceAccess = executesOnDevice || resolved.connection.device_worker_id != null
			? decideDeviceAccess(chatAccessOfToolContext(ctx))
			: "run";
		if (deviceAccess === "refuse") return withFailureCode({ error: DEVICE_ACCESS_REFUSED }, "PERMISSION");

		const [requesterPolicy, callerPolicy, principal] = await Promise.all([
			resolveRunConnectorPolicy({ organizationId: ctx.organizationId, runId: run.id, sql: tx, destination }),
			resolveConnectorPolicy({
				organizationId: ctx.organizationId,
				connectionId: run.connection_id,
				operation: resolved.operation,
				actor,
				appPrincipalId: ctx.appPrincipalId ?? null,
				input: run.action_input,
				sql: tx,
				destination,
				classify: { live: false, results: storedPolicyClassify(run.run_metadata) },
			}),
			resolvePolicyPrincipal(tx, ctx.organizationId, { kind: run.policy_principal_kind, id: run.policy_principal_id }),
		]);
		// A replacement runner may hold this Automation's next window. Its own
		// restrictions also apply, alongside the persisted requester's policy.
		const policy = requesterPolicy && writeEffectRank(callerPolicy.effect) > writeEffectRank(requesterPolicy.effect)
			? callerPolicy
			: requesterPolicy;
		if (!policy || policy.effect === "deny") {
			const why = policy?.reason === "allowlist"
				? allowlistRefusal(run.action_key)
				: `Policy now blocks '${run.action_key}'${policy ? connectorPolicyNoteSuffix(policy) : "."}`;
			await settle("rejected", why);
			return withFailureCode({
				error: why,
				...(policy ? { policy: requesterPolicyExplanation(explainConnectorPolicy(policy, principal)) } : {}),
			}, "PERMISSION");
		}
		if (policy.effect === "approval" || deviceAccess === "ask_owner") {
			const why = "The policy now asks a person to approve this operation.";
			await settle("withdrawn", why);
			return withFailureCode({
				error: `${why} Run ${run.id} was withdrawn; call operations.execute again to request approval.`,
				reason: "policy_changed" as const,
				policy: requesterPolicyExplanation(explainConnectorPolicy(policy, principal, deviceAccess === "ask_owner")),
			}, "PRECONDITION_FAILED");
		}

		const confirmedAt = new Date().toISOString();
		const check = { statement, confirmed_at: confirmedAt };
		const activation = run.activation_kind != null;
		const inline = !executesOnDevice && !activation;
		const background = run.run_metadata?.background === true;
		const inlineOwner = inline ? newGatewayInlineOwner() : null;
		// Release under the dispatch the run would have had at execute: an inline
		// run is claimed here, a device run starts its queue horizon, and a
		// page-activated run keeps its activation horizon.
		const dispatchSet = inline
			? tx`, status = 'running', claimed_by = ${inlineOwner}, claimed_at = current_timestamp,
				last_heartbeat_at = current_timestamp, expires_at = NULL`
			: executesOnDevice && !activation
				? tx`, run_at = current_timestamp, expires_at = current_timestamp +
					(${background ? DEVICE_BACKGROUND_ACTION_QUEUE_BUDGET_MS : DEVICE_ACTION_QUEUE_BUDGET_MS}::int * interval '1 millisecond')`
				: tx``;
		const [released] = await tx<{
			status: string;
			claimed_by: string | null;
			run_metadata: Record<string, unknown> | null;
			action_input: Record<string, unknown> | null;
		}>`
			UPDATE runs
			SET approval_status = 'auto',
				run_metadata = COALESCE(run_metadata, '{}'::jsonb) || jsonb_build_object(${POLICY_CHECK_METADATA_KEY}::text, ${tx.json(check)}::jsonb)
				${dispatchSet}
			WHERE id = ${run.id} AND approval_status = 'check' AND status = 'pending'
			RETURNING status, claimed_by, run_metadata, action_input
		`;
		if (!released) throw new Error(`Locked check run ${run.id} could not be released.`);
		const input = released.action_input ?? {};
		await insertDispatchCard(tx, {
			ctx,
			connection: resolved.connection,
			operation: resolved.operation,
			input,
			cardEntityIds: await resolveConnectionCardEntityIds(tx, run.connection_id),
			runId: run.id,
			policy: { ...policy, check },
			principal,
			failedMessage: null,
		});
		return {
			release: {
				resolved,
				input,
				released,
				device: executesOnDevice && !activation,
				activation,
				background,
			},
		};
	});
	if (!("release" in decided)) return decided;

	const { resolved, input, released, device, activation, background } = decided.release;
	if (device) await notifyWorkerWork(sql);
	return dispatchAdmittedRun({
		claim: {
			runId: args.run_id,
			created: true,
			status: released.status,
			approvalStatus: "auto",
			actionOutput: null,
			errorMessage: null,
			errorCode: null,
			claimedBy: released.claimed_by,
		},
		ctx,
		connection: resolved.connection,
		operation: resolved.operation,
		input,
		visibilityUserId,
		runMetadata: released.run_metadata,
		device,
		activation,
		background,
		// Reactions were tracked when the run was held.
		trackOperationReaction: noReactionTracking,
	});
}
