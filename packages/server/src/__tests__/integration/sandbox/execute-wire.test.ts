/**
 * `run_sdk` MCP tool round-trip through the sandbox.
 *
 * Complementary to sandbox/client-sdk-org and namespace-dispatch (which test
 * the SDK directly): this exercises the wire path — JSON-RPC → tool dispatch
 * → isolated-vm → SDK call → response shape.
 *
 * Skipped automatically if isolated-vm cannot load (e.g. local Node 25 without
 * matching prebuilds); CI pins Node 22 where the abi127 prebuild ships.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestEvent,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient, TestMcpClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase } from '../../setup/test-db';

function isolatedVmAvailable(): boolean {
  // isolated-vm ships prebuilds for abi127 (Node 22), abi137 (Node 24), and
  // isolated-vm-next for Node 26+. We can't actually try `new Isolate()` to
  // detect — on a wrong ABI it segfaults. Gate on ABI + the package being on
  // disk (bun install optional dep).
  const abi = process.versions.modules;
  const abiOk = abi === '127' || abi === '137' || abi === '147';
  if (!abiOk) return false;
  const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
  return (
    existsSync(join(root, 'node_modules/isolated-vm')) ||
    existsSync(join(root, 'node_modules/isolated-vm-next'))
  );
}

describe('sandbox run (wire)', () => {
  let orgSlug: string;
  let token: string;
  const isolatedAvailable = isolatedVmAvailable();

  beforeAll(async () => {
    await cleanupTestDatabase();

    const org = await createTestOrganization({ name: 'Sandbox Wire Org' });
    const user = await createTestUser({ email: 'sandbox-wire@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const oauthClient = await createTestOAuthClient();
    const oauthResult = await createTestAccessToken(user.id, org.id, oauthClient.client_id, {
      scope: 'mcp:read mcp:write mcp:admin',
    });

    orgSlug = org.slug;
    token = oauthResult.token;

    const seedClient = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });
    await seedClient.entity_schema.createType({
      slug: 'company',
      name: 'Company',
    });
    await seedClient.entities.create({ entity_type: 'company', name: 'Sandbox Co' });
    await seedClient.entity_schema.createType({
      slug: 'net-worth-snapshot',
      name: 'Net Worth Snapshot',
      backing: {
        sql: `SELECT
          latest.week,
          SUM(latest.net_worth_gbp) OVER () AS net_worth_gbp,
          SUM(latest.net_worth_low_gbp) OVER () AS net_worth_low_gbp,
          SUM(latest.net_worth_high_gbp) OVER () AS net_worth_high_gbp,
          latest.breakdowns,
          latest.previous,
          latest.attribution
        FROM (
          SELECT
            metadata->>'week' AS week,
            (metadata->>'net_worth_gbp')::numeric AS net_worth_gbp,
            (metadata->'net_worth_range_gbp'->>'low')::numeric AS net_worth_low_gbp,
            (metadata->'net_worth_range_gbp'->>'high')::numeric AS net_worth_high_gbp,
            metadata->'breakdowns' AS breakdowns,
            metadata->'previous' AS previous,
            metadata->'attribution' AS attribution
          FROM events
          WHERE semantic_type = 'summary'
            AND metadata->>'schema' = 'net-worth-snapshot/v4'
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ) latest`,
      },
    });
    await createTestEvent({
      organization_id: org.id,
      content: 'weekly household net worth',
      semantic_type: 'summary',
      metadata: {
        schema: 'net-worth-snapshot/v4',
        week: '2026-W33',
        net_worth_gbp: 2_685_826.12,
        net_worth_range_gbp: { low: 2_547_076.12, high: 2_839_576.12 },
        breakdowns: {
          by_source: [
            { key: 'midas', value_gbp: 805_829.74 },
            { key: 'property', value_gbp: 652_500 },
          ],
        },
        previous: { week: '2026-W32', event_id: 41, net_worth_gbp: 1_342.5 },
        attribution: { fx_gbp: 12_345.67, total_gbp: 45_678.9 },
      },
    });
  });

  it('runs a trivial script and returns its result', async (testCtx) => {
    if (!isolatedAvailable) return testCtx.skip();
    const client = new TestMcpClient({ token, orgSlug });
    const result = await client.runSdk<unknown>(
      `export default async (_ctx, _client) => ({ ok: true, n: 42 });`
    );
    const json = JSON.stringify(result);
    expect(json).toContain('"ok":true');
    expect(json).toContain('"n":42');
  });

  it('runs a script that calls into client.entities.list (real SDK round-trip)', async (testCtx) => {
    if (!isolatedAvailable) return testCtx.skip();
    const client = new TestMcpClient({ token, orgSlug });
    const result = await client.runSdk<unknown>(
      `export default async (_ctx, client) => {
         const list = await client.entities.list({ entity_type: 'company' });
         return { count: list.entities?.length ?? 0 };
       };`
    );
    const json = JSON.stringify(result);
    // We seeded one company; the script should see it.
    expect(json).toContain('"count":1');
  });

  it('run_sdk can list schedules via client.schedules.list', async (testCtx) => {
    if (!isolatedAvailable) return testCtx.skip();
    const client = new TestMcpClient({ token, orgSlug });
    const result = await client.runSdk<unknown>(
      `export default async (_ctx, client) => {
         const out = await client.schedules.list();
         return { hasSchedules: Array.isArray(out.schedules) };
       };`
    );
    expect(JSON.stringify(result)).toContain('"hasSchedules":true');
  });

  it('query_sdk can list Automations via client.automations.list', async (testCtx) => {
    if (!isolatedAvailable) return testCtx.skip();
    const client = new TestMcpClient({ token, orgSlug });
    const result = await client.querySdk<unknown>(
      `export default async (_ctx, client) => {
         const out = await client.automations.list({ status: 'active' });
				 return { hasAutomations: Array.isArray(out.automations) };
       };`
    );
    expect(JSON.stringify(result)).toContain('"hasAutomations":true');
  });

  it('run_sdk can create an agent via client.agents.create', async (testCtx) => {
    if (!isolatedAvailable) return testCtx.skip();
    const client = new TestMcpClient({ token, orgSlug });
    const result = await client.runSdk<unknown>(
      `export default async (_ctx, client) => {
         const out = await client.agents.create({
           agent_id: 'wire-test-agent',
           name: 'Wire Test Agent',
         });
         return out;
       };`,
      { timeout_ms: 15_000 }
    );
    expect(JSON.stringify(result)).toContain('"action":"create"');
  });

  it('query_sdk can list metrics via client.metrics.list', async (testCtx) => {
    if (!isolatedAvailable) return testCtx.skip();
    const client = new TestMcpClient({ token, orgSlug });
    const result = await client.querySdk<unknown>(
      `export default async (_ctx, client) => {
         const out = await client.metrics.list();
         return { hasCatalog: Array.isArray(out.entity_types) };
       };`
    );
    expect(JSON.stringify(result)).toContain('"hasCatalog":true');
  });

  it('discovers and queries net worth through the public MCP and SDK sandbox', async (testCtx) => {
    if (!isolatedAvailable) return testCtx.skip();
    const client = new TestMcpClient({ token, orgSlug });

    const discovery = JSON.stringify(await client.searchSdk({ query: 'net worth' }));
    expect(discovery).toContain('metrics.list');
    expect(discovery).toContain('metrics.query');

    const result = await client.querySdk<unknown>(
      `export default async (_ctx, client) => {
         const catalog = await client.metrics.list({ q: 'net worth' });
         const metric = catalog.entity_types.find(
           (entry) => entry.entity_type === 'net-worth-snapshot'
         );
         const snapshot = await client.metrics.query({
           entity_type: 'net-worth-snapshot',
           measure: 'net_worth_gbp',
           by: ['week', 'breakdowns', 'previous', 'attribution'],
         });
         const low = await client.metrics.query({
           entity_type: 'net-worth-snapshot',
           measure: 'net_worth_low_gbp',
         });
         const high = await client.metrics.query({
           entity_type: 'net-worth-snapshot',
           measure: 'net_worth_high_gbp',
         });
         return {
           measures: metric?.measures.map((measure) => measure.name),
           snapshot: snapshot.rows[0],
           low: low.rows[0]?.net_worth_low_gbp,
           high: high.rows[0]?.net_worth_high_gbp,
         };
       };`
    );
    const json = JSON.stringify(result);
    expect(json).toContain('"net_worth_gbp":"2685826.12"');
    expect(json).toContain('"low":"2547076.12"');
    expect(json).toContain('"high":"2839576.12"');
    expect(json).toContain('"key":"midas"');
    expect(json).toContain('"week":"2026-W32"');
    expect(json).toContain('"fx_gbp":12345.67');
  });

  it('run_sdk can list agents via client.agents.list', async (testCtx) => {
    if (!isolatedAvailable) return testCtx.skip();
    const client = new TestMcpClient({ token, orgSlug });
    const result = await client.runSdk<unknown>(
      `export default async (_ctx, client) => {
         const out = await client.agents.list();
         return { action: out.action, n: out.agents?.length ?? 0 };
       };`
    );
    const json = JSON.stringify(result);
    expect(json).toContain('"action":"list"');
    expect(json).toMatch(/"n":\d+/);
  });
});
