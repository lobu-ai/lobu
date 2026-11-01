import type { ManageAutomationsArgs } from '@lobu/core/contracts/tools/manage-automations';
import { getDb, type DbClient } from '../../../db/client';
import { assertExpectedRevision, configRevision } from '../../../utils/config-revision';
import { ToolUserError } from '../../../utils/errors';

const CONFIG_FIELDS = [
  'slug', 'name', 'description', 'status', 'entity_ids', 'managed_agent_id',
  'device_worker_id', 'agent_kind', 'delivery_target', 'min_cooldown_seconds',
  'model_config', 'execution_config', 'sources', 'triggers', 'schedule', 'timezone',
  'tags', 'reaction_script', 'current_version_id', 'automation_group_id', 'source_automation_id',
] as const;
const DEFINITION_FIELDS = ['name', 'description', 'prompt', 'skills', 'outputs', 'reactions_guidance', 'version_sources'] as const;

export function automationConfigRevision(
  configuration: Record<string, unknown>,
  definition: Record<string, unknown> | null,
): string {
  return configRevision('automation', `${configuration.organization_id}:${configuration.id}:${configuration.created_at}`, {
    configuration: Object.fromEntries(CONFIG_FIELDS.map((key) => [key, configuration[key] ?? null])),
    definition: Object.fromEntries(DEFINITION_FIELDS.map((key) => [key, definition?.[key] ?? null])),
  });
}

export async function readAutomationConfiguration(
  organizationId: string,
  automationId: string,
  sql: DbClient = getDb(),
) {
  const rows = await sql`
    SELECT to_jsonb(a) AS configuration, to_jsonb(v) AS definition
    FROM automations a LEFT JOIN automation_versions v ON v.id = a.current_version_id
    WHERE a.organization_id = ${organizationId} AND a.id = ${automationId}
  `;
  if (!rows[0]) return null;
  const { configuration, definition } = rows[0];
  return { configuration, definition, revision: automationConfigRevision(configuration, definition) };
}

/** Call while the target's existing group or row lock is held. */
export async function assertAutomationRevision(
  args: ManageAutomationsArgs,
  organizationId: string,
  sql: DbClient = getDb(),
): Promise<string> {
  if (!args.automation_id) throw new ToolUserError('automation_id is required', 400);
  const snapshot = await readAutomationConfiguration(organizationId, args.automation_id, sql);
  if (!snapshot) throw new ToolUserError(`Automation ${args.automation_id} not found`, 404);
  assertExpectedRevision(args.expected_revision, snapshot.revision);
  return snapshot.revision;
}
