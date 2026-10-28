/**
 * Headless Automation execution lane: once the daemon claims a
 * `run_type='automation'` run, every unhandled failure must still reach a
 * terminal state through complete-automation (never the sync endpoint), and the
 * spawned agent must receive the per-run session credentials, not the daemon's.
 *
 * The resume loop itself is covered by automation-arm.test.ts.
 */

import { describe, expect, test } from 'bun:test';

import { resolveDeviceAgentRunAccess } from '../daemon/automation.js';
import { executeRun } from '../daemon/executor.js';
import type { AutomationPollPayload } from '@lobu/core/contracts/worker/protocol';

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
