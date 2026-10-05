/**
 * Keyed Automation event outputs must keep EXACTLY ONE live event per key.
 *
 * `persistAutomationEventOutput` resolves the current head with a SELECT and then
 * INSERTs inside the caller's transaction. Under READ COMMITTED a second run
 * whose probe lands before the first run COMMITS sees no head, so both insert
 * with `supersedes_event_id = NULL` and both stay live — permanently, silently,
 * with no error raised. `idx_events_superseded_by` cannot catch it because it is
 * unique on `supersedes_event_id`, which is NULL on both rows.
 *
 * This is not a timing test. The interleaving is forced: transaction A is held
 * open after its insert until B has probed and committed, which is exactly the
 * state two Automation runs on two replicas are in when their windows overlap.
 */
import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { persistAutomationEventOutput } from '../../../utils/persist-automation-event-output';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { TestWorkspace } from '../../setup/test-mcp-client';
import type { ToolContext } from '../../../tools/registry';

// Only consulted to authorize a row's own `entity_ids`; none of these rows carry any.
const UNLINKED_ROWS_CTX = {
  organizationId: 'unused',
  userId: null,
  memberRole: null,
  isAuthenticated: true,
} as ToolContext;

const KEYED_OUTPUT = {
  event: 'voice_profile',
  key: ['channel', 'mode'],
} as const;

/**
 * Block until some backend is waiting on a transaction lock — the state a
 * conflicting INSERT enters while the tuple it collides with is still
 * uncommitted. Polls on a THIRD connection, so it observes A and B rather than
 * participating. Throws instead of hanging, so a version of this suite where the
 * race stops being reachable fails loudly rather than silently testing nothing.
 */
async function waitForBlockedInsert(sql: Sql, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%INSERT INTO events%'
    `;
    if (rows[0].n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    'no INSERT ever blocked on the identity constraint — the concurrent interleaving was not reached, so this test would prove nothing'
  );
}

/**
 * A real `automations` row. `events.automation_id` is FK'd to it, so the fabricated
 * id this suite used to pass now fails the constraint INSIDE the parked
 * transaction — which deadlocks the sibling run rather than failing cleanly,
 * and the suite times out instead of reporting the race it exists to prove.
 */
async function createRaceAutomation(sql: Sql, organizationId: string): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO automations (organization_id, created_by, automation_group_id, name, slug, status, version)
    SELECT ${organizationId}, u.id, 0, 'Keyed race Automation', 'keyed-race-automation', 'active', 1
    FROM "user" u LIMIT 1
    RETURNING id
  `;
  return Number(row.id);
}

async function createResultRun(
  sql: Sql,
  organizationId: string,
  automationId: number
): Promise<number> {
  const [run] = await sql<{ id: number }[]>`
    INSERT INTO runs (
      organization_id, automation_id, run_type, status, approved_input,
      action_output, completed_at
    ) VALUES (
      ${organizationId}, ${automationId}, 'automation', 'completed', '{}'::jsonb,
      '{}'::jsonb, NOW()
    )
    RETURNING id
  `;
  return Number(run.id);
}

describe('Automation keyed event outputs > concurrent runs', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('keeps exactly one live event per key when two runs interleave', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Keyed Race Org' });
    const organizationId = workspace.org.id;
    const automationId = await createRaceAutomation(sql, organizationId);

    /** One Automation run persisting a single keyed draft. */
    const persistRun = (tx: DbClient, runId: number) =>
      persistAutomationEventOutput({
        tx,
        rows: [
          {
            title: 'Voice profile',
            content: `Refinement from run ${runId}.`,
            metadata: { channel: 'x', mode: 'taste' },
          },
        ],
        outputName: 'profiles',
        output: KEYED_OUTPUT,
        automationId,
        versionId: null,
        organizationId,
        runId,
        boundEntityIds: [],
        ctx: UNLINKED_ROWS_CTX,
        validContentIds: new Set<number>(),
        occurredAt: new Date().toISOString(),
      });

    // ── Force the interleaving ────────────────────────────────────────────
    // A inserts, then parks with its transaction still OPEN. B therefore probes
    // against a database where A's row is not yet visible.
    let signalAInserted!: () => void;
    const aInserted = new Promise<void>((resolve) => {
      signalAInserted = resolve;
    });
    let releaseA!: () => void;
    const aMayCommit = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const runAId = await createResultRun(sql, organizationId, automationId);
    const runBId = await createResultRun(sql, organizationId, automationId);
    const runA = sql.begin(async (tx) => {
      await persistRun(tx as unknown as DbClient, runAId);
      signalAInserted();
      await aMayCommit;
    });

    await aInserted;
    // B must NOT be awaited before A is released: once the identity constraint
    // exists, B's insert blocks on A's uncommitted conflicting tuple — which is
    // the constraint working — so awaiting B here would deadlock the test
    // against itself rather than exercise the race.
    const runB = sql.begin(async (tx) => {
      await persistRun(tx as unknown as DbClient, runBId);
    });

    // Releasing A here directly would be a COIN FLIP, not a race: A usually
    // commits while B is still acquiring its connection, so B's probe finds the
    // committed head and performs an ordinary supersede. Measured — the retry
    // branch was entered 0 times in 3 runs, i.e. the interesting path was never
    // executed and a mutation to it did not fail this test.
    //
    // Wait for B to be genuinely BLOCKED on A's uncommitted tuple instead. That
    // state is only reachable once B has already probed and seen no head (a
    // READ COMMITTED SELECT never blocks), so it pins the exact interleaving:
    // both runs believe they are creating the first version of this key.
    // releaseA in finally: if the wait times out, A must still commit so the
    // failure surfaces as the timeout's message, not as a hung pool teardown.
    try {
      await waitForBlockedInsert(sql);
    } finally {
      releaseA();
    }
    await Promise.all([runA, runB]);

    const live = await sql<{ id: number; supersedes_event_id: number | null }[]>`
      SELECT id, supersedes_event_id
      FROM events
      WHERE organization_id = ${organizationId}
        AND semantic_type = 'voice_profile'
        AND superseded_by IS NULL
      ORDER BY id
    `;

    // Both rows must survive — events is append-only — but only one may be live.
    const all = await sql<{ id: number; supersedes_event_id: number | null }[]>`
      SELECT id, supersedes_event_id FROM events
      WHERE organization_id = ${organizationId} AND semantic_type = 'voice_profile'
      ORDER BY id
    `;
    expect(all).toHaveLength(2);
    expect(live).toHaveLength(1);

    // And the survivors form ONE chain, which is what proves the recovery path
    // ran rather than the constraint merely rejecting B outright. B's first
    // insert hit 23505 on idx_events_identity_root_automation, so it re-probed,
    // found A's now-committed row, and retried as A's successor.
    const [root, successor] = all;
    expect(root.supersedes_event_id).toBeNull();
    expect(successor.supersedes_event_id).toBe(root.id);
    expect(live[0].id).toBe(successor.id);
  });

  it('recovers when two runs supersede the SAME committed head (superseded_by collision)', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Keyed Race Org' });
    const organizationId = workspace.org.id;
    const automationId = await createRaceAutomation(sql, organizationId);

    /** One Automation run persisting a single keyed draft. */
    const persistRun = (tx: DbClient, runId: number) =>
      persistAutomationEventOutput({
        tx,
        rows: [
          {
            title: 'Voice profile',
            content: `Refinement from run ${runId}.`,
            metadata: { channel: 'x', mode: 'taste' },
          },
        ],
        outputName: 'profiles',
        output: KEYED_OUTPUT,
        automationId,
        versionId: null,
        organizationId,
        runId,
        boundEntityIds: [],
        ctx: UNLINKED_ROWS_CTX,
        validContentIds: new Set<number>(),
        occurredAt: new Date().toISOString(),
      });

    // Seed a committed head for the key first — the state two runs then both
    // probe and both try to supersede. (The first test starts from NO head,
    // which collides on the ROOT index; this one needs a head so both inserts
    // are successors of the SAME row and collide on idx_events_superseded_by.)
    const seedRunId = await createResultRun(sql, organizationId, automationId);
    await sql.begin(async (tx) => {
      await persistRun(tx as unknown as DbClient, seedRunId);
    });
    const seedHead = await sql<{ id: number }[]>`
      SELECT id FROM events
      WHERE organization_id = ${organizationId} AND identity_key IS NOT NULL
    `;
    expect(seedHead).toHaveLength(1);

    // ── Force the interleaving ────────────────────────────────────────────
    // A inserts a successor of the committed head and parks. B probes against
    // that state (A's row is not yet visible), sees the SAME committed head,
    // and inserts its own successor of it — which blocks on A's uncommitted
    // tuple in idx_events_superseded_by. That is the first-attempt collision
    // the recovery path must also handle.
    let signalAInserted!: () => void;
    const aInserted = new Promise<void>((resolve) => {
      signalAInserted = resolve;
    });
    let releaseA!: () => void;
    const aMayCommit = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const runAId = await createResultRun(sql, organizationId, automationId);
    const runBId = await createResultRun(sql, organizationId, automationId);
    const runA = sql.begin(async (tx) => {
      await persistRun(tx as unknown as DbClient, runAId);
      signalAInserted();
      await aMayCommit;
    });

    await aInserted;
    const runB = sql.begin(async (tx) => {
      await persistRun(tx as unknown as DbClient, runBId);
    });

    try {
      await waitForBlockedInsert(sql);
    } finally {
      releaseA();
    }
    await Promise.all([runA, runB]);

    const all = await sql<{ id: number; supersedes_event_id: number | null }[]>`
      SELECT id, supersedes_event_id FROM events
      WHERE organization_id = ${organizationId} AND semantic_type = 'voice_profile'
      ORDER BY id
    `;
    const live = await sql<{ id: number }[]>`
      SELECT id FROM events
      WHERE organization_id = ${organizationId}
        AND semantic_type = 'voice_profile'
        AND superseded_by IS NULL
    `;

    // Seed + A + B all survive (append-only), but they form ONE chain: exactly
    // one live row, B re-probed after its first-attempt superseded_by collision
    // and retried as a successor of A's row rather than surfacing a raw 23505.
    expect(all).toHaveLength(3);
    expect(live).toHaveLength(1);
    expect(all[0].supersedes_event_id).toBeNull();
    expect(all[1].supersedes_event_id).toBe(all[0].id);
    expect(all[2].supersedes_event_id).toBe(all[1].id);
  });
});
