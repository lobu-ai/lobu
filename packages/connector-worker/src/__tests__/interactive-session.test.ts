import { afterEach, describe, expect, test } from 'bun:test';
import { execFile, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildDeviceAutomationPrompt } from '@lobu/core/contracts/worker/device-automation';
import {
  deriveInteractiveWorkerId,
  detectCodexInteractiveSession,
  detectInteractiveSession,
  detectOpenCodeInteractiveSession,
  detectParentClaudeSession,
  handoffToInteractiveSession,
  type ParentClaudeSession,
} from '../daemon/interactive-session.js';
import { resolveDaemonLaunchContext } from '../daemon/start.js';

const execFileAsync = promisify(execFile);
const cleanupDirs: string[] = [];
const cleanupServers: net.Server[] = [];
const RESULT_CAP_BYTES = 4 * 1024 * 1024;

function runHelper(
  helperPath: string,
  args: string[],
  input: string | Buffer,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 && signal == null) resolve();
      else reject(new Error(stderr.trim() || `helper exited with ${signal ?? code}`));
    });
    child.stdin.end(input);
  });
}

function readHelperConfig(helperPath: string): {
  socketPath: string;
  runId: number;
  nonce: string;
} {
  const source = readFileSync(helperPath, 'utf8');
  const configJson = source.match(/^const config = (.+);$/m)?.[1];
  if (!configJson) throw new Error('helper config not found');
  return JSON.parse(configJson);
}

function rawHelperRequest(socketPath: string, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(request));
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.once('error', reject);
    socket.once('end', () => resolve(response));
  });
}

async function listen(server: net.Server, socketPath: string): Promise<void> {
  cleanupServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
}

async function close(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  await Promise.all(cleanupServers.splice(0).map(close));
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function parentFixture(): Promise<{
  dir: string;
  session: ParentClaudeSession;
  frames: Promise<string>;
}> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lobu-parent-test-'));
  cleanupDirs.push(dir);
  const socketPath = path.join(dir, 'parent.sock');
  let receiveFrames!: (frames: string) => void;
  const frames = new Promise<string>((resolve) => {
    receiveFrames = resolve;
  });
  await listen(
    net.createServer((socket) => {
      socket.setEncoding('utf8');
      let body = '';
      socket.on('data', (chunk) => {
        body += chunk;
      });
      socket.on('end', () => receiveFrames(body));
      // Deliberately send no acknowledgement. Delivery is write-based.
    }),
    socketPath
  );
  chmodSync(socketPath, 0o600);

  const registryPath = path.join(dir, `${process.pid}.json`);
  writeFileSync(
    registryPath,
    JSON.stringify({
      pid: process.pid,
      sessionId: 'claude-session-test',
      kind: 'interactive',
      messagingSocketPath: socketPath,
    }),
    { mode: 0o600 }
  );
  return {
    dir,
    frames,
    session: {
      kind: 'claude-code',
      pid: process.pid,
      sessionId: 'claude-session-test',
      socketPath,
      messagingToken: 'parent-messaging-token',
      registryPath,
    },
  };
}

describe('detectParentClaudeSession', () => {
  test('accepts the real 0644 registry mode but rejects group-writable metadata', async () => {
    const fixture = await parentFixture();
    const env = {
      CLAUDE_PID: String(process.pid),
      CLAUDE_CODE_SESSION_ID: fixture.session.sessionId,
      CLAUDE_CODE_MESSAGING_SOCKET: fixture.session.socketPath,
      CLAUDE_CODE_MESSAGING_TOKEN: fixture.session.messagingToken,
    };
    // Claude currently publishes this registry as 0644; ownership and exact
    // record matching carry the trust check while the socket itself is 0600.
    chmodSync(fixture.session.registryPath, 0o644);

    expect(detectParentClaudeSession({ env, sessionsDir: fixture.dir })).toEqual({
      ok: true,
      session: fixture.session,
    });

    chmodSync(fixture.session.registryPath, 0o664);
    expect(detectParentClaudeSession({ env, sessionsDir: fixture.dir })).toEqual({
      ok: false,
      reason: 'Claude session registry did not match an interactive parent',
    });

    chmodSync(fixture.session.registryPath, 0o644);
    writeFileSync(
      fixture.session.registryPath,
      JSON.stringify({
        pid: process.pid,
        sessionId: fixture.session.sessionId,
        kind: 'background',
        messagingSocketPath: fixture.session.socketPath,
      }),
      { mode: 0o600 }
    );
    expect(detectParentClaudeSession({ env, sessionsDir: fixture.dir })).toEqual({
      ok: false,
      reason: 'Claude session registry did not match an interactive parent',
    });
  });

  test('rejects missing inherited metadata instead of discovering another session', () => {
    expect(detectParentClaudeSession({ env: {} })).toEqual({
      ok: false,
      reason: 'missing inherited Claude session metadata',
    });
  });
});

describe('detectInteractiveSession', () => {
  test('detects an exact Codex thread only when both inherited ids agree', () => {
    expect(
      detectCodexInteractiveSession({
        CODEX_THREAD_ID: 'thread-exact',
        CODEX_SESSION_ID: 'thread-exact',
      })
    ).toEqual({
      ok: true,
      session: { kind: 'codex', sessionId: 'thread-exact', threadId: 'thread-exact' },
    });
    expect(
      detectCodexInteractiveSession({
        CODEX_THREAD_ID: 'thread-a',
        CODEX_SESSION_ID: 'thread-b',
      })
    ).toEqual({
      ok: false,
      reason: 'inherited Codex thread and session ids did not match',
    });
  });

  test('accepts only owner-safe authenticated OpenCode bridge metadata', async () => {
    const fixture = await parentFixture();
    const env = {
      OPENCODE_PID: String(process.pid),
      OPENCODE_SESSION_ID: 'ses_exact',
      LOBU_OPENCODE_BRIDGE_SOCKET: fixture.session.socketPath,
      LOBU_OPENCODE_BRIDGE_TOKEN: 'b'.repeat(64),
    };
    expect(detectOpenCodeInteractiveSession(env)).toEqual({
      ok: true,
      session: {
        kind: 'opencode',
        pid: process.pid,
        sessionId: 'ses_exact',
        socketPath: fixture.session.socketPath,
        bridgeToken: 'b'.repeat(64),
      },
    });
    for (const token of ['b'.repeat(63), 'b'.repeat(65), 'g'.repeat(64), ` ${'b'.repeat(64)}`]) {
      expect(
        detectOpenCodeInteractiveSession({
          ...env,
          LOBU_OPENCODE_BRIDGE_TOKEN: token,
        })
      ).toEqual({ ok: false, reason: 'invalid inherited OpenCode bridge token' });
    }
    expect(
      detectOpenCodeInteractiveSession({
        ...env,
        LOBU_OPENCODE_BRIDGE_TOKEN: 'ABCDEF'.repeat(10) + 'ABCD',
      })
    ).toMatchObject({ ok: true });
    chmodSync(fixture.session.socketPath, 0o666);
    expect(detectOpenCodeInteractiveSession(env)).toEqual({
      ok: false,
      reason: 'OpenCode bridge socket failed local ownership checks',
    });
  });

  test('auto detection ignores a partial invalid marker and accepts one valid provider', () => {
    const codexEnv = {
      CODEX_THREAD_ID: 'thread-exact',
      CODEX_SESSION_ID: 'thread-exact',
    };
    expect(detectInteractiveSession({ env: codexEnv })).toEqual({
      ok: true,
      session: { kind: 'codex', sessionId: 'thread-exact', threadId: 'thread-exact' },
    });
    expect(
      detectInteractiveSession({
        env: {
          ...codexEnv,
          CLAUDE_PID: String(process.pid),
          CLAUDE_CODE_SESSION_ID: 'partial-claude',
        },
      })
    ).toEqual({
      ok: true,
      session: { kind: 'codex', sessionId: 'thread-exact', threadId: 'thread-exact' },
    });
  });

  test('auto detection rejects genuinely valid Claude and Codex parents as ambiguous', async () => {
    const fixture = await parentFixture();
    expect(
      detectInteractiveSession({
        sessionsDir: fixture.dir,
        env: {
          CODEX_THREAD_ID: 'thread-exact',
          CODEX_SESSION_ID: 'thread-exact',
          CLAUDE_PID: String(process.pid),
          CLAUDE_CODE_SESSION_ID: fixture.session.sessionId,
          CLAUDE_CODE_MESSAGING_SOCKET: fixture.session.socketPath,
          CLAUDE_CODE_MESSAGING_TOKEN: fixture.session.messagingToken,
        },
      })
    ).toEqual({ ok: false, reason: 'multiple supported interactive sessions were inherited' });
  });
});

describe('deriveInteractiveWorkerId', () => {
  test('is stable within one parent session and distinct across sessions', () => {
    const first = deriveInteractiveWorkerId({
      kind: 'codex',
      sessionId: 'session-a',
      threadId: 'session-a',
    });
    expect(first).toBe(
      deriveInteractiveWorkerId({
        kind: 'codex',
        sessionId: 'session-a',
        threadId: 'session-a',
      })
    );
    expect(first).not.toBe(
      deriveInteractiveWorkerId({
        kind: 'codex',
        sessionId: 'session-b',
        threadId: 'session-b',
      })
    );
    expect(first).toMatch(/^headless:codex:[a-f0-9]{24}$/);
  });
});

describe('interactive daemon launch context', () => {
  test('auto-detected Codex is headless and explicit opt-out leaves the ordinary default unchanged', () => {
    const env = { CODEX_THREAD_ID: 'thread-exact', CODEX_SESSION_ID: 'thread-exact' };
    expect(resolveDaemonLaunchContext({ defaultPlatform: 'macos' }, env)).toMatchObject({
      platform: 'headless',
      interactiveSession: { kind: 'codex', sessionId: 'thread-exact' },
    });
    expect(
      resolveDaemonLaunchContext(
        { defaultPlatform: 'macos', interactiveSession: false },
        env
      )
    ).toEqual({ platform: 'macos', interactiveSession: undefined });
  });

  test('rejects an explicit non-headless platform for an interactive session', () => {
    const env = { CODEX_THREAD_ID: 'thread-exact', CODEX_SESSION_ID: 'thread-exact' };
    expect(() => resolveDaemonLaunchContext({ platform: 'macos' }, env)).toThrow(
      /registers as --platform headless.*Pass --no-interactive-session/s
    );
  });
});

describe('handoffToInteractiveSession', () => {
  test('OpenCode bridge routes the exact session without a TCP listener or run credential', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lobu-opencode-transport-test-'));
    cleanupDirs.push(dir);
    const socketPath = path.join(dir, 'bridge.sock');
    let receiveRequest!: (value: Record<string, unknown>) => void;
    const request = new Promise<Record<string, unknown>>((resolve) => {
      receiveRequest = resolve;
    });
    await listen(
      net.createServer({ allowHalfOpen: true }, (socket) => {
        let body = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
          body += chunk;
          if (!body.endsWith('\n')) return;
          const parsed = JSON.parse(body) as Record<string, unknown>;
          receiveRequest(parsed);
          socket.end(`${JSON.stringify({ ok: true, session_id: parsed.session_id })}\n`);
        });
      }),
      socketPath
    );
    chmodSync(socketPath, 0o600);
    const delivery = await handoffToInteractiveSession({
      session: {
        kind: 'opencode',
        pid: process.pid,
        sessionId: 'ses_exact',
        socketPath,
        bridgeToken: 'bridge-secret',
      },
      runId: 69,
      prompt: 'Do bounded OpenCode work',
      token: 'run-scoped-secret',
      memoryUrl: 'https://gateway.test/mcp/test',
      timeoutMs: 10_000,
    });
    expect(delivery.kind).toBe('handed-off');
    if (delivery.kind !== 'handed-off') throw new Error(delivery.reason);
    expect(delivery.certainty).toBe('acknowledged');
    const bridged = await request;
    expect(bridged.session_id).toBe('ses_exact');
    expect(bridged.token).toBe('bridge-secret');
    expect(String(bridged.prompt)).toContain('Do bounded OpenCode work');
    expect(String(bridged.prompt)).not.toContain('run-scoped-secret');
    await runHelper(delivery.helperPath, ['complete'], 'OpenCode completed');
    expect(await delivery.completion).toMatchObject({
      kind: 'completed',
      output: 'OpenCode completed',
    });
  });

  test('queues into the exact Codex thread and requires the positive acknowledgement', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lobu-codex-queue-test-'));
    cleanupDirs.push(dir);
    const logPath = path.join(dir, 'args.json');
    const command = path.join(dir, 'codex');
    writeFileSync(
      command,
      `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(logPath)},JSON.stringify(args));console.log('Queued message test-message for thread '+args[2]+'.');\n`,
      { mode: 0o700 }
    );
    const delivery = await handoffToInteractiveSession({
      session: { kind: 'codex', sessionId: 'thread-exact', threadId: 'thread-exact' },
      runId: 70,
      prompt: 'Do bounded work',
      token: 'run-scoped-secret',
      memoryUrl: 'https://gateway.test/mcp/test',
      timeoutMs: 10_000,
      codexCommand: command,
    });
    expect(delivery.kind).toBe('handed-off');
    if (delivery.kind !== 'handed-off') throw new Error(delivery.reason);
    expect(delivery.certainty).toBe('acknowledged');
    const args = JSON.parse(readFileSync(logPath, 'utf8')) as string[];
    expect(args.slice(0, 3)).toEqual(['queue', '--thread', 'thread-exact']);
    expect(args[3]).toBe('--message');
    expect(args[4]).toContain('Do bounded work');
    expect(args[4]).not.toContain('run-scoped-secret');
    await runHelper(delivery.helperPath, ['complete'], 'Codex completed');
    expect(await delivery.completion).toMatchObject({
      kind: 'completed',
      output: 'Codex completed',
    });
  });

  test('missing Codex binary is unambiguously not delivered', async () => {
    const delivery = await handoffToInteractiveSession({
      session: { kind: 'codex', sessionId: 'thread-exact', threadId: 'thread-exact' },
      runId: 71,
      prompt: 'Do bounded work',
      token: 'run-scoped-secret',
      memoryUrl: 'https://gateway.test/mcp/test',
      timeoutMs: 10_000,
      codexCommand: path.join(os.tmpdir(), 'lobu-definitely-missing-codex'),
    });
    expect(delivery).toEqual({
      kind: 'not-delivered',
      reason: 'Codex queue command was unavailable',
    });
  });

  test('negative or ambiguous Codex output is possible delivery, never safe fallback', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lobu-codex-ambiguous-test-'));
    cleanupDirs.push(dir);
    const command = path.join(dir, 'codex');
    writeFileSync(command, `#!${process.execPath}\nprocess.stderr.write('queue failed after send\\n');process.exit(2);\n`, {
      mode: 0o700,
    });
    const delivery = await handoffToInteractiveSession({
      session: { kind: 'codex', sessionId: 'thread-exact', threadId: 'thread-exact' },
      runId: 72,
      prompt: 'Do bounded work',
      token: 'run-scoped-secret',
      memoryUrl: 'https://gateway.test/mcp/test',
      timeoutMs: 10_000,
      codexCommand: command,
    });
    expect(delivery.kind).toBe('handed-off');
    if (delivery.kind !== 'handed-off') throw new Error(delivery.reason);
    expect(delivery.certainty).toBe('possible');
    await runHelper(delivery.helperPath, ['complete'], 'possibly delivered result');
    expect(await delivery.completion).toMatchObject({ kind: 'completed' });
  });
  test('needs no parent ack and keeps the run bearer in an owner-only helper channel', async () => {
    const fixture = await parentFixture();
    const verifierPath = path.join(fixture.dir, 'verifier.sock');
    let receiveAccess!: (value: Record<string, unknown>) => void;
    const access = new Promise<Record<string, unknown>>((resolve) => {
      receiveAccess = resolve;
    });
    await listen(
      net.createServer((socket) => {
        socket.setEncoding('utf8');
        let body = '';
        socket.on('data', (chunk) => {
          body += chunk;
        });
        socket.on('end', () => receiveAccess(JSON.parse(body)));
      }),
      verifierPath
    );
    const verifierSource = `
      const net = require('node:net');
      const socket = net.createConnection(${JSON.stringify(verifierPath)}, () => {
        socket.end(JSON.stringify({
          token: process.env.LOBU_API_TOKEN,
          memoryUrl: process.env.LOBU_MEMORY_URL,
          workerToken: process.env.WORKER_API_TOKEN ?? null,
          claudePid: process.env.CLAUDE_PID ?? null,
          claudeSession: process.env.CLAUDE_CODE_SESSION_ID ?? null,
          claudeSocket: process.env.CLAUDE_CODE_MESSAGING_SOCKET ?? null,
          claudeToken: process.env.CLAUDE_CODE_MESSAGING_TOKEN ?? null,
          openCodePid: process.env.OPENCODE_PID ?? null,
          openCodeSession: process.env.OPENCODE_SESSION_ID ?? null,
          openCodeDirectory: process.env.OPENCODE_SESSION_DIRECTORY ?? null,
          openCodeSocket: process.env.LOBU_OPENCODE_BRIDGE_SOCKET ?? null,
          openCodeToken: process.env.LOBU_OPENCODE_BRIDGE_TOKEN ?? null,
          codexThread: process.env.CODEX_THREAD_ID ?? null,
          codexSession: process.env.CODEX_SESSION_ID ?? null,
          args: process.argv.slice(1),
        }));
      });
    `;
    const bearer = 'run-scoped-secret-bearer';
    const memoryUrl = 'https://gateway.test/mcp/test';
    const standardPrompt = buildDeviceAutomationPrompt(
      {
        automation: { id: '77', prompt: 'Read the window and finish it' },
        event: { fired_at: '2026-08-21T00:00:00.000Z', payload: {} },
        context: { device: {}, user: {} },
      },
      77
    );
    const started = Date.now();
    const delivery = await handoffToInteractiveSession({
      session: fixture.session,
      runId: 77,
      prompt: `${standardPrompt}\nFinalize via lobu CLI or MCP.`,
      token: bearer,
      memoryUrl,
      timeoutMs: 10_000,
      disconnectCheckIntervalMs: 10_000,
      cliLaunch: { command: process.execPath, args: ['-e', verifierSource] },
    });

    expect(delivery.kind).toBe('handed-off');
    if (delivery.kind !== 'handed-off') throw new Error(delivery.reason);
    expect(Date.now() - started).toBeLessThan(1_000);

    const parentFrames = await fixture.frames;
    const messageFrame = parentFrames
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((frame) => frame.type === 'user');
    const deliveredPrompt = messageFrame.message.content as string;
    const helperDir = path.dirname(delivery.helperPath);
    const helperSocket = path.join(helperDir, 'helper.sock');
    expect(deliveredPrompt).toContain(`'${delivery.helperPath}' call run_sdk --arg title=`);
    expect(deliveredPrompt).toContain(`'${delivery.helperPath}' complete`);
    expect(deliveredPrompt).toContain('final user-visible result on stdin');
    expect(deliveredPrompt).toContain('Do not reuse a helper from an earlier Automation message.');
    expect(deliveredPrompt).toContain('For a window Automation');
    expect(deliveredPrompt).toContain('For an event turn');
    expect(deliveredPrompt).toContain('do not use bare `lobu call` or ambient Lobu MCP');
    expect(deliveredPrompt).not.toContain('  lobu call ');
    expect(deliveredPrompt).toContain('Use the run-specific helper above for all Lobu access.');
    expect(deliveredPrompt).not.toContain('MCP is also fine if already wired');
    expect(deliveredPrompt).not.toContain('Finalize via lobu CLI or MCP');
    expect(deliveredPrompt).not.toContain('same login as the Owletto menubar');
    expect(deliveredPrompt).not.toContain('~/.config/lobu');
    expect(deliveredPrompt).not.toContain(bearer);
    expect(await Bun.file(delivery.helperPath).text()).not.toContain(bearer);
    expect(lstatSync(helperDir).mode & 0o077).toBe(0);
    expect(lstatSync(delivery.helperPath).mode & 0o077).toBe(0);
    expect(lstatSync(helperSocket).mode & 0o077).toBe(0);

    const moduleSource = 'export default async () => ({ ok: true })';
    const callArgs = [
      'call',
      'run_sdk',
      '--arg',
      'title=Read Automation window input',
      '--arg',
      `script=${moduleSource}`,
    ];
    await execFileAsync(delivery.helperPath, callArgs, {
      env: {
        ...process.env,
        PATH: '',
        WORKER_API_TOKEN: 'daemon-worker-secret',
        CLAUDE_PID: '123',
        CLAUDE_CODE_SESSION_ID: 'claude-session',
        CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/claude.sock',
        CLAUDE_CODE_MESSAGING_TOKEN: 'claude-secret',
        OPENCODE_PID: '456',
        OPENCODE_SESSION_ID: 'opencode-session',
        OPENCODE_SESSION_DIRECTORY: '/tmp/opencode',
        LOBU_OPENCODE_BRIDGE_SOCKET: '/tmp/opencode.sock',
        LOBU_OPENCODE_BRIDGE_TOKEN: 'opencode-secret',
        CODEX_THREAD_ID: 'codex-thread',
        CODEX_SESSION_ID: 'codex-session',
      },
    });
    expect(await access).toEqual({
      token: bearer,
      memoryUrl,
      workerToken: null,
      claudePid: null,
      claudeSession: null,
      claudeSocket: null,
      claudeToken: null,
      openCodePid: null,
      openCodeSession: null,
      openCodeDirectory: null,
      openCodeSocket: null,
      openCodeToken: null,
      codexThread: null,
      codexSession: null,
      args: callArgs,
    });

    await runHelper(
      delivery.helperPath,
      ['complete'],
      `final result for ChatGPT; bearer=${bearer}`,
      { ...process.env, PATH: '' }
    );
    expect(await delivery.completion).toMatchObject({
      kind: 'completed',
      output: 'final result for ChatGPT; bearer=[REDACTED]',
    });
    expect(existsSync(helperDir)).toBe(false);
  });

  test('refuses every helper call shape except `call <sdk tool> --arg <entry>...`', async () => {
    const fixture = await parentFixture();
    const marker = path.join(fixture.dir, 'cli-launched');
    const delivery = await handoffToInteractiveSession({
      session: fixture.session,
      runId: 81,
      prompt: 'Do work',
      token: 'run-secret',
      memoryUrl: 'https://gateway.test/mcp/test',
      timeoutMs: 10_000,
      disconnectCheckIntervalMs: 10_000,
      cliLaunch: {
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.argv.slice(1).join(' '))`],
      },
    });
    expect(delivery.kind).toBe('handed-off');
    if (delivery.kind !== 'handed-off') throw new Error(delivery.reason);

    const title = ['--arg', 'title=Probe'];
    const rejected: Array<[string, string[]]> = [
      ['--url', ['call', 'run_sdk', ...title, '--url', 'https://attacker.test/mcp']],
      ['--org', ['call', 'run_sdk', ...title, '--org', 'other-org']],
      ['--input-file', ['call', 'run_sdk', '--input-file', '/tmp/args.json']],
      ['--context', ['call', 'run_sdk', ...title, '--context', 'cloud']],
      ['--arg=<entry>', ['call', 'run_sdk', '--arg=title=Probe']],
      ['a flag smuggled as an --arg entry', ['call', 'run_sdk', '--arg', '--url=https://attacker.test']],
      ['an --arg entry without a key', ['call', 'run_sdk', '--arg', '=x']],
      ['a stray positional', ['call', 'run_sdk', ...title, 'extra']],
      ['a non-SDK tool', ['call', 'manage_feeds', '--arg', 'action=list']],
      ['no --arg entries', ['call', 'run_sdk']],
      ['the retired exec form', ['exec', 'export default async () => 1']],
    ];
    for (const [label, args] of rejected) {
      await expect(runHelper(delivery.helperPath, args, ''), label).rejects.toThrow(
        /usage: <helper> call run_sdk\|query_sdk\|query_sql/
      );
    }
    expect(existsSync(marker)).toBe(false);

    await runHelper(delivery.helperPath, ['call', 'query_sql', ...title, '--arg', 'sql=SELECT 1'], '');
    expect(readFileSync(marker, 'utf8')).toBe('call query_sql --arg title=Probe --arg sql=SELECT 1');
    await runHelper(delivery.helperPath, ['complete'], 'done');
    expect(await delivery.completion).toMatchObject({ kind: 'completed' });
  });

  test('caps completion stdin, preserves truncation evidence, and works without PATH', async () => {
    const fixture = await parentFixture();
    const delivery = await handoffToInteractiveSession({
      session: fixture.session,
      runId: 78,
      prompt: 'Do work',
      token: 'run-secret',
      memoryUrl: 'https://gateway.test/mcp/test',
      timeoutMs: 10_000,
      disconnectCheckIntervalMs: 10_000,
    });

    expect(delivery.kind).toBe('handed-off');
    if (delivery.kind !== 'handed-off') throw new Error(delivery.reason);
    const helper = await Bun.file(delivery.helperPath).text();
    expect(helper.startsWith(`#!${process.execPath}\n`)).toBe(true);

    await runHelper(delivery.helperPath, ['complete'], Buffer.alloc(RESULT_CAP_BYTES + 1, 97), {
      ...process.env,
      PATH: '',
    });
    const completion = await delivery.completion;
    expect(completion.kind).toBe('completed');
    if (completion.kind !== 'completed') throw new Error(completion.error);
    expect(Buffer.byteLength(completion.output)).toBeLessThanOrEqual(RESULT_CAP_BYTES);
    expect(completion.output.endsWith('\n[result truncated]')).toBe(true);
  });

  test('rejects unsafe or unavailable Node executables before parent delivery', async () => {
    const fixture = await parentFixture();
    const unavailable = path.join(fixture.dir, 'missing-node');
    const notExecutable = path.join(fixture.dir, 'not-executable-node');
    writeFileSync(notExecutable, '#!/bin/sh\n', { mode: 0o600 });

    for (const command of ['node', unavailable, notExecutable, '/bin/node\ninjected']) {
      const delivery = await handoffToInteractiveSession({
        session: fixture.session,
        runId: 79,
        prompt: 'Do work',
        token: 'run-secret',
        memoryUrl: 'https://gateway.test/mcp/test',
        timeoutMs: 10_000,
        cliLaunch: { command, args: [] },
      });
      expect(delivery.kind).toBe('not-delivered');
      if (delivery.kind === 'not-delivered') {
        expect(delivery.reason).toContain('Node executable');
      }
    }
  });

  test('rejects malformed and oversized completion frames without settling the attempt', async () => {
    const fixture = await parentFixture();
    const delivery = await handoffToInteractiveSession({
      session: fixture.session,
      runId: 80,
      prompt: 'Do work',
      token: 'run-secret',
      memoryUrl: 'https://gateway.test/mcp/test',
      timeoutMs: 10_000,
      disconnectCheckIntervalMs: 10_000,
    });
    expect(delivery.kind).toBe('handed-off');
    if (delivery.kind !== 'handed-off') throw new Error(delivery.reason);
    const config = readHelperConfig(delivery.helperPath);

    expect(await rawHelperRequest(config.socketPath, 'not-json\n')).toBe('{"ok":false}\n');
    expect(
      await rawHelperRequest(
        config.socketPath,
        `${JSON.stringify({
          version: 1,
          run_id: config.runId,
          nonce: config.nonce,
          op: 'complete',
          output_base64: Buffer.alloc(RESULT_CAP_BYTES + 1).toString('base64'),
          truncated: false,
        })}\n`
      )
    ).toBe('{"ok":false}\n');

    await runHelper(delivery.helperPath, ['complete'], 'valid answer');
    expect(await delivery.completion).toMatchObject({
      kind: 'completed',
      output: 'valid answer',
    });
  });

  test("a prior attempt's credentials cannot complete a later attempt", async () => {
    const fixture = await parentFixture();
    const first = await handoffToInteractiveSession({
      session: fixture.session,
      runId: 81,
      prompt: 'First attempt',
      token: 'run-secret',
      memoryUrl: 'https://gateway.test/mcp/test',
      timeoutMs: 10_000,
      disconnectCheckIntervalMs: 10_000,
    });
    expect(first.kind).toBe('handed-off');
    if (first.kind !== 'handed-off') throw new Error(first.reason);

    // Capture the first attempt's nonce before its helper directory is removed.
    const staleNonce = readHelperConfig(first.helperPath).nonce;
    await runHelper(first.helperPath, ['complete'], 'first answer');
    expect(await first.completion).toMatchObject({ kind: 'completed', output: 'first answer' });

    const second = await handoffToInteractiveSession({
      session: fixture.session,
      runId: 81,
      prompt: 'Second attempt',
      token: 'run-secret',
      memoryUrl: 'https://gateway.test/mcp/test',
      timeoutMs: 10_000,
      disconnectCheckIntervalMs: 10_000,
    });
    expect(second.kind).toBe('handed-off');
    if (second.kind !== 'handed-off') throw new Error(second.reason);
    const current = readHelperConfig(second.helperPath);
    expect(staleNonce).not.toBe(current.nonce);

    // The same run id on the live socket, replaying the retired attempt's nonce.
    const replay = (op: Record<string, unknown>) =>
      rawHelperRequest(
        current.socketPath,
        `${JSON.stringify({ version: 1, run_id: current.runId, nonce: staleNonce, ...op })}\n`
      );
    expect(await replay({ op: 'credentials' })).toBe('{"ok":false}\n');
    expect(
      await replay({
        op: 'complete',
        output_base64: Buffer.from('stale answer').toString('base64'),
        truncated: false,
      })
    ).toBe('{"ok":false}\n');

    await runHelper(second.helperPath, ['complete'], 'current answer');
    expect(await second.completion).toMatchObject({
      kind: 'completed',
      output: 'current answer',
    });
  });

  test('daemon shutdown completes a delivered handoff and removes its helper', async () => {
    const fixture = await parentFixture();
    const shutdown = new AbortController();
    const delivery = await handoffToInteractiveSession({
      session: fixture.session,
      runId: 82,
      prompt: 'Do work',
      token: 'secret',
      memoryUrl: 'https://gateway.test/mcp/test',
      timeoutMs: 10_000,
      disconnectCheckIntervalMs: 10_000,
      shutdownSignal: shutdown.signal,
    });

    expect(delivery.kind).toBe('handed-off');
    if (delivery.kind !== 'handed-off') throw new Error(delivery.reason);
    const helperDir = path.dirname(delivery.helperPath);
    shutdown.abort();
    expect(await delivery.completion).toMatchObject({ kind: 'shutdown' });
    expect(existsSync(helperDir)).toBe(false);
  });

  test('a terminal heartbeat completes only its active handoff and removes the helper', async () => {
    const fixture = await parentFixture();
    const terminal = new AbortController();
    const delivery = await handoffToInteractiveSession({
      session: fixture.session,
      runId: 85,
      prompt: 'Do work',
      token: 'secret',
      memoryUrl: 'https://gateway.test/mcp/test',
      // Long enough that only the terminal latch can settle this handoff — a
      // short timeout would let the deadline win the race and pass for the
      // wrong reason.
      timeoutMs: 10_000,
      disconnectCheckIntervalMs: 10_000,
      terminalSignal: terminal.signal,
    });

    expect(delivery.kind).toBe('handed-off');
    if (delivery.kind !== 'handed-off') throw new Error(delivery.reason);
    const helperDir = path.dirname(delivery.helperPath);
    terminal.abort();
    expect(await delivery.completion).toMatchObject({
      kind: 'terminal',
      error: 'automation run became terminal before the interactive session completed it',
    });
    expect(existsSync(helperDir)).toBe(false);
  });

  test('daemon shutdown destroys a half-open helper connection before cleanup', async () => {
    const fixture = await parentFixture();
    const shutdown = new AbortController();
    const delivery = await handoffToInteractiveSession({
      session: fixture.session,
      runId: 821,
      prompt: 'Do work',
      token: 'secret',
      memoryUrl: 'https://gateway.test/mcp/test',
      timeoutMs: 10_000,
      disconnectCheckIntervalMs: 10_000,
      shutdownSignal: shutdown.signal,
    });
    expect(delivery.kind).toBe('handed-off');
    if (delivery.kind !== 'handed-off') throw new Error(delivery.reason);

    const helperDir = path.dirname(delivery.helperPath);
    const config = readHelperConfig(delivery.helperPath);
    const held = net.createConnection(config.socketPath);
    await new Promise<void>((resolve, reject) => {
      held.once('connect', resolve);
      held.once('error', reject);
    });
    const closed = new Promise<void>((resolve) => held.once('close', () => resolve()));

    shutdown.abort();
    expect(await delivery.completion).toMatchObject({ kind: 'shutdown' });
    await closed;
    expect(held.destroyed).toBe(true);
    expect(existsSync(helperDir)).toBe(false);
  });

  test('the existing run timeout bounds a parent handoff', async () => {
    const fixture = await parentFixture();
    const delivery = await handoffToInteractiveSession({
      session: fixture.session,
      runId: 83,
      prompt: 'Do work',
      token: 'secret',
      memoryUrl: 'https://gateway.test/mcp/test',
      timeoutMs: 20,
      disconnectCheckIntervalMs: 10_000,
    });

    expect(delivery.kind).toBe('handed-off');
    if (delivery.kind !== 'handed-off') throw new Error(delivery.reason);
    const helperDir = path.dirname(delivery.helperPath);
    expect(await delivery.completion).toMatchObject({ kind: 'timeout' });
    expect(existsSync(helperDir)).toBe(false);
  });

  test('an unavailable inbox is unambiguously not delivered', async () => {
    const fixture = await parentFixture();
    await close(cleanupServers.pop()!);
    rmSync(fixture.session.socketPath, { force: true });

    const delivery = await handoffToInteractiveSession({
      session: fixture.session,
      runId: 84,
      prompt: 'Do work',
      token: 'secret',
      memoryUrl: 'https://gateway.test/mcp/test',
      timeoutMs: 10_000,
    });

    expect(delivery).toEqual({
      kind: 'not-delivered',
      reason: 'parent inbox was unavailable before delivery',
    });
  });
});
