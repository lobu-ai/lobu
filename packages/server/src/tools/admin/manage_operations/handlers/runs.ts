import { deepRedactSecrets } from "@lobu/core";
import {
	GetRunAction,
	LIST_RUNS_DEFAULT_EXCLUDED_RUN_TYPES,
	ListActivityAction,
	ListRunsAction,
	type ManageOperationsResult,
} from "../schemas";
import type { Static } from "@sinclair/typebox";
import {
	getDb,
	pgBigintArray,
	pgTextArray,
} from "../../../../db/client";
import { ToolUserError } from "../../../../utils/errors";
import type { ToolContext } from "../../../registry";
import { listOrgActivity } from "../activity-feed";
import { ENTITY_CHANGE_ACTION_KEYS } from "../../entity-field-approval";
export async function handleListActivity(
	args: Static<typeof ListActivityAction>,
	ctx: ToolContext,
): Promise<ManageOperationsResult> {
	const sql = getDb();
	const orgRows = (await sql`
    SELECT slug FROM organization WHERE id = ${ctx.organizationId} LIMIT 1
  `) as unknown as Array<{ slug: string }>;
	const ownerSlug = orgRows[0]?.slug ?? ctx.organizationId;
	const result = await listOrgActivity({
		organizationId: ctx.organizationId,
		userId: ctx.userId,
		ownerSlug,
		limit: args.limit,
		includeNotifications: args.include_notifications,
		includeRuns: args.include_runs,
		aggregate: args.aggregate,
		kinds: args.kinds,
		agentId: args.agent_id,
	});
	return {
		action: "list_activity",
		items: result.items,
		total: result.total,
		limit: result.limit,
	};
}

function publicAutomationFields(value: unknown): unknown {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value)
	) {
		return value;
	}
	const {
		automation_id: automationId,
		...publicRef
	} = value as Record<string, unknown>;
	return automationId == null
		? publicRef
		: { ...publicRef, automation_id: automationId };
}

function publicRunRecord(
	row: Record<string, unknown>,
): Record<string, unknown> {
	const publicRecord: Record<string, unknown> = {
		...row,
		input:
			row.run_type === "internal" &&
			ENTITY_CHANGE_ACTION_KEYS.some(
				(actionKey) => actionKey === row.operation_key,
			)
				? publicAutomationFields(row.input)
				: row.input,
		initiator_ref:
			row.initiator_kind === "automation"
				? publicAutomationFields(row.initiator_ref)
				: row.initiator_ref,
	};
	const { created_at, completed_at, ...redactable } = publicRecord;
	return {
		...(deepRedactSecrets(redactable) as Record<string, unknown>),
		created_at,
		completed_at,
	};
}

/**
 * The device a run is attributed to — the ONE definition shared by list_runs'
 * projection, its `device_worker_id` filter, and get_run (#3213).
 *
 * Immutable, write-time attribution only: `target_device_worker_id` is stamped
 * at creation, `executed_by_device_worker_id` atomically at claim. Never fall
 * back to `connections.device_worker_id` — that is the connection's CURRENT,
 * mutable pin, so reading it here retroactively rewrote which device
 * already-completed runs reported, and let a re-pin sweep historical runs
 * onto the new device. Gateway-inline runs execute in the server process and
 * are never device-attributed.
 *
 * A run with BOTH columns NULL is therefore unattributed — it is not listable
 * under any device. That is deliberate: rows predating the 20260903120000
 * migration (which adds the columns without a backfill), plus the occasional
 * sync created while its connection carried no pin, have no write-time record
 * of where they ran, so the only available answer is the mutable pin — #3213's
 * defect itself. Reporting "unknown" beats reporting a guess that a later
 * re-pin silently rewrites. `target_device_worker_id` and
 * `executed_by_device_worker_id` stay projected so a caller can tell the
 * difference between unattributed and attributed-elsewhere.
 */
function runDeviceAttribution(sql: ReturnType<typeof getDb>) {
  return sql`
    CASE
      WHEN r.claimed_by LIKE 'gateway-inline-%' THEN NULL
      ELSE COALESCE(r.executed_by_device_worker_id, r.target_device_worker_id)
    END`;
}

export async function handleListRuns(
	args: Static<typeof ListRunsAction>,
	ctx: ToolContext,
): Promise<ManageOperationsResult> {
  const limit = args.limit ?? 20;
  if ((args.before_id == null) !== (args.before_created_at == null)) {
    throw new ToolUserError(
      "before_id and before_created_at must be provided together",
      400,
    );
  }
  // Keyset pagination short-circuits offset whenever a cursor is supplied.
  const hasCursor = args.before_id != null && args.before_created_at != null;
  const offset = hasCursor ? 0 : (args.offset ?? 0);

  // Date-range bounds are validated up front so a bad value is a clean caller
  // error instead of a mid-query Postgres cast failure.
  for (const field of [
    "created_after",
    "created_before",
    "before_created_at",
  ] as const) {
    const value = args[field];
    if (value != null && Number.isNaN(Date.parse(value))) {
      throw new ToolUserError(
        `${field} must be an ISO 8601 timestamp (got '${value}')`,
        400,
      );
    }
  }

  const sql = getDb();

  // Shared WHERE fragment so the count and page queries can't drift apart.
  let where = sql`r.organization_id = ${ctx.organizationId}`;
  if (args.run_types && args.run_types.length > 0) {
    // fetch_types:false means JS arrays aren't auto-serialized — use the
    // PG array-literal helpers (see db/client.ts).
    where = sql`${where} AND r.run_type = ANY(${pgTextArray(args.run_types)}::text[])`;
  } else {
    // Default operational view: hide the chat-message transport lane (complete
    // replies + per-delta streaming fragments) that otherwise buries real run
    // history (#2051). Naming run_types explicitly opts back in.
    where = sql`${where} AND r.run_type <> ALL(${pgTextArray([...LIST_RUNS_DEFAULT_EXCLUDED_RUN_TYPES])}::text[])`;
  }
  // connection scope: scalar connection_id (REST/SDK) or an explicit id list.
  // Device scope is deliberately NOT a connection scope — see
  // runDeviceAttribution.
  if (args.connection_id != null) {
    where = sql`${where} AND r.connection_id = ${args.connection_id}`;
  }
  if (args.connection_ids && args.connection_ids.length > 0) {
    where = sql`${where} AND r.connection_id = ANY(${pgBigintArray(args.connection_ids)}::bigint[])`;
  }
  if (args.feed_ids && args.feed_ids.length > 0) {
    where = sql`${where} AND r.feed_id = ANY(${pgBigintArray(args.feed_ids)}::bigint[])`;
  }
  if (args.device_worker_id) {
    // Same expression as the projected `device_worker_id`, so the filter can
    // never again answer a different question than the field it filters on.
    where = sql`${where} AND ${runDeviceAttribution(sql)} = ${args.device_worker_id}::uuid`;
  }
  if (args.connector_key) {
    where = sql`${where} AND r.connector_key = ${args.connector_key}`;
  }
  if (args.operation_key) {
    where = sql`${where} AND r.action_key = ${args.operation_key}`;
  }
  if (args.status) {
    where = sql`${where} AND r.status = ${args.status}`;
  }
  if (args.created_after) {
    where = sql`${where} AND r.created_at >= ${args.created_after}::timestamptz`;
  }
  if (args.created_before) {
    where = sql`${where} AND r.created_at < ${args.created_before}::timestamptz`;
  }
  if (args.approval_status) {
    where = sql`${where} AND r.approval_status = ${args.approval_status}`;
  }
  if (args.automation_ids && args.automation_ids.length > 0) {
    where = sql`${where} AND r.automation_id = ANY(${pgBigintArray(args.automation_ids)}::bigint[])`;
  }

  const countQuery = sql`SELECT COUNT(*)::int AS total FROM runs r WHERE ${where}`;

  let pageWhere = where;
  if (hasCursor) {
    pageWhere = sql`${pageWhere} AND (r.created_at, r.id) < (${args.before_created_at}::timestamptz, ${args.before_id})`;
  }
  const query = sql`
    SELECT r.id, r.run_type, r.automation_id AS automation_id, r.parent_run_id, r.connection_id, r.feed_id, r.connector_key, r.connector_version,
           r.action_key AS operation_key, r.action_input AS input, r.action_output AS output,
           r.approval_status, r.status, r.error_message, r.items_collected, r.checkpoint,
           r.created_at, r.completed_at,
           r.initiator_kind, r.initiator_ref, r.created_by_user_id,
           f.feed_key, f.display_name AS feed_display_name,
           c.display_name AS connection_display_name,
           r.target_device_worker_id,
           r.executed_by_device_worker_id,
           ${runDeviceAttribution(sql)} AS device_worker_id
    FROM runs r
    LEFT JOIN feeds f ON f.id = r.feed_id
    LEFT JOIN connections c ON c.id = r.connection_id
    WHERE ${pageWhere}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${limit + 1} OFFSET ${offset}
  `;

  const [countResult, rows] = await Promise.all([countQuery, query]);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  return {
		action: "list_runs",
    runs: pageRows.map((row) => publicRunRecord(row)),
    total: Number(countResult[0]?.total ?? 0),
    limit,
    offset,
    has_more: hasMore,
  };
}

export async function handleGetRun(
	args: Static<typeof GetRunAction>,
	ctx: ToolContext,
): Promise<ManageOperationsResult> {
  const sql = getDb();
  // Include 'internal' runs (builder / entity-change approvals), not just
  // connector 'action' runs: list_runs surfaces them and approve/reject act on
  // them, so a caller that can list and approve an internal run must be able to
  // get_run it too. get_run must resolve ANY run_type that list_runs surfaces —
  // action, internal, automation, sync — not just action+internal. It uses the
  // SAME excluded-types set as the list_runs default so the two can never drift:
  // a run visible in the list is always fetchable here. Only the chat-message
  // transport lane (the list's default exclusion) stays unfetchable.
  const rows = await sql`
    SELECT r.id, r.automation_id AS automation_id, r.parent_run_id, r.connection_id, r.connector_key,
           r.action_key AS operation_key, r.action_input AS input, r.action_output AS output,
           r.approval_status, r.status, r.error_message, r.run_type,
           r.created_at, r.completed_at,
           r.initiator_kind, r.initiator_ref, r.created_by_user_id,
           -- How a device-executed Automation's local CLI ended, and the tail of
           -- what it printed. The worker has always written these four; nothing
           -- read them back, so a timed-out device Automation could only be
           -- diagnosed by querying the database directly. Single-row fetch only:
           -- output_tail is up to 2000 chars, too heavy for a list page.
           r.exit_reason, r.exit_code, r.exit_signal, r.output_tail,
           r.target_device_worker_id,
           r.executed_by_device_worker_id,
           ${runDeviceAttribution(sql)} AS device_worker_id,
           c.display_name AS connection_display_name
    FROM runs r
    LEFT JOIN connections c ON c.id = r.connection_id
    WHERE r.id = ${args.run_id}
      AND r.organization_id = ${ctx.organizationId}
      AND r.run_type <> ALL(${pgTextArray([...LIST_RUNS_DEFAULT_EXCLUDED_RUN_TYPES])}::text[])
    LIMIT 1
  `;
	if (rows.length === 0) return { error: "Run not found" };
	return {
		action: "get_run",
		run: publicRunRecord(rows[0] as Record<string, unknown>),
	};
}
