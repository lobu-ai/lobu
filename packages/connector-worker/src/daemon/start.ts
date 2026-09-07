/**
 * Shared device-daemon bootstrap: flag validation + worker registration + the
 * poll loop. Both the `connector-worker` binary and the `lobu daemon` command
 * call this, so the two cannot drift on validation or registration semantics.
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { isKnownPlatform } from '@lobu/core';
import {
  EXECUTION_BACKENDS,
} from '@lobu/core/contracts/worker/protocol';
import { assertExternalDepsResolvable } from '../compile/index.js';
import { buildConnectorWorkerEnv } from '../env.js';
import { assertConnectorRuntimeLoadable } from '../self-check/index.js';
import { DEVICE_MANIFESTS_BY_PLATFORM } from './device-manifests.js';
import { startDaemon, type WorkerDaemon } from './index.js';
import { log, setDebug } from './log.js';
import {
  attachInteractiveSession,
  deriveInteractiveWorkerId,
  detectInteractiveSession,
  type InteractiveSession,
} from './interactive-session.js';

/**
 * Accepted `--worker-id` shape. Deliberately narrow: the default is
 * `<platform>:<short-hostname>` (or a session-derived id in a supported
 * interactive agent), and anything a shell, a URL path, or a JSON payload
 * would mangle has no business being a durable device identity.
 */
const WORKER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface DaemonStartOptions {
  apiUrl: string;
  workerId?: string;
  version?: string;
  /** Host platform for device registration (macos, headless, …). */
  platform?: string;
  /** Device default supplied by `lobu daemon`; omitted by fleet worker callers. */
  defaultPlatform?: string;
  label?: string;
  /** Declared capability names (already comma-split). */
  capabilities?: string[];
  /** Durable `owl_pat_…` personal access token for device mode. */
  workerApiToken?: string;
  debug?: boolean;
  /** False only when the operator explicitly disables inherited-session delivery. */
  interactiveSession?: false;
  workerCredentialMaintenance?: (activate: (workerApiToken: string) => void) => Promise<void>;
  /** Active organization slug for action permission management URL. */
  activeOrg?: string;
}

export function resolveDaemonWorkerId(
  opts: Pick<DaemonStartOptions, 'workerId'>,
  platform: string | undefined,
  shortHostname: string,
  interactiveSession?: InteractiveSession
): string {
  return (
    opts.workerId ??
    (interactiveSession
      ? deriveInteractiveWorkerId(interactiveSession)
      : platform
        ? `${platform}:${shortHostname}`
        : `worker-${randomUUID().slice(0, 8)}`)
  );
}

export function resolveDaemonLaunchContext(
  opts: Pick<
    DaemonStartOptions,
    'platform' | 'defaultPlatform' | 'interactiveSession'
  >,
  env: NodeJS.ProcessEnv = process.env,
  sessionsDir?: string
): { platform: string | undefined; interactiveSession: InteractiveSession | undefined } {
  const detected =
    opts.interactiveSession === false
      ? undefined
      : (() => {
          const result = detectInteractiveSession({
            env,
            ...(sessionsDir ? { sessionsDir } : {}),
          });
          return result.ok ? result.session : undefined;
        })();
  if (detected && opts.platform && opts.platform !== 'headless') {
    // Interactive delivery registers a per-session headless device, so it can
    // never also claim the host's own platform identity.
    throw new Error(
      `an inherited interactive agent session registers as --platform headless, so it cannot be combined with --platform ${opts.platform}. Pass --no-interactive-session to register this host as a ${opts.platform} device instead.`
    );
  }
  return {
    platform: detected ? 'headless' : (opts.platform ?? opts.defaultPlatform),
    interactiveSession: detected,
  };
}

/**
 * Validate the options and boot the daemon. Throws a user-facing `Error` on
 * bad input; the caller prints it and exits non-zero.
 */
export async function startDaemonCommand(
  opts: DaemonStartOptions
): Promise<WorkerDaemon> {
  setDebug(opts.debug === true);
  const launch = resolveDaemonLaunchContext(opts);
  const detected = launch.interactiveSession;
  const platform = launch.platform;
  const { capabilities = [] } = opts;

  if (platform && !isKnownPlatform(platform)) {
    throw new Error(`unknown device platform '${platform}'`);
  }
  // `worker_id` is the device's identity: the server upserts on
  // (user_id, worker_id) and Automation pins resolve the device row through it.
  // An unusable value therefore does not fail loudly — it mints a second device
  // and the pinned Automations go quiet on this one. Reject it at boot instead.
  if (opts.workerId !== undefined && !WORKER_ID_PATTERN.test(opts.workerId)) {
    throw new Error(
      `invalid --worker-id '${opts.workerId}': expected 1-128 characters of ` +
        'letters, digits, dot, underscore, colon or hyphen'
    );
  }
  if (capabilities.length > 0 && !platform) {
    throw new Error(
      '--capabilities requires --platform so the server can authorize the device capability set'
    );
  }
  // A device daemon runs for weeks; its bearer is snapshotted once at startup.
  // `lobu whoami --json` returns `workerToken ?? accessToken`, so a user without
  // a durable agent token silently gets the OAuth SESSION token — which expires
  // in 24h. The daemon would then poll 401 forever and every scheduled run
  // would stop with no failure anywhere the user looks. Fail closed at boot.
  if (platform && !opts.workerApiToken?.startsWith('owl_pat_')) {
    throw new Error(
      'device mode requires a durable personal access token in WORKER_API_TOKEN.\n' +
        "       `lobu whoami --json` falls back to your session's OAuth access token, which\n" +
        '       expires within 24h and would leave this daemon polling 401 indefinitely.\n' +
        '       Mint a device token and pass it as WORKER_API_TOKEN (expects an owl_pat_ prefix).'
    );
  }

  // Fleet workers advertise the DB-egress contract and the agent-turn lane by
  // default; device workers advertise only their declared, server-authorized
  // capabilities. `agent_turn` is what stops a gateway that already emits the
  // new run type from handing one to a worker binary that predates the lane:
  // the two sides agree by string equality, so an old worker never matches and
  // its dispatch default (a connector sync) is never reached.
  const workerCapabilities: Record<string, boolean> = platform
    ? Object.fromEntries(capabilities.map((name) => [name, true]))
    : { db_egress_hardening: true, agent_turn: true };
  // Auto-discover device identity from the host when not passed: a device
  // worker defaults to `<platform>:<short-hostname>` and a hostname label. An
  // interactive daemon instead derives its id from the exact inherited
  // provider session, so each TUI registers its own device rather than stealing
  // the host's. Explicit --worker-id remains authoritative.
  const shortHostname = hostname().split('.')[0] || hostname();
  const workerId = resolveDaemonWorkerId(opts, platform, shortHostname, detected);
  const label = opts.label ?? (platform ? shortHostname : undefined);

  // Crash loud before the first poll if the installed runtime cannot resolve or
  // execute the same connector graph this worker is about to advertise -- with
  // one exception: on `headless` the shell builtin is the recovery primitive
  // used to REPAIR exactly this breakage, so a daemon whose compiler graph is
  // broken must still boot and advertise it.
  //
  // The compiled backend is then reported from what the probe actually found,
  // never from the platform label. `headless` is also the default platform of
  // every ordinary self-hosted `lobu daemon`, so treating the label as proof of
  // a broken compiler would close the compiled lane on healthy device workers
  // and leave their execution-pinned connections queued forever with no error.
  let compiledRuntimeReady = true;
  try {
    assertExternalDepsResolvable(createRequire(import.meta.url).resolve);
    await assertConnectorRuntimeLoadable();
  } catch (error) {
    // Second exception: under Bun `isolate/load.ts` returns null, so the only
    // executor there is cannot load however healthy the compile graph is. A
    // Bun-hosted daemon therefore boots with the compiled lane closed rather
    // than refusing to start. Every other platform still crashes loud.
    const bunHost = typeof (process.versions as { bun?: string }).bun === 'string';
    if (platform !== 'headless' && !bunHost) throw error;
    compiledRuntimeReady = false;
    log.info(
      '[cli] compiled-connector runtime unavailable; this daemon will advertise built-in operations only:',
      error
    );
  }
  const backendCapacity = {
    [EXECUTION_BACKENDS.compiledConnector]: compiledRuntimeReady ? 1 : 0,
  };
  log.info(`[cli] Starting worker daemon (ID: ${workerId}, API: ${opts.apiUrl})`);
  const env = buildConnectorWorkerEnv();
  const maxConcurrentJobs = process.env.WORKER_MAX_CONCURRENT_JOBS
    ? Math.max(1, Number.parseInt(process.env.WORKER_MAX_CONCURRENT_JOBS, 10))
    : undefined;
  if (platform) {
    log.info(
      `[cli] device mode: platform=${platform} capabilities=${capabilities.join(',') || '(none)'}`
    );
    if (opts.activeOrg) {
      const deviceUrl = `${opts.apiUrl.replace(/\/+$/, '')}/${encodeURIComponent(opts.activeOrg)}/connectors/device/${encodeURIComponent(workerId)}`;
      log.info(
        `[cli] Manage action permissions (Approval vs Auto) at: ${deviceUrl}`
      );
    }
  }
  if (detected) {
    log.info(
      `[cli] interactive-session delivery enabled for ${detected.kind}`
    );
  }

  const daemonConfig = {
    apiUrl: opts.apiUrl,
    workerId,
    version: opts.version ?? '1.0.0',
    workerApiToken: opts.workerApiToken,
    capabilities: workerCapabilities,
    ...(platform ? { platform } : {}),
    ...(label ? { label } : {}),
    ...(platform ? { manifests: DEVICE_MANIFESTS_BY_PLATFORM[platform] ?? [] } : {}),
    ...(Number.isFinite(maxConcurrentJobs) ? { maxConcurrentJobs } : {}),
    backendCapacity,
    ...(opts.workerCredentialMaintenance
      ? { workerCredentialMaintenance: opts.workerCredentialMaintenance }
      : {}),
    ...(detected
      ? {
          agentKinds: [detected.kind],
          executor: {
            defaultAgentKind: detected.kind,
          }
        }
      : {}),
  };
  if (detected) attachInteractiveSession(daemonConfig, detected);
  return startDaemon(daemonConfig, env);
}
