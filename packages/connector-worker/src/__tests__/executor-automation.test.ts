/**
 * Headless Automation execution lane — tests through the AutomationRunIo seam.
 *
 * The daemon claims `run_type='automation'` runs only when it advertises
 * `automations.execute` (server-side gate in worker-api/poll.ts); once
 * claimed, the executor must reach a TERMINAL state via complete-automation
 * for every outcome: clean exit, CLI failure, timeout, or an unexpected throw.
 *
 * These tests exercise the dispatchAutomationResumeLoop via its injected IO
 * seam — no real subprocesses are spawned, keeping tests fast and hermetic.
 */

import { describe, expect, test } from 'bun:test';

import {
  dispatchAutomationResumeLoop,
  resolveDeviceAgentRunAccess,
  type AutomationRunIo,
  type ExecutorResult,
} from '../daemon/automation.js';
import { executeRun } from '../daemon/executor.js';
import type {
  AutomationPollPayload,
  CompleteAutomationRequest,
} from '@lobu/core/contracts/worker/protocol';

function makeResult(overrides: Partial<ExecutorResult> = {}): ExecutorResult {
  return {
    output: 'fake output',
    error: null,
    exitCode: 0,
    exitSignal: null,
    exitReason: 'ok',
    durationMs: 100,
    ...overrides,
  };
}

describe('dispatchAutomationResumeLoop', () => {
  test('clean exit reports success and returns', async () => {
    const reports: CompleteAutomationRequest[] = [];
    const io: AutomationRunIo = {
      async run() { return makeResult(); },
      async deliver(result, finalizeAttempt) {
        reports.push({
          worker_id: 'test-worker',
          output: result.output,
          exit_code: result.exitCode,
          exit_reason: result.exitReason,
          finalize_attempt: finalizeAttempt,
        });
        return { ok: true, status: 'completed' };
      },
      async reportError() {},
    };

    const result = await dispatchAutomationResumeLoop(io);

    expect(result.error).toBeUndefined();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.exit_code).toBe(0);
    expect(reports[0]!.exit_reason).toBe('ok');
  });

  test('non-zero exit delivers error via report', async () => {
    const reports: CompleteAutomationRequest[] = [];
    const io: AutomationRunIo = {
      async run() { return makeResult({ exitCode: 3, error: 'boom', exitReason: 'crash' }); },
      async deliver(result, finalizeAttempt) {
        reports.push({
          worker_id: 'test-worker',
          output: result.output,
          error: result.error ?? undefined,
          exit_code: result.exitCode,
          exit_reason: result.exitReason,
          finalize_attempt: finalizeAttempt,
        });
        return { ok: true, status: 'completed' };
      },
      async reportError() {},
    };

    const result = await dispatchAutomationResumeLoop(io);

    expect(result.error).toBeUndefined();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.exit_code).toBe(3);
    expect(reports[0]!.exit_reason).toBe('crash');
    expect(reports[0]!.error).toBe('boom');
  });

  test('signal exit is reported', async () => {
    const reports: CompleteAutomationRequest[] = [];
    const io: AutomationRunIo = {
      async run() { return makeResult({ exitCode: null, exitSignal: 'SIGTERM', exitReason: 'timeout' }); },
      async deliver(result, finalizeAttempt) {
        reports.push({
          worker_id: 'test-worker',
          output: result.output,
          exit_signal: result.exitSignal,
          exit_reason: result.exitReason,
          finalize_attempt: finalizeAttempt,
        });
        return { ok: true, status: 'completed' };
      },
      async reportError() {},
    };

    const result = await dispatchAutomationResumeLoop(io);

    expect(result.error).toBeUndefined();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.exit_signal).toBe('SIGTERM');
  });

  test('resume response re-spawns with nudge', async () => {
    let round = 0;
    const reports: CompleteAutomationRequest[] = [];
    const runs: (string | undefined)[] = [];
    const io: AutomationRunIo = {
      async run(nudge) {
        round++;
        runs.push(nudge);
        if (round === 1) return makeResult({ output: 'partial work' });
        return makeResult({ output: 'done' });
      },
      async deliver(result, finalizeAttempt) {
        reports.push({
          worker_id: 'test-worker',
          output: result.output,
          finalize_attempt: finalizeAttempt,
        });
        if (round === 1) {
          return { ok: true, status: 'resume', attempt: 1, max_attempts: 3, nudge: 'Please finalize the window.' };
        }
        return { ok: true, status: 'completed' };
      },
      async reportError() {},
    };

    const result = await dispatchAutomationResumeLoop(io);

    expect(result.error).toBeUndefined();
    expect(reports).toHaveLength(2);
    expect(runs[0]).toBeUndefined();
    expect(runs[1]).toContain('Please finalize the window.');
  });

  test('loop exhausted by repeated resumes returns error', async () => {
    const reports: CompleteAutomationRequest[] = [];
    const io: AutomationRunIo = {
      async run() { return makeResult(); },
      async deliver(result, finalizeAttempt) {
        reports.push({
          worker_id: 'test-worker',
          output: result.output,
          finalize_attempt: finalizeAttempt,
        });
        return { ok: true, status: 'resume', attempt: 1, max_attempts: 99, nudge: 'again' };
      },
      async reportError() {},
    };

    const result = await dispatchAutomationResumeLoop(io);

    expect(reports).toHaveLength(8);
    expect(result.error).toContain('safety cap');
  });

  test('run exception reports error and returns', async () => {
    const errors: string[] = [];
    const io: AutomationRunIo = {
      async run() { throw new Error('binary not found'); },
      async deliver() { return { ok: true, status: 'completed' }; },
      async reportError(error) { errors.push(error); },
    };

    const result = await dispatchAutomationResumeLoop(io);

    expect(result.error).toContain('binary not found');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('binary not found');
  });

  test('idempotent response still continues the loop (server-level idempotency)', async () => {
    let round = 0;
    const reports: CompleteAutomationRequest[] = [];
    const io: AutomationRunIo = {
      async run() {
        round++;
        return makeResult({ output: `round ${round}` });
      },
      async deliver(result, finalizeAttempt) {
        reports.push({
          worker_id: 'test-worker',
          output: result.output,
          finalize_attempt: finalizeAttempt,
        });
        if (round === 1) return { ok: true, status: 'resume', attempt: 1, max_attempts: 3, nudge: 'nudge' };
        return { ok: true, status: 'resume', idempotent: true };
      },
      async reportError() {},
    };

    const result = await dispatchAutomationResumeLoop(io);

    expect(reports).toHaveLength(8);
    expect(result.error).toContain('safety cap');
  });

  test('null deliver response returns without error', async () => {
    const io: AutomationRunIo = {
      async run() { return makeResult(); },
      async deliver() { return null; },
      async reportError() {},
    };

    const result = await dispatchAutomationResumeLoop(io);

    expect(result.error).toBeUndefined();
    expect(result.itemsCollected).toBe(0);
  });
});

function makeSafetyNetClient() {
  const completes: Array<Record<string, unknown>> = [];
  const automationCompletes: Array<{ runId: number; req: Record<string, unknown> }> = [];
  const client = {
    id: 'test-worker',
    version: 'test',
    async heartbeat() {},
    async stream() {},
    async complete(req: Record<string, unknown>) { completes.push(req); },
    async completeAction() {},
    async completeEmbeddings() {},
    async completeAuth() {},
    async emitAuthArtifact() {},
    async pollAuthSignal() { return { signal: null }; },
    async fetchEventsForEmbedding() { return []; },
    async dispatchChromeAction() { return {}; },
    async completeAutomation(runId: number, req: Record<string, unknown>) {
      automationCompletes.push({ runId, req });
      return { ok: true, status: 'completed' };
    },
  };
  return { client, completes, automationCompletes };
}

describe('executeRun try/catch safety net', () => {
  test('catches unhandled errors and terminates the run via complete', async () => {
    const { client, completes } = makeSafetyNetClient();

    const result = await executeRun(
      client as any,
      { run_id: 9, run_type: 'sync' } as any,
      {}
    );

    expect(result.error).toContain('Invalid run: missing run_id or connector_key');
    expect(completes).toHaveLength(1);
    expect(completes[0]!.status).toBe('failed');
    expect(completes[0]!.run_id).toBe(9);
  });

  test('automation-lane unhandled error terminates via complete-automation, never the sync endpoint', async () => {
    const { client, completes, automationCompletes } = makeSafetyNetClient();

    // A payload that clears the envelope guard but has no `context` → throws
    // inside executeAutomationRun before its own reporting kicks in, exercising
    // the outer net. The sync /complete endpoint must NOT be used: it would
    // finalize the run row but skip the automation-side bookkeeping.
    const result = await executeRun(
      client as any,
      {
        run_id: 12,
        run_type: 'automation',
        payload: { automation: { agent_kind: 'pi' } },
      } as any,
      {}
    );

    expect(result.error).toBeTruthy();
    expect(completes).toHaveLength(0);
    expect(automationCompletes).toHaveLength(1);
    expect(automationCompletes[0]!.runId).toBe(12);
    expect(automationCompletes[0]!.req.exit_reason).toBe('crash');
    expect(String(automationCompletes[0]!.req.error)).toBeTruthy();
  });

  test('a non-automation envelope on the automation lane is reported, not crashed', async () => {
    const { client, completes, automationCompletes } = makeSafetyNetClient();

    const result = await executeRun(
      client as any,
      { run_id: 13, run_type: 'automation', payload: { turn: {} } } as any,
      {}
    );

    expect(result.error).toContain('non-automation payload envelope');
    expect(completes).toHaveLength(0);
    expect(automationCompletes).toHaveLength(1);
    expect(automationCompletes[0]!.runId).toBe(13);
    expect(automationCompletes[0]!.req.exit_reason).toBe('error_message');
  });
});

describe('resolveDeviceAgentRunAccess', () => {
  const daemonWiring = { url: 'http://daemon.local/api/mcp', bearer: 'daemon-pat' };
  const basePayload = (
    session?: NonNullable<AutomationPollPayload['context']['agent_session']>
  ): AutomationPollPayload => ({
    automation: { id: '7' },
    event: { fired_at: '2026-08-20T00:00:00.000Z' },
    context: {
      device: {},
      user: {},
      ...(session ? { agent_session: session } : {}),
    },
  });

  test('prefers the per-run agent session for both MCP wiring and CLI env', () => {
    const session = {
      conversation_id: 'agent_automation_7_run_9',
      mcp_url: 'https://gateway.test/lobu/mcp/lobu-memory',
      token: 'run-scoped-token',
      expires_at: Date.now() + 60_000,
    };
    const access = resolveDeviceAgentRunAccess(
      basePayload(session).context.agent_session,
      daemonWiring
    );
    expect(access.wiring).toEqual({
      url: 'https://gateway.test/lobu/mcp/lobu-memory',
      bearer: 'run-scoped-token',
    });
    expect(access.env).toEqual({
      LOBU_API_TOKEN: 'run-scoped-token',
      LOBU_MEMORY_URL: 'https://gateway.test/lobu/mcp/lobu-memory',
    });
  });

  test('falls back to the daemon wiring (and no env override) without a session', () => {
    const access = resolveDeviceAgentRunAccess(
      basePayload().context.agent_session,
      daemonWiring
    );
    expect(access.wiring).toBe(daemonWiring);
    expect(access.env).toEqual({});
  });
});
