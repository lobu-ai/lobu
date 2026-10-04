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

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup.js';
import { resolveSystemJudgeTarget } from '../../gateway/inference/system-judge-target.js';
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
  // Guardrail judge models are resolved against the provider registry at write
  // time, so the persistence tests below need a registry and a system key or
  // their fixture model is rejected before it is ever stored.
  process.env.LOBU_PROVIDER_REGISTRY_PATH = new URL(
    '../../../../../config/providers.json',
    import.meta.url
  ).pathname;
  process.env.OPENAI_API_KEY ||= 'sk-test-deployment-owned';
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
  authStash.user = { id: 'u1', name: 'Test', email: 'u1@test', emailVerified: true };
  authStash.organizationId = ORG;
  authStash.authSource = 'session';
  authStash.mcpAuthInfo = null;
}, 30_000);

describe('custom guardrails persist through PATCH/GET /config', () => {
  test('guardrailsInline round-trips and merges without clobbering other settings', async () => {
    const app = await importAgentRoutes();
    const inline = [
      {
        name: 'no-competitors',
        enabled: true,
        stage: 'output',
        policy: 'Deny any response that names a competitor.',
        model: 'openai/gpt-4o-mini',
      },
    ];

    // Seed an unrelated setting first so we can prove the partial merge.
    const seedIdentity = await app.request(`/${AGENT}/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identityMd: 'You are a helpful agent.' }),
    });
    expect(seedIdentity.status).toBe(200);

    const patch = await app.request(`/${AGENT}/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ guardrailsInline: inline }),
    });
    expect(patch.status).toBe(200);

    const get = await app.request(`/${AGENT}/config`);
    expect(get.status).toBe(200);
    const body = (await get.json()) as {
      guardrailsInline?: unknown;
      identityMd?: string;
    };
    expect(body.guardrailsInline).toEqual(inline);
    // The earlier identity write survived the guardrail patch (partial merge).
    expect(body.identityMd).toBe('You are a helpful agent.');
  });

  test('disabling a custom guardrail persists the enabled=false flag', async () => {
    const app = await importAgentRoutes();
    const inline = [
      {
        name: 'tone-check',
        enabled: false,
        stage: 'input',
        policy: 'Deny hostile messages.',
        // A model is required (the test org has no default provider model).
        model: 'openai/gpt-4o-mini',
      },
    ];
    await app.request(`/${AGENT}/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ guardrailsInline: inline }),
    });
    const get = await app.request(`/${AGENT}/config`);
    const body = (await get.json()) as {
      guardrailsInline?: Array<{ enabled: boolean }>;
    };
    expect(body.guardrailsInline?.[0]?.enabled).toBe(false);
  });

  /**
   * `skillsConfig` is spread into the settings row verbatim and read back as a
   * trusted `SkillConfig`, so a malformed payload has to be rejected AT the
   * write boundary — the readers have no second chance.
   *
   * Driven through the real PATCH route rather than the exported validator: the
   * plausible way this ships broken is the helper existing but never being
   * called, which a direct unit test cannot see.
   */
  const MALFORMED_SKILLS_CONFIGS: Array<[label: string, skillsConfig: unknown]> =
    [
      // The runtime gates skills on truthiness (`s.enabled && …`), so "yes"
      // would enable a skill the write path never saw as enabled.
      [
        'a non-boolean enabled',
        { skills: [{ repo: 'file/x', name: 'x', enabled: 'yes' }] },
      ],
      // A non-array throws at the first `.filter()` downstream.
      ['a non-array skills', { skills: 'nope' }],
    ];

  for (const [label, skillsConfig] of MALFORMED_SKILLS_CONFIGS) {
    test(`rejects ${label} and persists nothing`, async () => {
      const app = await importAgentRoutes();

      // Seed a good value first, so "not persisted" means the row still holds
      // the last valid write — not merely that the field was never set.
      const good = { skills: [{ repo: 'file/ok', name: 'ok', enabled: true }] };
      const seed = await app.request(`/${AGENT}/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skillsConfig: good }),
      });
      expect(seed.status).toBe(200);

      const res = await app.request(`/${AGENT}/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skillsConfig }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error?: string;
        error_description?: string;
      };
      expect(body.error).toBe('invalid_skills_config');
      // The message names the offending path so the UI can point at the field.
      expect(body.error_description).toContain('skillsConfig/skills');

      // The rejected payload never reached the row.
      const get = await app.request(`/${AGENT}/config`);
      expect(get.status).toBe(200);
      const after = (await get.json()) as { skillsConfig?: unknown };
      expect(after.skillsConfig).toEqual(good);
    });
  }

  test('accepts a well-formed skillsConfig through the route', async () => {
    // Guards the other direction: a validator that rejected everything would
    // pass the tests above while breaking every real save.
    const app = await importAgentRoutes();
    const skillsConfig = {
      skills: [{ repo: 'file/x', name: 'x', enabled: true }],
    };
    const res = await app.request(`/${AGENT}/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skillsConfig }),
    });
    expect(res.status).toBe(200);

    const get = await app.request(`/${AGENT}/config`);
    const body = (await get.json()) as { skillsConfig?: unknown };
    expect(body.skillsConfig).toEqual(skillsConfig);
  });

  test('rejects a custom guardrail with no model when the org has no default model', async () => {
    // The test org has no default provider model, so a model is required.
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        guardrailsInline: [
          { name: 'needs-model', enabled: true, stage: 'output', policy: 'deny' },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('guardrail_model_required');
  });

  // A judge model that cannot resolve used to SAVE and then deny every request
  // the guardrail covers at runtime, with only a log line to explain it. These
  // two pin the write-time gate that replaced that silent failure.
  describe('judge model resolution at write time', () => {
    const REGISTRY_ENV = 'LOBU_PROVIDER_REGISTRY_PATH';
    const REGISTRY_PATH = new URL(
      '../../../../../config/providers.json',
      import.meta.url
    ).pathname;
    let undo: Array<() => void> = [];

    function setEnv(key: string, value: string | undefined) {
      const prev = process.env[key];
      undo.push(() => {
        if (prev === undefined) delete process.env[key];
        else process.env[key] = prev;
      });
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    afterEach(() => {
      for (const fn of undo.reverse()) fn();
      undo = [];
    });

    test('rejects a judge model this deployment can never run', async () => {
      // `claude` is sdkCompat "anthropic" in the shipped registry, and the
      // judge transport speaks only OpenAI-compatible /chat/completions. The
      // key being SET is the point: presence of a credential must not be
      // mistaken for the model being runnable.
      setEnv(REGISTRY_ENV, REGISTRY_PATH);
      setEnv('ANTHROPIC_API_KEY', 'sk-ant-still-configured');
      const app = await importAgentRoutes();
      const res = await app.request(`/${AGENT}/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          guardrailsInline: [
            {
              name: 'anthropic-judge',
              enabled: true,
              stage: 'output',
              policy: 'deny',
              model: 'claude/claude-haiku-4-5-20251001',
            },
          ],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('guardrail_model_unresolvable');
    });

    test('an already-stored model that stopped resolving stays editable', async () => {
      // The lockout this prevents: every PATCH carries the whole
      // guardrailsInline array, so re-validating stored values would make an
      // agent holding a now-unrunnable model impossible to edit — including to
      // remove the offending guardrail. Save a valid model, take its credential
      // away, then prove the agent can still be saved.
      setEnv(REGISTRY_ENV, REGISTRY_PATH);
      setEnv('OPENAI_API_KEY', 'sk-deployment-owned');
      const app = await importAgentRoutes();
      const inline = [
        {
          name: 'grandfathered',
          enabled: true,
          stage: 'output',
          policy: 'deny',
          model: 'openai/gpt-4o-mini',
        },
      ];
      const saved = await app.request(`/${AGENT}/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ guardrailsInline: inline }),
      });
      expect(saved.status).toBe(200);

      // The credential goes away; the stored model can no longer resolve.
      setEnv('OPENAI_API_KEY', undefined);
      expect(
        (await resolveSystemJudgeTarget('openai/gpt-4o-mini')).ok
      ).toBe(false);

      const again = await app.request(`/${AGENT}/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identityMd: 'edited', guardrailsInline: inline }),
      });
      expect(again.status).toBe(200);

      // But a NEWLY named bad model is still refused — grandfathering is scoped
      // to the exact stored value, not a blanket amnesty.
      const changed = await app.request(`/${AGENT}/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          guardrailsInline: [
            { ...inline[0], model: 'claude/claude-haiku-4-5-20251001' },
          ],
        }),
      });
      expect(changed.status).toBe(400);
    });

    test('rejects a model-less guardrail when the org default model cannot run the judge', async () => {
      // A model-less guardrail runs on the org default. A Claude (Anthropic
      // protocol) default is not judge-eligible, so saving it would only deny
      // every covered request at runtime.
      const providerSecrets = await import('../stores/provider-secrets.js');
      const spy = spyOn(providerSecrets, 'getOrgDefaultModel').mockResolvedValue(
        'claude/claude-haiku-4-5-20251001'
      );
      try {
        const app = await importAgentRoutes();
        const res = await app.request(`/${AGENT}/config`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            guardrailsInline: [
              { name: 'no-model', enabled: true, stage: 'output', policy: 'deny' },
            ],
          }),
        });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('guardrail_model_unresolvable');
      } finally {
        spy.mockRestore();
      }
    });

    test('accepts a judge model backed by an operator system key', async () => {
      // POSITIVE CONTROL. A validator that rejected every model would pass the
      // test above while making the Guardrails tab unusable.
      setEnv(REGISTRY_ENV, REGISTRY_PATH);
      setEnv('OPENAI_API_KEY', 'sk-deployment-owned');
      const app = await importAgentRoutes();
      const res = await app.request(`/${AGENT}/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          guardrailsInline: [
            {
              name: 'openai-judge',
              enabled: true,
              stage: 'output',
              policy: 'deny',
              model: 'openai/gpt-4o-mini',
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
    });
  });

  test('guardrail-judge-default reports null when the org has no default model', async () => {
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/guardrail-judge-default`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ defaultModel: null });
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
