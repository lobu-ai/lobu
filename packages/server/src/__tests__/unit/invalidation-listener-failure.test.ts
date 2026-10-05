import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';

test.each([
  ['rejects', false],
  ['throws synchronously', true],
])('a LISTEN that %s does not announce a live stream and the next connection retries', (_label, throwsSync) => {
  // Isolate the DB mock so other suites still exercise the real emitter.
  const dbUrl = new URL('../../db/client.ts', import.meta.url).href;
  const streamUrl = new URL('../../events/sse.ts', import.meta.url).href;
  const script = `
    import { mock } from 'bun:test';
    let attempts = 0;
    mock.module(${JSON.stringify(dbUrl)}, () => ({
      getDbListener: () => {
        if (${throwsSync} && attempts === 0) {
          attempts++;
          throw new Error('synthetic listener outage');
        }
        return { listen: async (_channel, _notify, onListen) => {
          if (++attempts === 1) throw new Error('synthetic listener outage');
          onListen?.();
          return { unlisten: async () => {} };
        } };
      },
      getDb: () => { throw new Error('unexpected database query'); },
    }));
    const { streamInvalidationEvents } = await import(${JSON.stringify(streamUrl)});
    async function connect() {
      const ctrl = new AbortController();
      const response = streamInvalidationEvents({
        req: { raw: { signal: ctrl.signal } },
        header: () => {},
        body: stream => new Response(stream),
      }, 'synthetic-org');
      try {
        const result = await response.body.getReader().read();
        return { connected: new TextDecoder().decode(result.value).startsWith('event: connected') };
      } catch {
        return { connected: false };
      } finally {
        ctrl.abort();
      }
    }
    const first = await connect();
    const second = await connect();
    console.log('RESULT=' + JSON.stringify({ first, second, attempts }));
  `;
  const output = execFileSync(process.execPath, ['--eval', script], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  const result = output.split('\n').find((line) => line.startsWith('RESULT='));
  expect(result).toBeDefined();
  expect(JSON.parse(result!.slice('RESULT='.length))).toEqual({
    first: { connected: false },
    second: { connected: true },
    attempts: 2,
  });
});
