import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadMigrationDownSection, loadMigrationUpSection } from '../../../db/migration-loader';
import { qualifiedOperationKey } from '../../../tools/admin/manage_operations/handlers/shared';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestOrganization } from '../../setup/test-fixtures';

const directory = fileURLToPath(new URL('../../../../../../db/migrations/', import.meta.url));
const file = '20261002230000_connector_exact_policy_target.sql';
const up = loadMigrationUpSection(directory, file);
const down = loadMigrationDownSection(directory, file);
const precondition = readFileSync(`${directory}preconditions/${file}`, 'utf8');
const sql = getTestDb();
let organizationId: string;

async function insert(operation: string, connector: string | null = null) {
  const [row] = await sql`INSERT INTO write_approval_policies
    (organization_id, resource_class, operation_key, connector_key, approval_channel_id)
    VALUES (${organizationId}, 'connector_action', ${operation}, ${connector}, 'synthetic-review-channel')
    RETURNING id`;
  await sql`INSERT INTO write_policy_action_effects (policy_id, action, effect)
    VALUES (${row.id}, 'execute', 'deny')`;
  return row.id;
}

describe('exact connector policy target migration', () => {
  beforeEach(async () => {
    await sql.unsafe(down);
    organizationId = (await createTestOrganization()).id;
  });
  afterEach(async () => {
    await cleanupTestDatabase();
    await sql.begin(tx => tx.unsafe(up));
  });

  it('preserves decisions, delivery and row identity while binding exact actions to their connector', async () => {
    const key = qualifiedOperationKey('synthetic.connector', 'action.with.dots::suffix');
    const id = await insert(key);
    await sql.unsafe(precondition);
    await sql.begin(tx => tx.unsafe(up));
    const [policy] = await sql`SELECT p.id, p.connector_key, p.operation_key, p.approval_channel_id, e.effect
      FROM write_approval_policies p JOIN write_policy_action_effects e ON e.policy_id = p.id WHERE p.id = ${id}`;
    expect(policy).toMatchObject({ id, connector_key: 'synthetic.connector', operation_key: key,
      approval_channel_id: 'synthetic-review-channel', effect: 'deny' });
    await expect(insert(qualifiedOperationKey('another.connector', 'send'))).rejects.toMatchObject({ code: '23514' });
    await sql.unsafe(down);
    await sql.begin(tx => tx.unsafe(up));
    expect((await sql`SELECT id FROM write_approval_policies WHERE id = ${id}`)).toHaveLength(1);
  });

  it('rolls back collisions instead of choosing between existing rules', async () => {
    const key = qualifiedOperationKey('synthetic.connector', 'send');
    const legacy = await insert(key);
    const explicit = await insert(key, 'synthetic.connector');
    await expect(sql.unsafe(precondition)).rejects.toMatchObject({ code: 'P0001' });
    await expect(sql.begin(tx => tx.unsafe(up))).rejects.toMatchObject({ code: '23505' });
    expect(await sql`SELECT id, connector_key FROM write_approval_policies
      WHERE organization_id = ${organizationId} AND operation_key = ${key} ORDER BY id`)
      .toEqual([{ id: legacy, connector_key: null }, { id: explicit, connector_key: 'synthetic.connector' }]);
  });

  it('refuses unqualified legacy keys without changing them', async () => {
    const id = await insert('unqualified-action');
    await expect(sql.unsafe(precondition)).rejects.toMatchObject({ code: 'P0001' });
    await expect(sql.begin(tx => tx.unsafe(up))).rejects.toMatchObject({ code: 'P0001' });
    expect((await sql`SELECT connector_key FROM write_approval_policies WHERE id = ${id}`)[0].connector_key).toBeNull();
  });
});
