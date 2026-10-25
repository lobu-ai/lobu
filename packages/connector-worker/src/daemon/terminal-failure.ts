import type { PollResponse, ExecutorClient } from './client.js';
import { completeActionOnce, completeAgentTurnOnce } from './terminal-delivery.js';

export async function reportTerminalFailure(
  client: ExecutorClient,
  job: PollResponse,
  message: string,
  exitReason: 'error_message' | 'crash' = 'crash',
): Promise<void> {
  if (job.run_id == null) return;
  if (job.run_type === 'action') {
    await completeActionOnce(client, {
      run_id: job.run_id,
      worker_id: client.id,
      status: 'failed',
      error_message: message,
    });
    return;
  }
  if (job.run_type === 'auth') {
    await client.completeAuth({
      run_id: job.run_id,
      worker_id: client.id,
      status: 'failed',
      error_message: message,
    });
    return;
  }
  if (job.run_type === 'agent_turn') {
    // The generic route refuses an agent turn with a 409, so a failure that
    // fell through to it would leave the run parked until the stale sweep.
    await completeAgentTurnOnce(client, {
      run_id: job.run_id,
      worker_id: client.id,
      status: 'failed',
      error: message,
      exit_reason: exitReason,
    });
    return;
  }
  if (job.run_type === 'automation') {
    await client.completeAutomation(job.run_id, {
      worker_id: client.id,
      output: '',
      error: message,
      duration_ms: 0,
      exit_reason: exitReason,
    });
    return;
  }
  await client.complete({
    run_id: job.run_id,
    worker_id: client.id,
    status: 'failed',
    error_message: message,
    items_collected: 0,
  });
}
