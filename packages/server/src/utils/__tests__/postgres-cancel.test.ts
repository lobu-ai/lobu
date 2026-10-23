import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(require.resolve('postgres')), '../..');

describe('Postgres cancellation transport failures', () => {
  it.each(['src', 'cjs/src', 'cf/src'])('%s keeps a failed cancel request from crashing the host', (variant) => {
    // A child runs with Node's default unhandled-rejection handling. Inject a
    // failed cancel transport into the installed driver's actual Query class.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { pathToFileURL } from 'node:url';
      const { Query } = await import(pathToFileURL(process.argv[1]).href);
      let attempts = 0;
      const query = new Query(['SELECT 1'], [], () => {}, () => {
        attempts++;
        return Promise.reject(new Error('synthetic cancel transport failure'));
      });
      query.cancel();
      query.cancel();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(attempts, 1);
      // The original statement still settles independently of the cancel.
      query.resolve([{ value: 1 }]);
      assert.deepEqual(await query, [{ value: 1 }]);
    `, resolve(packageRoot, variant, 'query.js')], { encoding: 'utf8', timeout: 5000 });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
