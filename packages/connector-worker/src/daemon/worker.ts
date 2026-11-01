/**
 * Worker Daemon
 *
 * Main daemon loop that polls for jobs and executes them.
 */

import type { Env } from '@lobu/connector-sdk';
import type { AgentKind } from '@lobu/core/contracts/worker/device-automation';
import { type WorkerCapabilities, WorkerClient } from './client.js';
import { type ExecutorConfig, executeRun } from './executor.js';
import {
  attachedInteractiveSession,
  attachInteractiveSession,
} from './interactive-session.js';
import { installWorkerPollLoopSignals, WorkerPollLoop } from './poll-loop.js';
import { ResourceAdmission } from './resource-admission.js';

export interface DaemonConfig {
  apiUrl: string;
  workerId: string;
  workerApiToken?: string;
  capabilities?: WorkerCapabilities;
  pollIntervalMs?: number;
  maxConcurrentJobs?: number;
  /** Separate agent-turn budget; see `WorkerPollLoopOptions`. */
  maxConcurrentAgentTurns?: number;
  executor?: Partial<ExecutorConfig>;
  version?: string;
  /** Set only for a device worker; cloud-fleet daemons leave this undefined. */
  platform?: string;
  /** Human-readable device name for the Devices page. */
  label?: string;
  /** Device-manifest connector definitions to register on each poll. */
  manifests?: unknown[];
  /** Fixed advertisement for an exact interactive session. */
  agentKinds?: AgentKind[];
  workerCredentialMaintenance?: (activate: (workerApiToken: string) => void) => Promise<void>;
  /** Backend capacities advertised to the gateway. */
  backendCapacity?: Record<string, number>;
}

const DEFAULT_CAPABILITIES: WorkerCapabilities = {};
const DEFAULT_EXECUTOR_TIMEOUT_MS = 600000;

/**
 * Worker Daemon
 *
 * Polls for jobs from the backend and executes them.
 */
export class WorkerDaemon {
  private client: WorkerClient;
  private env: Env;
  private config: { executor: Partial<ExecutorConfig> };
  private pollLoop: WorkerPollLoop;
  private shutdownController: AbortController;

  constructor(daemonConfig: DaemonConfig, env: Env) {
    const interactiveSession = attachedInteractiveSession(daemonConfig);
    const credentialMaintenance = daemonConfig.workerCredentialMaintenance;
    this.client = new WorkerClient({
      apiUrl: daemonConfig.apiUrl,
      workerId: daemonConfig.workerId,
      authToken: daemonConfig.workerApiToken,
      capabilities: daemonConfig.capabilities ?? DEFAULT_CAPABILITIES,
      version: daemonConfig.version,
      platform: daemonConfig.platform,
      label: daemonConfig.label,
      manifests: daemonConfig.manifests,
      // The poll advertisement and the spawn path must resolve the same
      // binaries, or the device advertises a kind it then fails to launch.
      binaryOverrides: daemonConfig.executor?.binaryOverrides,
      agentKinds: daemonConfig.agentKinds,
      backendCapacity: daemonConfig.backendCapacity,
    });

    this.env = env;
    // Always present: the daemon builtin cancels an in-flight shell command on
    // shutdown, so the signal can no longer be scoped to interactive sessions.
    this.shutdownController = new AbortController();
    const executor = {
      timeoutMs: DEFAULT_EXECUTOR_TIMEOUT_MS,
      ...(daemonConfig.executor ?? {}),
      shutdownSignal: this.shutdownController.signal,
    };
    if (interactiveSession) attachInteractiveSession(executor, interactiveSession);
    this.config = {
      executor,
    };
    this.pollLoop = new WorkerPollLoop({
      client: this.client,
      pollIntervalMs: daemonConfig.pollIntervalMs,
      maxConcurrentJobs: daemonConfig.maxConcurrentJobs,
      maxConcurrentAgentTurns: daemonConfig.maxConcurrentAgentTurns,
      resourceAdmission: !daemonConfig.platform && daemonConfig.maxConcurrentAgentTurns !== undefined
        ? new ResourceAdmission() : undefined,
      execute: (job) => executeRun(this.client, job, this.env, this.config.executor),
      ...(credentialMaintenance
        ? {
            beforeIdlePoll: () =>
              credentialMaintenance((token) => this.client.replaceAuthToken(token)),
            failClosedOnPollAuthError: true,
          }
        : {}),
    });
  }

  /**
   * Start the daemon
   */
  async start(): Promise<void> {
    await this.pollLoop.start();
  }

  installShutdownSignals(): void {
    installWorkerPollLoopSignals(this.pollLoop, () => this.stop(), { stdinEof: false });
  }

  /**
   * Stop the daemon
   */
  stop(): void {
    this.pollLoop.stop();
    this.shutdownController.abort();
  }

  /**
   * Wait for all active jobs to finish, with a timeout.
   * Returns true if all jobs completed, false if timed out.
   */
  async waitForActiveJobs(timeoutMs = 30000, pollMs = 500): Promise<boolean> {
    return this.pollLoop.waitForActiveJobs(timeoutMs, pollMs);
  }
}

/**
 * Start the worker daemon
 */
export async function startDaemon(config: DaemonConfig, env: Env): Promise<WorkerDaemon> {
  const daemon = new WorkerDaemon(config, env);
  daemon.installShutdownSignals();
  await daemon.start();
  return daemon;
}
