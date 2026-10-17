/**
 * Far-end of the connector-side taxonomy pipe (lobu#2051 Item 2): when a connector
 * connector run fails, query_sql and manage_feeds re-throw with a code derived from
 * the structured `httpStatus` the executor propagates (from the SDK's
 * HttpStatusError) — not from keyword-matching the redacted message. This pins
 * that classification.
 */

import { describe, expect, it } from 'bun:test';
import { isRetryable, ToolError, BrowserInterruptionError } from '@lobu/core';
import { classifyPushdownFailure } from '../../lib/connector-pushdown';

// Mirror of ConnectorExecutionError's surface: a message plus the propagated httpStatus.
class ConnectorExecutionErrorLike extends Error {
  httpStatus?: number;
  constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = 'ConnectorExecutionError';
    this.httpStatus = httpStatus;
  }
}

describe('classifyPushdownFailure', () => {
  it('classifies a propagated 429 as RATE_LIMITED (retryable)', () => {
    const code = classifyPushdownFailure(new ConnectorExecutionErrorLike('redacted', 429));
    expect(code).toBe('RATE_LIMITED');
    expect(isRetryable(code)).toBe(true);
  });

  it('classifies a propagated 503 as UPSTREAM_5XX (retryable)', () => {
    const code = classifyPushdownFailure(new ConnectorExecutionErrorLike('redacted', 503));
    expect(code).toBe('UPSTREAM_5XX');
    expect(isRetryable(code)).toBe(true);
  });

  it('classifies a propagated 404 as NOT_FOUND (not retryable)', () => {
    const code = classifyPushdownFailure(new ConnectorExecutionErrorLike('redacted', 404));
    expect(code).toBe('NOT_FOUND');
    expect(isRetryable(code)).toBe(false);
  });

  it('prefers the structured status over a misleading message', () => {
    // Message contains "timeout" (would keyword-match) but the real status is 429.
    const code = classifyPushdownFailure(
      new ConnectorExecutionErrorLike('connection timeout while fetching', 429)
    );
    expect(code).toBe('RATE_LIMITED');
  });

  it('falls back to UPSTREAM_5XX for an opaque failure with no status', () => {
    // A broken feed/connector with no HTTP status and an unclassifiable message:
    // default to a retryable server-side error rather than INTERNAL.
    const code = classifyPushdownFailure(new ConnectorExecutionErrorLike('feed exploded', undefined));
    expect(code).toBe('UPSTREAM_5XX');
  });

  it('still keyword-classifies a transient message when no status is present', () => {
    const code = classifyPushdownFailure(new ConnectorExecutionErrorLike('ECONNRESET', undefined));
    expect(code).toBe('NETWORK');
    expect(isRetryable(code)).toBe(true);
  });

  it('classifies a structured execution deadline as UPSTREAM_TIMEOUT', () => {
    const error = Object.assign(new Error('redacted'), { exitReason: 'timeout' });
    const code = classifyPushdownFailure(error);
    expect(code).toBe('UPSTREAM_TIMEOUT');
    expect(isRetryable(code)).toBe(true);
  });

  it('preserves a gateway-owned structured code regardless of message text', () => {
    const code = classifyPushdownFailure(
      new ToolError('NOT_FOUND', 'upstream body claimed an internal timeout'),
    );
    expect(code).toBe('NOT_FOUND');
    expect(isRetryable(code)).toBe(false);
  });
});


it('keeps a typed browser interruption non-retryable even when its prose says timeout', () => {
  const code = classifyPushdownFailure(new BrowserInterruptionError('challenge_required', 'timeout is not challenge evidence'));
  expect(code).toBe('BROWSER_INTERRUPTED');
  expect(isRetryable(code)).toBe(false);
});
