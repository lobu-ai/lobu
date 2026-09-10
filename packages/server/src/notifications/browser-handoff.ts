import { compileConnectionRowVisibility } from "../authz/connection-visibility";
import { getDb, parsePgTextArray } from "../db/client";
import { emit } from "../events/emitter";
import { resolveActionMode } from "../operations/action-modes";
import { getOperationForConnection } from "../operations/connector-operations";
import { validateOperationInput } from "../operations/input-validation";
import { DEFAULT_PAGE_ACTIVATION_SECONDS } from "../runs/page-activation";
import { createConnectorOperationRun } from "../runs/queue-service";
import { ToolUserError } from "../utils/errors";

type HandoffSource = {
	event_id: number;
	browser_url: string;
	browser_run_id: number;
	connection_id: number;
	connector_key: string;
	action_key: string;
	action_input: Record<string, unknown> | null;
	automation_id: number | null;
	parent_run_id: number | null;
	status: string;
	approval_status: string;
	activation_kind: string | null;
	activation_target_urls: string | string[] | null;
	run_metadata: Record<string, unknown> | null;
	activated_at: Date | string | null;
	expires_at: Date | string | null;
};

async function loadHandoffSource(
	organizationId: string,
	userId: string,
	eventId: number,
): Promise<HandoffSource> {
	const sql = getDb();
	const visibility = compileConnectionRowVisibility(
		{ organizationId, principal: userId },
		"c",
	);
	let query = sql`
		SELECT
			t.event_id,
			t.browser_url,
			t.browser_run_id,
			r.connection_id,
			r.connector_key,
			r.action_key,
			r.action_input,
			r.automation_id,
			r.parent_run_id,
			r.status,
			r.approval_status,
			r.activation_kind,
			r.activation_target_urls,
			r.run_metadata,
			r.activated_at,
			r.expires_at
		FROM notification_targets t
		JOIN events e
		  ON e.id = t.event_id
		 AND e.organization_id = ${organizationId}
		JOIN runs r
		  ON r.id = t.browser_run_id
		 AND r.organization_id = e.organization_id
		JOIN connections c
		  ON c.id = r.connection_id
		 AND c.organization_id = e.organization_id
		 AND c.deleted_at IS NULL
		WHERE t.event_id = ${eventId}
		  AND t.user_id = ${userId}
		  AND t.browser_url IS NOT NULL
		  AND r.created_by_user_id = ${userId}
	`;
	query = sql`${query} ${sql.unsafe(visibility)} LIMIT 1`;
	const rows = (await query) as unknown as HandoffSource[];
	const source = rows[0];
	if (!source) {
		throw new ToolUserError("Browser handoff not found.", 404);
	}
	return source;
}

function isReady(source: HandoffSource): boolean {
	return (
		source.run_metadata?.page_activation_identity === "exact" &&
		source.status === "pending" &&
		source.approval_status === "auto" &&
		source.activation_kind === "page_visit" &&
		source.activated_at == null &&
		source.expires_at != null &&
		new Date(source.expires_at).getTime() > Date.now()
	);
}

function isFailed(source: HandoffSource): boolean {
	return source.status === "failed" || source.status === "timeout";
}

/**
 * Recreate an expired page-activation run from the exact notification the
 * signed-in owner clicked. The target row is the serialization point: two app
 * replicas racing the same click either reuse the newly-ready run or converge
 * through the per-old-run idempotency key.
 */
export async function recreateBrowserHandoff(
	organizationId: string,
	userId: string,
	eventId: number,
	attempt = 0,
): Promise<{
	browser_url: string;
	browser_handoff: {
		run_id: number;
		state: "ready";
		expires_at: string;
		error_message: null;
	};
}> {
	const source = await loadHandoffSource(organizationId, userId, eventId);
	if (isReady(source)) {
		return {
			browser_url: source.browser_url,
			browser_handoff: {
				run_id: source.browser_run_id,
				state: "ready",
				expires_at: new Date(source.expires_at!).toISOString(),
				error_message: null,
			},
		};
	}
	if (
		!isFailed(source) &&
		(source.status === "completed" || source.activated_at != null)
	) {
		throw new ToolUserError(
			"This draft handoff was already activated. Open the existing browser tab or dismiss the card.",
			409,
		);
	}
	if (
		source.activation_kind !== "page_visit" ||
		source.approval_status !== "auto" ||
		!source.action_input
	) {
		throw new ToolUserError(
			"This notification is not a recreatable page-activated draft.",
			409,
		);
	}

	const resolved = await getOperationForConnection(
		organizationId,
		source.connection_id,
		source.action_key,
	);
	if (!resolved || resolved.connection.status !== "active") {
		throw new ToolUserError(
			"The connector for this draft is no longer available.",
			409,
		);
	}
	if (
		resolved.operation.backend !== "local_action" ||
		resolveActionMode(resolved.operation, resolved.connection.config) !== "auto"
	) {
		throw new ToolUserError(
			"This draft action is no longer enabled for automatic page activation.",
			409,
		);
	}
	const validationError = validateOperationInput(
		resolved.operation,
		source.action_input,
	);
	if (validationError) {
		throw new ToolUserError(
			`This saved draft no longer matches the connector action: ${validationError}`,
			409,
		);
	}
	if (source.run_metadata?.page_activation_identity !== "exact") {
		throw new ToolUserError("This draft's original page target was lost. Create a new draft with its full URL.", 409);
	}
	const activationUrls = parsePgTextArray(source.activation_target_urls);
	if (activationUrls.length === 0) {
		throw new ToolUserError("This draft has no page-activation target.", 409);
	}

	const sql = getDb();
	const result = await sql.begin(async (tx) => {
		const locked = await tx<{
			browser_run_id: number | null;
		}>`
			SELECT browser_run_id
			FROM notification_targets
			WHERE event_id = ${eventId}
			  AND user_id = ${userId}
			FOR UPDATE
		`;
		if (locked.length === 0) {
			throw new ToolUserError("Browser handoff not found.", 404);
		}
		if (locked[0]?.browser_run_id !== source.browser_run_id) {
			return null;
		}
		const created = await createConnectorOperationRun({
			organizationId,
			connectionId: source.connection_id,
			connectorKey: source.connector_key,
			operationKey: source.action_key,
			operationInput: source.action_input!,
			approvalMode: "inline",
			activation: {
				kind: "page_visit",
				urls: activationUrls,
				expiresInSeconds: DEFAULT_PAGE_ACTIVATION_SECONDS,
			},
			requireCompiledCode: true,
			createdByUserId: userId,
			automationId: source.automation_id,
			parentRunId: source.parent_run_id,
			idempotencyKey: `notification-browser-handoff:${eventId}:retry:${source.browser_run_id}`,
			db: tx,
		});
		await tx`
			UPDATE notification_targets
			SET browser_run_id = ${created.runId}
			WHERE event_id = ${eventId}
			  AND user_id = ${userId}
		`;
		const [newRun] = await tx<{ id: number; expires_at: Date | string }>`
			SELECT id, expires_at
			FROM runs
			WHERE id = ${created.runId}
		`;
		if (!newRun?.expires_at) {
			throw new Error("Recreated browser handoff has no expiry.");
		}
		return newRun;
	});

	if (result === null) {
		// A concurrent click already swapped browser_run_id: re-read and settle on
		// whatever that request created. Bounded so a pathological swap loop fails
		// the request instead of spinning it.
		if (attempt >= 3) {
			throw new ToolUserError(
				"This draft handoff is being recreated by another request. Reload and try again.",
				409,
			);
		}
		return recreateBrowserHandoff(organizationId, userId, eventId, attempt + 1);
	}
	emit(organizationId, { keys: ["notifications", "activity-feed"] });
	return {
		browser_url: source.browser_url,
		browser_handoff: {
			run_id: result.id,
			state: "ready",
			expires_at: new Date(result.expires_at).toISOString(),
			error_message: null,
		},
	};
}
