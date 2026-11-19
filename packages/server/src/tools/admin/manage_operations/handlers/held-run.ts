import type { DbClient } from "../../../../db/client";
import type { getOperationForConnection } from "../../../../operations/connector-operations";
import { deviceManifestAdmissionError } from "../../../../runs/queue-service";
import { selectedConnectorVersionArtifactSql } from "../../../../utils/connector-execution-placement";

/** A connector operation run held for a decision: an Ask or a Check. */
export interface HeldOperationRun {
	id: number;
	connection_id: number;
	connector_key: string;
	connector_version: string | null;
	connector_artifact_hash: string | null;
	pinned_artifact_hash: string | null;
	target_device_worker_id: string | null;
	target_device_platform: string | null;
	action_key: string;
	action_input: Record<string, unknown> | null;
	policy_principal_kind: string | null;
	policy_principal_id: string | null;
	created_by_user_id: string | null;
	activation_kind: string | null;
	run_metadata: Record<string, unknown> | null;
	expires_at: Date | null;
	unexpired: boolean;
}

/** Read a pending run held under `approvalStatus`, with its pinned artifact. */
export async function loadHeldOperationRun(
	sql: DbClient,
	organizationId: string,
	runId: number,
	approvalStatus: "pending" | "check",
	lock = false,
): Promise<HeldOperationRun | null> {
	const [run] = await sql<HeldOperationRun>`
    SELECT id, connection_id, action_key, action_input,
           connector_key, connector_version, connector_artifact_hash, target_device_worker_id,
           (SELECT platform FROM device_workers WHERE id = runs.target_device_worker_id) AS target_device_platform,
           policy_principal_kind, policy_principal_id, created_by_user_id,
           activation_kind, run_metadata, expires_at,
           COALESCE(expires_at > current_timestamp, true) AS unexpired,
           cv.artifact_hash AS pinned_artifact_hash
    FROM runs
    LEFT JOIN LATERAL (
      ${selectedConnectorVersionArtifactSql(sql, {
				connectorKey: sql`runs.connector_key`,
				version: sql`runs.connector_version`,
				organizationId: sql`runs.organization_id`,
			})}
    ) cv ON TRUE
    WHERE id = ${runId}
      AND organization_id = ${organizationId}
      AND approval_status = ${approvalStatus}
      AND status = 'pending'
      AND run_type = 'action'
    ${lock ? sql`FOR UPDATE OF runs` : sql``}
  `;
	return run ?? null;
}

/**
 * A held run is released only under the contract it was created against.
 * Compare with the artifact of the run's own pinned version (the org's active
 * definition can move ahead of a pinned device), then check the original
 * execution pin against the run's recorded hash.
 */
export async function heldRunContractError(
	sql: DbClient,
	organizationId: string,
	run: HeldOperationRun,
	resolved: NonNullable<Awaited<ReturnType<typeof getOperationForConnection>>>,
): Promise<string | null> {
	if (run.connector_artifact_hash == null && resolved.connection.connector_manifest_hash == null) return null;
	if (
		run.connector_artifact_hash == null ||
		run.connector_version == null ||
		run.connector_artifact_hash !== run.pinned_artifact_hash ||
		run.connector_key !== resolved.connection.connector_key
	) {
		return "The connector contract changed since this run was queued. Re-run the operation.";
	}
	return deviceManifestAdmissionError(
		sql, organizationId, run.connection_id, run.connector_key,
		run.connector_version, run.target_device_worker_id,
		{ manifestBacked: true, manifestHash: run.connector_artifact_hash },
	);
}
