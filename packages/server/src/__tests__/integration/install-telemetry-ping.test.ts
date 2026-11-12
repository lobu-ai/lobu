/**
 * The anonymous install ping against a real Postgres and a real HTTP receiver:
 * what it sends, that it sends nothing identifying, that every opt-out holds,
 * and that a dead endpoint never surfaces as an error.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../db/client';
import { installTelemetryEnabled, sendInstallPing } from '../../telemetry/install-ping';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization } from '../setup/test-fixtures';

describe('install telemetry ping', () => {
  const received: Array<Record<string, unknown>> = [];
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/install`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    await getTestDb()`DELETE FROM instance_identity`;
    received.length = 0;
  });

  it('sends one bucketed, non-identifying ping with a stable install id', async () => {
    const orgs = [
      await createTestOrganization({ name: 'Synthetic Telemetry Org' }),
      await createTestOrganization(),
    ];
    const env = { LOBU_TELEMETRY: '1', LOBU_TELEMETRY_URL: url, LOBU_DEPLOY_KIND: 'helm' };

    await sendInstallPing(getDb(), env);
    await sendInstallPing(getDb(), env);

    expect(received).toHaveLength(2);
    const [first, second] = received;
    expect(first.install_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.install_id).toBe(first.install_id);
    expect(first).toMatchObject({
      schema: 1,
      deploy_kind: 'helm',
      counts: { organizations: '1-5', automations: '0', automation_runs_7d: '0' },
    });
    expect(first.node_count).toBeGreaterThanOrEqual(1);

    const body = JSON.stringify(first);
    for (const org of orgs) {
      expect(body).not.toContain(org.id);
      expect(body).not.toContain(org.slug);
      expect(body).not.toContain(org.name);
    }
  });

  it('an unknown deploy kind is reported as other, never echoed', async () => {
    await sendInstallPing(getDb(), {
      LOBU_TELEMETRY: '1',
      LOBU_TELEMETRY_URL: url,
      LOBU_DEPLOY_KIND: 'acme-prod-cluster',
    });
    expect(received[0].deploy_kind).toBe('other');
  });

  it('every opt-out sends nothing and creates no install id', async () => {
    for (const env of [
      { LOBU_TELEMETRY: '0', NODE_ENV: 'production' },
      { DO_NOT_TRACK: '1', LOBU_TELEMETRY: '1' },
      { LOBU_CLOUD_MODE: '1', LOBU_TELEMETRY: '1' },
      { NODE_ENV: 'development' },
      { NODE_ENV: 'test' },
      { NODE_ENV: 'production', CI: 'true' },
    ]) {
      await sendInstallPing(getDb(), { ...env, LOBU_TELEMETRY_URL: url });
    }
    expect(received).toHaveLength(0);
    const rows = await getTestDb()`SELECT 1 FROM instance_identity`;
    expect(rows).toHaveLength(0);
  });

  it('is on by default for a production process', () => {
    expect(installTelemetryEnabled({ NODE_ENV: 'production' })).toBe(true);
    expect(installTelemetryEnabled({})).toBe(true);
  });

  it('an unreachable endpoint resolves quietly', async () => {
    await expect(
      sendInstallPing(getDb(), { LOBU_TELEMETRY: '1', LOBU_TELEMETRY_URL: 'http://127.0.0.1:9/v1/install' }),
    ).resolves.toBeUndefined();
  });
});
