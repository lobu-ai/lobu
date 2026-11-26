/**
 * Regression coverage for the agent Guardrails tab's "recent trips" feed.
 *
 * The owletto UI shipped a `useGuardrailTrips` hook calling
 * `GET /api/<org>/agents/<id>/guardrail-trips`, but no server route existed —
 * the request 404'd and the hook silently rendered "No trips yet" forever even
 * though `recordGuardrailTrip` was writing `guardrail-trip` events the whole
 * time. These tests drive the real route over the embedded Postgres harness and
 * assert it reads those events back, scoped to the agent + org, newest first.
 *
 * Uses the shared route-test mocks (auth + gateway) so the handler runs against
 * the genuine `events` table; no network.
 */

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedOrgMembership,
} from '../../gateway/__tests__/helpers/db-setup.js';
import { authStash, installRouteTestMocks } from './helpers/route-test-mocks';

installRouteTestMocks();

const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const ORG = 'org-trips';
const OTHER_ORG = 'org-trips-other';
const AGENT = 'trips-agent';
const OTHER_AGENT = 'other-agent';

beforeAll(async () => {
  await ensureDbForGatewayTests();
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
}, 60_000);

async function seedOrgAndAgent(
  orgId: string,
  agentId: string,
  agentName: string
): Promise<void> {
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${orgId}, ${orgId}, ${orgId})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO agents (id, organization_id, name)
    VALUES (${agentId}, ${orgId}, ${agentName})
    ON CONFLICT (organization_id, id) DO NOTHING
  `;
}

/** Append a `guardrail-trip` event matching `recordGuardrailTrip`'s shape. */
async function insertTrip(params: {
  organizationId: string;
  agentId: string;
  stage: string;
  guardrail: string;
  reason: string | null;
  occurredAt: Date;
}): Promise<void> {
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();
  await sql`
    INSERT INTO events
      (organization_id, origin_id, title, semantic_type, origin_type, metadata, occurred_at)
    VALUES (
      ${params.organizationId},
      ${`trip_${params.stage}_${params.guardrail}_${params.occurredAt.getTime()}`},
      ${`Guardrail "${params.guardrail}" tripped at ${params.stage}`},
      'guardrail-trip',
      ${`guardrail-${params.stage}`},
      ${sql.json({
        guardrail: params.guardrail,
        stage: params.stage,
        reason: params.reason,
        agent_id: params.agentId,
        user_id: null,
        conversation_id: null,
      })},
      ${params.occurredAt}
    )
  `;
}

async function importAgentRoutes() {
  const mod = await import('../agent-routes.js');
  return mod.agentRoutes;
}

beforeEach(async () => {
  await resetTestDatabase();
  await seedOrgAndAgent(ORG, AGENT, 'Trips Agent');
  await seedOrgMembership(ORG, "u1", "owner");
  authStash.user = { id: 'u1', name: 'Test', email: 'u1@test', emailVerified: true };
  authStash.organizationId = ORG;
  authStash.authSource = 'session';
  authStash.mcpAuthInfo = null;
}, 30_000);

describe('retired agent settings keys answer 422 naming their new home', () => {
  test.each([
    { key: 'skillsConfig', value: { skills: [] }, names: 'manage_skills' },
    { key: 'guardrails', value: ['secret-scan'], names: 'Settings → Policies' },
    {
      key: 'guardrailsInline',
      value: [{ name: 'tone', enabled: true, stage: 'output', policy: 'deny' }],
      names: 'Settings → Policies',
    },
  ])('refuses $key and persists nothing', async ({ key, value, names }) => {
    // A caller still sending the old key learns where it went instead of
    // having the key silently dropped, and the rest of the patch is not saved.
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ soulMd: 'Must not persist', [key]: value }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: string; error_description?: string };
    expect(body.error).toBe('setting_moved');
    expect(body.error_description).toContain(names);

    const get = await app.request(`/${AGENT}/config`);
    const after = (await get.json()) as Record<string, unknown>;
    expect(after.soulMd).not.toBe('Must not persist');
    expect(after).not.toHaveProperty(key);
  });
});

describe('GET /agents/:agentId/guardrail-trips', () => {
  test('returns an empty list when nothing has tripped', async () => {
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/guardrail-trips?limit=50`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ trips: [] });
  });

  test('maps trip events newest-first with the resolved agent name', async () => {
    await insertTrip({
      organizationId: ORG,
      agentId: AGENT,
      stage: 'output',
      guardrail: 'secret-scan',
      reason: 'Output contains a value that looks like a openai-key',
      occurredAt: new Date('2026-06-24T10:00:00.000Z'),
    });
    await insertTrip({
      organizationId: ORG,
      agentId: AGENT,
      stage: 'input',
      guardrail: 'pii-scan',
      reason: 'Potential PII detected (email)',
      occurredAt: new Date('2026-06-24T10:05:00.000Z'),
    });

    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/guardrail-trips?limit=50`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      trips: Array<Record<string, unknown>>;
    };

    expect(body.trips).toHaveLength(2);
    // Newest first.
    expect(body.trips[0]).toMatchObject({
      agentId: AGENT,
      agentName: 'Trips Agent',
      stage: 'input',
      guardrailName: 'pii-scan',
      reason: 'Potential PII detected (email)',
      occurredAt: '2026-06-24T10:05:00.000Z',
    });
    expect(body.trips[1]).toMatchObject({
      stage: 'output',
      guardrailName: 'secret-scan',
    });
    expect(typeof body.trips[0]!.id).toBe('number');
  });

  test('omits the reason field when the trip recorded none', async () => {
    await insertTrip({
      organizationId: ORG,
      agentId: AGENT,
      stage: 'pre-tool',
      guardrail: 'forbidden-tools',
      reason: null,
      occurredAt: new Date('2026-06-24T11:00:00.000Z'),
    });
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/guardrail-trips`);
    const body = (await res.json()) as { trips: Array<Record<string, unknown>> };
    expect(body.trips).toHaveLength(1);
    expect(body.trips[0]).not.toHaveProperty('reason');
  });

  test('scopes to the agent and org — other agents/orgs are not leaked', async () => {
    // The other org must exist for the cross-org event's FK to resolve.
    await seedOrgAndAgent(OTHER_ORG, AGENT, 'Trips Agent (other org)');
    // A trip for a different agent in the same org…
    await insertTrip({
      organizationId: ORG,
      agentId: OTHER_AGENT,
      stage: 'output',
      guardrail: 'secret-scan',
      reason: null,
      occurredAt: new Date('2026-06-24T10:00:00.000Z'),
    });
    // …and one for our agent id but a different org.
    await insertTrip({
      organizationId: OTHER_ORG,
      agentId: AGENT,
      stage: 'output',
      guardrail: 'secret-scan',
      reason: null,
      occurredAt: new Date('2026-06-24T10:00:00.000Z'),
    });
    // Our agent's own trip.
    await insertTrip({
      organizationId: ORG,
      agentId: AGENT,
      stage: 'input',
      guardrail: 'pii-scan',
      reason: null,
      occurredAt: new Date('2026-06-24T10:10:00.000Z'),
    });

    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/guardrail-trips`);
    const body = (await res.json()) as { trips: Array<Record<string, unknown>> };
    expect(body.trips).toHaveLength(1);
    expect(body.trips[0]).toMatchObject({ guardrailName: 'pii-scan' });
  });

  test('falls back to created_at when occurred_at is null (real audit rows)', async () => {
    // recordGuardrailTrip writes created_at but leaves occurred_at null.
    const { getDb } = await import('../../db/client.js');
    const sql = getDb();
    await sql`
      INSERT INTO events
        (organization_id, origin_id, title, semantic_type, origin_type, metadata, occurred_at)
      VALUES (
        ${ORG}, 'trip_null_occurred', 'Guardrail tripped', 'guardrail-trip',
        'guardrail-input',
        ${sql.json({ guardrail: 'pii-scan', stage: 'input', reason: null, agent_id: AGENT })},
        NULL
      )
    `;
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/guardrail-trips`);
    const body = (await res.json()) as {
      trips: Array<{ occurredAt: string }>;
    };
    expect(body.trips).toHaveLength(1);
    expect(body.trips[0]!.occurredAt).not.toBe('');
    expect(body.trips[0]!.occurredAt).not.toBe('null');
    expect(Number.isNaN(Date.parse(body.trips[0]!.occurredAt))).toBe(false);
  });

  test('narrows to a single guardrail when ?guardrail= is given', async () => {
    await insertTrip({
      organizationId: ORG,
      agentId: AGENT,
      stage: 'output',
      guardrail: 'secret-scan',
      reason: null,
      occurredAt: new Date('2026-06-24T10:00:00.000Z'),
    });
    await insertTrip({
      organizationId: ORG,
      agentId: AGENT,
      stage: 'input',
      guardrail: 'pii-scan',
      reason: null,
      occurredAt: new Date('2026-06-24T10:05:00.000Z'),
    });

    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/guardrail-trips?guardrail=pii-scan`);
    const body = (await res.json()) as { trips: Array<Record<string, unknown>> };
    expect(body.trips).toHaveLength(1);
    expect(body.trips[0]).toMatchObject({ guardrailName: 'pii-scan' });
  });

  test('clamps the limit so a hand-crafted query cannot ask for an unbounded scan', async () => {
    for (let i = 0; i < 3; i++) {
      await insertTrip({
        organizationId: ORG,
        agentId: AGENT,
        stage: 'input',
        guardrail: 'pii-scan',
        reason: null,
        occurredAt: new Date(Date.UTC(2026, 5, 24, 10, i, 0)),
      });
    }
    const app = await importAgentRoutes();
    // limit=1 is honored…
    const limited = await app.request(`/${AGENT}/guardrail-trips?limit=1`);
    expect(((await limited.json()) as { trips: unknown[] }).trips).toHaveLength(1);
    // …and a garbage limit falls back to the default rather than erroring.
    const garbage = await app.request(`/${AGENT}/guardrail-trips?limit=not-a-number`);
    expect(garbage.status).toBe(200);
    expect(((await garbage.json()) as { trips: unknown[] }).trips).toHaveLength(3);
  });

});
