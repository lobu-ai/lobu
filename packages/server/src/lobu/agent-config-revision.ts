import type { DbClient } from '../db/client';
import { getDb } from '../db/client';
import { configRevision } from '../utils/config-revision';

/** The authored agent row, excluding usage timestamps and other bookkeeping. */
const AGENT_CONFIG_FIELDS = [
  'name', 'description', 'owner_platform', 'owner_user_id',
  'models', 'network_config', 'nix_config', 'soul_md', 'user_md', 'identity_md',
  'skills_config', 'verbose_logging', 'show_tool_calls', 'starters',
  'guardrails', 'guardrails_inline', 'sandbox_id',
] as const;

export function agentConfigRevision(row: Record<string, unknown>): string {
  // to_jsonb preserves PostgreSQL's full created_at precision. Agent IDs are
  // reusable slugs, so id alone would let a deleted/recreated row accept a draft.
  return configRevision('agent', `${row.organization_id}:${row.id}:${row.created_at}`,
    Object.fromEntries(AGENT_CONFIG_FIELDS.map((field) => [field, row[field] ?? null])));
}

export async function readAgentConfigurationRow(
  organizationId: string,
  agentId: string,
  transaction: DbClient = getDb(),
  lock = false,
): Promise<Record<string, any> | null> {
  const rows = await transaction`
    SELECT to_jsonb(a) AS configuration FROM agents a
    WHERE a.organization_id = ${organizationId} AND a.id = ${agentId}
    ${lock ? transaction`FOR UPDATE OF a` : transaction``}
  `;
  return rows[0]?.configuration ?? null;
}
