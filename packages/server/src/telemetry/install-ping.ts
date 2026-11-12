/**
 * Anonymous install ping: once a day, one request per installation telling
 * Lobu which version is running and roughly how much it is used.
 *
 * Cadence and cross-replica dedup come from the TaskScheduler cron (one row
 * per tick, deduped by idempotency key), so N replicas still send one ping.
 * The install id lives in `instance_identity`, created by the first ping.
 *
 * Privacy contract (docs/DOCKER.md#anonymous-usage-telemetry): no hostnames,
 * URLs, emails, names, slugs or exact usage counts — counts are bucketed. The
 * ping is best-effort: one attempt, a short timeout, and every failure is
 * swallowed so it can never retry, block or slow the server.
 */

import os from 'node:os';
import { type DbClient, getDb } from '../db/client';
import { isCloudMode } from '../utils/cloud-mode';
import logger from '../utils/logger';
import { getRuntimeInfo } from '../utils/runtime-info';
import { organizationLiveSql } from '../workspace/deletion-state';

const DEFAULT_INSTALL_PING_URL = 'https://telemetry.lobu.ai/v1/install';
const SEND_TIMEOUT_MS = 5_000;
/** Counting stops here: the top bucket is "21+", so more rows add nothing. */
const COUNT_CAP = 21;
/** The pool name every server process connects with (db/client.ts). */
const SERVER_APPLICATION_NAME = 'server';
const DEPLOY_KINDS = new Set(['docker', 'helm', 'cli', 'mac']);

type Env = Record<string, string | undefined>;

export type CountBucket = '0' | '1-5' | '6-20' | '21+';

export interface InstallPing {
  schema: 1;
  install_id: string;
  version: string;
  git_sha: string;
  deploy_kind: string;
  os: string;
  arch: string;
  uptime_bucket: string;
  node_count: number;
  counts: {
    organizations: CountBucket;
    users: CountBucket;
    agents: CountBucket;
    connections: CountBucket;
    automations: CountBucket;
    automation_runs_7d: CountBucket;
  };
}

function flag(value: string | undefined): 'on' | 'off' | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return 'on';
  if (['0', 'false', 'no', 'off'].includes(normalized)) return 'off';
  return undefined;
}

/**
 * On by default for self-hosted installs. `DO_NOT_TRACK` and the hosted cloud
 * (`LOBU_CLOUD_MODE`) always switch it off; an explicit `LOBU_TELEMETRY`
 * decides next; otherwise development, test and CI processes stay quiet so
 * contributors and pipelines are never counted as installs.
 */
export function installTelemetryEnabled(env: Env = process.env): boolean {
  if (flag(env.DO_NOT_TRACK) === 'on' || isCloudMode(env)) return false;
  const explicit = flag(env.LOBU_TELEMETRY);
  if (explicit) return explicit === 'on';
  if (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') return false;
  if (flag(env.CI) === 'on') return false;
  return true;
}

/** The ping endpoint, or null when `LOBU_TELEMETRY_URL` is not a valid http(s) URL. */
export function installPingUrl(env: Env = process.env): URL | null {
  try {
    const url = new URL(env.LOBU_TELEMETRY_URL?.trim() || DEFAULT_INSTALL_PING_URL);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

export function bucketCount(count: number): CountBucket {
  if (count <= 0) return '0';
  if (count <= 5) return '1-5';
  if (count <= 20) return '6-20';
  return '21+';
}

function uptimeBucket(seconds: number): string {
  const days = seconds / 86_400;
  if (days < 1) return '<1d';
  if (days < 7) return '1-7d';
  if (days < 30) return '7-30d';
  return '30d+';
}

async function ensureInstallId(sql: DbClient): Promise<string> {
  await sql`INSERT INTO instance_identity DEFAULT VALUES ON CONFLICT (singleton) DO NOTHING`;
  const [row] = await sql<{ install_id: string }>`SELECT install_id FROM instance_identity`;
  return row.install_id;
}

export async function buildInstallPing(
  sql: DbClient = getDb(),
  env: Env = process.env,
): Promise<InstallPing> {
  const installId = await ensureInstallId(sql);
  // Each count reads at most COUNT_CAP rows: the bucket is all that is sent.
  const [counts] = await sql<
    {
      organizations: number;
      users: number;
      agents: number;
      connections: number;
      automations: number;
      automation_runs_7d: number;
      node_count: number;
    }
  >`
    SELECT
      (SELECT count(*) FROM (SELECT 1 FROM organization o
         WHERE ${sql.unsafe(organizationLiveSql('o'))} LIMIT ${COUNT_CAP}) s)::int AS organizations,
      (SELECT count(*) FROM (SELECT 1 FROM "user" LIMIT ${COUNT_CAP}) s)::int AS users,
      (SELECT count(*) FROM (SELECT 1 FROM agents LIMIT ${COUNT_CAP}) s)::int AS agents,
      (SELECT count(*) FROM (SELECT 1 FROM connections
         WHERE deleted_at IS NULL LIMIT ${COUNT_CAP}) s)::int AS connections,
      (SELECT count(*) FROM (SELECT 1 FROM automations
         WHERE status = 'active' LIMIT ${COUNT_CAP}) s)::int AS automations,
      (SELECT count(*) FROM (SELECT 1 FROM runs
         WHERE run_type = 'automation' AND created_at > now() - interval '7 days'
         LIMIT ${COUNT_CAP}) s)::int AS automation_runs_7d,
      -- Server processes connected right now. Each replica connects from its
      -- own address; local socket connections have none and count as one.
      (SELECT count(DISTINCT coalesce(host(client_addr), 'local'))
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND application_name = ${SERVER_APPLICATION_NAME})::int AS node_count
  `;
  const runtime = getRuntimeInfo();
  const deployKind = env.LOBU_DEPLOY_KIND?.trim().toLowerCase() ?? '';
  return {
    schema: 1,
    install_id: installId,
    version: runtime.version,
    git_sha: runtime.revision,
    deploy_kind: DEPLOY_KINDS.has(deployKind) ? deployKind : 'other',
    os: os.platform(),
    arch: os.arch(),
    uptime_bucket: uptimeBucket(process.uptime()),
    node_count: counts.node_count,
    counts: {
      organizations: bucketCount(counts.organizations),
      users: bucketCount(counts.users),
      agents: bucketCount(counts.agents),
      connections: bucketCount(counts.connections),
      automations: bucketCount(counts.automations),
      automation_runs_7d: bucketCount(counts.automation_runs_7d),
    },
  };
}

/** Builds and sends one ping. Never throws and never asks for a retry. */
export async function sendInstallPing(
  sql: DbClient = getDb(),
  env: Env = process.env,
): Promise<void> {
  const url = installPingUrl(env);
  if (!installTelemetryEnabled(env) || !url) return;
  try {
    const ping = await buildInstallPing(sql, env);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ping),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    logger.debug({ status: response.status }, '[telemetry] install ping sent');
  } catch (error) {
    logger.debug({ error }, '[telemetry] install ping failed; skipping until tomorrow');
  }
}

/** One line per boot, so the default is never silent. Never throws. */
export function logInstallTelemetryNotice(env: Env = process.env): void {
  if (!installTelemetryEnabled(env)) return;
  const url = installPingUrl(env);
  if (!url) {
    logger.warn('LOBU_TELEMETRY_URL is not a valid http(s) URL; the anonymous install ping is off.');
    return;
  }
  logger.info(
    `Anonymous install telemetry is on: one daily ping to ${url.host} with the version and bucketed usage counts, no identifying data. Set LOBU_TELEMETRY=0 to turn it off. See docs/DOCKER.md#anonymous-usage-telemetry.`,
  );
}
