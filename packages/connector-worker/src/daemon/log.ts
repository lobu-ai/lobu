/**
 * Daemon logging.
 *
 * All daemon runtime output goes to stderr (stdout is reserved for the spawned
 * CLI and any machine-readable output). By default we log one line per run —
 * the run's start and its terminal result — plus startup/shutdown and hard
 * failures. Pass `--debug` to enable the poll/heartbeat/retry chatter.
 */

import { scrubDiagnosticValue } from '@lobu/core';

let debugEnabled = false;

function write(level: string, parts: unknown[]): void {
  let line: string;
  try {
    const record = scrubDiagnosticValue({
      timestamp: new Date().toISOString(), level, service: 'lobu-worker',
      release: process.env.APP_GIT_SHA,
      message: parts.filter((part) => typeof part === 'string').join(' '),
      data: parts.filter((part) => typeof part !== 'string'),
    });
    line = JSON.stringify(record, (_key, value) => typeof value === 'bigint' ? String(value) : value);
  } catch {
    // A diagnostic must not prevent a run from reporting its terminal state.
    line = JSON.stringify({ level, service: 'lobu-worker', message: 'Log record could not be serialized safely' });
  }
  // stderr is intentional: stdout belongs to the CLI's machine protocol.
  console.error(line);
}

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export const log = {
  /** Always-on: one line per run, startup/shutdown, and hard failures. */
  info: (...parts: unknown[]): void => {
    write('info', parts);
  },
  warn: (...parts: unknown[]): void => write('warn', parts),
  error: (...parts: unknown[]): void => write('error', parts),
  /** Debug-only: poll chatter, heartbeats, retry and backoff detail. */
  debug: (...parts: unknown[]): void => {
    if (debugEnabled) write('debug', parts);
  },
};
