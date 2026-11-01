/**
 * Coverage for the Deployments API (deployment-routes.ts): summary ingestion
 * with apply_id dedupe, the feed (deployments + standalone changes, config
 * rows grouped under an apply run excluded from the top level), and the
 * detail routes' event-sourced before/after computation.
 *
 * Also drives a REAL agent-routes mutation with an `x-lobu-apply-id` header
 * end-to-end to prove handlers stamp config events with the apply id.
 *
 * Uses the shared route-test mocks (auth + gateway) over the embedded
 * Postgres harness; no network.
 */

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup.js';
import { authStash, installRouteTestMocks } from './helpers/route-test-mocks';

installRouteTestMocks();

const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const ORG = 'org-deploys';
const OTHER_ORG = 'org-deploys-other';
const AGENT = 'deploy-agent';
const APPLY_ID = 'apl_11111111-2222-3333-4444-555555555555';

beforeAll(async () => {
  await ensureDbForGatewayTests();
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
}, 60_000);

async function seedOrgAndAgent(orgId: string, agentId: string): Promise<void> {
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();
  // events.created_by has an FK to "user" — the session actor must exist.
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES ('u1', 'Test', 'u1@test', true, now(), now())
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${orgId}, ${orgId}, ${orgId})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO agents (id, organization_id, name)
    VALUES (${agentId}, ${orgId}, 'Deploy Agent')
    ON CONFLICT (organization_id, id) DO NOTHING
  `;
}

/** Insert a category='config' event the way insertConfigChangeEventInTransaction does. */
async function insertConfigEvent(params: {
  organizationId: string;
  resourceKind: string;
  resourceId: string;
  op: string;
  state: Record<string, unknown> | null;
  applyId?: string | null;
  actorSource?: string;
}): Promise<number> {
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();
  const rows = await sql`
    INSERT INTO events
      (organization_id, origin_id, title, semantic_type, origin_type, payload_type, payload_data, metadata)
    VALUES (
      ${params.organizationId},
      ${`config_${params.resourceKind}_${params.op}_${params.resourceId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`},
      ${`${params.resourceKind} '${params.resourceId}' ${params.op}`},
      'change',
      ${`config_${params.resourceKind}_${params.op}`},
      'empty',
      ${sql.json({ state: params.state })},
      ${sql.json({
        category: 'config',
        resource_kind: params.resourceKind,
        resource_id: params.resourceId,
        op: params.op,
        ...(params.applyId ? { apply_id: params.applyId } : {}),
        ...(params.actorSource ? { actor_source: params.actorSource } : {}),
      })}
    )
    RETURNING id
  `;
  return rows[0].id as number;
}

async function importDeploymentRoutes() {
  const mod = await import('../deployment-routes.js');
  return mod.deploymentRoutes;
}

async function importAgentRoutes() {
  const mod = await import('../agent-routes.js');
  return mod.agentRoutes;
}

/** Poll the events table until the fire-and-forget audit writer lands. */
async function waitForConfigEvents(
  organizationId: string,
  minCount: number,
  timeoutMs = 5_000
): Promise<Array<Record<string, any>>> {
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await sql`
      SELECT id, metadata, payload_data FROM events
      WHERE organization_id = ${organizationId}
        AND semantic_type = 'change'
        AND metadata->>'category' = 'config'
      ORDER BY id ASC
    `;
    if (rows.length >= minCount) return rows as any;
    if (Date.now() > deadline) {
      throw new Error(
        `Expected ${minCount} config events, found ${rows.length} after ${timeoutMs}ms`
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function summaryBody(overrides: Record<string, unknown> = {}) {
  return {
    apply_id: APPLY_ID,
    status: 'succeeded',
    counts: { create: 1, update: 2, noop: 3, drift: 0, delete: 0 },
    counts_by_kind: { agent: { create: 1 }, connection: { update: 2 } },
    manifest_hash: 'sha256:abc123',
    git_sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    git_dirty: false,
    cli_version: '13.4.0',
    ...overrides,
  };
}

beforeEach(async () => {
  await resetTestDatabase();
  await seedOrgAndAgent(ORG, AGENT);
  await seedOrgAndAgent(OTHER_ORG, 'other-agent');
  authStash.user = { id: 'u1', name: 'Test', email: 'u1@test', emailVerified: true };
  authStash.organizationId = ORG;
  authStash.authSource = 'session';
  authStash.mcpAuthInfo = null;
}, 30_000);

describe('POST /deployments', () => {
  test('records a deployment summary event and dedupes retries', async () => {
    const app = await importDeploymentRoutes();

    const first = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(summaryBody()),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: number };
    expect(firstBody.id).toBeGreaterThan(0);

    // Retried POST (CLI network blip) returns the existing row, no new event.
    const retry = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(summaryBody()),
    });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as { id: number; deduped: boolean };
    expect(retryBody.deduped).toBe(true);
    expect(retryBody.id).toBe(firstBody.id);
  });

  test('rejects malformed apply_id and unknown status', async () => {
    const app = await importDeploymentRoutes();
    const badId = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(summaryBody({ apply_id: 'not-an-apply-id' })),
    });
    expect(badId.status).toBe(400);

    const badStatus = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(summaryBody({ status: 'exploded' })),
    });
    expect(badStatus.status).toBe(400);
  });
});

describe('GET /deployments (feed)', () => {
  test('lists deployments and standalone changes; hides apply-grouped config rows', async () => {
    const app = await importDeploymentRoutes();

    // One apply run: summary + a grouped config change.
    await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(summaryBody()),
    });
    await insertConfigEvent({
      organizationId: ORG,
      resourceKind: 'agent-settings',
      resourceId: AGENT,
      op: 'updated',
      state: { soulMd: 'v2' },
      applyId: APPLY_ID,
    });
    // One standalone UI edit.
    await insertConfigEvent({
      organizationId: ORG,
      resourceKind: 'automation',
      resourceId: 'w-1',
      op: 'created',
      state: { prompt: 'watch things' },
      actorSource: 'ui',
    });
    // Noise in another org must not leak.
    await insertConfigEvent({
      organizationId: OTHER_ORG,
      resourceKind: 'automation',
      resourceId: 'w-other',
      op: 'created',
      state: {},
    });

    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: any[]; has_more: boolean };
    expect(body.has_more).toBe(false);
    expect(body.items).toHaveLength(2);

    const types = body.items.map((i) => i.type).sort();
    expect(types).toEqual(['change', 'deployment']);

    const deployment = body.items.find((i) => i.type === 'deployment');
    expect(deployment.applyId).toBe(APPLY_ID);
    expect(deployment.status).toBe('succeeded');
    expect(deployment.gitSha).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');

    const change = body.items.find((i) => i.type === 'change');
    expect(change.resourceKind).toBe('automation');
    expect(change.actorSource).toBe('ui');
    // Feed rows never carry state snapshots.
    expect(change.before).toBeUndefined();
    expect(change.after).toBeUndefined();
  });

  test('keyset pagination pages through without overlap', async () => {
    const app = await importDeploymentRoutes();
    for (let i = 0; i < 5; i++) {
      await insertConfigEvent({
        organizationId: ORG,
        resourceKind: 'feed',
        resourceId: `f-${i}`,
        op: 'created',
        state: { i },
      });
    }

    const page1Res = await app.request('/?limit=3');
    const page1 = (await page1Res.json()) as { items: any[]; has_more: boolean };
    expect(page1.items).toHaveLength(3);
    expect(page1.has_more).toBe(true);

    const last = page1.items[page1.items.length - 1];
    const page2Res = await app.request(`/?limit=3&before_id=${last.id}`);
    const page2 = (await page2Res.json()) as { items: any[]; has_more: boolean };
    expect(page2.items).toHaveLength(2);
    expect(page2.has_more).toBe(false);

    const ids = new Set([...page1.items, ...page2.items].map((i) => i.id));
    expect(ids.size).toBe(5);
  });
});

describe('GET /deployments/:applyId (detail)', () => {
  test('returns summary + grouped changes with event-sourced before/after', async () => {
    const app = await importDeploymentRoutes();

    // Earlier standalone state for the same resource → becomes `before`.
    await insertConfigEvent({
      organizationId: ORG,
      resourceKind: 'agent-settings',
      resourceId: AGENT,
      op: 'updated',
      state: { soulMd: 'v1', networkConfig: { allowedDomains: [] } },
    });
    await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(summaryBody()),
    });
    await insertConfigEvent({
      organizationId: ORG,
      resourceKind: 'agent-settings',
      resourceId: AGENT,
      op: 'updated',
      state: { soulMd: 'v2', networkConfig: { allowedDomains: ['github.com'] } },
      applyId: APPLY_ID,
    });

    const res = await app.request(`/${APPLY_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deployment: any; changes: any[] };

    expect(body.deployment.applyId).toBe(APPLY_ID);
    expect(body.deployment.manifestHash).toBe('sha256:abc123');
    expect(body.deployment.countsByKind).toEqual({
      agent: { create: 1 },
      connection: { update: 2 },
    });

    expect(body.changes).toHaveLength(1);
    const change = body.changes[0];
    expect(change.after.soulMd).toBe('v2');
    expect(change.before.soulMd).toBe('v1');
  });

  test('does not expose unrecognized config resource kinds', async () => {
    const app = await importDeploymentRoutes();
    const eventId = await insertConfigEvent({
      organizationId: ORG,
      resourceKind: 'retired-kind',
      resourceId: 'retired-1',
      op: 'updated',
      state: { value: 'historical' },
    });

    const feedRes = await app.request('/');
    expect(feedRes.status).toBe(200);
    const feed = (await feedRes.json()) as { items: any[] };
    expect(
      feed.items.find((item) => item.id === eventId)?.resourceKind
    ).toBeNull();

    const detailRes = await app.request(`/changes/${eventId}`);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as { change: any };
    expect(detail.change.resourceKind).toBeNull();
  });

  test('404s for an unknown apply id', async () => {
    const app = await importDeploymentRoutes();
    const res = await app.request('/apl_00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });
});

describe('GET /deployments/changes/:eventId', () => {
  test('returns a standalone change with before/after', async () => {
    const app = await importDeploymentRoutes();
    await insertConfigEvent({
      organizationId: ORG,
      resourceKind: 'automation',
      resourceId: 'w-1',
      op: 'created',
      state: { prompt: 'v1' },
    });
    const secondId = await insertConfigEvent({
      organizationId: ORG,
      resourceKind: 'automation',
      resourceId: 'w-1',
      op: 'updated',
      state: { prompt: 'v2' },
    });

    const res = await app.request(`/changes/${secondId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { change: any };
    expect(body.change.after.prompt).toBe('v2');
    expect(body.change.before.prompt).toBe('v1');
    expect(body.change.op).toBe('updated');
  });
});

describe('x-lobu-apply-id end-to-end through a real mutation', () => {
  test('agent settings PATCH stamps the config event with the apply id', async () => {
    const agentApp = await importAgentRoutes();
    const config = await agentApp.request(`/${AGENT}/config`);
    expect(config.status).toBe(200);
    const original = await config.json() as { revision: string };
    expect(typeof original.revision).toBe('string');

    const patch = await agentApp.request(`/${AGENT}/config`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-lobu-apply-id': APPLY_ID,
      },
      body: JSON.stringify({ identityMd: 'Deployed identity.', expected_revision: original.revision }),
    });
    expect(patch.status).toBe(200);
    const saved = await patch.json() as { revision: string };
    expect(typeof saved.revision).toBe('string');

    const events = await waitForConfigEvents(ORG, 1);
    const metadata = events[events.length - 1].metadata as Record<string, unknown>;
    expect(metadata.resource_kind).toBe('agent-settings');
    expect(metadata.apply_id).toBe(APPLY_ID);
    expect(metadata.actor_source).toBe('cli');

    // Malformed header is ignored, not stored and not fatal.
    const patch2 = await agentApp.request(`/${AGENT}/config`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-lobu-apply-id': 'garbage !!',
      },
      body: JSON.stringify({ identityMd: 'Second write.', expected_revision: saved.revision }),
    });
    expect(patch2.status).toBe(200);
    const events2 = await waitForConfigEvents(ORG, 2);
    const metadata2 = events2[events2.length - 1].metadata as Record<string, unknown>;
    expect(metadata2.apply_id).toBeUndefined();
    // Session auth without an apply header reads as a UI edit.
    expect(metadata2.actor_source).toBe('ui');
  });
});

describe('deployment snapshots + promotions pause (lobu rollback)', () => {
  test('stores the manifest, returns it from detail, and stamps rollback_of', async () => {
    const app = await importDeploymentRoutes();
    const manifest = {
      version: 1,
      state: { agents: [], connectors: { definitions: [], authProfiles: [], connections: [] } },
      connector_versions: { 'zz.probe': '1.2.0' },
    };

    const posted = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(summaryBody({ manifest })),
    });
    expect(posted.status).toBe(201);

    const detail = await app.request(`/${APPLY_ID}`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { deployment: Record<string, any> };
    expect(body.deployment.manifest).toEqual(manifest);
    expect(body.deployment.rollbackOf).toBeNull();

    // A rollback deployment references what it restored, in detail AND feed.
    const rollbackId = 'apl_99999999-8888-7777-6666-555555555555';
    const rolled = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        summaryBody({ apply_id: rollbackId, rollback_of: APPLY_ID, manifest })
      ),
    });
    expect(rolled.status).toBe(201);
    const rolledDetail = (await (await app.request(`/${rollbackId}`)).json()) as {
      deployment: Record<string, any>;
    };
    expect(rolledDetail.deployment.rollbackOf).toBe(APPLY_ID);
    const feed = (await (await app.request('/')).json()) as {
      items: Array<Record<string, any>>;
    };
    const feedRow = feed.items.find((i) => i.applyId === rollbackId);
    expect(feedRow?.rollbackOf).toBe(APPLY_ID);
  });

  test('rejects a non-object manifest and an oversized manifest', async () => {
    const app = await importDeploymentRoutes();
    const notObject = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(summaryBody({ manifest: [1, 2, 3] })),
    });
    expect(notObject.status).toBe(400);

    const oversized = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        summaryBody({ manifest: { blob: 'x'.repeat(1_000_001) } })
      ),
    });
    expect(oversized.status).toBe(400);
  });

  test('pause lifecycle: unpaused → PUT → paused (org-scoped) → DELETE → unpaused', async () => {
    const app = await importDeploymentRoutes();

    const target = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        summaryBody({ manifest: { version: 1, state: {} } })
      ),
    });
    expect(target.status).toBe(201);

    const initial = (await (await app.request('/pause')).json()) as {
      paused: boolean;
    };
    expect(initial.paused).toBe(false);

    const set = await app.request('/pause', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apply_id: 'apl_99999999-8888-7777-6666-555555555555',
        rollback_of: APPLY_ID,
      }),
    });
    expect(set.status).toBe(200);

    const paused = (await (await app.request('/pause')).json()) as Record<string, any>;
    expect(paused.paused).toBe(true);
    expect(paused.rollbackOf).toBe(APPLY_ID);

    // Pause is org-scoped: another org is unaffected.
    authStash.organizationId = OTHER_ORG;
    const otherOrg = (await (await app.request('/pause')).json()) as { paused: boolean };
    expect(otherOrg.paused).toBe(false);
    authStash.organizationId = ORG;

    const cleared = await app.request('/pause', { method: 'DELETE' });
    expect(cleared.status).toBe(200);
    const after = (await (await app.request('/pause')).json()) as { paused: boolean };
    expect(after.paused).toBe(false);
  });

  test('pause setter rejects malformed ids and a non-restorable target', async () => {
    const app = await importDeploymentRoutes();
    const malformed = await app.request('/pause', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apply_id: 'bad', rollback_of: APPLY_ID }),
    });
    expect(malformed.status).toBe(400);

    const missing = await app.request('/pause', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apply_id: 'apl_99999999-8888-7777-6666-555555555555',
        rollback_of: APPLY_ID,
      }),
    });
    expect(missing.status).toBe(400);

    const state = (await (await app.request('/pause')).json()) as { paused: boolean };
    expect(state.paused).toBe(false);
  });
});

describe('blocked deployments + GET /deployments/latest', () => {
  test('POST accepts status=blocked with candidates', async () => {
    const app = await importDeploymentRoutes();
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        summaryBody({
          apply_id: 'apl_22222222-2222-2222-2222-222222222222',
          status: 'blocked',
          counts: { create: 0, update: 0, noop: 0, drift: 2, delete: 0 },
          candidates: {
            token: 'lobu1:tkn_abc',
            items: [{ kind: 'entity-type', slug: 'contact', action: 'delete' }],
          },
        })
      ),
    });
    expect(res.status).toBe(201);

    const detail = await app.request('/apl_22222222-2222-2222-2222-222222222222');
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as any;
    expect(body.deployment.status).toBe('blocked');
    expect(body.deployment.candidates.token).toBe('lobu1:tkn_abc');
    expect(body.deployment.candidates.items[0].slug).toBe('contact');
  });

  test('POST still rejects an unknown status', async () => {
    const app = await importDeploymentRoutes();
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(summaryBody({ status: 'exploded' })),
    });
    expect(res.status).toBe(400);
  });

  test('POST succeeded rejects a non-admin session member (forge baseline)', async () => {
    const prev = authStash.memberRole;
    authStash.memberRole = 'member';
    try {
      const app = await importDeploymentRoutes();
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          summaryBody({
            apply_id: 'apl_44444444-4444-4444-4444-444444444444',
            status: 'succeeded',
          })
        ),
      });
      expect(res.status).toBe(403);
    } finally {
      authStash.memberRole = prev;
    }
  });

  test('POST blocked still allows a non-admin session member', async () => {
    const prev = authStash.memberRole;
    authStash.memberRole = 'member';
    try {
      const app = await importDeploymentRoutes();
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          summaryBody({
            apply_id: 'apl_55555555-5555-5555-5555-555555555555',
            status: 'blocked',
            candidates: { items: [{ kind: 'entity-type', slug: 'x' }] },
          })
        ),
      });
      expect(res.status).toBe(201);
    } finally {
      authStash.memberRole = prev;
    }
  });

  test('GET /latest returns the newest succeeded deployment, ignoring blocked/standalone rows', async () => {
    const app = await importDeploymentRoutes();

    // First succeeded run.
    await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        summaryBody({
          apply_id: 'apl_33333333-3333-3333-3333-333333333333',
          manifest_hash: 'sha256:first',
        })
      ),
    });
    // A blocked run + a standalone UI edit land after it — must not shadow it.
    await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        summaryBody({
          apply_id: 'apl_44444444-4444-4444-4444-444444444444',
          status: 'blocked',
          counts: { drift: 1 },
        })
      ),
    });
    await insertConfigEvent({
      organizationId: ORG,
      resourceKind: 'automation',
      resourceId: 'w-late',
      op: 'created',
      state: {},
      actorSource: 'ui',
    });
    // A second succeeded run is the true baseline.
    await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        summaryBody({
          apply_id: 'apl_55555555-5555-5555-5555-555555555555',
          manifest_hash: 'sha256:second',
        })
      ),
    });

    const res = await app.request('/latest');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deployment: any };
    expect(body.deployment.applyId).toBe('apl_55555555-5555-5555-5555-555555555555');
    expect(body.deployment.status).toBe('succeeded');
    expect(body.deployment.manifestHash).toBe('sha256:second');
  });

  test('GET /latest returns deployment:null when no succeeded run exists', async () => {
    const app = await importDeploymentRoutes();
    const res = await app.request('/latest');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).deployment).toBeNull();
  });
});
