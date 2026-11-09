/** HTTP runner double for storage/action suites. Real Chromium acceptance is
 * exercised separately in manage-views, without replacing the API boundary. */
import { createServer } from 'node:http';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import type { Env } from '../../index';
import { validationIdentity } from '../../views/validation-contract';
export function useViewValidator(env: Env) {
  let pause: (() => Promise<void>) | undefined;
  const control = { pauseNext() {
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { resume = resolve; });
    pause = async () => { enter(); await released; };
    return { entered, resume };
  }, mode: 'pass' as 'pass' | 'reject' | 'unavailable' | 'mismatch' };
  let previous: string | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const waiting = pause; pause = undefined;
    if (waiting) await waiting();
    if (control.mode === 'unavailable') { res.writeHead(503).end(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ...validationIdentity(input.artifact),
      ...(control.mode === 'mismatch' ? { runtimeHash: 'wrong-runtime' } : {}),
      passed: control.mode !== 'reject', diagnostics: control.mode === 'reject' ? ['Fixture rejected candidate'] : [] }));
  });
  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    env.VIEW_VALIDATOR_URL = url;
    previous = process.env.VIEW_VALIDATOR_URL;
    process.env.VIEW_VALIDATOR_URL = url;
  });
  beforeEach(() => { control.mode = 'pass'; });
  afterAll(async () => {
    if (previous === undefined) delete process.env.VIEW_VALIDATOR_URL;
    else process.env.VIEW_VALIDATOR_URL = previous;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return control;
}
