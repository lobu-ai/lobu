/**
 * Connector-runtime env whitelist.
 *
 * A connector run receives `context.env`, which the prelude installs as
 * `process.env` inside the isolate guest.
 * The standalone `connector-worker` CLI builds this set deliberately so
 * connectors only see the env vars they actually need (GitHub token,
 * provider API keys, etc.) — never the host process's secrets.
 *
 * Used by both the standalone CLI (`bin.ts`) and the in-process embedded
 * worker (`packages/server/src/scheduled/embedded-connector-worker.ts`).
 * Lives in its own module so the embedded worker can import the helper
 * without pulling in `bin.ts`'s top-level `main()` call (which would
 * print CLI usage and `process.exit` on startup).
 */

import type { Env } from '@lobu/connector-sdk';

/** Mirror the server's isCloudMode() truthiness (1/true/yes, case-insensitive) —
 *  a bare `process.env.LOBU_CLOUD_MODE ?` would wrongly treat "0"/"false" as on.
 *  Duplicated rather than imported: connector-worker can't depend on @lobu/server. */
function cloudModeOn(): boolean {
  const v = process.env.LOBU_CLOUD_MODE?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Deployment-level provider credentials: the operator's own GitHub / Reddit /
 * Maps apps. They reach connector code the operator SHIPS — the image's
 * bundled connectors — and never code an organization uploaded. On a shared
 * fleet worker the isolate is the only boundary between a tenant's connector
 * and this env, so `withoutDeploymentProviderKeys` is what that boundary
 * withholds; the decision is made per RUN, on provenance, because a worker
 * often has no `LOBU_CLOUD_MODE` of its own (prod's fleet worker learns
 * block-private from the gateway's poll response, not from its env).
 */
export const DEPLOYMENT_PROVIDER_ENV_KEYS = [
  'GITHUB_TOKEN',
  'GOOGLE_MAPS_API_KEY',
  'REDDIT_CLIENT_ID',
  'REDDIT_CLIENT_SECRET',
] as const;

export function withoutDeploymentProviderKeys(env: Env): Env {
  const out: Record<string, string | undefined> = { ...env };
  for (const key of DEPLOYMENT_PROVIDER_ENV_KEYS) delete out[key];
  return out as Env;
}

/**
 * The env for one connector run executed IN the gateway process (inline
 * actions, webhook registration). Same whitelist a fleet worker gets — never
 * `process.env`, which would hand ENCRYPTION_KEY, DATABASE_URL and
 * WORKER_API_TOKEN to whatever code the run executes — and, under Cloud,
 * without the deployment provider keys when the code is organization-supplied.
 */
export function connectorRunEnv(opts: {
  organizationSupplied: boolean;
  cloud: boolean;
}): Record<string, string | undefined> {
  const env = buildConnectorWorkerEnv();
  return { ...(opts.cloud && opts.organizationSupplied ? withoutDeploymentProviderKeys(env) : env) };
}

/**
 * The operator's `LOBU_HTTP_EGRESS_ALLOW_HOSTS`: comma-separated EXACT hosts a
 * connector's `fetch` may reach even though they resolve into private space
 * (another container on a self-hosted Docker network). Read here, from this
 * process's env, by every producer of a connector run's `job.env` -- this
 * whitelist (worker daemon, in-gateway runs) and the gateway's source-read,
 * pushdown and listener paths. The isolate host is the one place that honours
 * it, and only for a run whose `LOBU_DB_EGRESS_POLICY` is `allow-private`, so
 * under Cloud (block-private, which the gateway's poll response forces onto any
 * worker) it is inert. Never the DB socket list: that is
 * `LOBU_DB_EGRESS_ALLOW_HOSTS`, a separate boundary.
 */
export function httpEgressAllowHostsEnv(): { LOBU_HTTP_EGRESS_ALLOW_HOSTS?: string } {
  const hosts = process.env.LOBU_HTTP_EGRESS_ALLOW_HOSTS;
  return hosts ? { LOBU_HTTP_EGRESS_ALLOW_HOSTS: hosts } : {};
}

export function buildConnectorWorkerEnv(): Env {
  return {
    ENVIRONMENT: process.env.ENVIRONMENT || 'production',
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
    REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID,
    REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET,
    REDDIT_USER_AGENT: process.env.REDDIT_USER_AGENT,
    // WORKER_API_TOKEN is deliberately absent. Everything returned here reaches
    // connector code — `buildConnectorConfig()` merges `job.env` into the
    // connector's config — and a request bearing this token authenticates as a
    // TRUSTED FLEET worker, which can claim and complete runs across tenants. The
    // daemon authenticates via `DaemonConfig.workerApiToken` instead, which
    // never enters this Env.
    // WORKER-DERIVED DEFAULT egress policy. The gateway ships its OWN
    // cloud-mode decision on the poll response (`db_egress_policy`); the daemon's
    // resolveEffectiveEnv() folds it in and takes the STRICTER of the two, so a
    // gateway that says block-private raises the floor even if this worker's
    // LOBU_CLOUD_MODE is unset (which would otherwise leave allow-private and the
    // SSRF guard OFF). This value is the fallback when the gateway response
    // predates that field. The isolate HOST refuses internal/metadata addresses
    // for a DB socket under block-private (`socketOpen` in `executor/isolate.ts`);
    // self-hosted (allow-private) reaches its own private DB.
    LOBU_DB_EGRESS_POLICY: cloudModeOn() ? 'block-private' : 'allow-private',
    ...httpEgressAllowHostsEnv(),
  };
}
