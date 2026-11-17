import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveConnectorPolicy, upsertEntityApprovalPolicy } from '../../../authz/entity-policy';
import { qualifiedOperationKey } from '../../../tools/admin/manage_operations/handlers/shared';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestOrganization } from '../../setup/test-fixtures';

const migration = readFileSync(
  new URL('../../../../../../db/migrations/20261117170000_personal_org_connector_auto_policy_backfill.sql', import.meta.url),
  'utf8'
).split('-- migrate:down')[0]!;

const actor = { kind: 'agent', id: 'backfill-agent', ownerAgentId: null, ownerResolved: true } as const;

/** Every org starts with the pre-20261015 seed: the trigger gives a marker-less org "Reads: Auto". */
async function orgWithReadSeed(metadata: string | null) {
  const sql = getTestDb();
  const org = await createTestOrganization();
  await sql`UPDATE organization SET metadata = ${metadata} WHERE id = ${org.id}`;
  await createTestAgent({ organizationId: org.id, agentId: actor.id });
  return org.id;
}

const personal = (ownerId: string) => JSON.stringify({ personal_org_for_user_id: ownerId });

async function connectorRules(organizationId: string) {
  const sql = getTestDb();
  return sql`
    SELECT p.operation_category, p.operation_key, p.note, p.updated_at,
           string_agg(e.action || '=' || e.effect, ',' ORDER BY e.action) AS effects
    FROM write_approval_policies p
    JOIN write_policy_action_effects e ON e.policy_id = p.id
    WHERE p.organization_id = ${organizationId} AND p.resource_class = 'connector_action'
    GROUP BY p.id ORDER BY p.id
  `;
}

/** A write matches no read seed, so it runs by default; the backfilled rule matches it. */
const writeDecision = async (organizationId: string) => {
  const { effect, reason } = await resolveConnectorPolicy({
    organizationId,
    connectionId: null,
    operation: { connector_key: 'demo.browser', operation_key: 'navigate', kind: 'write' },
    actor,
  });
  return { effect, reason };
};

describe('personal org connector auto policy backfill', () => {
  beforeEach(cleanupTestDatabase);

  it('moves only untouched personal-org read seeds to All actions: Auto, idempotently', async () => {
    const sql = getTestDb();
    const untouched = await orgWithReadSeed(personal('user-untouched'));
    const team = await orgWithReadSeed(JSON.stringify({ plan: 'team' }));
    const emptyOwner = await orgWithReadSeed(personal(''));
    const malformed = await orgWithReadSeed('{not json');

    const extraRule = await orgWithReadSeed(personal('user-extra-rule'));
    await upsertEntityApprovalPolicy(extraRule, {
      resourceClass: 'connector_action',
      operationKey: qualifiedOperationKey('demo.browser', 'screenshot'),
      effects: { execute: 'approval' },
    });

    const edited = await orgWithReadSeed(personal('user-edited'));
    await sql`
      UPDATE write_approval_policies SET updated_at = created_at + interval '1 hour'
      WHERE organization_id = ${edited} AND resource_class = 'connector_action'
    `;

    const askReads = await orgWithReadSeed(personal('user-ask-reads'));
    await sql`
      UPDATE write_policy_action_effects SET effect = 'approval'
      WHERE policy_id IN (SELECT id FROM write_approval_policies
        WHERE organization_id = ${askReads} AND resource_class = 'connector_action')
    `;

    const noted = await orgWithReadSeed(personal('user-noted'));
    await sql`
      UPDATE write_approval_policies SET note = 'Reads only on purpose', updated_at = created_at
      WHERE organization_id = ${noted} AND resource_class = 'connector_action'
    `;

    const keptOrgs = [team, emptyOwner, malformed, extraRule, edited, askReads, noted];
    const before = new Map<string, unknown>();
    for (const org of keptOrgs) before.set(org, await connectorRules(org));
    expect(await writeDecision(untouched)).toEqual({ effect: 'auto', reason: 'default_auto' });

    await sql.unsafe(migration);

    const [rule] = await connectorRules(untouched);
    expect(rule).toMatchObject({ operation_category: null, operation_key: null, note: null, effects: 'execute=auto' });
    expect(await connectorRules(untouched)).toHaveLength(1);
    expect(await writeDecision(untouched)).toEqual({ effect: 'auto', reason: 'matched_rule' });
    for (const org of keptOrgs) expect(await connectorRules(org)).toEqual(before.get(org));
    expect(await writeDecision(team)).toEqual({ effect: 'auto', reason: 'default_auto' });
    expect(await writeDecision(extraRule)).toEqual({ effect: 'auto', reason: 'default_auto' });

    const afterFirst = await connectorRules(untouched);
    await sql.unsafe(migration);
    expect(await connectorRules(untouched)).toEqual(afterFirst);
  });
});
