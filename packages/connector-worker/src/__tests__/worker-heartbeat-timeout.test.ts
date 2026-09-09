import { describe, expect, spyOn, test } from 'bun:test';
import { createServer } from 'node:http';
import { WorkerClient } from '../daemon/client.js';

describe('worker heartbeat deadline', () => {
  test.each(['headers', 'body'] as const)('recovers after a stalled %s response', async (stall) => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      if (++attempts === 1) {
        if (stall === 'body') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.write('{');
        }
        return;
      }
      response.end(JSON.stringify({ continue: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP port');
    const client = new WorkerClient({
      apiUrl: `http://127.0.0.1:${address.port}`,
      workerId: 'heartbeat-test-worker',
      capabilities: {},
    });
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const deadline = spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(40));
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        client.heartbeat(1).then(() => 'completed', (error: Error) => error.name),
        new Promise<string>((resolve) => {
          watchdog = setTimeout(() => resolve('still hung'), 500);
        }),
      ]);
      expect(outcome).toBe('TimeoutError');
      expect(deadline).toHaveBeenCalledWith(15_000);
      await expect(client.heartbeat(1)).resolves.toEqual({ continue: true });
      expect(attempts).toBe(2);
    } finally {
      clearTimeout(watchdog);
      deadline.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
