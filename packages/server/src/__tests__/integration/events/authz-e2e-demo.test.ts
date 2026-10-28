/**
 * END-TO-END DEMO (real Postgres, real tool handler).
 *
 * Boots an embedded Postgres, seeds one org with two members (Alice, Bob) who
 * each own a PRIVATE connection plus a shared ORG connection, then drives the
 * REAL `query_sql` MCP tool handler — the exact path an agent's `query_sql`
 * call hits — as three principals: Alice, Bob, and a headless service caller.
 *
 * It prints a transcript so you can SEE the guarantee, and asserts it so it
 * can't rot: connection-sourced data never reaches a user beyond what that user
 * can access in the source system. The same holds for the `connections` rows
 * themselves (a private connection's display_name/account/config must not leak)
 * and for `feeds`, which inherit their connection's visibility. Run with:
 *
 *   cd packages/server && npx vitest run src/__tests__/integration/events/authz-e2e-demo.test.ts
 */

import { describe, expect, it } from 'vitest';
import { querySql } from '../../../tools/admin/query_sql';
import type { ToolContext } from '../../../tools/registry';
import { validateAndScopeQuery } from '../../../utils/execute-data-sources';
import {
  createTestConnection,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

/** An authenticated org member (Alice/Bob). */
function memberCtx(organizationId: string, userId: string): ToolContext {
  return {
    organizationId,
    userId,
    memberRole: 'member',
    agentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ['read'],
    tokenType: 'session',
    scopedToOrg: true,
    allowCrossOrg: false,
  };
}

/** A headless / service caller — no requesting user (automation, scheduled job). */
function headlessCtx(organizationId: string): ToolContext {
  return {
    organizationId,
    userId: null,
    memberRole: null,
    agentId: null,
    isAuthenticated: false,
    clientId: null,
    scopes: null,
    tokenType: 'anonymous',
    scopedToOrg: true,
    allowCrossOrg: false,
  };
}

const QUERY = 'SELECT payload_text FROM events ORDER BY occurred_at';

async function payloadsSeenBy(ctx: ToolContext): Promise<string[]> {
  const res = await querySql({ sql: QUERY }, undefined, ctx);
  if (res.error) throw new Error(`query_sql failed: ${res.error}`);
  return res.rows.map((r) => String(r.payload_text)).sort();
}

/** Connection ids reachable through `connections` rows and through `feeds`. */
async function connectionIdsSeenBy(ctx: ToolContext): Promise<{ connections: number[]; feeds: number[] }> {
  const ids = async (sql: string, column: string) => {
    const res = await querySql({ sql }, undefined, ctx);
    if (res.error) throw new Error(`query_sql failed: ${res.error}`);
    return res.rows.map((r) => Number(r[column]));
  };
  return {
    connections: await ids('SELECT id FROM connections', 'id'),
    // Each test connection auto-creates a default feed.
    feeds: await ids('SELECT connection_id FROM feeds', 'connection_id'),
  };
}

describe('END-TO-END: per-user connection visibility through the real query_sql handler', () => {
  it('Alice, Bob, and a headless caller each see only what they may', async () => {
    // ---- seed: one org, two members, three connections, three events --------
    const org = await createTestOrganization({ name: 'Acme' });
    const alice = await createTestUser();
    const bob = await createTestUser();

    const alicePrivate = await createTestConnection({
      organization_id: org.id,
      connector_key: 'slack',
      created_by: alice.id,
      visibility: 'private',
      display_name: "Alice's personal Slack",
    });
    const bobPrivate = await createTestConnection({
      organization_id: org.id,
      connector_key: 'slack',
      created_by: bob.id,
      visibility: 'private',
      display_name: "Bob's personal Slack",
    });
    const orgShared = await createTestConnection({
      organization_id: org.id,
      connector_key: 'slack',
      visibility: 'org',
      display_name: 'Company Slack',
    });

    const ALICE_SECRET = "Alice DM: my comp is $250k — don't share";
    const BOB_SECRET = 'Bob DM: interviewing at a competitor next week';
    const ORG_SHARED = 'Eng all-hands: ship the authz milestone Friday';

    await createTestEvent({
      organization_id: org.id,
      connection_id: alicePrivate.id,
      content: ALICE_SECRET,
      connector_key: 'slack',
    });
    await createTestEvent({
      organization_id: org.id,
      connection_id: bobPrivate.id,
      content: BOB_SECRET,
      connector_key: 'slack',
    });
    await createTestEvent({
      organization_id: org.id,
      connection_id: orgShared.id,
      content: ORG_SHARED,
      connector_key: 'slack',
    });

    // ---- show the predicate the seam injects below the tool -----------------
    const scoped = validateAndScopeQuery(QUERY, org.id, { userId: alice.id });
    const cteHead = scoped.sql.slice(0, scoped.sql.indexOf(')\n') + 1) || scoped.sql.slice(0, 600);

    // ---- run the REAL handler as each principal -----------------------------
    const aliceSees = await payloadsSeenBy(memberCtx(org.id, alice.id));
    const bobSees = await payloadsSeenBy(memberCtx(org.id, bob.id));
    const headlessSees = await payloadsSeenBy(headlessCtx(org.id));

    // ---- transcript ---------------------------------------------------------
    /* eslint-disable no-console */
    console.log('\n========== AUTHZ END-TO-END DEMO ==========');
    console.log('Org "Acme" — agent runs `query_sql`: %s\n', QUERY);
    console.log('The seam injects this org+user-scoped CTE below the tool (excerpt):');
    console.log(
      cteHead
        .split('\n')
        .map((l) => '   ' + l)
        .join('\n')
    );
    console.log('   ...  (params bound: org=%s, principal=<user id>)\n', org.id);
    const row = (who: string, seen: string[]) =>
      console.log(
        '  %s sees %d row(s):\n%s',
        who.padEnd(22),
        seen.length,
        seen.map((s) => `      • ${s}`).join('\n')
      );
    row('Alice (owns private)', aliceSees);
    row('Bob (owns private)', bobSees);
    row('Headless / service', headlessSees);
    console.log('\n  ⇒ Alice never sees Bob\'s DM; Bob never sees Alice\'s; headless sees neither.');
    console.log('==========================================\n');
    /* eslint-enable no-console */

    // ---- assertions: the guarantee holds ------------------------------------
    expect(aliceSees).toContain(ALICE_SECRET);
    expect(aliceSees).toContain(ORG_SHARED);
    expect(aliceSees).not.toContain(BOB_SECRET);

    expect(bobSees).toContain(BOB_SECRET);
    expect(bobSees).toContain(ORG_SHARED);
    expect(bobSees).not.toContain(ALICE_SECRET);

    // Headless / service: org-visible only, private data fails closed.
    expect(headlessSees).toEqual([ORG_SHARED]);

    // The connections and feeds rows follow the same per-user rule.
    const expectIds = (seen: number[], visible: number[], hidden: number[]) => {
      for (const id of visible) expect(seen).toContain(id);
      for (const id of hidden) expect(seen).not.toContain(id);
    };
    const aliceRows = await connectionIdsSeenBy(memberCtx(org.id, alice.id));
    const bobRows = await connectionIdsSeenBy(memberCtx(org.id, bob.id));
    const headlessRows = await connectionIdsSeenBy(headlessCtx(org.id));
    for (const seen of [aliceRows.connections, aliceRows.feeds]) {
      expectIds(seen, [alicePrivate.id, orgShared.id], [bobPrivate.id]);
    }
    for (const seen of [bobRows.connections, bobRows.feeds]) {
      expectIds(seen, [bobPrivate.id, orgShared.id], [alicePrivate.id]);
    }
    for (const seen of [headlessRows.connections, headlessRows.feeds]) {
      expectIds(seen, [orgShared.id], [alicePrivate.id, bobPrivate.id]);
    }
  });
});
