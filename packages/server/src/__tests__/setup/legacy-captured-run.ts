import type { DbClient } from '../../db/client';

/** Seed the stored shape from the retired eval feature to test rollout safety. */
export async function createLegacyCapturedRun(sourceRunId: number, sql: DbClient) {
  const [row] = await sql<{ id: number }>`
    INSERT INTO runs (
      organization_id, run_type, automation_id, approval_status, status, approved_input
    )
    SELECT organization_id, 'automation_eval', automation_id, 'auto', 'pending', approved_input
    FROM runs WHERE id = ${sourceRunId} AND run_type = 'automation'
    RETURNING id
  `;
  if (!row) throw new Error('Missing legacy capture source fixture');
  return { runId: Number(row.id) };
}
