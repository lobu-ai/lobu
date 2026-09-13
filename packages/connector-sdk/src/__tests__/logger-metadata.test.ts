/**
 * The SDK logger is a deliberate standalone copy of `@lobu/core`'s console
 * formatter (the package root must stay loadable inside a V8 isolate), so the
 * pino-style `(meta, message)` contract has to be pinned on both sides or the
 * copies drift. Core's half lives in
 * `packages/core/src/__tests__/logger-metadata.test.ts`.
 *
 * The shared bug: the branch that recognised a leading metadata object took
 * the message out of the trailing args and sliced the object away without
 * rendering it, so a connector diagnostic logged its sentence and lost every
 * field it was carrying.
 */

import { describe, expect, test } from 'bun:test';
import { createConsoleLogger } from '../logger.js';

function captureWarn(run: (log: ReturnType<typeof createConsoleLogger>) => void): string {
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    run(createConsoleLogger('test-connector'));
  } finally {
    console.warn = original;
  }
  return lines.join('\n');
}

describe('sdk console logger pino-style metadata', () => {
  test('renders BOTH the message and the leading metadata object', () => {
    const line = captureWarn((log) => {
      log.warn({ connection_id: 4917, page: 'cursor-3' }, 'retrying fetch');
    });

    expect(line).toContain('retrying fetch');
    expect(line).toContain('4917');
    expect(line).toContain('cursor-3');
  });

  test('renders the error cause passed as leading metadata', () => {
    const line = captureWarn((log) => {
      log.warn({ err: new Error('socket hang up') }, 'upstream call failed');
    });

    expect(line).toContain('upstream call failed');
    expect(line).toContain('socket hang up');
  });

  test('still redacts sensitive keys inside the metadata object', () => {
    const line = captureWarn((log) => {
      log.warn({ api_key: 'sk-live-must-not-appear' }, 'credential check');
    });

    expect(line).toContain('credential check');
    expect(line).toContain('[REDACTED]');
    expect(line).not.toContain('sk-live-must-not-appear');
  });

  test('leaves the plain (message, data) form working', () => {
    const line = captureWarn((log) => {
      log.warn('plain message', { detail: 'kept' });
    });

    expect(line).toContain('plain message');
    expect(line).toContain('kept');
  });
});
