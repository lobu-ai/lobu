import { describe, expect, it, vi } from 'vitest';
import logger from '../logger';

describe('HTTP secret redaction', () => {
  it('scrubs the actual stdout record, including nested fields and error URLs', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let output = '';
    try {
      const error = new Error('failed https://example.test/path?token=synthetic-query-secret');
      error.stack = `${error.message}\n    at syntheticOperation (worker.js:12:3)`;
      logger.error({ error, nested: { cookie: 'synthetic-cookie-secret' } },
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
