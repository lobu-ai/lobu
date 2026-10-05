import { randomUUID } from 'node:crypto';
import type { ContentItem, PollResponse, StreamBatch } from '../client.js';
import type { WorkerClient } from '../client.js';
import { log } from '../log.js';
import { NativeBridgeClient, type NativeBridgeRunResult } from './client.js';

const FEED_READ_ACTION = '__lobu_feed_read';
const NATIVE_BRIDGE_HEARTBEAT_INTERVAL_MS = 30_000;
export const NATIVE_BRIDGE_EXECUTION_TIMEOUT_MS = 600_000;

export async function executeNativeBridgeRun(
  client: WorkerClient,
  bridge: NativeBridgeClient,
  job: PollResponse,
  timeoutMs = NATIVE_BRIDGE_EXECUTION_TIMEOUT_MS,
): Promise<{ itemsCollected: number; error?: string }> {
  if (!job.run_id) throw new Error('native bridge run is missing run_id');

  const runId = job.run_id;
  const requestId = randomUUID();
  let operation: ReturnType<typeof nativeOperation> | undefined;
  let itemsCollected = 0;
  let checkpoint = asRecord(job.checkpoint);
  let terminalDelivered = false;
  let terminalReporter: (() => Promise<void>) | undefined;
  let terminalAttempts = 0;
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined;

  const deliverTerminal = async (reporter: () => Promise<void>): Promise<void> => {
    if (terminalDelivered) return;
    terminalReporter ??= reporter;
    let lastError: unknown;
    while (terminalAttempts < 2) {
      terminalAttempts += 1;
      try {
        await terminalReporter();
        terminalDelivered = true;
        return;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError === undefined) {
      throw new Error('native bridge terminal report attempts exhausted');
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };

  const completeSync = async (result: NativeBridgeRunResult, errorMessage?: string) => {
    const payload = {
      run_id: runId,
      worker_id: client.id,
      status: errorMessage ? ('failed' as const) : ('success' as const),
      items_collected: itemsCollected,
      ...(!errorMessage && checkpoint ? { checkpoint } : {}),
      ...(result.auth_update ? { auth_update: result.auth_update } : {}),
      ...(errorMessage ? { error_message: errorMessage } : {}),
    };
    await deliverTerminal(() => client.complete(payload));
  };
  const completeAction = async (result: NativeBridgeRunResult, errorMessage?: string) => {
    const output = result.action_output ?? {};
    const payload = {
      run_id: runId,
      worker_id: client.id,
      status: errorMessage ? ('failed' as const) : ('success' as const),
      ...(errorMessage ? { error_message: errorMessage } : { action_output: output }),
    };
    await deliverTerminal(() => client.completeAction(payload));
  };
  const completeAuth = async (result: NativeBridgeRunResult, errorMessage?: string) => {
    const payload = {
      run_id: runId,
      worker_id: client.id,
      status: errorMessage ? ('failed' as const) : ('success' as const),
      ...(result.credentials ? { credentials: result.credentials } : {}),
      ...(result.metadata ? { metadata: result.metadata } : {}),
      ...(errorMessage ? { error_message: errorMessage } : {}),
    };
    await deliverTerminal(() => client.completeAuth(payload));
  };

  try {
    const currentOperation = nativeOperation(job);
    operation = currentOperation;
    heartbeatInterval = setInterval(() => {
      void client.heartbeat(runId).catch((error) => {
        log.debug(`[native-bridge] Heartbeat for run ${runId} failed:`, error);
      });
    }, NATIVE_BRIDGE_HEARTBEAT_INTERVAL_MS);
    const result = await runWithTimeout(
      bridge,
      requestId,
      runId,
      timeoutMs,
      bridge.run({
        requestId,
        operation: currentOperation,
        job: bridgeJob(job),
        onStream:
          currentOperation === 'sync'
            ? async (payload) => {
                const items = readItems(payload.items);
                const nextCheckpoint = asRecord(payload.checkpoint);
                if (items.length === 0 && !nextCheckpoint) return;
                const batch: StreamBatch = {
                  type: 'batch',
                  run_id: runId,
                  worker_id: client.id,
                  items,
                  ...(nextCheckpoint ?? checkpoint
                    ? { checkpoint: nextCheckpoint ?? checkpoint }
                    : {}),
                };
                await client.stream(batch);
                if (nextCheckpoint) checkpoint = nextCheckpoint;
                itemsCollected += items.length;
              }
            : undefined,
      }),
    );

    if (result.checkpoint) checkpoint = result.checkpoint;
    if (currentOperation === 'sync') await completeSync(result);
    else if (currentOperation === 'auth') await completeAuth(result);
    else await completeAction(result);
    return { itemsCollected };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.info(`[native-bridge] Run ${runId} failed:`, message);
    try {
      if (operation === 'sync') await completeSync({}, message);
      else if (operation === 'auth') await completeAuth({}, message);
      else if (job.run_type === 'automation') {
        await client.completeAutomation(runId, {
          worker_id: client.id,
          output: '',
          error: message,
          duration_ms: 0,
          exit_reason: 'error_message',
        });
      } else if (job.run_type === 'embed_backfill') await completeSync({}, message);
      else await completeAction({}, message);
    } catch (completionError) {
      log.info(`[native-bridge] Terminal report for run ${runId} failed:`, completionError);
    }
    return { itemsCollected, error: message };
  } finally {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
  }
}

async function runWithTimeout(
  bridge: NativeBridgeClient,
  requestId: string,
  runId: number,
  timeoutMs: number,
  run: Promise<NativeBridgeRunResult>,
): Promise<NativeBridgeRunResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run,
      new Promise<NativeBridgeRunResult>((_, reject) => {
        timer = setTimeout(() => {
          const timeoutError = new Error(`native bridge run timed out after ${timeoutMs}ms`);
          void bridge.cancelAndAbandon(requestId, runId, timeoutError).catch(() => undefined);
          reject(timeoutError);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function nativeOperation(job: PollResponse): 'sync' | 'action' | 'read' | 'auth' {
  if (job.run_type === 'automation' || job.run_type === 'embed_backfill') {
    throw new Error('native bridge does not execute run_type ' + String(job.run_type));
  }
  if (job.run_type === 'sync') return 'sync';
  if (job.run_type === 'auth') return 'auth';
  if (job.action_key === FEED_READ_ACTION) return 'read';
  return 'action';
}

function bridgeJob(job: PollResponse): Record<string, unknown> {
  const input = job.action_input ?? {};
  return {
    run_id: job.run_id,
    run_type: job.run_type,
    connector_key: job.connector_key,
    connector_version: job.connector_version,
    connector_manifest_hash: job.connector_manifest_hash,
    source_attribution: job.source_attribution,
    source_url: job.source_url,
    feed_key: job.feed_key,
    feed_id: job.feed_id,
    config: job.config ?? {},
    checkpoint: job.checkpoint,
    entity_ids: job.entity_ids,
    action_key: job.action_key,
    operation_key: job.operation_key,
    action_input: input,
  };
}

function readItems(value: unknown): ContentItem[] {
  if (!Array.isArray(value)) throw new Error('native bridge stream payload is missing items');
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.payload_text !== 'string' || typeof item.occurred_at !== 'string') {
      throw new Error(`native bridge stream item ${index} is malformed`);
    }
    return item as ContentItem;
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
