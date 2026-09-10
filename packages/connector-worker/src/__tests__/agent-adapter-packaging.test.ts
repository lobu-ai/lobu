import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import packageJson from '../../package.json';

test('published worker does not install agent engines through ACP adapters', () => {
  for (const name of ['@agentclientprotocol/claude-agent-acp', '@agentclientprotocol/codex-acp']) {
    expect(Object.keys(packageJson.dependencies)).not.toContain(name);
  }
});

// Copy only shipped bundles outside the workspace: package imports accidentally
// left by esbuild must not be rescued by monorepo node_modules.
test('standalone adapters use the exact external executable and environment', () => {
  const root = path.resolve(import.meta.dir, '../..');
  const directory = mkdtempSync(path.join(tmpdir(), 'lobu-external-acp-'));
  try {
    const output = path.join(directory, 'bundles');
    const build = spawnSync('node', ['scripts/build-acp-adapters.mjs', output], { cwd: root, encoding: 'utf8' });
    expect(build.status, build.stderr).toBe(0);
    const home = path.join(directory, 'home');
    mkdirSync(home);
    writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
    const executable = path.join(directory, 'external agent');
    writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$0" "$ACP_TEST_MARKER" "$@"\n', { mode: 0o755 });
    for (const [adapter, variable, args] of [
      ['claude', 'CLAUDE_CODE_EXECUTABLE', ['--cli', 'synthetic-argument']],
      ['codex', 'CODEX_PATH', ['cli', 'synthetic-argument']],
    ] as const) {
      const bundle = path.join(directory, `${adapter}.js`);
      cpSync(path.join(output, `${adapter}.js`), bundle);
      // PATH is pinned to system directories, so resolve node before narrowing it.
      const result = spawnSync(Bun.which('node')!, [bundle, ...args], {
        cwd: directory,
        env: { PATH: '/usr/bin:/bin', HOME: home, [variable]: executable, ACP_TEST_MARKER: 'synthetic-env' },
        encoding: 'utf8', timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split('\n')).toEqual([executable, 'synthetic-env', 'synthetic-argument']);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test('internal adapter entrypoint refuses a missing external agent', () => {
  for (const [kind, variable] of [
    ['codex', 'CODEX_PATH'],
    ['claude-code', 'CLAUDE_CODE_EXECUTABLE'],
  ] as const) {
    const result = spawnSync(process.execPath, [path.resolve(import.meta.dir, '../mac-device-daemon.ts'), '--internal-acp-adapter', kind], {
      cwd: tmpdir(), env: { PATH: '/usr/bin:/bin', HOME: tmpdir() }, encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(`${variable} must identify an installed`);
  }
});
