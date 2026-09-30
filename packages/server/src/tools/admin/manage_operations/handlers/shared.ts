type InlineExecutionResult =
	| {
			status: "completed";
			output: Record<string, unknown>;
			metadata?: Record<string, unknown>;
	  }
	| { status: "failed" | "blocked"; error_message: string; output?: Record<string, unknown> }
	| { status: "pending_approval" };

type ConnectionRow = {
	id: number;
	connector_key: string;
	connector_version: string;
	status: string;
	auth_profile_id: number | null;
	app_auth_profile_id: number | null;
	display_name: string | null;
	config: Record<string, unknown> | null;
	device_worker_id: string | null;
	device_platform: string | null;
	connector_runtime: Record<string, unknown> | null;
	connector_artifact_source_path: string | null;
	name: string;
};

/** The write-gate scope key for one connector operation. */
export function qualifiedOperationKey(
	connectorKey: string,
	operationKey: string,
): string {
	return `${connectorKey}::${operationKey}`;
}

export type { ConnectionRow, InlineExecutionResult };
