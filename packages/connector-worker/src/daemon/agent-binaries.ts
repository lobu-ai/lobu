/**
 * Local agent CLI discovery.
 *
 * Two consumers:
 *   - the automation arm, which resolves the binary it is about to spawn;
 *   - the poll loop, which advertises `agent_kinds` so the gateway can withhold
 *     an Automation run from a device that cannot execute it.
 *
 * Those have to agree. Advertising the static `AGENT_KINDS` list would say
 * "this build knows about five CLIs", not "this machine has them" — the run
 * would still be claimed and then fail locally with "binary not found on PATH",
 * which is exactly the outcome the gateway gate exists to prevent.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentKind } from '@lobu/core/contracts/worker/device-automation';
import {
  AGENT_KINDS,
  DEVICE_AGENT_SPECS_BY_KIND,
} from '@lobu/core/contracts/worker/device-automation';

/** Search prefixes for CLI discovery — mirrors the Mac app's detector list. */
export function searchDirs(): string[] {
  const home = homedir();
  return [
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

/**
 * `dirs` overrides the discovery path. Production never passes it — the default
 * respects `$PATH` first, with fixed prefixes as a fallback for GUI-launched
 * daemons whose minimal `$PATH` omits user-installed CLIs.
 */
export function locateBinary(name: string, dirs?: string[]): string | null {
  const search = dirs ?? [
    ...(process.env.PATH ?? '').split(':').filter(Boolean),
    ...searchDirs(),
  ];
  for (const dir of search) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * OpenCode must expose its ACP entrypoint before the device advertises it. An
 * older binary can exist and still lack `acp`; claiming its runs would then
 * fail only after the gateway assigned one.
 */
export function supportsOpenCodeAcp(binaryPath: string): boolean {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  };
  delete env.WORKER_API_TOKEN;
  delete env.LOBU_API_TOKEN;
  delete env.LOBU_MEMORY_URL;
  const result = spawnSync(binaryPath, ['acp', '--pure', '--help'], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
  });
  return result.status === 0;
}

/**
 * The agent kinds this machine can actually spawn right now, in
 * `DEVICE_AGENT_SPECS` order.
 *
 * `overrides` is the executor's `binaryOverrides` map: an explicit path wins
 * over PATH discovery, matching how the arm resolves the binary at spawn time,
 * but it still has to exist — an override pointing at a deleted file must not
 * make the device claim runs it will fail.
 */
export function resolveRunnableAgentKinds(
  overrides?: Partial<Record<AgentKind, string>>,
  dirs?: string[]
): AgentKind[] {
  return AGENT_KINDS.filter((kind) => {
    const spec = DEVICE_AGENT_SPECS_BY_KIND.get(kind);
    if (!spec) return false;
    const override = overrides?.[kind];
    if (override) return existsSync(override);
    return locateBinary(spec.binaryName, dirs) !== null;
  });
}
