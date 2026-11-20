import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('../utils/logger');
  vi.doUnmock('../diagnostics');
});

describe('operational errors reach stdout', () => {
  it('retains the original caught route stack and marks the request to avoid duplicate capture', async () => {
    const { routeFailure, isErrorReported } = await import('../diagnostics');
    const app = new Hono();
    const error = new Error('synthetic handler failure');
    let reported = false;
    app.get('/synthetic', (c) => {
      const failure = routeFailure(c, c.json({ error: 'unavailable' }, 503), error);
      reported = isErrorReported(c);
      throw failure;
    });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let output = '';
    try {
      expect((await app.request('/synthetic')).status).toBe(503);
      output = write.mock.calls.map(([line]) => String(line)).join('');
    } finally {
      write.mockRestore();
    }
    const record = JSON.parse(output.trim());
    expect(record).toMatchObject({ level: 'error', source: 'route_failure', res_status: 503 });
    expect(record.error.stack).toContain('error-log-coverage.test.ts');
    expect(reported).toBe(true);
  });
});
