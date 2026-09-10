import { buildDeviceChatPrompt } from '@lobu/core/contracts/worker/device-chat';
import {
  type AgentKind,
  DEVICE_AGENT_SPECS_BY_KIND,
} from '@lobu/core/contracts/worker/device-automation';
import type {
  DeviceChatPollPayload,
  PollResponse,
} from '@lobu/core/contracts/worker/protocol';
import {
  type AutomationExecutorConfig,
  DEFAULT_DEVICE_AGENT_TIMEOUT_MS,
  monitorDeviceAgentRun,
  resolveDeviceAgentRunAccess,
  runCli,
} from './automation.js';
import type { ExecutorClient } from './client.js';

function isDeviceChatPayload(value: unknown): value is DeviceChatPollPayload {
  return !!value && typeof value === 'object' && 'chat' in value;
}

/** Execute one device-placed chat turn through the same supervised CLI runner as Automations. */
export async function executeDeviceChatRun(
  client: ExecutorClient,
  job: PollResponse,
  cfg: AutomationExecutorConfig,
): Promise<{ itemsCollected: number; error?: string }> {
  const runId = job.run_id;
  if (!runId) {
    return {
      itemsCollected: 0,
      error: 'device chat run missing its run id',
    };
  }
  const fail = async (error: string) => {
    await client.completeDeviceChat(runId, {
      worker_id: client.id,
      error,
      exit_reason: 'error_message',
    });
    return { itemsCollected: 0, error };
  };

  // The run is already claimed, so every rejected envelope must be reported;
  // returning locally would leave the turn parked until the stale-run sweep.
  const payload = job.payload;
  if (!isDeviceChatPayload(payload)) {
    return fail('device chat run received a non-chat payload envelope');
  }

  const kind = payload.chat.agent_kind as AgentKind;
  const spec = DEVICE_AGENT_SPECS_BY_KIND.get(kind);
  if (!spec)
    return fail(`no local agent executor configured for agent_kind='${kind}'`);
  if (cfg.requireRunScopedSession && !payload.context.agent_session) {
    return fail(
      'device chat run is missing its required run-scoped agent session',
    );
  }

  const timeoutMs = cfg.timeoutMs ?? DEFAULT_DEVICE_AGENT_TIMEOUT_MS;
  const monitor = monitorDeviceAgentRun(client, runId, cfg, 'Device chat');

  try {
    const result = await runCli(
      spec,
      buildDeviceChatPrompt(payload),
      payload.chat.execution_config,
      resolveDeviceAgentRunAccess(
        payload.context.agent_session,
        client.mcpWiring,
      ),
      timeoutMs,
      cfg.binaryOverrides?.[kind],
      monitor.abortController.signal,
      cfg.shutdownSignal,
      cfg.terminalHeartbeatGraceMs,
    );
    const output = result.output.trim();
    const error =
      result.error ?? (!output ? `${spec.binaryName} returned no reply` : null);
    await client.completeDeviceChat(runId, {
      worker_id: client.id,
      output,
      error,
      exit_code: result.exitCode,
      exit_signal: result.exitSignal,
      exit_reason: result.exitReason,
    });
    return error ? { itemsCollected: 0, error } : { itemsCollected: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message);
  } finally {
    monitor.stop();
  }
}
