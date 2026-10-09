import { describe, expect, spyOn, test } from 'bun:test';
import { log, setDebug } from '../daemon/log.js';

describe('daemon log', () => {
  test('keeps arbitrary diagnostic values from interrupting failure reporting', () => {
    const stderr = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => log.error({ bytes: 1n }, 'connector failed')).not.toThrow();
      expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toMatchObject({
        level: 'error', data: [{ bytes: '1' }],
      });
      const diagnostic = { toJSON() { return { authorization: 'synthetic-secret' }; } };
      expect(() => log.error(diagnostic, 'connector failed')).not.toThrow();
      const serialized = String(stderr.mock.calls[1]?.[0]);
      expect(JSON.parse(serialized)).toMatchObject({ level: 'error', service: 'lobu-worker' });
      expect(serialized).not.toContain('synthetic-secret');
    } finally {
      stderr.mockRestore();
    }
  });

  test('writes parseable severity and a scrubbed error stack to stderr only', () => {
    const stderr = spyOn(console, 'error').mockImplementation(() => {});
    const stdout = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const error = new Error('fetch https://example.test/path?token=synthetic-secret');
      error.stack = `${error.message}\n    at syntheticOperation (worker.js:12:3)`;
      log.error({ run_id: 42, error, authorization: 'synthetic-header' }, 'connector failed');
      const line = String(stderr.mock.calls[0]?.[0]);
      expect(JSON.parse(line)).toMatchObject({ level: 'error', service: 'lobu-worker', message: 'connector failed' });
      expect(line).toContain('syntheticOperation');
      expect(line).not.toContain('synthetic-secret');
      expect(line).not.toContain('synthetic-header');
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });

  test('info always prints; debug prints only after setDebug(true)', () => {
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      setDebug(false);
      log.info('run line');
      log.debug('poll chatter');
      expect(err).toHaveBeenCalledTimes(1);

      setDebug(true);
      log.debug('poll chatter');
      expect(err).toHaveBeenCalledTimes(2);
    } finally {
      setDebug(false);
      err.mockRestore();
    }
  });
});
