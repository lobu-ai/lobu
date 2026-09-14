/**
 * A tool failure must never be reported on a status whose body the edge in
 * front of the gateway replaces (see `utils/errors.ts`): the structured
 * `{ error, code, retryable }` JSON is then discarded before the browser sees
 * it, and the SPA shows the edge's own `error code: 502` text instead.
 *
 * The guard belongs on `ToolUserError` rather than on each of the 500+ throw
 * sites, because every wire boundary that answers a tool call reads
 * `httpStatus` straight off the error.
 */

import { describe, expect, it } from 'bun:test';
import type { ToolErrorCode } from '@lobu/core';
import { ToolUserError, toolErrorHttpStatus } from '../../utils/errors';

const CDN_SUBSTITUTED_STATUSES = [502, 504];

// Keyed by the union, so adding a `ToolErrorCode` without covering it here
// fails to compile rather than silently escaping this suite.
const ALL_CODES = Object.keys({
  AUTH_MISSING: true,
  AUTH_INVALID: true,
  NOT_FOUND: true,
  VALIDATION: true,
  PERMISSION: true,
  RATE_LIMITED: true,
  UPSTREAM_TIMEOUT: true,
  UPSTREAM_5XX: true,
  NETWORK: true,
  UPSTREAM_UNAVAILABLE: true,
  INTERNAL: true,
} satisfies Record<ToolErrorCode, true>) as ToolErrorCode[];

describe('toolErrorHttpStatus', () => {
  it('never maps a code onto a substituted status', () => {
    for (const code of ALL_CODES) {
      expect(CDN_SUBSTITUTED_STATUSES).not.toContain(toolErrorHttpStatus(code));
    }
  });

  it('keeps the caller-actionable codes in the 4xx range', () => {
    expect(toolErrorHttpStatus('NOT_FOUND')).toBe(404);
    expect(toolErrorHttpStatus('PERMISSION')).toBe(403);
    expect(toolErrorHttpStatus('RATE_LIMITED')).toBe(429);
    expect(toolErrorHttpStatus('VALIDATION')).toBe(400);
    // The CALLER's session is valid — only the connection's credentials are
    // not — so this must not read to the SPA as "sign in again".
    expect(toolErrorHttpStatus('AUTH_INVALID')).toBe(400);
    expect(toolErrorHttpStatus('AUTH_MISSING')).toBe(400);
  });
});

describe('ToolUserError', () => {
  it('re-derives a substituted status from the structured code', () => {
    const timedOut = new ToolUserError('upstream timed out', 504, 'UPSTREAM_TIMEOUT');
    expect(timedOut.httpStatus).toBe(toolErrorHttpStatus('UPSTREAM_TIMEOUT'));
    expect(CDN_SUBSTITUTED_STATUSES).not.toContain(timedOut.httpStatus);

    const notFound = new ToolUserError('gone upstream', 502, 'NOT_FOUND');
    expect(notFound.httpStatus).toBe(404);
  });

  it('falls back to 500 when a substituted status carries no code', () => {
    expect(new ToolUserError('bare gateway failure', 502).httpStatus).toBe(500);
  });

  it('leaves every other status exactly as the throw site set it', () => {
    expect(new ToolUserError('bad input').httpStatus).toBe(400);
    expect(new ToolUserError('nope', 403).httpStatus).toBe(403);
    expect(new ToolUserError('too big', 413).httpStatus).toBe(413);
    expect(new ToolUserError('boom', 500).httpStatus).toBe(500);
  });

  it('keeps retryability keyed to the code, not the rewritten status', () => {
    expect(new ToolUserError('upstream', 502, 'UPSTREAM_5XX').retryable).toBe(true);
    expect(new ToolUserError('upstream', 502, 'VALIDATION').retryable).toBe(false);
  });
});
