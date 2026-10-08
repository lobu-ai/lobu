import { describe, expect, spyOn, test } from 'bun:test';
import { log, setDebug } from '../daemon/log.js';

describe('daemon log', () => {
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
