/**
 * The one name for "this turn is executing an Automation", shared by the site
 * that stamps it and the sites that read it back off the signed worker token.
 *
 * An Automation run is dispatched with `intent.kind === "automation_run"`; the
 * enqueue path (routes/public/agent.ts) turns that into
 * `platformMetadata.source = "automation-run"`, which `buildWorkerTokenClaims`
 * lifts into the token as `WorkerTokenData.source`. `automation` is the internal
 * engine vocabulary for an Automation, so the wire value keeps its historical
 * spelling — nothing agent-facing reads it.
 *
 * What reading it back means: the turn's job text is the FROZEN instruction
 * set saved on the Automation version, not a human's message. That freeze is only
 * honest if the agent's live skill *library* stays out of the turn: the worker
 * receives the version's pinned skill snapshots instead. Persona, tools, MCP
 * and network stay live; they are the agent, not the job.
 *
 * Narrower than the SSE-routing notion of "headless": connector-repair,
 * scheduled-job and internal turns have no frozen Automation text behind them,
 * so suppressing their skills would only make them dumber. Ordinary chat is
 * excluded for the same reason even when an Automation is listening on the
 * conversation — a human is in that thread and the library is theirs.
 *
 * Why the worker's 5-minute session-context cache needs no isolation key: an
 * Automation run opens its own session (`thread: automation-<runId>`, `forceNew`,
 * see `automations/automation.ts`), and the deployment name hashes the
 * conversation id — so a run's worker process is never the process that also
 * serves that agent's chat. If a future dispatch path ever runs an Automation on
 * a shared conversation, that cache becomes the place this decision leaks.
 */

import type { DbClient } from "../db/client.js";
import { getDb } from "../db/client.js";
import {
	type AutomationSkillSnapshot,
	parseAutomationSkillSnapshots,
} from "../automations/skill-snapshots.js";
import { parseAutomationRunConversationId } from "./permissions/automation-run-intent.js";
import { AUTOMATION_RUN_TYPES_PG } from "../runs/run-types.js";

export const AUTOMATION_RUN_SOURCE = "automation-run";

export type AutomationRunSkillResolver = (args: {
	conversationId: string;
	organizationId: string | undefined;
	agentId: string | undefined;
}) => Promise<AutomationSkillSnapshot[]>;

/**
 * Resolve the exact version pinned on an Automation run. The org, agent, Automation,
 * and run correlations all come from signed worker-token claims; keep every one
 * in the query so a malformed token can never read another tenant's snapshots.
 *
 * Missing or malformed durable state fails closed. Returning an empty list for
 * a missing row would let a skills-only Automation execute without instructions.
 */
export async function resolveAutomationRunSkills(
	args: Parameters<AutomationRunSkillResolver>[0],
	db: DbClient = getDb(),
): Promise<AutomationSkillSnapshot[]> {
	return (await resolveAutomationRunContext(args, db)).skills;
}

/** The pinned instructions and completion requirement of the same durable run. */
export async function resolveAutomationRunContext(
	args: Parameters<AutomationRunSkillResolver>[0],
	db: DbClient = getDb(),
): Promise<{ skills: AutomationSkillSnapshot[]; requiresWindowCompletion: boolean }> {
	const intent = parseAutomationRunConversationId(args.conversationId);
	if (!intent || !args.organizationId || !args.agentId) {
		throw new Error("Automation run token is missing its pinned-skill scope");
	}

	const rows = await db`
		SELECT version.skills, automation_run.approved_input->>'trigger_execution' AS trigger_execution
		FROM runs automation_run
		JOIN automations automation
		  ON automation.id = automation_run.automation_id
		 AND automation.organization_id = automation_run.organization_id
		 AND automation.managed_agent_id = ${args.agentId}
		JOIN automation_versions version
		  ON version.id = COALESCE(
		       NULLIF(automation_run.approved_input->>'version_id', '')::bigint,
		       automation.current_version_id
		     )
		 AND version.automation_id = automation.automation_group_id
		WHERE automation_run.id = ${intent.runId}
		  AND automation_run.run_type = ANY(${AUTOMATION_RUN_TYPES_PG}::text[])
		  AND automation_run.automation_id = ${intent.automationId}
		  AND automation_run.organization_id = ${args.organizationId}
		LIMIT 1
	`;
	if (rows.length !== 1) {
		throw new Error("Automation run's pinned version was not found");
	}
	return {
		skills: parseAutomationSkillSnapshots(rows[0]?.skills),
		requiresWindowCompletion: rows[0]?.trigger_execution !== "turn",
	};
}

export function formatAutomationRunSkillInstructions(
	skills: readonly AutomationSkillSnapshot[],
): string {
	if (skills.length === 0) return "";
	return [
		"## Pinned Automation skills",
		"",
		"Read every skill below before performing this Automation's task. These files are frozen to this run's version; do not substitute similarly named skills.",
		"",
		...skills.map((skill) => `- \`${skill.name}\`: \`.skills/${skill.name}/SKILL.md\``),
	].join("\n");
}
