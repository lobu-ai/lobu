/**
 * Tests for the pino → Sentry forwarding guard in utils/logger.ts.
 *
 * Expected client-fault outcomes (ToolUserError / 4xx httpStatus) must NOT be
 * forwarded to Sentry — they are returned to the caller as a 4xx and are not
 * operational alerts. Genuine operational errors must still be captured. This
 * is the path that previously turned routine 409/403 tool outcomes into Sentry
 * issues (LOBU-BACKEND-12, LOBU-BACKEND-Z, LOBU-BACKEND-11).
 *
 * Tested via the exported pure predicate rather than by mocking `@sentry/node`:
 * the integration suite runs with `isolate: false` (shared module registry),
 * so per-file module mocks of an already-loaded singleton are unreliable.
 */

import { describe, expect, it, vi } from 'vitest';
import logger, { isExpectedClientFaultLog } from '../logger';

describe('HTTP secret redaction', () => {
  it('scrubs the actual stdout record, including nested fields and error URLs', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let output = '';
    try {
      const error = new Error('failed https://example.test/path?token=synthetic-query-secret');
      error.stack = `${error.message}\n    at syntheticOperation (worker.js:12:3)`;
      logger.error({ error, nested: { cookie: 'synthetic-cookie-secret' }, sentryReported: true },
        'failed https://example.test/path?token=synthetic-message-secret');
      output = write.mock.calls.map(([line]) => String(line)).join('');
    } finally {
      write.mockRestore();
    }
    const entry = JSON.parse(output);
    expect(entry.level).toBe('error');
    expect(entry.error.stack).toContain('syntheticOperation');
    expect(output).not.toContain('synthetic-query-secret');
    expect(output).not.toContain('synthetic-message-secret');
    expect(output).not.toContain('synthetic-cookie-secret');
  });

  it('redacts credentials from request and response headers', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let output = '';

    try {
      const requestLogger = logger.child({
        req: {
          headers: {
            authorization: 'Bearer request-secret',
            cookie: 'session=request-cookie',
            'proxy-authorization': 'Basic proxy-secret',
            'x-api-key': 'api-key-secret',
            'x-lobu-worker-token': 'lobu-worker-secret',
            'x-custom-signature': 'custom-signature-secret',
            'x-slack-signature': 'v0=slack-signature-secret',
            'x-hub-signature-256': 'sha256=hub-signature-secret',
            'content-type': 'application/json',
            'idempotency-key': 'request-123',
            'authorization-mode': 'oauth',
            'cookie-policy': 'strict',
            'x-keyboard-layout': 'qwerty',
            'x-tokenizer-version': 'v1',
          },
        },
      });
      requestLogger.info(
        {
          res: {
            headers: {
              'set-cookie': 'session=response-cookie',
            },
          },
        },
        'request completed',
      );
      output = write.mock.calls.map(([line]) => String(line)).join('');
    } finally {
      write.mockRestore();
    }

    const entry = JSON.parse(output);
    expect(entry.msg).toBe('request completed');
    expect(entry.req.headers).toEqual({
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      'proxy-authorization': '[REDACTED]',
      'x-api-key': '[REDACTED]',
      'x-lobu-worker-token': '[REDACTED]',
      'x-custom-signature': '[REDACTED]',
      'x-slack-signature': '[REDACTED]',
      'x-hub-signature-256': '[REDACTED]',
      'content-type': 'application/json',
      'idempotency-key': 'request-123',
      'authorization-mode': 'oauth',
      'cookie-policy': 'strict',
      'x-keyboard-layout': 'qwerty',
      'x-tokenizer-version': 'v1',
    });
    expect(entry.res.headers['set-cookie']).toBe('[REDACTED]');
  });
});

describe('isExpectedClientFaultLog', () => {
  it('skips a ToolUserError regardless of status', () => {
    expect(isExpectedClientFaultLog({ type: 'ToolUserError', httpStatus: 409 })).toBe(true);
    expect(isExpectedClientFaultLog({ type: 'ToolUserError' })).toBe(true);
  });

  it('skips any 4xx httpStatus (e.g. a 403 thrown as a plain Error)', () => {
    expect(isExpectedClientFaultLog({ type: 'Error', httpStatus: 403 })).toBe(true);
    expect(isExpectedClientFaultLog({ httpStatus: 400 })).toBe(true);
    expect(isExpectedClientFaultLog({ httpStatus: 499 })).toBe(true);
  });

  it('forwards genuine operational errors (no 4xx status, not a ToolUserError)', () => {
    expect(isExpectedClientFaultLog({ type: 'Error', message: 'db boom' })).toBe(false);
    expect(isExpectedClientFaultLog({ type: 'Error', httpStatus: 500 })).toBe(false);
    expect(isExpectedClientFaultLog({ httpStatus: 503 })).toBe(false);
    expect(isExpectedClientFaultLog(undefined)).toBe(false);
  });
});
