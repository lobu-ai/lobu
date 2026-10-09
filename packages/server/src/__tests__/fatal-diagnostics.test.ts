import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const instrument = fileURLToPath(new URL('../instrument.ts', import.meta.url));

describe('fatal process diagnostics', () => {
  for (const expression of [
    'setImmediate(() => { throw failure; })',
    'Promise.reject(failure)',
  ]) {
    it(`records a sanitized fatal error and exits: ${expression}`, () => {
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--import', instrument, '-e',
        `const failure = new Error('synthetic fatal token="synthetic-fatal-secret with spaces" https://example.test/path?password="synthetic-url-secret with spaces"', { cause: { password: 'synthetic-cause-secret' } }); ${expression}`], {
        env: { ...process.env, SENTRY_DSN: '', NODE_ENV: 'test', ENVIRONMENT: 'test' },
        encoding: 'utf8', timeout: 10_000,
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(1);
      const records = child.stdout.split('\n').filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line));
      const fatal = records.find((record) => record.level === 'fatal');
      expect(fatal).toMatchObject({ service: 'lobu-server', msg: 'Process terminated by an unhandled error' });
      expect(fatal.error.stack).toContain('[eval]');
      expect(child.stdout + child.stderr).not.toContain('synthetic-fatal-secret');
      expect(child.stdout + child.stderr).not.toContain('synthetic-cause-secret');
      expect(child.stdout + child.stderr).not.toContain('synthetic-url-secret');
    });
  }
  it('retains nested aggregate failures and their structured codes at process exit', () => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--import', instrument, '-e',
      `const inner = Object.assign(new Error('connect failed token=synthetic-aggregate-secret'), { code: 'ECONNREFUSED' });
       const failure = new Error('fatal outer failure', { cause: new AggregateError([inner], 'multiple failures') });
       setImmediate(() => { throw failure; });`], {
      env: { ...process.env, SENTRY_DSN: '', NODE_ENV: 'test', ENVIRONMENT: 'test' },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    const records = child.stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    const fatal = records.find((record) => record.level === 'fatal');
    expect(fatal.error.cause.errors[0].code).toBe('ECONNREFUSED');
    expect(fatal.error.cause.errors[0].stack).toContain('[eval]');
    expect(child.stdout + child.stderr).not.toContain('synthetic-aggregate-secret');
  });

});
