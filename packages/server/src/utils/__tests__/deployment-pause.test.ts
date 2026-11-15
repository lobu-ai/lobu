/**
 * The promotions-pause decision, executed rather than asserted about.
 *
 * This guard sits in the auth funnel, so a wrong answer either freezes a
 * product that should still be editable, or waves through the CI re-promotion
 * the pause exists to stop. Both failures are silent, so every branch of the
 * decision gets a case here — including the three exemptions that are easy to
 * lose in a refactor: the tool proxy owns its own read/write signal, the
 * audit-summary POST records a refused run, and `--resume` must be able to
 * clear the pause it is exiting.
 */

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup.js';

const ORG = 'org-pause-gate';
const PAUSED_BY_APPLY = 'apl_aaaaaaaa-1111-2222-3333-444444444444';
const ROLLED_BACK = 'apl_bbbbbbbb-1111-2222-3333-444444444444';
const RUNNING_APPLY = 'apl_cccccccc-1111-2222-3333-444444444444';

beforeAll(async () => {
  await ensureDbForGatewayTests();
}, 60_000);

beforeEach(async () => {
  await resetTestDatabase();
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug) VALUES (${ORG}, ${ORG}, ${ORG})
    ON CONFLICT (id) DO NOTHING
  `;
});

async function pauseOrg(): Promise<void> {
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();
  await sql`
    INSERT INTO deployment_pause (organization_id, apply_id, rollback_of, paused_by)
    VALUES (${ORG}, ${PAUSED_BY_APPLY}, ${ROLLED_BACK}, 'u1')
    ON CONFLICT (organization_id) DO UPDATE SET rollback_of = EXCLUDED.rollback_of
  `;
}

/** A deployment the CLI could legitimately claim to be rolling back. */
async function seedDeployment(applyId: string): Promise<void> {
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();
  await sql`
    INSERT INTO events (organization_id, origin_id, semantic_type, payload_data, metadata)
    VALUES (${ORG}, ${`deployment_${applyId}`}, 'change',
            ${sql.json({ manifest: { state: {} } })},
            ${sql.json({
              category: 'deployment',
              apply_id: applyId,
              status: 'succeeded',
            })})
  `;
}

/** Minimal stand-in for the Hono context the funnel hands the guard. */
function ctx(opts: {
  method: string;
  path?: string;
  rollbackOf?: string;
  organizationId?: string | null;
}) {
  const headers: Record<string, string> = {};
  if (opts.rollbackOf) headers['x-lobu-rollback-of'] = opts.rollbackOf;
  return {
    req: {
      method: opts.method,
      path: opts.path ?? '/api/org-pause-gate/agents',
      header: (name: string) => headers[name.toLowerCase()],
    },
    get: (key: string) =>
      key === 'organizationId'
        ? opts.organizationId === undefined
          ? ORG
          : opts.organizationId
        : null,
    json: (body: unknown, status: 409) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  };
}

/** "blocked" | "allowed" — what the funnel would actually do. */
async function verdict(
  c: ReturnType<typeof ctx>,
  toolName: string | null = null
): Promise<'blocked' | 'allowed'> {
  const { checkApplyPause } = await import('../deployment-pause.js');
  const res = await checkApplyPause(c as never, RUNNING_APPLY, toolName);
  if (!res) return 'allowed';
  expect(res.status).toBe(409);
  return 'blocked';
}

describe('promotions pause — the funnel decision', () => {
  test('blocks a mutating apply-run request while paused', async () => {
    await pauseOrg();
    expect(await verdict(ctx({ method: 'POST' }))).toBe('blocked');
    expect(await verdict(ctx({ method: 'PATCH' }))).toBe('blocked');
    expect(await verdict(ctx({ method: 'PUT' }))).toBe('blocked');
  });

  test('allows everything when the org is not paused', async () => {
    expect(await verdict(ctx({ method: 'POST' }))).toBe('allowed');
  });

  test('never blocks a read, so the diff and --dry-run survive a pause', async () => {
    await pauseOrg();
    expect(await verdict(ctx({ method: 'GET' }))).toBe('allowed');
    expect(await verdict(ctx({ method: 'HEAD' }))).toBe('allowed');
  });

  test('leaves the tool proxy to its own guard', async () => {
    await pauseOrg();
    // Apply's READS go through the proxy as POSTs. Deciding here on the method
    // would classify them as mutations and break `--dry-run` against a paused
    // org — the proxy reads intent from the tool args instead.
    expect(await verdict(ctx({ method: 'POST' }), 'manage_entity_schema')).toBe('allowed');
  });

  test('never blocks the DELETE that --resume uses to clear the pause', async () => {
    await pauseOrg();
    expect(
      await verdict(ctx({ method: 'DELETE', path: '/api/org-pause-gate/deployments/pause' }))
    ).toBe('allowed');
    // …but a DELETE anywhere else is still a mutation.
    expect(await verdict(ctx({ method: 'DELETE' }))).toBe('blocked');
    expect(
      await verdict(
        ctx({ method: 'DELETE', path: '/api/org-pause-gate/agents/deployments/pause' })
      )
    ).toBe('blocked');
  });

  test('allows only the exact audit-summary POST after a blocked apply', async () => {
    await pauseOrg();
    expect(
      await verdict(ctx({ method: 'POST', path: '/api/org-pause-gate/deployments' }))
    ).toBe('allowed');
    expect(
      await verdict(ctx({ method: 'POST', path: '/api/org-pause-gate/agents/deployments' }))
    ).toBe('blocked');
  });

  test('lets a genuine rollback through while paused', async () => {
    await pauseOrg();
    await seedDeployment(ROLLED_BACK);
    expect(await verdict(ctx({ method: 'POST', rollbackOf: ROLLED_BACK }))).toBe('allowed');
  });

  test('rejects a rollback claim naming a deployment that does not exist', async () => {
    await pauseOrg();
    // Shape-valid but fabricated: without the existence check the header would
    // be a one-line bypass for anyone who can spell `apl_`.
    expect(
      await verdict(ctx({ method: 'POST', rollbackOf: 'apl_dddddddd-9999-9999-9999-999999999999' }))
    ).toBe('blocked');
  });

  test('rejects a malformed rollback claim', async () => {
    await pauseOrg();
    expect(
      await verdict(ctx({ method: 'POST', rollbackOf: 'deployment_apl_not-valid' }))
    ).toBe('blocked');
  });

  test('rejects a matching origin id that is not a restorable deployment', async () => {
    const { getDb } = await import('../../db/client.js');
    const sql = getDb();
    await sql`
      INSERT INTO events (organization_id, origin_id, semantic_type, payload_data, metadata)
      VALUES (${ORG}, ${`deployment_${ROLLED_BACK}`}, 'change', '{}'::jsonb,
              ${JSON.stringify({ category: 'config', apply_id: ROLLED_BACK })}::jsonb)
    `;
    await pauseOrg();

    expect(await verdict(ctx({ method: 'POST', rollbackOf: ROLLED_BACK }))).toBe('blocked');
  });

  test('rejects blocked and snapshot-less deployment targets', async () => {
    const { getDb } = await import('../../db/client.js');
    const sql = getDb();
    await sql`
      INSERT INTO events (organization_id, origin_id, semantic_type, payload_data, metadata)
      VALUES
        (${ORG}, 'deployment_apl_blocked', 'change',
         ${sql.json({ manifest: { state: {} } })},
         ${sql.json({
           category: 'deployment',
           apply_id: 'apl_blocked',
           status: 'blocked',
         })}),
        (${ORG}, 'deployment_apl_snapshotless', 'change', '{}'::jsonb,
         ${sql.json({
           category: 'deployment',
           apply_id: 'apl_snapshotless',
           status: 'succeeded',
         })})
    `;
    await pauseOrg();

    expect(await verdict(ctx({ method: 'POST', rollbackOf: 'apl_blocked' }))).toBe('blocked');
    expect(await verdict(ctx({ method: 'POST', rollbackOf: 'apl_snapshotless' }))).toBe('blocked');
  });

  test('rejects a rollback claim naming another org’s deployment', async () => {
    const { getDb } = await import('../../db/client.js');
    const sql = getDb();
    await sql`
      INSERT INTO organization (id, name, slug) VALUES ('org-other', 'other', 'org-other')
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO events (organization_id, origin_id, semantic_type, payload_data, metadata)
      VALUES ('org-other', ${`deployment_${ROLLED_BACK}`}, 'change',
              ${sql.json({ manifest: { state: {} } })},
              ${sql.json({
                category: 'deployment',
                apply_id: ROLLED_BACK,
                status: 'succeeded',
              })})
    `;
    await pauseOrg();
    expect(await verdict(ctx({ method: 'POST', rollbackOf: ROLLED_BACK }))).toBe('blocked');
  });

  test('lets a read-tier tool call through while paused', async () => {
    await pauseOrg();
    const { getBlockingPause } = await import('../deployment-pause.js');
    // The proxy path decides read-vs-write from the tool args and passes the
    // answer in. This is apply's MAIN read path — `manage_*` list/get calls are
    // POSTs — so losing this branch breaks `--dry-run` against a paused org
    // even though the HTTP-method rule above still looks correct.
    expect(
      await getBlockingPause({
        organizationId: ORG,
        applyId: RUNNING_APPLY,
        rollbackOf: null,
        isReadOnly: true,
      })
    ).toBeNull();
    // …and the same call at write tier is refused.
    expect(
      await getBlockingPause({
        organizationId: ORG,
        applyId: RUNNING_APPLY,
        rollbackOf: null,
        isReadOnly: false,
      })
    ).not.toBeNull();
  });

  test('the real tool executor refuses a classified mutation before its handler', async () => {
    await pauseOrg();
    const { executeTool } = await import('../../tools/execute.js');
    const { DeploymentsPausedError } = await import('../deployment-pause.js');

    let caught: unknown;
    try {
      await executeTool(
        'manage_entity_schema',
        { action: 'create', schema_type: 'entity_type', slug: 'must-not-exist' },
        {} as never,
        {
          organizationId: ORG,
          tokenOrganizationId: ORG,
          userId: 'u1',
          memberRole: 'owner',
          agentId: null,
          requestedAgentId: null,
          isAuthenticated: true,
          clientId: 'pause-test',
          scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
          tokenType: 'pat',
          requestUrl: 'http://test.local/api/org-pause-gate/manage_entity_schema',
          baseUrl: 'http://test.local',
          scopedToOrg: true,
          allowCrossOrg: false,
          applyId: RUNNING_APPLY,
          rollbackOf: null,
        }
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DeploymentsPausedError);
    // The REST tool proxy maps this status; anything but a ToolUserError 4xx
    // becomes an opaque 500 and the caller loses the `--resume` instruction.
    expect(caught).toMatchObject({ httpStatus: 409 });
    const { getDb } = await import('../../db/client.js');
    const [row] = await getDb()`
      SELECT count(*)::int AS count
      FROM entity_types
      WHERE organization_id = ${ORG} AND slug = 'must-not-exist'
    `;
    expect(row?.count).toBe(0);
  });

  test('ignores traffic that is not part of an apply run', async () => {
    await pauseOrg();
    const { getBlockingPause } = await import('../deployment-pause.js');
    // No apply header at all: Owletto edits and one-off API calls are never
    // gated, or a paused org would be a frozen product.
    expect(
      await getBlockingPause({
        organizationId: ORG,
        applyId: null,
        rollbackOf: null,
        isReadOnly: false,
      })
    ).toBeNull();
  });

  test('treats a malformed apply id as non-apply traffic', async () => {
    await pauseOrg();
    const { checkApplyPause } = await import('../deployment-pause.js');

    expect(
      await checkApplyPause(ctx({ method: 'POST' }) as never, 'not-an-apply-id', null)
    ).toBeNull();
  });

  test('never blocks when authentication resolved no organization', async () => {
    await pauseOrg();
    expect(await verdict(ctx({ method: 'POST', organizationId: null }))).toBe('allowed');
  });

  test('normalizes the database timestamp at the in-process boundary', async () => {
    await pauseOrg();
    const { getBlockingPause } = await import('../deployment-pause.js');
    const pause = await getBlockingPause({
      organizationId: ORG,
      applyId: RUNNING_APPLY,
      rollbackOf: null,
      isReadOnly: false,
    });

    expect(typeof pause?.pausedAt).toBe('string');
    expect(pause?.pausedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('rollback verification has a non-partial index-backed plan', async () => {
    const { getDb } = await import('../../db/client.js');
    const sql = getDb();
    const [catalog] = await sql`
      SELECT
        i.indpred IS NULL AS non_partial,
        pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'idx_events_org_origin'
    `;
    expect(catalog?.non_partial).toBe(true);
    expect(catalog?.definition).toContain('(organization_id, origin_id)');

    const production = await sql.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      return tx`
        EXPLAIN (FORMAT JSON)
        SELECT 1
        FROM events
        WHERE organization_id = ${ORG}
          AND origin_id = ${`deployment_${ROLLED_BACK}`}
          AND semantic_type = 'change'
          AND metadata->>'category' = 'deployment'
          AND metadata->>'apply_id' = ${ROLLED_BACK}
          AND metadata->>'status' IN ('succeeded', 'partial_failure')
          AND jsonb_typeof(payload_data->'manifest') = 'object'
          AND jsonb_typeof(payload_data->'manifest'->'state') = 'object'
        LIMIT 1
      `;
    });
    expect(JSON.stringify(production)).toContain('Index Scan');
    expect(JSON.stringify(production)).not.toContain('Seq Scan');
  });
});
