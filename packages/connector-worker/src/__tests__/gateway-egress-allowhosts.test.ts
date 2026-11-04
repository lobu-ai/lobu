import { describe, expect, test } from 'bun:test';
import type { Env } from '@lobu/connector-sdk';
import type { PollResponse } from '../daemon/client.js';
import { resolveEffectiveEnv } from '../daemon/executor.js';
import { buildConnectorWorkerEnv } from '../env.js';
import { buildConnectorConfig } from '../executor/connector-config.js';

/**
 * The operator's DB egress allow-host list rides the SAME gateway-authoritative
 * channel as `db_egress_policy`. It must REPLACE any worker-local list, never
 * union with it — unioning would let a compromised or misconfigured fleet worker
 * widen its own egress boundary, which is exactly the downgrade the policy
 * ratchet exists to prevent.
 */
describe('resolveEffectiveEnv — allow-host list is gateway-authoritative', () => {
  const job = (allow?: string): PollResponse =>
    ({
      run_id: 1,
      run_type: 'sync',
      connector_key: 'postgres',
      db_egress_policy: 'block-private',
      db_egress_allow_hosts: allow,
    }) as PollResponse;

  test("the gateway's list is installed into the child env", () => {
    const out = resolveEffectiveEnv({} as Env, job('100.127.177.56'));
    expect(out.LOBU_DB_EGRESS_ALLOW_HOSTS).toBe('100.127.177.56');
  });

  test('a worker-local list is DISCARDED when the gateway ships none', () => {
    const workerEnv = { LOBU_DB_EGRESS_ALLOW_HOSTS: '10.0.0.5' } as unknown as Env;
    const out = resolveEffectiveEnv(workerEnv, job(undefined));
    expect(out.LOBU_DB_EGRESS_ALLOW_HOSTS).toBe('');
  });

  test('a worker cannot ADD entries to the gateway list', () => {
    const workerEnv = { LOBU_DB_EGRESS_ALLOW_HOSTS: '169.254.169.254,10.0.0.5' } as unknown as Env;
    const out = resolveEffectiveEnv(workerEnv, job('100.127.177.56'));
    expect(out.LOBU_DB_EGRESS_ALLOW_HOSTS).toBe('100.127.177.56');
    expect(out.LOBU_DB_EGRESS_ALLOW_HOSTS).not.toContain('10.0.0.5');
  });
});

/**
 * End-to-end of the CLOUD path: the worker's own env whitelist
 * (`buildConnectorWorkerEnv`) deliberately does NOT carry an allow-host list —
 * the gateway is the only source. These assert the full fold: poll response →
 * effective env → authoritative child config, with tenant config unable to win.
 */
describe('cloud path — gateway list reaches the connector config', () => {
  test('worker env whitelist carries no allow-host list of its own', () => {
    const env = buildConnectorWorkerEnv() as Record<string, unknown>;
    expect(env.LOBU_DB_EGRESS_ALLOW_HOSTS).toBeUndefined();
  });

  test('tenant config cannot override the gateway allow-host list', () => {
    const gatewayJob = {
      run_id: 1,
      run_type: 'sync',
      connector_key: 'postgres',
      db_egress_policy: 'block-private',
      db_egress_allow_hosts: '100.127.177.56',
    } as PollResponse;
    const effective = resolveEffectiveEnv({} as Env, gatewayJob);
    const config = buildConnectorConfig({
      config: {
        // A malicious tenant trying to widen its own boundary.
        LOBU_DB_EGRESS_ALLOW_HOSTS: '169.254.169.254',
        LOBU_DB_EGRESS_POLICY: 'allow-private',
      },
      env: effective as unknown as Record<string, string | undefined>,
    });
    expect(config.LOBU_DB_EGRESS_ALLOW_HOSTS).toBe('100.127.177.56');
    expect(config.LOBU_DB_EGRESS_POLICY).toBe('block-private');
  });
});

/**
 * The HTTP allow-host list is the worker OPERATOR's (its own env, through the
 * whitelist the daemon hands every run), not the gateway's — but the isolate
 * honours it only under `allow-private`, so the gateway's authoritative
 * block-private must still win over a worker that carries one.
 */
describe('daemon path — LOBU_HTTP_EGRESS_ALLOW_HOSTS', () => {
  const pollJob = (policy?: 'block-private' | 'allow-private'): PollResponse =>
    ({ run_id: 1, run_type: 'sync', connector_key: 'http-source', db_egress_policy: policy }) as PollResponse;

  test('rides from the worker env into the run env, and a block-private gateway neutralizes it', () => {
    const saved = { hosts: process.env.LOBU_HTTP_EGRESS_ALLOW_HOSTS, cloud: process.env.LOBU_CLOUD_MODE };
    process.env.LOBU_HTTP_EGRESS_ALLOW_HOSTS = 'inventory-api';
    delete process.env.LOBU_CLOUD_MODE;
    try {
      const selfHosted = resolveEffectiveEnv(buildConnectorWorkerEnv(), pollJob('allow-private')) as Record<string, unknown>;
      expect(selfHosted.LOBU_HTTP_EGRESS_ALLOW_HOSTS).toBe('inventory-api');
      expect(selfHosted.LOBU_DB_EGRESS_POLICY).toBe('allow-private');

      const cloud = resolveEffectiveEnv(buildConnectorWorkerEnv(), pollJob('block-private')) as Record<string, unknown>;
      expect(cloud.LOBU_DB_EGRESS_POLICY).toBe('block-private');
    } finally {
      for (const [key, value] of [['LOBU_HTTP_EGRESS_ALLOW_HOSTS', saved.hosts], ['LOBU_CLOUD_MODE', saved.cloud]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
