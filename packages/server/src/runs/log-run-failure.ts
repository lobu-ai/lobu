import logger from '../utils/logger';

/** Log only committed terminal failures. Callers must finish their transaction
 * first. The run remains the authorized source for private diagnostic text. */
export function logRunFailure(run: {
  id: number;
  status: string;
  run_type?: string | null;
  connector_key?: string | null;
  exit_reason?: string | null;
  exit_code?: number | null;
  exit_signal?: string | null;
}): void {
  if (run.status !== 'failed' && run.status !== 'timeout') return;
  const level = run.exit_reason === 'cancelled' ? 'info'
    : run.status === 'timeout' || ['crash', 'oom', 'timeout'].includes(run.exit_reason ?? '')
      ? 'error' : 'warn';
  logger[level]({
    source: 'run_completion', run_id: run.id, status: run.status,
    run_type: run.run_type, connector_key: run.connector_key,
    exit_reason: run.exit_reason, exit_code: run.exit_code, exit_signal: run.exit_signal,
  }, 'Run failed');
}
