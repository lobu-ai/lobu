/**
 * The anonymous install ping against a real Postgres and a real HTTP receiver:
 * what it sends, that it sends nothing identifying, that every opt-out holds,
 * and that a dead endpoint never surfaces as an error.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../db/client';
import {
  installTelemetryEnabled,
  logInstallTelemetryNotice,
  sendInstallPing,
} from '../../telemetry/install-ping';
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

  it('sends one bucketed, non-identifying ping a day with a stable install id', async () => {
    const orgs = [
      await createTestOrganization({ name: 'Synthetic Telemetry Org' }),
      await createTestOrganization(),
    ];
    const env = { LOBU_TELEMETRY: '1', LOBU_TELEMETRY_URL: url, LOBU_DEPLOY_KIND: 'helm' };

    await sendInstallPing(getDb(), env);
    await sendInstallPing(getDb(), env);

    // A second process on the same UTC day has nothing to claim.
    expect(received).toHaveLength(1);
    const [first] = received;
    expect(first.install_id).toMatch(/^[0-9a-f-]{36}$/);
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

    // The next UTC day claims and sends again with the same install id.
    await getTestDb()`
      UPDATE instance_identity
         SET last_ping_day = (now() AT TIME ZONE 'UTC')::date - 1
    `;
    await sendInstallPing(getDb(), env);
    expect(received).toHaveLength(2);
    expect(received[1].install_id).toBe(first.install_id);
  });

  it('collapses concurrent replica boots into one request', async () => {
    const env = { LOBU_TELEMETRY: '1', LOBU_TELEMETRY_URL: url, LOBU_DEPLOY_KIND: 'docker' };

    await Promise.all([
      sendInstallPing(getDb(), env),
      sendInstallPing(getDb(), env),
      sendInstallPing(getDb(), env),
    ]);

    expect(received).toHaveLength(1);
    expect(await getTestDb()`SELECT 1 FROM instance_identity`).toHaveLength(1);
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
      { NODE_ENV: 'test', LOBU_INSTALL_ORIGIN: 'install' },
      { NODE_ENV: 'production', CI: 'true' },
      { NODE_ENV: 'production', LOBU_INSTALL_ORIGIN: 'checkout' },
    ]) {
      await sendInstallPing(getDb(), { ...env, LOBU_TELEMETRY_URL: url });
    }
    expect(received).toHaveLength(0);
    const rows = await getTestDb()`SELECT 1 FROM instance_identity`;
    expect(rows).toHaveLength(0);
  });

  it('counts installed runs and keeps contributor checkouts out', () => {
    expect(installTelemetryEnabled({ NODE_ENV: 'production' })).toBe(true);
    expect(installTelemetryEnabled({})).toBe(true);
    // `lobu run` from an installed package is a real install even though the
    // runtime labels the process development for local conveniences.
    expect(
      installTelemetryEnabled({ NODE_ENV: 'development', LOBU_INSTALL_ORIGIN: 'install' }),
    ).toBe(true);
    // `lobu run` from the monorepo is a contributor run.
    expect(
      installTelemetryEnabled({ NODE_ENV: 'production', LOBU_INSTALL_ORIGIN: 'checkout' }),
    ).toBe(false);
    // Explicit opt-in still wins for a checkout; DO_NOT_TRACK still wins over it.
    expect(installTelemetryEnabled({ LOBU_INSTALL_ORIGIN: 'checkout', LOBU_TELEMETRY: '1' })).toBe(
      true,
    );
    expect(
      installTelemetryEnabled({ NODE_ENV: 'production', DO_NOT_TRACK: '1' }),
    ).toBe(false);
  });

  it('a malformed LOBU_TELEMETRY_URL turns the ping off instead of failing boot', async () => {
    for (const bad of ['telemetry.internal/v1/install', 'ftp://telemetry.invalid/v1/install']) {
      const env = { LOBU_TELEMETRY: '1', LOBU_TELEMETRY_URL: bad };
      expect(() => logInstallTelemetryNotice(env)).not.toThrow();
      await expect(sendInstallPing(getDb(), env)).resolves.toBeUndefined();
    }
    expect(received).toHaveLength(0);
    expect(await getTestDb()`SELECT 1 FROM instance_identity`).toHaveLength(0);
  });

  it('a failed attempt consumes the day and stays quiet', async () => {
    await expect(
      sendInstallPing(getDb(), { LOBU_TELEMETRY: '1', LOBU_TELEMETRY_URL: 'http://127.0.0.1:9/v1/install' }),
    ).resolves.toBeUndefined();

    // The day was claimed before the attempt, so a later call today — a
    // replica boot or the heartbeat — does not retry it.
    await sendInstallPing(getDb(), { LOBU_TELEMETRY: '1', LOBU_TELEMETRY_URL: url });
    expect(received).toHaveLength(0);
  });
});
