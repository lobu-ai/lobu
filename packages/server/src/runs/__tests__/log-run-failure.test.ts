import { describe, expect, it, vi } from 'vitest';
import { logRunFailure } from '../log-run-failure';

describe('run diagnostic boundary', () => {
  it('uses terminal status and exit codes without copying private payloads', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let output = '';
    try {
      const run = { id: 123, status: 'failed', error_message: 'private page content', action_output: { secret: 'private-output' } };
      logRunFailure(run);
      logRunFailure({ ...run, exit_reason: 'crash' });
      logRunFailure({ ...run, status: 'timeout' });
      logRunFailure({ ...run, status: 'completed' });
      logRunFailure({ ...run, status: 'cancelled' });
      output = write.mock.calls.map(([line]) => String(line)).join('');
    } finally { write.mockRestore(); }
    const records = output.trim().split('\n').map((line) => JSON.parse(line));
    expect(records.map((r) => r.level)).toEqual(['warn', 'error', 'error']);
    expect(records.every((r) => r.source === 'run_completion' && r.run_id === 123)).toBe(true);
    expect(output).not.toContain('private');
  });
});
