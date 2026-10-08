import { getDb, pgBigintArray } from "../../db/client.js";
import { paginateSessionMessages } from "./session-message-page.js";
import { AUTOMATION_RUN_TYPES_PG } from "../../runs/run-types.js";

/**
 * Read the latest N durable automation runs for one automation, newest first, ready
 * to be stitched into a single read-only thread on the client. A transcript is
 * optional derived data: runs without one must still surface their approvals.
 */
export async function readAutomationRunThreads(args: {
	agentId: string;
	automationId: number;
	organizationId: string;
	limit: number;
}): Promise<{
	runs: Array<{
		runId: number;
		completedAt: string;
		status: string;
		task: string | null;
		pendingActionCount: number;
		messages: ReturnType<typeof paginateSessionMessages>["messages"];
		actions: Array<{
			type: "tool-approval";
			eventId: number;
			runId: number;
			action: string | null;
			proposal: Record<string, unknown> | null;
			current: Record<string, unknown> | null;
			fields: Record<string, unknown> | null;
			attribution: string | null;
			resourceKind: string | null;
			reason: string | null;
			status: string;
			reviewedByName: string | null;
		}>;
	}>;
}> {
	const { agentId, automationId, organizationId, limit } = args;
	const sql = getDb();
	const rows = await sql<{
		conversation_id: string | null;
		created_at: Date;
		snapshot_jsonl: string | null;
		run_id: number;
		status: string;
		prompt: string | null;
	}>`
		WITH selected_runs AS (
			SELECT r.*
			FROM runs r
			JOIN automations w
			  ON w.id = r.automation_id
			 AND w.organization_id = r.organization_id
			WHERE r.organization_id = ${organizationId}
			  AND r.automation_id = ${automationId}
			  AND w.managed_agent_id = ${agentId}
			  AND r.run_type = ANY(${AUTOMATION_RUN_TYPES_PG}::text[])
			ORDER BY COALESCE(r.completed_at, r.created_at) DESC, r.id DESC
			LIMIT ${limit}
		)
		SELECT snapshot.conversation_id,
		       COALESCE(snapshot.created_at, r.completed_at, r.created_at) AS created_at,
		       snapshot.snapshot_jsonl, r.id AS run_id, r.status,
		       -- run_metadata->>'prompt_rendered' only exists on historical runs
		       -- from the templating era; current runs read the version's
		       -- literal prompt.
		       COALESCE(r.run_metadata->>'prompt_rendered', version.prompt) AS prompt
		FROM selected_runs r
		LEFT JOIN LATERAL (
			SELECT transcript.conversation_id, transcript.created_at,
			       transcript.snapshot_jsonl
			FROM public.agent_transcript_snapshot transcript
			WHERE transcript.organization_id = ${organizationId}
			  AND transcript.agent_id = ${agentId}
			  -- NOT transcript.run_id = r.id. An Automation execution writes two run
			  -- rows: the scheduler's automation row (r, the one this thread is
			  -- built from) and the chat_message row the worker actually claims.
			  -- The worker knows only the run it claimed, so it posts the snapshot
			  -- against the dispatch run and run_id = r.id matched no snapshot in
			  -- production. The automation run id reaches the worker solely inside
			  -- the conversationId, so that is the join key: POST /api/v1/agents
			  -- builds it as agentId + _automation_<automationId> + _run_<runId> from a
			  -- server-VERIFIED automation_run intent, and rejects any other caller
			  -- that tries to construct the shape (automation-run-intent.ts). Equality
			  -- on (organization_id, agent_id, conversation_id) is the leading
			  -- prefix of agent_transcript_snapshot_latest, so this stays a seek.
			  AND transcript.conversation_id =
			      ${agentId} || '_automation_' || ${automationId}::text
			      || '_run_' || r.id::text
			  AND transcript.terminal_status = 'completed'
			ORDER BY transcript.created_at DESC
			LIMIT 1
		) snapshot ON true
		LEFT JOIN automation_versions version
		  ON version.id = (r.approved_input->>'version_id')::bigint
		ORDER BY COALESCE(r.completed_at, r.created_at) DESC, r.id DESC
	`;

	const runs = rows.map((row) => {
		const runId = Number(row.run_id);
		const messages = row.snapshot_jsonl
			? paginateSessionMessages(row.snapshot_jsonl, "", 200, {
					excludeVerbose: true,
					sessionIdFallback: row.conversation_id ?? `automation-run-${runId}`,
				}).messages
			: [];
		return {
			runId,
			completedAt: row.created_at.toISOString(),
			status: row.status,
			task: row.prompt,
			pendingActionCount: 0,
			messages,
			actions: [] as Array<{
				type: "tool-approval";
				eventId: number;
				runId: number;
				action: string | null;
				proposal: Record<string, unknown> | null;
				current: Record<string, unknown> | null;
				fields: Record<string, unknown> | null;
				attribution: string | null;
				resourceKind: string | null;
				reason: string | null;
				status: string;
				reviewedByName: string | null;
			}>,
		};
	});
	const runIds = runs.map((run) => run.runId);

	// Approval cards are durable events rather than transcript JSONL parts. Read
	// them separately, then attach each child to its causal parent run.
	const approvalRows = await sql<{
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
		parent_run_id: number;
		interaction_status: string;
		reviewed_by_name: string | null;
	}>`
		SELECT e.id AS event_id,
		       e.run_id,
		       e.metadata->>'action' AS action,
		       e.metadata->'proposal' AS proposal,
		       e.metadata->'current' AS current,
		       e.metadata->'fields' AS fields,
		       e.metadata->>'attribution' AS attribution,
		       e.metadata->>'resourceKind' AS resource_kind,
		       e.metadata->>'reason' AS reason,
		       e.metadata->>'tool' AS tool,
		       e.interaction_status,
		       e.metadata->>'reviewed_by_name' AS reviewed_by_name,
		       r.parent_run_id
		FROM current_event_records e
		JOIN runs r ON r.id = e.run_id
		JOIN automations w
		  ON w.id = r.automation_id
		 AND w.organization_id = r.organization_id
		WHERE e.organization_id = ${organizationId}
		  AND w.managed_agent_id = ${agentId}
		  AND r.automation_id = ${automationId}
		  AND e.interaction_type = 'approval'
		  AND r.parent_run_id = ANY(${pgBigintArray(runIds)}::bigint[])
		ORDER BY e.run_id
	`;
	const actions = approvalRows.map((row) => {
		const resourceKind =
			row.resource_kind ??
			(row.tool === "manage_automations"
				? "automation"
				: row.tool === "manage_agents"
					? "agent"
					: row.tool === "entity_field_change" || row.tool === "entity_change"
						? "entity"
						: null);
		const rawProposal = row.proposal ?? null;
		const proposal =
			resourceKind === "automation" &&
			rawProposal &&
			typeof rawProposal === "object" &&
			(rawProposal as { args?: unknown }).args &&
			typeof (rawProposal as { args: unknown }).args === "object"
				? (rawProposal as { args: Record<string, unknown> }).args
				: rawProposal;
		return {
			parentRunId: Number(row.parent_run_id),
			type: "tool-approval" as const,
			eventId: Number(row.event_id),
			runId: Number(row.run_id),
			action: row.action,
			proposal,
			current: row.current ?? null,
			fields: row.fields ?? null,
			attribution: row.attribution ?? null,
			resourceKind,
			reason: row.reason ?? null,
			status: row.interaction_status,
			reviewedByName: row.reviewed_by_name,
		};
	});

	const runById = new Map(runs.map((run) => [run.runId, run]));
	for (const { parentRunId, ...action } of actions) {
		const run = runById.get(parentRunId);
		if (!run) continue;
		run.actions.push(action);
		if (action.status === "pending") run.pendingActionCount += 1;
	}

	return { runs };
}
