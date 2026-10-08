import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import HerdrConnector from '../herdr';
import type { ActionContext } from '@lobu/connector-sdk';

const connector = new HerdrConnector();
let directory: string;
let binary: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'herdr-connector-test-'));
  binary = join(directory, "herdr' fixture");
  await writeFile(
    binary,
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({argv:process.argv.slice(2)}));\n',
    { mode: 0o700 },
  );
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function invoke(actionKey: string, input: Record<string, unknown>, receipt?: unknown) {
  const requests: Array<Record<string, unknown>> = [];
  const ctx = {
    actionKey,
    input,
    config: { shell_connection_id: 123, binary },
    credentials: null,
    operations: {
      execute: async (request: Record<string, unknown>) => {
        requests.push(request);
        if (receipt) return receipt;
        const process = Bun.spawn(
          ['bash', '--noprofile', '--norc', '-c', (request.input as { command: string }).command],
          { stdout: 'pipe', stderr: 'pipe' },
        );
        const stdout = await new Response(process.stdout).text();
        const stderr = await new Response(process.stderr).text();
        return {
          action: 'execute',
          status: 'completed',
          run_id: 456,
          output: { exit_code: await process.exited, stdout, stderr, timed_out: false },
        };
      },
    },
  } as ActionContext;
  const result = await connector.execute(ctx);
  return { result, requests };
}

describe('Herdr connector over the existing shell operation', () => {
  it('quotes executable and arbitrary prompt text as argv without shell expansion', async () => {
    const prompt = "don't expand $(printf WRONG); `printf WRONG`\n--help \\";
    const { result, requests } = await invoke('agent_prompt', {
      target: 'test-agent',
      text: prompt,
    });
    expect(result).toMatchObject({
      success: true,
      output: {
        result: { argv: ['agent', 'prompt', 'test-agent', prompt] },
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      connection_id: 123,
      operation_key: 'run',
      idempotency_key: 'herdr-command',
      input: { timeout_ms: 15000 },
    });
  });
  it.each([
    ['snapshot', {}, ['api', 'snapshot']],
    ['process_info', { pane_id: 'w1:p1' }, ['pane', 'process-info', '--pane', 'w1:p1']],
    [
      'workspace_create',
      { cwd: '/tmp/test dir', label: '--hello' },
      ['workspace', 'create', '--cwd', '/tmp/test dir', '--label', '--hello', '--no-focus'],
    ],
    ['workspace_close', { workspace_id: 'w1' }, ['workspace', 'close', 'w1']],
    ['agent_list', {}, ['agent', 'list']],
    ['agent_get', { target: 'test-agent' }, ['agent', 'get', 'test-agent']],
    [
      'agent_start',
      { name: 'test-agent', kind: 'claude', pane_id: 'w1:p1', args: ['--model', 'opus'] },
      [
        'agent',
        'start',
        'test-agent',
        '--kind',
        'claude',
        '--pane',
        'w1:p1',
        '--timeout',
        '30000',
        '--',
        '--model',
        'opus',
      ],
    ],
    [
      'agent_wait',
      { target: 'test-agent', timeout_ms: 1000, until: ['idle', 'blocked'] },
      ['agent', 'wait', 'test-agent', '--timeout', '1000', '--until', 'idle', '--until', 'blocked'],
    ],
    [
      'agent_prompt',
      { target: 'test-agent', text: '--wait', wait: true, timeout_ms: 1000, until: ['idle'] },
      ['agent', 'prompt', 'test-agent', '--wait', '--wait', '--timeout', '1000', '--until', 'idle'],
    ],
    ['agent_interrupt', { target: 'test-agent' }, ['agent', 'send-keys', 'test-agent', 'ctrl+c']],
  ] as const)('%s has an explicit target and bounded CLI call', async (key, input, argv) => {
    const { result } = await invoke(key, input);
    expect(result).toMatchObject({ success: true, output: { result: { argv: [...argv] } } });
  });
  it.each(['agent_read', 'pane_read'])(
    '%s preserves text and defaults to passive visible output',
    async (key) => {
      const { result } = await invoke(key, { target: 'test-agent', pane_id: 'w1:p1' });
      const text = result.output?.result as string;
      expect(JSON.parse(text).argv).toEqual([
        key === 'agent_read' ? 'agent' : 'pane',
        'read',
        key === 'agent_read' ? 'test-agent' : 'w1:p1',
        '--source',
        'visible',
        '--lines',
        '80',
        '--format',
        'text',
      ]);
    },
  );
  it('returns the pending approval receipt without claiming a delivered prompt', async () => {
    const receipt = {
      action: 'execute',
      status: 'pending_approval',
      run_id: 456,
      approval_url: 'https://gateway.test/approval',
      message: 'Approval needed',
    };
    const { result, requests } = await invoke(
      'agent_prompt',
      { target: 'test-agent', text: 'hello' },
      receipt,
    );
    expect(result).toEqual({ success: true, output: receipt });
    expect(requests).toHaveLength(1);
  });
  it('does not retry a timeout or a structured Herdr error', async () => {
    for (const output of [
      {
        exit_code: 1,
        stdout: JSON.stringify({ error: { code: 'agent_prompt_stalled' } }),
        stderr: '',
        timed_out: false,
      },
      { exit_code: 143, stdout: '', stderr: '', timed_out: true },
    ]) {
      const { result, requests } = await invoke(
        'agent_prompt',
        { target: 'test-agent', text: 'hello' },
        { action: 'execute', status: 'completed', run_id: 456, output },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('456');
      expect(requests).toHaveLength(1);
    }
  });
  it('fails before dispatch for unsafe identifiers, missing setup and invalid waits', async () => {
    await expect(invoke('agent_get', { target: '--help' })).rejects.toThrow(/explicit/);
    await expect(
      invoke('agent_wait', { target: 'test-agent', timeout_ms: 200000 }),
    ).rejects.toThrow(/limit/);
    await expect(invoke('workspace_create', { cwd: 'relative', label: 'test' })).rejects.toThrow(
      /absolute/,
    );
    expect(
      await connector.execute({ actionKey: 'snapshot', input: {}, config: {}, credentials: null }),
    ).toMatchObject({ success: false, error: expect.stringContaining('host') });
  });
  it('rejects unsupported timeout combinations and empty JSON success output', async () => {
    await expect(
      invoke('agent_prompt', { target: 'test-agent', text: 'hello', timeout_ms: 1000 }),
    ).rejects.toThrow(/wait: true/);
    await expect(
      invoke('agent_start', {
        name: 'test-agent',
        kind: 'claude',
        pane_id: 'w1:p1',
        timeout_ms: 1000,
      }),
    ).rejects.toThrow(/limit/);
    const { result } = await invoke(
      'snapshot',
      {},
      {
        action: 'execute',
        status: 'completed',
        run_id: 456,
        output: { stdout: '', stderr: '', exit_code: 0 },
      },
    );
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('invalid JSON'),
    });
  });
});
