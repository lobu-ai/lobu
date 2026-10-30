/**
 * Daemon Module
 *
 * Exports worker daemon, client, and executor.
 */

export type {
  CompleteRequest,
  ContentItem,
  PollResponse,
  StreamBatch,
  WorkerAdvertisementProvider,
  WorkerAdvertisementSnapshot,
  WorkerCapabilities,
} from './client.js';
export {
  MutableWorkerAdvertisementProvider,
  WorkerClient,
  WorkerUpgradeRequiredError,
} from './client.js';
export {
  NATIVE_BRIDGE_PROTOCOL,
  NATIVE_BRIDGE_PROTOCOL_VERSION,
  NativeBridgeProtocolError,
} from './native-bridge/protocol.js';
export { NativeBridgeClient } from './native-bridge/client.js';
export type { ExecutorConfig } from './executor.js';
export { executeRun } from './executor.js';
export type { DaemonConfig } from './worker.js';
export { startDaemon, WorkerDaemon } from './worker.js';
export {
  resolveDaemonLaunchContext,
  resolveDaemonWorkerId,
  startDaemonCommand,
  type DaemonStartOptions,
} from './start.js';
export { executeClaimedAutomationRun, UnexecutableRunError } from './execute-run.js';
