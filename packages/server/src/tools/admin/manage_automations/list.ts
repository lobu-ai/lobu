/**
 * list action handler for manage_automations.
 */

import {
	ListAutomationsResultSchema,
	type ListAutomationsArgs,
	type ListAutomationsResult,
} from "@lobu/core/contracts/tools/manage-automations";
import { getDb } from "../../../db/client";
import type { Env } from "../../../index";
import { ToolUserError } from "../../../utils/errors";
import logger from "../../../utils/logger";
import {
	buildAutomationUrl,
	getOrganizationSlug,
	getPublicWebUrl,
} from "../../../utils/url-builder";
import { buildLatestAutomationRunJoinSql } from "../../../automations/automation";
import { computeAutomationHealth } from "../../../automations/automation-health";
import { loadRecentAutomationRunStatuses } from "../../../automations/automation-health-history";
import type { ToolContext } from "../../registry";
import { batchCountUnanalyzedContent } from "./shared";

export { ListAutomationsResultSchema };

// ============================================
// handleList
// ============================================

export async function handleList(
	args: ListAutomationsArgs,
	_env: Env,
	ctx: ToolContext
): Promise<ListAutomationsResult> {
	const sql = getDb();

	if (args.entity_id) {
		const entityCheck = await sql`
			SELECT id
			FROM entities
			WHERE id = ${args.entity_id}
			  AND organization_id = ${ctx.organizationId}
		`;
		if (entityCheck.length === 0) {
			throw new ToolUserError(`Entity with ID ${args.entity_id} not found`, 404);
		}
	}

	let query = `
    SELECT
      i.id as automation_id,
      i.name,
      i.slug,
      i.status,
      i.version,
      i.created_at,
      i.updated_at,
      i.triggers,
      i.next_run_at,
      i.consecutive_scheduled_failures,
      i.schedule_auto_paused_at,
      i.last_event_activation_at AS health_last_event_activation_at,
      i.managed_agent_id,
      i.device_worker_id,
      i.last_fired_at,
      -- Materialized completion stamp of the most recent completed run,
      -- written by a trigger on runs. last_fired_at is NOT a substitute: only
      -- the worker-api terminal-report path stamps it, so runs that finish
      -- through any other terminal writer leave it NULL or stale and the
      -- listing renders "Never run" for an Automation that ran minutes ago.
      i.last_run_completed_at,
      i.model_config,
      i.execution_config,
      i.sources,
      -- With fetch_types:false (see db/client.ts) postgres.js does not parse
      -- arrays, so text[] arrives as the literal "{a,b}"; wrap in to_jsonb so
      -- clients get a real JSON array.
      to_jsonb(i.tags) AS tags,
      i.delivery_target,
      i.min_cooldown_seconds,
      i.agent_kind,
      i.automation_group_id::text AS automation_group_id,
      i.source_automation_id::text AS source_automation_id,
      wr.id as run_id,
      wr.status as automation_run_status,
      wr.outcome as automation_run_outcome,
      wr.error_message as automation_run_error,
      wr.created_at as automation_run_created_at,
      wr.completed_at as automation_run_completed_at,
      e.id as entity_id,
      et.slug AS entity_type,
      e.name as entity_name,
      e.slug as entity_slug,
      -- The Automation's OWN org, not the entity's. The entities join is a LEFT
      -- JOIN, so an org-scoped Automation (empty entity_ids — the common shape)
      -- yielded NULL here, which stranded the slug lookup below and dropped
      -- both organization_slug and view_url from every such row.
      -- automations.organization_id is NOT NULL, so this always resolves.
      i.organization_id,
      parent.id as parent_id,
      parent.name as parent_name,
      parent.slug as parent_slug,
      pet.slug as parent_entity_type,
      i.current_version_id,
      (SELECT COUNT(*) FROM runs r WHERE r.automation_id = i.id AND r.run_type = 'automation' AND r.status = 'completed') as windows_count,
      (SELECT COUNT(DISTINCT r.run_metadata->>'client_id') FROM runs r WHERE r.automation_id = i.id AND r.run_type = 'automation' AND r.status = 'completed' AND r.run_metadata->>'client_id' IS NOT NULL) as processing_client_count
  `;

	if (args.include_details) {
		query += `,
      cv.description,
      cv.prompt,
      cv.skills,
      cv.outputs,
      cv.reactions_guidance
    `;
	}

	query += `
    FROM automations i
    LEFT JOIN entities e ON e.id = ANY(i.entity_ids)
    LEFT JOIN entity_types et ON et.id = e.entity_type_id
    LEFT JOIN entities parent ON e.parent_id = parent.id
    LEFT JOIN entity_types pet ON pet.id = parent.entity_type_id
    LEFT JOIN automation_versions cv ON i.current_version_id = cv.id
    ${buildLatestAutomationRunJoinSql("i", "wr")}
  `;

	const conditions: string[] = [];
	const params: any[] = [];
	let paramCount = 1;

	conditions.push(`i.organization_id = $${paramCount}::text`);
	params.push(ctx.organizationId);
	paramCount++;

	if (args.entity_id) {
		conditions.push(`$${paramCount} = ANY(i.entity_ids)`);
		params.push(args.entity_id);
		paramCount++;
	}

	if (args.automation_id) {
		conditions.push(`i.id = $${paramCount}`);
		params.push(args.automation_id);
		paramCount++;
	}

	if (args.managed_agent_id) {
		conditions.push(`i.managed_agent_id = $${paramCount}`);
		params.push(args.managed_agent_id);
		paramCount++;
	}

	if (args.status) {
		conditions.push(`i.status = $${paramCount}`);
		params.push(args.status);
		paramCount++;
	} else {
		// Default to active automations only (exclude archived)
		conditions.push(`i.status = 'active'`);
	}

	// Discovery filter for executors: match the LATEST run per Automation (the
	// lateral join prioritizes active runs), e.g. pending manual-open runs.
	if (args.run_status) {
		conditions.push(`wr.status = $${paramCount}`);
		params.push(args.run_status);
		paramCount++;
	}

	query += ` WHERE ${conditions.join(" AND ")}`;

	const orderDir = args.order_dir === "asc" ? "ASC" : "DESC";
	if (args.order_by === "last_fired_at") {
		query += ` ORDER BY i.last_fired_at ${orderDir} NULLS LAST, i.updated_at ${orderDir}`;
	} else {
		query += ` ORDER BY i.created_at ${orderDir}`;
	}

	if (args.limit != null && args.limit > 0) {
		query += ` LIMIT $${paramCount}`;
		params.push(args.limit);
		paramCount++;
	}

	const result = await sql.unsafe(query, params);

	const baseUrl = getPublicWebUrl(ctx.requestUrl, ctx.baseUrl);
	const automationIds = (result as any[]).map((i) => Number(i.automation_id));
	const recentRunStatuses = await loadRecentAutomationRunStatuses(sql, automationIds);

	let counts: Map<number, { pending: number; historical: number }>;
	try {
		counts = await batchCountUnanalyzedContent(automationIds);
	} catch (error) {
		logger.error(
			{ error },
			"[manage_automations] Error batch counting unanalyzed content"
		);
		counts = new Map();
	}

	const uniqueOrgIds = [
		...new Set(
			(result as any[]).map((r) => r.organization_id as string).filter(Boolean)
		),
	];
	const orgSlugMap = new Map<string, string>();
	for (const orgId of uniqueOrgIds) {
		const slug = await getOrganizationSlug(orgId);
		if (slug) orgSlugMap.set(orgId, slug);
	}

	const automationsWithPendingCount = (result as any[]).map((automation) => {
		const automationId = Number(automation.automation_id);
		const countData = counts.get(automationId) || { pending: 0, historical: 0 };
		const orgSlug = orgSlugMap.get(automation.organization_id as string) ?? null;

		// Workspace-level route: agentless (device-pinned / manual-only)
		// Automations carry a view_url just like agent-owned ones.
		const viewUrl = orgSlug
			? buildAutomationUrl(orgSlug, automationId, baseUrl)
			: undefined;

		const {
			organization_id: _orgId,
			health_last_event_activation_at: lastEventActivationAt,
			...rest
		} = automation;

		if (!args.include_details) {
			delete (rest as Record<string, unknown>).prompt;
			delete (rest as Record<string, unknown>).skills;
			delete (rest as Record<string, unknown>).description;
		}

		// Stringify `automation_id` to match the rest of the manage_automations
		// contract: `handleCreate` returns `String(automationId)`, the input schema
		// declares `automation_id` as a string, and downstream callers (CLI
		// `apply-cmd.ts` → `updateAutomation`, MCP tools) forward whatever they
		// receive straight back. Without the cast the raw integer leaks through
		// and a follow-up `update`/`upgrade` call fails the schema gate with
		// `/automation_id: Expected string`. Same bug pattern for `current_version_id`
		// (kept as-is — no consumer feeds it back into manage_automations today).
		if ((rest as Record<string, unknown>).automation_id != null) {
			(rest as Record<string, unknown>).automation_id = String(
				(rest as Record<string, unknown>).automation_id
			);
		}

		const automationHealth = computeAutomationHealth({
			status: automation.status,
			externalExecutor: automation.execution_config?.executor?.kind === 'external',
			nextRunAt: automation.next_run_at,
			consecutiveScheduledFailures:
				automation.consecutive_scheduled_failures,
			scheduleAutoPausedAt: automation.schedule_auto_paused_at,
			latestRunStatus: automation.automation_run_status,
			latestRunCreatedAt: automation.automation_run_created_at,
			latestRunError: (rest as Record<string, unknown>).automation_run_error as
				| string
				| null
				| undefined,
			latestRunOutcome: automation.automation_run_outcome,
			triggers: automation.triggers,
			lastEventActivationAt,
			recentTerminalRunStatuses: recentRunStatuses.get(automationId) ?? [],
		});

		return {
			...rest,
			organization_slug: orgSlug,
			pending_content_count: countData.pending,
			historical_content_count: countData.historical,
			view_url: viewUrl,
			health: automationHealth.health,
			...(automationHealth.reasons.length > 0 && {
				health_reasons: automationHealth.reasons,
			}),
			last_scheduling_error: automationHealth.last_scheduling_error,
			last_run_outcome: automationHealth.last_run_outcome,
		};
	});

	return { action: "list", automations: automationsWithPendingCount };
}
