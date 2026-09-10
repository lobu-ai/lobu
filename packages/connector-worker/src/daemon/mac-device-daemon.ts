import { hostname } from 'node:os';
import {
  AGENT_KINDS,
  type AgentKind,
} from '@lobu/core/contracts/worker/device-automation';
import type { PollResponse } from '@lobu/core/contracts/worker/protocol';
import { executeAutomationRun, type AutomationExecutorConfig } from './automation.js';
import { executeDeviceChatRun } from './device-chat.js';
import type { AutomationAcpAdapters } from './automation-acp.js';
import {
  locateBinary,
  resolveRunnableAgentKinds,
  supportsOpenCodeAcp,
} from './agent-binaries.js';
import {
  MutableWorkerAdvertisementProvider,
  WorkerClient,
  type WorkerCapabilities,
} from './client.js';
import { installWorkerPollLoopSignals, WorkerPollLoop } from './poll-loop.js';
import { setDebug } from './log.js';
import { NativeBridgeClient } from './native-bridge/client.js';
import { executeNativeBridgeRun } from './native-bridge/executor.js';
import { NATIVE_BRIDGE_PROTOCOL } from './native-bridge/protocol.js';
import { reportTerminalFailure } from './terminal-failure.js';

export const MAC_DEVICE_PLATFORM = 'macos';
const WORKER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const WORKER_PAT_PATTERN = /^owl_pat_[A-Za-z0-9_-]{32}$/;
const DEFAULT_POLL_INTERVAL_MS = 10000;
// Source reads default to a ten-second end-to-end deadline. Keep the signed
// Mac daemon's claim latency well below that even when the server returns its
// normal ten-second idle hint.
const SOURCE_READ_IDLE_DELAY_CEILING_MS = 1000;
const DEFAULT_MAX_CONCURRENT_JOBS = 1;
const NATIVE_BRIDGE_SHUTDOWN_TIMEOUT_MS = 5000;
export const INTERNAL_ACP_ADAPTER_ARG = '--internal-acp-adapter';

export interface MacDeviceDaemonOptions {
  apiUrl?: string;
  workerId?: string;
  workerApiToken?: string;
  version: string;
  pollIntervalMs?: number;
  maxConcurrentJobs?: number;
  defaultAgentKind?: AgentKind;
  debug?: boolean;
  noPoll?: boolean;
  supervisedStdio?: boolean;
}

export interface MacDeviceDaemonMetadata {
  name: 'lobu-device-daemon';
  version: string;
  protocol: typeof NATIVE_BRIDGE_PROTOCOL;
  platform: typeof MAC_DEVICE_PLATFORM;
  artifact: 'standalone-bun-macho-arm64';
}

export function macDeviceDaemonMetadata(version: string): MacDeviceDaemonMetadata {
  return {
    name: 'lobu-device-daemon',
    version,
    protocol: NATIVE_BRIDGE_PROTOCOL,
    platform: MAC_DEVICE_PLATFORM,
    artifact: 'standalone-bun-macho-arm64',
  };
}

function defaultWorkerId(): string {
  const shortHostname = hostname().split('.')[0] || hostname();
  return `${MAC_DEVICE_PLATFORM}:${shortHostname}`;
}

/**
 * Argv for re-entering this daemon's own entrypoint. A compiled artifact is its
 * own interpreter, so the internal argument stands alone; running from source
 * needs the script path back in front of it.
 */
export function packagedDaemonArgs(...args: string[]): string[] {
  return process.argv[1] && /\.[cm]?[jt]s$/.test(process.argv[1])
    ? [process.argv[1], ...args]
    : args;
}

function validateNumber(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got '${value}')`);
  }
  return value;
}

function validateAgentKind(value: AgentKind | undefined): AgentKind | undefined {
  if (value === undefined) return undefined;
  if (!(AGENT_KINDS as readonly string[]).includes(value)) {
    throw new Error(`invalid --default-agent-kind '${value}' (expected ${AGENT_KINDS.join(', ')})`);
  }
  return value;
}

export function selectMacDeviceDaemonAgentKind(
  runnableAgentKinds: readonly AgentKind[],
  explicitAgentKind?: AgentKind
): AgentKind | undefined {
  if (explicitAgentKind !== undefined) {
    if (!runnableAgentKinds.includes(explicitAgentKind)) {
      throw new Error(
        `--default-agent-kind '${explicitAgentKind}' is not runnable on this machine (available: ${runnableAgentKinds.join(', ') || 'none'})`
      );
    }
    return explicitAgentKind;
  }
  return runnableAgentKinds[0];
}

export function createMacDeviceDaemonShutdown(
  controller: AbortController,
  loop: WorkerPollLoop,
  bridge?: NativeBridgeClient,
  shutdownTimeoutMs = NATIVE_BRIDGE_SHUTDOWN_TIMEOUT_MS
): () => Promise<void> {
  return async () => {
    loop.stop();
    controller.abort();
    if (!bridge) return;

    let shutdownError: unknown;
    const deadline = Date.now() + shutdownTimeoutMs;
    try {
      await withTimeout(
        bridge.cancelActiveRuns(),
        Math.max(1, deadline - Date.now()),
        'native bridge cancellation',
      );
    } catch (error) {
      shutdownError = error;
    }
    try {
      await withTimeout(
        bridge.shutdown(),
        Math.max(1, deadline - Date.now()),
        'native bridge shutdown',
      );
    } catch (error) {
      shutdownError ??= error;
    }
    // The app may close the transport as soon as it has acknowledged the
    // shutdown frame, so keep the writer alive until the shared poll-loop
    // shutdown handler observes terminal failures from active jobs.
    bridge.close(new Error('native bridge daemon shutdown'));
    if (shutdownError) throw shutdownError;
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(resolve, reject).finally(() => {
      if (timer) clearTimeout(timer);
    });
  });
}

export function validateMacDeviceDaemonOptions(
  options: MacDeviceDaemonOptions
): Required<Pick<MacDeviceDaemonOptions, 'apiUrl' | 'workerId' | 'workerApiToken'>> &
  Omit<MacDeviceDaemonOptions, 'apiUrl' | 'workerId' | 'workerApiToken'> {
  const workerId = options.workerId?.trim() || defaultWorkerId();
  if (!WORKER_ID_PATTERN.test(workerId)) {
    throw new Error(
      `invalid --worker-id '${workerId}': expected 1-128 characters of letters, digits, dot, underscore, colon or hyphen`
    );
  }
  const pollIntervalMs = validateNumber(options.pollIntervalMs, '--poll-interval-ms');
  const maxConcurrentJobs = validateNumber(
    options.maxConcurrentJobs,
    '--max-concurrent-jobs'
  );
  const defaultAgentKind = validateAgentKind(options.defaultAgentKind);

  const apiUrl = options.apiUrl?.trim();
  if (apiUrl) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(apiUrl);
    } catch {
      throw new Error(`invalid --api-url '${apiUrl}': expected an absolute http(s) URL`);
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`invalid --api-url '${apiUrl}': expected an http(s) URL`);
    }
  }

  if (options.noPoll) {
    return {
      ...options,
      apiUrl: apiUrl ?? '',
      workerId,
      workerApiToken: options.workerApiToken?.trim() ?? '',
      ...(pollIntervalMs ? { pollIntervalMs } : {}),
      ...(maxConcurrentJobs ? { maxConcurrentJobs } : {}),
      ...(defaultAgentKind ? { defaultAgentKind } : {}),
    };
  }

  if (!apiUrl) throw new Error('--api-url or API_URL is required unless --no-poll is set');

  const workerApiToken = options.workerApiToken?.trim();
  if (!workerApiToken || !WORKER_PAT_PATTERN.test(workerApiToken)) {
    throw new Error(
      'device mode requires WORKER_API_TOKEN in the form owl_pat_<32 base64url characters>; session OAuth tokens are not durable'
    );
  }

  return {
    ...options,
    apiUrl,
    workerId,
    workerApiToken,
    pollIntervalMs: pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    maxConcurrentJobs: maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS,
    ...(defaultAgentKind ? { defaultAgentKind } : {}),
  };
}

async function rejectUnsupportedRun(client: WorkerClient, job: PollResponse): Promise<void> {
  const message = `macOS device daemon does not execute run_type '${job.run_type ?? 'unknown'}'; no native connector capabilities are advertised`;
  await reportTerminalFailure(client, job, message, 'error_message');
}

async function rejectUnadvertisedConnector(
  client: WorkerClient,
  job: PollResponse
): Promise<void> {
  const message = `macOS device daemon advertises no native implementation of '${job.connector_key ?? 'unknown'}'`;
  await reportTerminalFailure(client, job, message, 'error_message');
}

/**
 * Whether the native bridge implements this run's connector.
 *
 * The daemon answers from the inventory the Mac app itself declared over the
 * bridge — the same manifests it advertises to the gateway — so what it will
 * execute and what it claims to offer cannot drift apart. It used to answer
 * from a routing marker the gateway derived from the connector manifest, which
 * meant the implementation had to be written into the manifest and hashed into
 * the contract's identity; a contract carrying its implementation cannot be
 * shared with a second endpoint.
 *
 * A payload carrying `compiled_code` is not bridge work by construction: the
 * gateway ships code only for connectors the device does NOT implement.
 */
export function bridgeImplementsRun(
  job: PollResponse,
  advertisementProvider: MutableWorkerAdvertisementProvider | undefined
): boolean {
  if (!job.connector_key || job.compiled_code) return false;
  const manifests = advertisementProvider?.snapshot().manifests ?? [];
  return manifests.some(
    (manifest) =>
      typeof manifest === 'object' &&
      manifest !== null &&
      (manifest as { key?: unknown }).key === job.connector_key
  );
}

export function createMacDeviceDaemon(
  options: MacDeviceDaemonOptions,
  dependencies: {
    advertisementProvider?: MutableWorkerAdvertisementProvider;
    bridge?: NativeBridgeClient;
    shutdownController?: AbortController;
  } = {}
): WorkerPollLoop {
  const validated = validateMacDeviceDaemonOptions(options);
  if (validated.noPoll) throw new Error('cannot create a polling daemon with --no-poll');

  const discoveredAgentKinds = resolveRunnableAgentKinds();
  const codexPath = discoveredAgentKinds.includes('codex') ? locateBinary('codex') : null;
  const claudePath = discoveredAgentKinds.includes('claude-code') ? locateBinary('claude') : null;
  const discoveredOpenCodePath = discoveredAgentKinds.includes('opencode')
    ? locateBinary('opencode')
    : null;
  const openCodePath =
    discoveredOpenCodePath && supportsOpenCodeAcp(discoveredOpenCodePath)
      ? discoveredOpenCodePath
      : null;
  const runnableAgentKinds = discoveredAgentKinds.filter(
    (kind) => kind !== 'opencode' || openCodePath !== null
  );
  const defaultAgentKind = selectMacDeviceDaemonAgentKind(
    runnableAgentKinds,
    validated.defaultAgentKind
  );
  const shutdownController = dependencies.shutdownController ?? new AbortController();
  const nativeBridge = dependencies.bridge;

  const client = new WorkerClient({
    apiUrl: validated.apiUrl,
    workerId: validated.workerId,
    authToken: validated.workerApiToken,
    capabilities: { 'automations.execute': true } satisfies WorkerCapabilities,
    version: validated.version,
    platform: MAC_DEVICE_PLATFORM,
    agentKinds: runnableAgentKinds,
    ...(dependencies.advertisementProvider
      ? { advertisementProvider: dependencies.advertisementProvider }
      : {}),
  });
  const acpAdapters: AutomationAcpAdapters = {};
  if (codexPath) {
    acpAdapters.codex = {
      command: process.execPath,
      args: packagedDaemonArgs(INTERNAL_ACP_ADAPTER_ARG, 'codex'),
      env: { CODEX_PATH: codexPath },
      defaultMode: 'agent',
      effortConfigId: 'reasoning_effort',
    };
  }
  if (claudePath) {
    acpAdapters['claude-code'] = {
      command: process.execPath,
      args: packagedDaemonArgs(INTERNAL_ACP_ADAPTER_ARG, 'claude-code'),
      env: {
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_EXECUTABLE: claudePath,
      },
      effortConfigId: 'effort',
      mcpServerName: 'lobu',
      sessionMeta: {
        claudeCode: {
          options: {
            allowedTools: ['mcp__lobu__query_sdk', 'mcp__lobu__run_sdk'],
            settingSources: [],
          },
        },
      },
    };
  }
  if (openCodePath) {
    acpAdapters.opencode = {
      command: openCodePath,
      args: ['acp', '--pure'],
      env: {
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      },
      autoApprovePermissions: true,
      effortConfigId: 'effort',
      isolateXdgConfig: true,
      mcpServerName: 'lobu',
    };
  }
  const automationConfig: AutomationExecutorConfig = {
    heartbeatIntervalMs: 30000,
    timeoutMs: 600000,
    ...(defaultAgentKind ? { defaultAgentKind } : {}),
    requireRunScopedSession: true,
    shutdownSignal: shutdownController.signal,
    acpAdapters,
  };
  const loop = new WorkerPollLoop({
    client,
    pollIntervalMs: validated.pollIntervalMs,
    maxIdleDelayMs: SOURCE_READ_IDLE_DELAY_CEILING_MS,
    maxConcurrentJobs: validated.maxConcurrentJobs,
    execute: async (job) => {
      if (job.run_type === 'automation') {
        return executeAutomationRun(client, job, automationConfig);
      }
      if (job.run_type === 'chat_message') {
        return executeDeviceChatRun(client, job, automationConfig);
      }
      if (job.run_type === 'sync' || job.run_type === 'action' || job.run_type === 'auth') {
        if (!bridgeImplementsRun(job, dependencies.advertisementProvider)) {
          return rejectUnadvertisedConnector(client, job);
        }
        if (!nativeBridge) {
          return rejectUnsupportedRun(client, job);
        }
        return executeNativeBridgeRun(client, nativeBridge, job);
      }
      return rejectUnsupportedRun(client, job);
    },
  });
  installWorkerPollLoopSignals(
    loop,
    createMacDeviceDaemonShutdown(shutdownController, loop, nativeBridge),
    {
    stdinEof: validated.supervisedStdio === true,
    }
  );
  return loop;
}

export async function runMacDeviceDaemon(options: MacDeviceDaemonOptions): Promise<void> {
  setDebug(options.debug === true);
  const validated = validateMacDeviceDaemonOptions(options);
  if (validated.noPoll) return;
  if (validated.supervisedStdio) {
    const advertisementProvider = new MutableWorkerAdvertisementProvider({
      capabilities: {},
      manifests: [],
      generation: 0,
    });
    const bridge = new NativeBridgeClient(
      process.stdin,
      process.stdout,
      advertisementProvider,
      validated.workerId,
      validated.version,
    );
    // The app is the authority for the worker identity and its current
    // connector generation. No health check or poll happens until this
    // handshake has validated both sides and echoed the nonce.
    await bridge.handshake();
    const shutdownController = new AbortController();
    const loop = createMacDeviceDaemon(validated, {
      advertisementProvider,
      bridge,
      shutdownController,
    });
    bridge.onTransportFailure(() => {
      shutdownController.abort();
      loop.stop();
    });
    // createMacDeviceDaemon installs the signal handlers. The bridge's
    // pending native requests are cancelled by the loop's normal shutdown
    // path before its bounded active-job wait.
    await loop.start();
    return;
  }
  await createMacDeviceDaemon(validated).start();
}
