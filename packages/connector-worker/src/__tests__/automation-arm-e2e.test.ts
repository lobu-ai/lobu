import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { type ChildProcess, spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { CompleteAutomationResponse, PollResponse } from '@lobu/core/contracts/worker/protocol';
import { executeAutomationRun } from '../daemon/automation.js';
import { CLI_SUPERVISOR_SOURCE } from '../daemon/automation-process.js';
import { WorkerClient } from '../daemon/client.js';
import type { ExecutorConfig } from '../daemon/executor.js';

/**
 * End-to-end automation arm: a real CLI subprocess (fake `pi` binary) + a real
 * HTTP round-trip against a stub gateway. Pins that the daemon actually spawns
 * the CLI, drains its output, and posts the exit report — the path the unit
 * tests mock away.
 */

const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobu-automation-e2e-'));
const fakeBinary = path.join(tmp, 'pi');
const heartbeatConflictBinary = path.join(tmp, 'pi-heartbeat-conflict');
const heartbeatConflictGrandchildBinary = path.join(tmp, 'pi-heartbeat-grandchild');
const transientHeartbeatBinary = path.join(tmp, 'pi-transient-heartbeat');
const openCodeQuotaBinary = path.join(tmp, 'opencode-quota-stall');
const openCodeGenericErrorBinary = path.join(tmp, 'opencode-generic-error-stall');
const openCodeQuotaThenExitBinary = path.join(tmp, 'opencode-quota-then-exit');
const argsLog = path.join(tmp, 'args.log');
const heartbeatConflictPid = path.join(tmp, 'heartbeat-conflict.pid');
const heartbeatConflictTerminated = path.join(tmp, 'heartbeat-conflict-terminated.log');
const heartbeatConflictGrandchildPid = path.join(tmp, 'heartbeat-conflict-grandchild.pid');
const heartbeatConflictGrandchildTerminated = path.join(
  tmp,
  'heartbeat-conflict-grandchild-terminated.log'
);
const heartbeatConflictGrandchildAnchor = path.join(tmp, 'heartbeat-conflict-anchor.log');
const syntheticCleanupSignal = path.join(tmp, 'synthetic-cleanup.signal');
const syntheticPidLog = path.join(tmp, 'synthetic-pids.log');
const parentLossHarness = path.join(tmp, 'parent-loss-harness.js');
const parentLossSupervisorPid = path.join(tmp, 'parent-loss-supervisor.pid');
const parentLossTargetPid = path.join(tmp, 'parent-loss-target.pid');
const parentLossTargetTerminated = path.join(tmp, 'parent-loss-target-terminated.log');
const parentLossGrandchildPid = path.join(tmp, 'parent-loss-grandchild.pid');
const parentLossGrandchildTerminated = path.join(tmp, 'parent-loss-grandchild-terminated.log');
const parentLossGrandchildAnchor = path.join(tmp, 'parent-loss-grandchild-anchor.log');
const parentLossIgnoringTargetBinary = path.join(tmp, 'parent-loss-ignoring-target');
const parentLossIgnoringGrandchildBinary = path.join(tmp, 'parent-loss-ignoring-grandchild');

function automationJob(): PollResponse {
  return {
    run_id: 42,
    run_type: 'automation',
    organization_id: 'org_test',
    payload: {
      automation: {
        id: 'beh_1',
        name: 'Test',
        slug: 'test',
        agent_kind: 'pi',
        prompt: 'do a thing',
      },
      event: { trigger_event_id: null, fired_at: '2026-07-30T00:00:00Z', payload: {} },
      context: { device: { worker_id: 'wrk_1' }, user: { user_id: 'usr_1' } },
    },
  };
}

function openCodeAutomationJob(): PollResponse {
  const job = automationJob();
  if (!job.payload) throw new Error('automation test payload missing');
  job.payload.automation.agent_kind = 'opencode';
  job.payload.automation.execution_config = {
    model: 'opencode-go/deepseek-v4-flash',
  };
  return job;
}

let server: http.Server;
let baseUrl: string;
let completions: Array<{ path: string; body: Record<string, unknown> }>;
let script: CompleteAutomationResponse[];
let heartbeatStatus = 200;
let heartbeatRequests = 0;
let heartbeatReadyFiles: string[] = [];
let heartbeatStatusAfterFirstCompletion: number | null = null;
let firstCompletionResponseDelayMs = 0;

function cfg(): ExecutorConfig {
  return {
    heartbeatIntervalMs: 60_000,
    generateEmbeddings: true,
    timeoutMs: 30_000,
    binaryOverrides: { pi: fakeBinary },
  };
}

function client(): WorkerClient {
  return new WorkerClient({
    apiUrl: baseUrl,
    workerId: 'wrk_1',
    authToken: 'owl_pat_test',
    capabilities: {},
  });
}

async function waitForFiles(files: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!files.every((file) => existsSync(file)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!files.every((file) => existsSync(file))) {
    throw new Error(`timed out waiting for ${files.length} process proof files`);
  }
}

async function waitForChildExit(proc: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (proc.exitCode !== null) return proc.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child exit timed out')), timeoutMs);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitForProcessesToExit(pids: number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(processIsAlive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return pids.every((pid) => !processIsAlive(pid));
}

async function launchParentLossHarness(
  targetBinary: string,
  grandchildBinary: string
): Promise<{ supervisorPid: number; ownedPids: number[] }> {
  const harness = spawn(process.execPath, [parentLossHarness], {
    env: {
      ...process.env,
      FAKE_CLI_BINARY: targetBinary,
      FAKE_CLI_SUPERVISOR_PID_FILE: parentLossSupervisorPid,
      FAKE_CLI_PID: parentLossTargetPid,
      FAKE_CLI_TERMINATED: parentLossTargetTerminated,
      FAKE_CLI_GRANDCHILD_BINARY: grandchildBinary,
      FAKE_CLI_GRANDCHILD_PID: parentLossGrandchildPid,
      FAKE_CLI_GRANDCHILD_TERMINATED: parentLossGrandchildTerminated,
      FAKE_CLI_GRANDCHILD_ANCHOR: parentLossGrandchildAnchor,
    },
    stdio: 'ignore',
  });
  if ((await waitForChildExit(harness, 5000)) !== 0) {
    throw new Error('parent-loss harness failed before exiting');
  }
  await waitForFiles(
    [parentLossSupervisorPid, parentLossTargetPid, parentLossGrandchildPid],
    1000
  );
  const supervisorPid = Number(readFileSync(parentLossSupervisorPid, 'utf8'));
  return {
    supervisorPid,
    ownedPids: [
      supervisorPid,
      Number(readFileSync(parentLossTargetPid, 'utf8')),
      Number(readFileSync(parentLossGrandchildPid, 'utf8')),
    ],
  };
}

async function cleanupFailedParentLossTest(
  supervisorPid: number | undefined,
  ownedPids: number[]
): Promise<void> {
  // The passing path never signals a numeric pid. On a regression, first let
  // cooperative fixtures exit, then remove only the still-live group leader
  // this test just created so a red test cannot leak an immortal supervisor.
  writeFileSync(syntheticCleanupSignal, 'exit');
  if (ownedPids.length > 1) await waitForProcessesToExit(ownedPids.slice(1), 500);
  if (supervisorPid != null && processIsAlive(supervisorPid)) {
    try {
      process.kill(-supervisorPid, 'SIGKILL');
    } catch {}
    await waitForProcessesToExit([supervisorPid], 1000);
  }
}

beforeAll(async () => {
  writeFileSync(
    fakeBinary,
    `#!/bin/sh\necho "FAKE_OUTPUT"\necho "---INVOCATION---" >> "$FAKE_CLI_LOG"\nprintf '%s\\n' "$@" >> "$FAKE_CLI_LOG"\nexit 0\n`
  );
  chmodSync(fakeBinary, 0o755);
  writeFileSync(
    heartbeatConflictBinary,
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst { spawn } = require('node:child_process');\nif (process.env.FAKE_CLI_PID_LOG) fs.appendFileSync(process.env.FAKE_CLI_PID_LOG, process.pid + '\\n');\nif (process.env.FAKE_CLI_CLEANUP_FILE) {\n  setInterval(() => {\n    if (fs.existsSync(process.env.FAKE_CLI_CLEANUP_FILE)) process.exit(0);\n  }, 25);\n  setTimeout(() => process.exit(0), 30_000);\n}\nif (process.env.FAKE_CLI_GRANDCHILD_BINARY) {\n  spawn(process.env.FAKE_CLI_GRANDCHILD_BINARY, [], {\n    env: { ...process.env, FAKE_CLI_SUPERVISOR_PID: String(process.ppid) },\n    stdio: 'ignore',\n  });\n}\nprocess.on('SIGTERM', () => {\n  if (process.env.FAKE_CLI_TERMINATED) fs.writeFileSync(process.env.FAKE_CLI_TERMINATED, 'SIGTERM');\n  process.exit(0);\n});\nif (process.env.FAKE_CLI_PID) fs.writeFileSync(process.env.FAKE_CLI_PID, String(process.pid));\nconst exitAfterMs = Number(process.env.FAKE_CLI_EXIT_AFTER_MS);\nif (Number.isFinite(exitAfterMs) && exitAfterMs > 0) {\n  setTimeout(() => {\n    process.stdout.write('GRACEFUL_HEARTBEAT_OUTPUT');\n    process.exit(0);\n  }, exitAfterMs);\n} else {\n  setInterval(() => {}, 1000);\n}\n`
  );
  chmodSync(heartbeatConflictBinary, 0o755);
  writeFileSync(
    heartbeatConflictGrandchildBinary,
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nif (process.env.FAKE_CLI_PID_LOG) fs.appendFileSync(process.env.FAKE_CLI_PID_LOG, process.pid + '\\n');\nif (process.env.FAKE_CLI_CLEANUP_FILE) {\n  setInterval(() => {\n    if (fs.existsSync(process.env.FAKE_CLI_CLEANUP_FILE)) process.exit(0);\n  }, 25);\n  setTimeout(() => process.exit(0), 30_000);\n}\nprocess.on('SIGTERM', () => {\n  if (process.env.FAKE_CLI_GRANDCHILD_TERMINATED) {\n    fs.writeFileSync(process.env.FAKE_CLI_GRANDCHILD_TERMINATED, 'SIGTERM');\n  }\n  if (process.env.FAKE_CLI_GRANDCHILD_ANCHOR) {\n    let anchorAlive = false;\n    try {\n      process.kill(Number(process.env.FAKE_CLI_SUPERVISOR_PID), 0);\n      anchorAlive = true;\n    } catch {}\n    fs.writeFileSync(process.env.FAKE_CLI_GRANDCHILD_ANCHOR, String(anchorAlive));\n  }\n  process.exit(0);\n});\nif (process.env.FAKE_CLI_GRANDCHILD_PID) {\n  fs.writeFileSync(process.env.FAKE_CLI_GRANDCHILD_PID, String(process.pid));\n}\nsetInterval(() => {}, 1000);\n`
  );
  chmodSync(heartbeatConflictGrandchildBinary, 0o755);
  writeFileSync(
    transientHeartbeatBinary,
    `#!/usr/bin/env node\nsetTimeout(() => {\n  process.stdout.write('TRANSIENT_HEARTBEAT_OUTPUT');\n  process.exit(0);\n}, 150);\n`
  );
  chmodSync(transientHeartbeatBinary, 0o755);
  writeFileSync(
    openCodeQuotaBinary,
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nif (process.env.FAKE_CLI_PID_LOG) fs.appendFileSync(process.env.FAKE_CLI_PID_LOG, process.pid + '\\n');\nif (process.env.FAKE_CLI_LOG) fs.appendFileSync(process.env.FAKE_CLI_LOG, process.argv.slice(2).join('\\n') + '\\n');\nconsole.error('timestamp=2026-08-21T04:25:04.987Z level=ERROR run=389ea1b7 message="stream error" providerID=opencode-go modelID=deepseek-v4-flash error.error="AI_APICallError: Monthly usage limit reached. Resets in 14 days. To continue using this model now, enable usage from your available balance"');\nsetTimeout(() => {\n  if (process.env.FAKE_CLI_PID) fs.writeFileSync(process.env.FAKE_CLI_PID, String(process.pid));\n}, 100);\nprocess.on('SIGTERM', () => {\n  if (process.env.FAKE_CLI_TERMINATED) fs.writeFileSync(process.env.FAKE_CLI_TERMINATED, 'SIGTERM');\n  process.exit(0);\n});\nsetInterval(() => {}, 1000);\n`
  );
  chmodSync(openCodeQuotaBinary, 0o755);
  writeFileSync(
    openCodeGenericErrorBinary,
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nconsole.error('timestamp=2026-08-21T04:25:04.987Z level=ERROR run=389ea1b7 message="stream error" providerID=opencode-go modelID=deepseek-v4-flash error.error="AI_APICallError: Provider service temporarily unavailable"');\nif (process.env.FAKE_CLI_PID) fs.writeFileSync(process.env.FAKE_CLI_PID, String(process.pid));\nsetInterval(() => {}, 1000);\n`
  );
  chmodSync(openCodeGenericErrorBinary, 0o755);
  writeFileSync(
    openCodeQuotaThenExitBinary,
    `#!/usr/bin/env node\nconsole.error('timestamp=2026-08-21T04:25:04.987Z level=ERROR run=389ea1b7 message="stream error" providerID=opencode-go modelID=deepseek-v4-flash error.error="AI_APICallError: Monthly usage limit reached. Resets in 14 days."');\nsetTimeout(() => {\n  process.stdout.write('RECOVERED_AND_SUCCEEDED');\n  process.exit(0);\n}, 400);\n`
  );
  chmodSync(openCodeQuotaThenExitBinary, 0o755);
  writeFileSync(
    parentLossHarness,
    `const fs = require('node:fs');\nconst { spawn } = require('node:child_process');\nconst supervisor = spawn(process.execPath, ['-e', ${JSON.stringify(CLI_SUPERVISOR_SOURCE)}, '--', process.env.FAKE_CLI_BINARY], { detached: true, env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });\nfs.writeFileSync(process.env.FAKE_CLI_SUPERVISOR_PID_FILE, String(supervisor.pid));\nconst deadline = Date.now() + 3000;\nconst ready = setInterval(() => {\n  if (fs.existsSync(process.env.FAKE_CLI_PID) && fs.existsSync(process.env.FAKE_CLI_GRANDCHILD_PID)) {\n    clearInterval(ready);\n    process.exit(0);\n  }\n  if (Date.now() >= deadline) process.exit(2);\n}, 25);\n`
  );
  writeFileSync(
    parentLossIgnoringGrandchildBinary,
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nif (process.env.FAKE_CLI_PID_LOG) fs.appendFileSync(process.env.FAKE_CLI_PID_LOG, process.pid + '\\n');\nif (process.env.FAKE_CLI_CLEANUP_FILE) {\n  setInterval(() => {\n    if (fs.existsSync(process.env.FAKE_CLI_CLEANUP_FILE)) process.exit(0);\n  }, 25);\n  setTimeout(() => process.exit(0), 30_000);\n}\nif (process.env.FAKE_CLI_GRANDCHILD_PID) fs.writeFileSync(process.env.FAKE_CLI_GRANDCHILD_PID, String(process.pid));\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`
  );
  chmodSync(parentLossIgnoringGrandchildBinary, 0o755);
  writeFileSync(
    parentLossIgnoringTargetBinary,
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst { spawn } = require('node:child_process');\nif (process.env.FAKE_CLI_PID_LOG) fs.appendFileSync(process.env.FAKE_CLI_PID_LOG, process.pid + '\\n');\nif (process.env.FAKE_CLI_CLEANUP_FILE) {\n  setInterval(() => {\n    if (fs.existsSync(process.env.FAKE_CLI_CLEANUP_FILE)) process.exit(0);\n  }, 25);\n  setTimeout(() => process.exit(0), 30_000);\n}\nspawn(process.env.FAKE_CLI_GRANDCHILD_BINARY, [], { env: process.env, stdio: 'ignore' });\nif (process.env.FAKE_CLI_PID) fs.writeFileSync(process.env.FAKE_CLI_PID, String(process.pid));\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`
  );
  chmodSync(parentLossIgnoringTargetBinary, 0o755);
  process.env.FAKE_CLI_LOG = argsLog;
  process.env.FAKE_CLI_PID = heartbeatConflictPid;
  process.env.FAKE_CLI_TERMINATED = heartbeatConflictTerminated;
  process.env.FAKE_CLI_CLEANUP_FILE = syntheticCleanupSignal;
  process.env.FAKE_CLI_PID_LOG = syntheticPidLog;

  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'POST' && req.url?.includes('/complete-automation')) {
        completions.push({ path: req.url ?? '', body: body ? JSON.parse(body) : {} });
        const reply = script.shift() ?? { status: 'completed' };
        if (completions.length === 1 && heartbeatStatusAfterFirstCompletion != null) {
          heartbeatStatus = heartbeatStatusAfterFirstCompletion;
        }
        const sendReply = () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(reply));
        };
        if (completions.length === 1 && firstCompletionResponseDelayMs > 0) {
          setTimeout(sendReply, firstCompletionResponseDelayMs);
        } else {
          sendReply();
        }
        return;
      }
      if (req.method === 'POST' && req.url?.includes('/heartbeat')) {
        heartbeatRequests += 1;
        // Hold the 409 back until the fake CLI has recorded its pid: cancelling
        // before the child exists would leave nothing to prove was killed.
        const status =
          heartbeatStatus === 409 && !heartbeatReadyFiles.every((file) => existsSync(file))
            ? 200
            : heartbeatStatus;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(
          status === 200
            ? '{}'
            : JSON.stringify({ error: 'Run is not in progress' })
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  delete process.env.FAKE_CLI_LOG;
  delete process.env.FAKE_CLI_PID;
  delete process.env.FAKE_CLI_TERMINATED;
  delete process.env.FAKE_CLI_EXIT_AFTER_MS;
  delete process.env.FAKE_CLI_GRANDCHILD_BINARY;
  delete process.env.FAKE_CLI_GRANDCHILD_PID;
  delete process.env.FAKE_CLI_GRANDCHILD_TERMINATED;
  delete process.env.FAKE_CLI_GRANDCHILD_ANCHOR;
  delete process.env.FAKE_CLI_CLEANUP_FILE;
  delete process.env.FAKE_CLI_PID_LOG;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(argsLog, { force: true });
  rmSync(heartbeatConflictPid, { force: true });
  rmSync(heartbeatConflictTerminated, { force: true });
  rmSync(heartbeatConflictGrandchildPid, { force: true });
  rmSync(heartbeatConflictGrandchildTerminated, { force: true });
  rmSync(heartbeatConflictGrandchildAnchor, { force: true });
  rmSync(syntheticCleanupSignal, { force: true });
  rmSync(syntheticPidLog, { force: true });
  rmSync(parentLossSupervisorPid, { force: true });
  rmSync(parentLossTargetPid, { force: true });
  rmSync(parentLossTargetTerminated, { force: true });
  rmSync(parentLossGrandchildPid, { force: true });
  rmSync(parentLossGrandchildTerminated, { force: true });
  rmSync(parentLossGrandchildAnchor, { force: true });
  delete process.env.FAKE_CLI_EXIT_AFTER_MS;
  delete process.env.FAKE_CLI_GRANDCHILD_BINARY;
  delete process.env.FAKE_CLI_GRANDCHILD_PID;
  delete process.env.FAKE_CLI_GRANDCHILD_TERMINATED;
  delete process.env.FAKE_CLI_GRANDCHILD_ANCHOR;
  heartbeatStatus = 200;
  heartbeatRequests = 0;
  heartbeatReadyFiles = [];
  heartbeatStatusAfterFirstCompletion = null;
  firstCompletionResponseDelayMs = 0;
});

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  // Signal only the synthetic scripts we own. Polling liveness is harmless if
  // a pid was recycled; unlike raw process.kill(pid, SIGKILL), it can never
  // terminate an unrelated process after a successful test.
  writeFileSync(syntheticCleanupSignal, 'exit');
  const pids = existsSync(syntheticPidLog)
    ? readFileSync(syntheticPidLog, 'utf8')
        .trim()
        .split('\n')
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 0)
    : [];
  const deadline = Date.now() + 2000;
  while (pids.some(processIsAlive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const leaked = pids.filter(processIsAlive);
  if (leaked.length > 0) throw new Error(`synthetic process cleanup timed out (${leaked.length})`);
});

function readArgsLog(): string {
  try {
    return readFileSync(argsLog, 'utf8');
  } catch {
    return '';
  }
}

describe('automation arm e2e', () => {
  test('a parent process exit terminates its detached supervisor and owned CLI tree', async () => {
    if (process.platform === 'win32') return;
    let supervisorPid: number | undefined;
    let ownedPids: number[] = [];
    try {
      ({ supervisorPid, ownedPids } = await launchParentLossHarness(
        heartbeatConflictBinary,
        heartbeatConflictGrandchildBinary
      ));

      expect(await waitForProcessesToExit(ownedPids, 5000)).toBe(true);
      expect(readFileSync(parentLossTargetTerminated, 'utf8')).toBe('SIGTERM');
      expect(readFileSync(parentLossGrandchildTerminated, 'utf8')).toBe('SIGTERM');
      expect(readFileSync(parentLossGrandchildAnchor, 'utf8')).toBe('true');
    } finally {
      await cleanupFailedParentLossTest(supervisorPid, ownedPids);
    }
  }, 15_000);

  test('parent loss force-kills the owned tree when every target ignores SIGTERM', async () => {
    if (process.platform === 'win32') return;
    let supervisorPid: number | undefined;
    let ownedPids: number[] = [];
    try {
      ({ supervisorPid, ownedPids } = await launchParentLossHarness(
        parentLossIgnoringTargetBinary,
        parentLossIgnoringGrandchildBinary
      ));
      expect(await waitForProcessesToExit(ownedPids, 5000)).toBe(true);
    } finally {
      await cleanupFailedParentLossTest(supervisorPid, ownedPids);
    }
  }, 15_000);

  test('TERM-ignoring parent-loss fixtures obey the synthetic cleanup backstop', async () => {
    if (process.platform === 'win32') return;
    let targetPid: number | undefined;
    let ownedPids: number[] = [];
    try {
      const target = spawn(parentLossIgnoringTargetBinary, [], {
        detached: true,
        env: {
          ...process.env,
          FAKE_CLI_PID: parentLossTargetPid,
          FAKE_CLI_GRANDCHILD_BINARY: parentLossIgnoringGrandchildBinary,
          FAKE_CLI_GRANDCHILD_PID: parentLossGrandchildPid,
        },
        stdio: 'ignore',
      });
      targetPid = target.pid;
      await waitForFiles([parentLossTargetPid, parentLossGrandchildPid], 1000);
      ownedPids = [
        Number(readFileSync(parentLossTargetPid, 'utf8')),
        Number(readFileSync(parentLossGrandchildPid, 'utf8')),
      ];

      writeFileSync(syntheticCleanupSignal, 'exit');
      expect(await waitForProcessesToExit(ownedPids, 1000)).toBe(true);
      const loggedPids = readFileSync(syntheticPidLog, 'utf8')
        .trim()
        .split('\n')
        .map(Number);
      for (const pid of ownedPids) expect(loggedPids).toContain(pid);
    } finally {
      await cleanupFailedParentLossTest(targetPid, ownedPids);
    }
  }, 10_000);

  test('spawns the CLI, drains output, and posts the exit report', async () => {
    completions = [];
    script = [{ status: 'completed' }];
    const result = await executeAutomationRun(client(), automationJob(), cfg());

    expect(result.error).toBeUndefined();
    expect(completions).toHaveLength(1);
    expect(completions[0].path).toBe('/api/workers/me/runs/42/complete-automation');
    expect(completions[0].body.worker_id).toBe('wrk_1');
    expect(completions[0].body.output).toContain('FAKE_OUTPUT');
    expect(completions[0].body.exit_reason).toBe('ok');
    expect(completions[0].body.finalize_attempt).toBe(0);
    expect(readArgsLog().split('---INVOCATION---').length - 1).toBe(1);
  });

  test("a granted resume re-spawns the CLI with the server's nudge in the prompt", async () => {
    completions = [];
    script = [
      { status: 'resume', attempt: 2, max_attempts: 3, nudge: 'finalize it' },
      { status: 'completed' },
    ];
    const result = await executeAutomationRun(client(), automationJob(), cfg());

    expect(result.error).toBeUndefined();
    expect(completions).toHaveLength(2);
    expect(completions[1].body.finalize_attempt).toBe(2);
    const log = readArgsLog();
    expect(log.split('---INVOCATION---').length - 1).toBe(2);
    expect(log).toContain('finalize it');
    expect(log).toContain('FINALIZE NUDGE');
  });

  test('a terminal heartbeat latched before a resume response prevents the next spawn', async () => {
    completions = [];
    script = [
      { status: 'resume', attempt: 1, max_attempts: 2, nudge: 'finalize it' },
      { status: 'completed' },
    ];
    heartbeatStatusAfterFirstCompletion = 409;
    // Model a resume response already committed while an independent terminal
    // transition makes heartbeats return 409 before that response reaches us.
    firstCompletionResponseDelayMs = 100;
    const raced = cfg();
    raced.heartbeatIntervalMs = 10;

    const result = await executeAutomationRun(client(), automationJob(), raced);

    expect(result).toEqual({ itemsCollected: 0 });
    expect(heartbeatRequests).toBeGreaterThan(0);
    expect(completions).toHaveLength(1);
    expect(readArgsLog().split('---INVOCATION---').length - 1).toBe(1);
  });

  test('a missing binary reports a terminal failure instead of hanging', async () => {
    completions = [];
    script = [{ status: 'completed' }];
    const missing = cfg();
    missing.binaryOverrides = { pi: path.join(tmp, 'does-not-exist') };
    const result = await executeAutomationRun(client(), automationJob(), missing);

    expect(result.error).toContain('binary not found');
    expect(completions).toHaveLength(1);
    expect(completions[0].body.error).toContain('binary not found');
    expect(completions[0].body.exit_reason).toBe('error_message');
  });

  test('a terminal heartbeat conflict stops the CLI and reports its device exit', async () => {
    completions = [];
    script = [{ status: 'completed' }];
    heartbeatStatus = 409;
    const conflict = cfg();
    conflict.heartbeatIntervalMs = 10;
    conflict.timeoutMs = 8000;
    conflict.terminalHeartbeatGraceMs = 100;
    conflict.binaryOverrides = { pi: heartbeatConflictBinary };
    process.env.FAKE_CLI_GRANDCHILD_BINARY = heartbeatConflictGrandchildBinary;
    process.env.FAKE_CLI_GRANDCHILD_PID = heartbeatConflictGrandchildPid;
    process.env.FAKE_CLI_GRANDCHILD_TERMINATED = heartbeatConflictGrandchildTerminated;
    heartbeatReadyFiles = [heartbeatConflictPid, heartbeatConflictGrandchildPid];

    const startedAt = Date.now();
    const result = await executeAutomationRun(client(), automationJob(), conflict);
    const elapsedMs = Date.now() - startedAt;

    expect(result).toEqual({ itemsCollected: 0 });
    // The server's terminal-safe completion path retains device provenance and
    // duration without replacing the outcome that made heartbeat return 409.
    expect(completions).toHaveLength(1);
    expect(completions[0].body.exit_reason).toBe('ok');
    expect(completions[0].body.exit_signal).toBe('SIGTERM');
    expect(readFileSync(heartbeatConflictTerminated, 'utf8')).toBe('SIGTERM');
    const childPid = Number(readFileSync(heartbeatConflictPid, 'utf8'));
    expect(() => process.kill(childPid, 0)).toThrow();
    expect(readFileSync(heartbeatConflictGrandchildTerminated, 'utf8')).toBe('SIGTERM');
    const grandchildPid = Number(readFileSync(heartbeatConflictGrandchildPid, 'utf8'));
    expect(() => process.kill(grandchildPid, 0)).toThrow();
    // Cancelled on the heartbeat, not left to the clock: an uncancelled run
    // burns the 8s timeout plus the SIGTERM/SIGKILL grace windows (~16s).
    expect(elapsedMs).toBeLessThan(4000);
  }, 30_000);

  test('a post-complete heartbeat conflict lets the CLI exit and report normally', async () => {
    completions = [];
    script = [{ status: 'completed' }];
    heartbeatStatus = 409;
    process.env.FAKE_CLI_EXIT_AFTER_MS = '250';
    const graceful = cfg();
    graceful.heartbeatIntervalMs = 10;
    graceful.terminalHeartbeatGraceMs = 1000;
    graceful.binaryOverrides = { pi: heartbeatConflictBinary };
    heartbeatReadyFiles = [heartbeatConflictPid];

    const result = await executeAutomationRun(client(), automationJob(), graceful);

    expect(result.error).toBeUndefined();
    expect(heartbeatRequests).toBeGreaterThan(0);
    expect(completions).toHaveLength(1);
    expect(completions[0].body.exit_signal).toBeNull();
    expect(completions[0].body.output).toContain('GRACEFUL_HEARTBEAT_OUTPUT');
    expect(existsSync(heartbeatConflictTerminated)).toBe(false);
  });

  test('a leader exiting inside the heartbeat grace cannot orphan its grandchild', async () => {
    completions = [];
    script = [{ status: 'completed' }];
    heartbeatStatus = 409;
    process.env.FAKE_CLI_EXIT_AFTER_MS = '250';
    process.env.FAKE_CLI_GRANDCHILD_BINARY = heartbeatConflictGrandchildBinary;
    process.env.FAKE_CLI_GRANDCHILD_PID = heartbeatConflictGrandchildPid;
    process.env.FAKE_CLI_GRANDCHILD_TERMINATED = heartbeatConflictGrandchildTerminated;
    process.env.FAKE_CLI_GRANDCHILD_ANCHOR = heartbeatConflictGrandchildAnchor;
    heartbeatReadyFiles = [heartbeatConflictPid, heartbeatConflictGrandchildPid];
    const gracefulTree = cfg();
    gracefulTree.heartbeatIntervalMs = 10;
    gracefulTree.terminalHeartbeatGraceMs = 1000;
    gracefulTree.binaryOverrides = { pi: heartbeatConflictBinary };

    const result = await executeAutomationRun(client(), automationJob(), gracefulTree);

    expect(result.error).toBeUndefined();
    expect(completions).toHaveLength(1);
    expect(completions[0].body.output).toContain('GRACEFUL_HEARTBEAT_OUTPUT');
    // The real CLI exited on its own, but the supervisor retained the group id
    // long enough to terminate and reap its still-running grandchild safely.
    expect(existsSync(heartbeatConflictTerminated)).toBe(false);
    expect(readFileSync(heartbeatConflictGrandchildTerminated, 'utf8')).toBe('SIGTERM');
    expect(readFileSync(heartbeatConflictGrandchildAnchor, 'utf8')).toBe('true');
    const childPid = Number(readFileSync(heartbeatConflictPid, 'utf8'));
    const grandchildPid = Number(readFileSync(heartbeatConflictGrandchildPid, 'utf8'));
    expect(() => process.kill(childPid, 0)).toThrow();
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  });

  test('a transient heartbeat failure does not cancel a healthy CLI', async () => {
    completions = [];
    script = [{ status: 'completed' }];
    heartbeatStatus = 503;
    const transient = cfg();
    transient.heartbeatIntervalMs = 10;
    transient.binaryOverrides = { pi: transientHeartbeatBinary };

    const result = await executeAutomationRun(client(), automationJob(), transient);

    expect(result.error).toBeUndefined();
    expect(heartbeatRequests).toBeGreaterThan(0);
    expect(completions).toHaveLength(1);
    expect(completions[0].body.output).toContain('TRANSIENT_HEARTBEAT_OUTPUT');
  });
});

/**
 * Regression: a grandchild that inherits the CLI's stdout keeps the pipe's
 * write end open after the CLI itself is reaped. Draining without a deadline
 * parked the run forever — claimed and heartbeating, so the server's stale-run
 * sweep never reclaimed it either. `runCli` now caps the post-exit flush.
 */
describe('automation arm drain deadline', () => {
  const hangBinary = path.join(tmp, 'pi-orphan-pipe');
  const bothPipesBinary = path.join(tmp, 'pi-orphan-both');

  beforeAll(() => {
    writeFileSync(
      bothPipesBinary,
      // Same as above, but the grandchild inherits stderr too — the only shape
      // that can tell a shared deadline apart from two sequential ones.
      `#!/usr/bin/env node\nconst { spawn } = require('node:child_process');\nspawn(${JSON.stringify(heartbeatConflictGrandchildBinary)}, [], { detached: true, env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });\nprocess.on('SIGTERM', () => {});\nconsole.log('PARTIAL_OUTPUT');\nsetTimeout(() => {}, 20_000);\n`
    );
    chmodSync(bothPipesBinary, 0o755);

    writeFileSync(
      hangBinary,
      // Ignore SIGTERM so the run reaches the SIGKILL arm, and daemonize the
      // grandchild into its own process group (`detached: true`) so the tree
      // kill cannot reach it and it keeps holding the inherited stdout write
      // end well past the 2s post-SIGKILL flush window.
      `#!/usr/bin/env node\nconst { spawn } = require('node:child_process');\nspawn(${JSON.stringify(heartbeatConflictGrandchildBinary)}, [], { detached: true, env: process.env, stdio: ['ignore', 'inherit', 'ignore'] });\nprocess.on('SIGTERM', () => {});\nconsole.log('PARTIAL_OUTPUT');\nsetTimeout(() => {}, 15_000);\n`
    );
    chmodSync(hangBinary, 0o755);
  });

  test('a CLI whose grandchild holds stdout still reports, keeping flushed output', async () => {
    completions = [];
    script = [{ status: 'completed' }];
    const hang = cfg();
    hang.timeoutMs = 500;
    hang.binaryOverrides = { pi: hangBinary };

    const startedAt = Date.now();
    const result = await executeAutomationRun(client(), automationJob(), hang);
    const elapsedMs = Date.now() - startedAt;

    expect(result.error).toBeUndefined();
    expect(completions).toHaveLength(1);
    expect(completions[0].body.exit_reason).toBe('timeout');
    // The bytes the CLI did flush survive the forced close.
    expect(completions[0].body.output).toContain('PARTIAL_OUTPUT');
    // Well under the 15s the grandchild holds the pipe: the deadline fired.
    expect(elapsedMs).toBeLessThan(12_000);
  }, 30_000);

  /**
   * The two pipes must race one clock. Awaiting stdout's deadline and *then*
   * stderr's gave each a full window, so a grandchild holding both cost twice
   * the deadline. Measured on the 60s clean-exit path that was 120s, not 60s.
   */
  test('a grandchild holding BOTH pipes costs one deadline, not two', async () => {
    completions = [];
    script = [{ status: 'completed' }];
    const both = cfg();
    both.timeoutMs = 500;
    both.binaryOverrides = { pi: bothPipesBinary };

    const startedAt = Date.now();
    await executeAutomationRun(client(), automationJob(), both);
    const elapsedMs = Date.now() - startedAt;

    expect(completions).toHaveLength(1);
    expect(completions[0].body.exit_reason).toBe('timeout');
    // ~3.5s to SIGTERM→SIGKILL→reap, then ONE 2s post-SIGKILL flush window.
    // Serialized deadlines spent two of them and landed past 7.5s.
    expect(elapsedMs).toBeLessThan(6_500);
  }, 30_000);
});

/**
 * A CLI that reports its fatal on stdout must still be diagnosable. `claude`
 * prints "Credit balance is too low" to stdout and leaves stderr empty, which
 * a stderr-only error message reduced to "exited with non-zero status 1".
 */
describe('automation arm failure diagnosis', () => {
  const stdoutFatalBinary = path.join(tmp, 'pi-stdout-fatal');

  beforeAll(() => {
    writeFileSync(
      stdoutFatalBinary,
      `#!/bin/sh\necho "Credit balance is too low"\nexit 1\n`
    );
    chmodSync(stdoutFatalBinary, 0o755);
  });

  test('falls back to stdout when the CLI leaves stderr empty', async () => {
    completions = [];
    script = [{ status: 'completed' }];
    const failing = cfg();
    failing.binaryOverrides = { pi: stdoutFatalBinary };

    await executeAutomationRun(client(), automationJob(), failing);

    expect(completions).toHaveLength(1);
    expect(completions[0].body.exit_reason).toBe('error_message');
    expect(completions[0].body.error).toContain('Credit balance is too low');
  });

  test('terminates an OpenCode account-limit retry instead of waiting for the outer timeout', async () => {
    completions = [];
    script = [{ status: 'completed' }];
    const quotaStall = cfg();
    quotaStall.timeoutMs = 8000;
    quotaStall.binaryOverrides = { opencode: openCodeQuotaBinary };

    const startedAt = Date.now();
    await executeAutomationRun(client(), openCodeAutomationJob(), quotaStall);
    const elapsedMs = Date.now() - startedAt;

    expect(completions).toHaveLength(1);
    expect(completions[0].body.exit_reason).toBe('error_message');
    expect(completions[0].body.error).toContain(
      'Monthly usage limit reached. Resets in 14 days.'
    );
    expect(completions[0].body.error).not.toContain('timeout');
    expect(readArgsLog()).toContain('--print-logs');
    expect(readArgsLog()).toContain('ERROR');
    expect(readFileSync(heartbeatConflictTerminated, 'utf8')).toBe('SIGTERM');
    const childPid = Number(readFileSync(heartbeatConflictPid, 'utf8'));
    expect(() => process.kill(childPid, 0)).toThrow();
    // The fixture's outer deadline plus tree cleanup is ~11s on current main.
    expect(elapsedMs).toBeLessThan(6000);
  }, 20_000);

  test('leaves generic OpenCode stream retries on the normal timeout path', async () => {
    completions = [];
    script = [{ status: 'completed' }];
    const genericStall = cfg();
    // Long enough that process spawn cannot beat the deadline: the fixture must
    // actually have written its stderr line for the assertion below to mean
    // anything. At 300ms this raced spawn latency and failed under suite load.
    genericStall.timeoutMs = 2000;
    genericStall.binaryOverrides = { opencode: openCodeGenericErrorBinary };

    await executeAutomationRun(client(), openCodeAutomationJob(), genericStall);

    expect(completions).toHaveLength(1);
    expect(completions[0].body.exit_reason).toBe('timeout');
    expect(completions[0].body.error).toContain('Provider service temporarily unavailable');
    // The generic class must never take the diagnostic stop: no early kill.
    expect(existsSync(heartbeatConflictTerminated)).toBe(false);
  }, 15_000);

  /**
   * OpenCode logs the account-limit line and then recovers on its own. The
   * diagnostic must not interrupt a CLI that is still making progress: killing
   * it discarded the output it went on to produce and reported the successful
   * run as `error_message` with an empty `output`.
   */
  test('keeps the real exit when the CLI logs an account limit and then succeeds', async () => {
    completions = [];
    script = [{ status: 'completed' }];
    const recovers = cfg();
    recovers.timeoutMs = 8000;
    recovers.binaryOverrides = { opencode: openCodeQuotaThenExitBinary };

    await executeAutomationRun(client(), openCodeAutomationJob(), recovers);

    expect(completions).toHaveLength(1);
    expect(completions[0].body.exit_reason).toBe('ok');
    expect(completions[0].body.error).toBeFalsy();
    expect(completions[0].body.output).toContain('RECOVERED_AND_SUCCEEDED');
  }, 20_000);

  test('a server cancellation wins when it races the OpenCode account-limit stop', async () => {
    completions = [];
    script = [{ status: 'completed' }];
    heartbeatStatus = 409;
    heartbeatReadyFiles = [heartbeatConflictPid];
    const conflict = cfg();
    conflict.heartbeatIntervalMs = 10;
    conflict.timeoutMs = 8000;
    conflict.terminalHeartbeatGraceMs = 100;
    conflict.binaryOverrides = { opencode: openCodeQuotaBinary };

    const result = await executeAutomationRun(client(), openCodeAutomationJob(), conflict);

    expect(result).toEqual({ itemsCollected: 0 });
    expect(heartbeatRequests).toBeGreaterThan(0);
    expect(completions).toHaveLength(1);
    expect(completions[0].body.exit_reason).toBe('ok');
    expect(completions[0].body.error).toBeFalsy();
    expect(readFileSync(heartbeatConflictTerminated, 'utf8')).toBe('SIGTERM');
  }, 15_000);
});

/**
 * A timed-out CLI is the one exit path with no diagnosis attached: the run row
 * gets `output_tail` from stdout only, and the timeout branch built its error
 * from a fixed string, so whatever the CLI wrote to stderr before it stalled
 * was dropped. That is how a device Automation can fail 39 times in a row and
 * leave nothing behind to explain why (prod #71, Aug 18-19).
 */
describe('automation arm timeout diagnosis', () => {
  const stderrStallBinary = path.join(tmp, 'pi-stderr-stall');
  const stderrSigtermProofBinary = path.join(tmp, 'pi-stderr-sigterm-proof');

  beforeAll(() => {
    // Writes its diagnosis to stderr, then stalls until the deadline kills it.
    writeFileSync(
      stderrStallBinary,
      `#!/bin/sh\necho "MCP server handshake failed: connection refused" >&2\nsleep 4\n`
    );
    chmodSync(stderrStallBinary, 0o755);

    // Same, but ignores SIGTERM so the tree kill escalates to SIGKILL — the
    // path where the supervisor dies before reporting the CLI outcome.
    writeFileSync(
      stderrSigtermProofBinary,
      `#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nconsole.error('MCP server handshake failed: connection refused');\nsetTimeout(() => {}, 15_000);\n`
    );
    chmodSync(stderrSigtermProofBinary, 0o755);
  });

  test('keeps the stderr the CLI wrote before it stalled', async () => {
    completions = [];
    script = [{ status: 'completed' }];
    const stalling = cfg();
    stalling.timeoutMs = 500;
    stalling.binaryOverrides = { pi: stderrStallBinary };

    await executeAutomationRun(client(), automationJob(), stalling);

    expect(completions).toHaveLength(1);
    expect(completions[0].body.exit_reason).toBe('timeout');
    // The deadline itself still has to be reported — it is the primary fact.
    expect(completions[0].body.error).toContain('timeout');
    // ...but so does the only evidence of WHY the CLI stalled.
    expect(completions[0].body.error).toContain('MCP server handshake failed');
  }, 30_000);

  test('SIGKILL escalation does not mask the stderr diagnosis with a supervisor error', async () => {
    completions = [];
    script = [{ status: 'completed' }];
    const stalling = cfg();
    stalling.timeoutMs = 500;
    stalling.binaryOverrides = { pi: stderrSigtermProofBinary };

    await executeAutomationRun(client(), automationJob(), stalling);

    expect(completions).toHaveLength(1);
    expect(completions[0].body.exit_reason).toBe('timeout');
    // SIGKILL takes the supervisor with the CLI before it can relay the exit;
    // its synthetic placeholder must lose to what the CLI actually wrote.
    expect(completions[0].body.error).toContain('SIGKILL');
    expect(completions[0].body.error).toContain('MCP server handshake failed');
    expect(completions[0].body.error).not.toContain('supervisor exited before reporting');
  }, 30_000);
});
