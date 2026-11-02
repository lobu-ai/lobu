import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type DbClient, getDb, pgTextArray } from '../../../db/client';
import { ToolUserError } from '../../../utils/errors';
import type { ManageAutomationsArgs } from '@lobu/core/contracts/tools/manage-automations';

export function automationAuditSnapshot(row: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!row) return null;
  const pick = (k: string) => (k in row ? row[k] : null);
  return {
    id: pick('id'),
    agent_kind: pick('agent_kind'),
    device_worker_id: pick('device_worker_id'),
    managed_agent_id: pick('managed_agent_id'),
    execution_config: pick('execution_config'),
    model_config: pick('model_config'),
    delivery_target: pick('delivery_target'),
    triggers: pick('triggers'),
    schedule: pick('schedule'),
    timezone: pick('timezone'),
    tags: pick('tags'),
    min_cooldown_seconds: pick('min_cooldown_seconds'),
    status: pick('status'),
    reaction_script: pick('reaction_script'),
    consecutive_scheduled_failures: pick('consecutive_scheduled_failures'),
    schedule_auto_paused_at: pick('schedule_auto_paused_at'),
    next_run_at: pick('next_run_at'),
  };
}

/** Configuration revisions ignore execution cursors and failure bookkeeping. */
function automationConfigVersion(row: Record<string, unknown>): string {
  const snapshot = automationAuditSnapshot(row)!;
  delete snapshot.next_run_at;
  delete snapshot.consecutive_scheduled_failures;
  delete snapshot.schedule_auto_paused_at;
  return createHash('sha256').update(JSON.stringify({
    ...snapshot, name: row.name, description: row.description, slug: row.slug,
    current_version_id: row.current_version_id, automation_group_id: row.automation_group_id,
    latest_version_id: row.latest_version_id ?? undefined,
  })).digest('hex');
}

function staleAutomationConfigError(): ToolUserError {
  return new ToolUserError('This Automation approval is stale because its configuration changed. Propose the change again.', 409);
}

export function assertAutomationConfigVersion(row: Record<string, unknown>, base: Record<string, string>): void {
  if (base[String(row.id)] !== automationConfigVersion(row)) throw staleAutomationConfigError();
}

/**
 * Compare the pinned revisions against the live rows. Runs once under the group
 * advisory lock before dispatch and again inside each handler's mutation
 * transaction after its FOR UPDATE on the target rows: a delete takes only its
 * row lock, so the row-lock recheck is what keeps an approved write off a row
 * archived between the two. Legacy proposals without pins fail closed.
 */
export async function assertAutomationConfigVersionsUnchanged(
  args: ManageAutomationsArgs, organizationId: string, base: Record<string, string> | undefined,
  sql: DbClient = getDb(),
): Promise<void> {
  if (!base) throw staleAutomationConfigError();
  const current = await readAutomationConfigVersions(args, organizationId, sql);
  if (!isDeepStrictEqual(base, current)) throw staleAutomationConfigError();
}

export async function readAutomationConfigVersions(
  args: ManageAutomationsArgs, organizationId: string, sql: DbClient = getDb(),
): Promise<Record<string, string>> {
  const targets = args.action === 'delete' ? args.automation_ids : (args.automation_id ? [args.automation_id] : []);
  const ids = (targets ?? []).map(id => String(Number(id)));
  if (!ids.length) return {};
  const groupShared = args.action === 'create_version' || args.action === 'set_reaction_script';
  const rows = await sql`
    SELECT a.*, CASE WHEN ${args.action === 'create_version'} THEN (
      SELECT id FROM automation_versions WHERE automation_id = a.automation_group_id
      ORDER BY version DESC LIMIT 1
    ) END AS latest_version_id
    FROM automations a
    WHERE a.organization_id = ${organizationId}
      AND (a.id::text = ANY(${pgTextArray(ids)}::text[]) OR (${groupShared} AND a.automation_group_id = (
        SELECT automation_group_id FROM automations WHERE id = ${Number(ids[0])} AND organization_id = ${organizationId}
      )))
    ORDER BY a.id
  `;
  return Object.fromEntries(rows.map(row => [String(row.id), automationConfigVersion(row)]));
}
