import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { captureServerError, isSentryReported, trackMCPToolCall } from '../sentry';
import { ToolUserError } from '../utils/errors';

describe('operational errors reach stdout without a Sentry transport', () => {
  it('retains the original caught route stack and marks the request to avoid duplicate capture', async () => {
    const app = new Hono();
    const error = new Error('synthetic handler failure');
    let reported = false;
    app.get('/synthetic', (c) => {
      captureServerError(c, error, 'synthetic_route', 503);
      reported = isSentryReported(c);
      return c.json({ error: 'unavailable' }, 503);
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
    expect(record).toMatchObject({ level: 'error', source: 'synthetic_route', res_status: 503 });
    expect(record.error.stack).toContain('error-log-coverage.test.ts');
    expect(reported).toBe(true);
  });

  it('logs operational MCP failures and keeps expected caller errors quiet', async () => {
    const failure = new Error('synthetic MCP failure');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let output = '';
    try {
      await expect(trackMCPToolCall('synthetic_tool', {}, async () => { throw failure; })).rejects.toBe(failure);
      await expect(trackMCPToolCall('synthetic_tool', {}, async () => {
        throw new ToolUserError('synthetic invalid input', 400);
      })).rejects.toBeInstanceOf(ToolUserError);
      output = write.mock.calls.map(([line]) => String(line)).join('');
    } finally {
      write.mockRestore();
    }
    const records = output.trim().split('\n').map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ level: 'error', source: 'mcp_tool', tool_name: 'synthetic_tool' });
    expect(records[0].error.stack).toContain('error-log-coverage.test.ts');
  });
});
