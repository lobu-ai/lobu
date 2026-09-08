/**
 * The turn's workspace tools over a filesystem that exists for this turn only.
 *
 * GUEST code, bundled with the agent entry, so it must stay portable: no
 * `node:` import, no host module, no root `@lobu/core` import (that root drags
 * the Node logger and tracing SDKs). The local shell is just-bash's browser
 * build, without real binaries or network access. Write and edit use Pi's own
 * factories with filesystem operations, as do read, ls and find. Pi also owns
 * output truncation; the bundler excludes unused Node I/O and renderers. Grep
 * stays local because Pi's grep always starts an rg process.
 *
 * The filesystem is in-memory and lives for one turn only. It starts empty
 * except for what the HOST seeds into it before the model runs — this turn's
 * non-image attachments under `input/` and the agent's enabled skills under
 * `.skills/`, the two established agent-visible locations. Nothing
 * written here outlives the turn, and nothing here can reach the network: the
 * shell is built without `fetch`, so `curl` and `wget` do not exist in it.
 */

import { withLobuFileParameters } from '@lobu/core/agent-tooling';
import {
  createEditTool, createFindTool, createLsTool, createReadTool, createWriteTool,
  DEFAULT_MAX_BYTES as MAX_BYTES, DEFAULT_MAX_LINES as MAX_LINES,
  formatSize, truncateHead, truncateLine, truncateTail,
} from '@mariozechner/pi-coding-agent';
import { enforceBashCommandPolicy, isDirectPackageInstallCommand } from '@lobu/core/tool-policy';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Bash, InMemoryFs } from 'just-bash/browser';
import type { AgentTurnBashPolicy, AgentTurnBuiltinTool, RuntimeExecRequest, RuntimeExecResult } from './types.js';

/** Where a turn's files live; also the shell's working directory. */
export const WORKSPACE_ROOT = '/workspace';

/**
 * Where the turn's own attachments are seeded. The name is part of the
 * agent-visible contract: the system prompt lists each upload by this path.
 */
export const INPUT_DIR = `${WORKSPACE_ROOT}/input`;

/**
 * Where the agent's enabled skills are seeded, one `SKILL.md` per skill.
 */
export const SKILLS_DIR = `${WORKSPACE_ROOT}/.skills`;

const LS_LIMIT = 500;
const FIND_LIMIT = 1000;
const FIND_IGNORED = /(^|\/)(node_modules|\.git)(\/|$)/;

/** The local shell's interpreter budget. */
const BASH_LIMITS = { maxCommandCount: 50_000, maxLoopIterations: 50_000 };

const decoder = new TextDecoder();

function text(value: string): { content: [{ type: 'text'; text: string }]; details: Record<string, never> } {
  return { content: [{ type: 'text', text: value }], details: {} };
}

function requireString(args: unknown, key: string): string {
  const value = args && typeof args === 'object' ? (args as Record<string, unknown>)[key] : undefined;
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Missing required parameter: ${key}`);
  return value;
}

function optionalString(args: unknown, key: string): string | undefined {
  const value = args && typeof args === 'object' ? (args as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function optionalNumber(args: unknown, key: string): number | undefined {
  const value = args && typeof args === 'object' ? (args as Record<string, unknown>)[key] : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * A result cap the model asked for, or the default when it asked for something
 * that is not a cap. A zero or negative limit would collect no rows at all and
 * make `ls` answer "(empty directory)" and `find` "No files found" — claims
 * about the workspace rather than about the argument.
 */
function positiveLimit(requested: number | undefined, fallback: number): number {
  return requested !== undefined && requested >= 1 ? Math.floor(requested) : fallback;
}

/** Lobu's existing admission rule; Pi owns the listing and its result. */
function withPositiveLimit(tool: AgentTool, fallback: number): AgentTool {
  return {
    ...tool,
    execute: (id, args, signal, onUpdate) => tool.execute(id, {
      ...(args && typeof args === 'object' ? args : {}),
      limit: positiveLimit(optionalNumber(args, 'limit'), fallback),
    }, signal, onUpdate),
  };
}

/** Binary reads are a Lobu admission refusal, not text for Pi to slice. */
class BinaryWorkspaceFile extends Error {
  constructor(readonly size: number) { super('Binary workspace file'); }
}

/** A `*`/`**`/`?` glob to a regexp over a `/`-separated path. */
function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches zero or more whole segments; a trailing `**` matches the rest.
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          source += '(?:[^/]*/)*';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

/** The bytes of a file that a text read must not pretend are text. */
function looksBinary(bytes: Uint8Array): boolean {
  const probe = Math.min(bytes.length, 8000);
  for (let i = 0; i < probe; i++) if (bytes[i] === 0) return true;
  return false;
}

/**
 * One file the HOST places in the turn's filesystem before the model runs.
 *
 * The guest never fetches: the gateway reads an attachment out of the artifact
 * store it already owns, and a skill straight out of agent settings, then hands
 * the bytes over the same signed envelope as everything else. `data` is base64
 * so arbitrary bytes survive the JSON hop intact; `text` is the convenience for
 * content that is already a string, and exactly one of the two is given.
 */
export type WorkspaceSeedFile =
  | { path: string; data: string; text?: never }
  | { path: string; text: string; data?: never };

/**
 * The turn's filesystem, and the tools that act on it.
 *
 * Returned together because more than the file tools need the FS: `upload_file`
 * reads the very same in-memory tree, so the workspace the model wrote with
 * `bash` is the workspace it can hand to the user. Handing out the `InMemoryFs`
 * is what keeps that one filesystem, rather than giving the media port a second
 * one that would always look empty.
 */
export interface AgentWorkspace {
  /** The turn's filesystem: seeded by the host, gone at the end of the turn. */
  fs: InMemoryFs;
  /** Resolved once the root directory exists; every tool awaits it first. */
  ready: Promise<unknown>;
  tools: AgentTool[];
  /**
   * Write host-supplied files into the turn's tree before the model runs.
   *
   * Containment goes through the SAME `resolve` the file tools use, so a
   * traversing path is refused here for the reason it is refused there rather
   * than by a second check that could drift. Throws on the first bad path and
   * writes nothing further, because a partially seeded workspace would tell the
   * model a file exists when its sibling silently did not.
   */
  seed(files: readonly WorkspaceSeedFile[]): Promise<void>;
  /**
   * Resolve a model-supplied path inside the workspace root, or throw.
   * Exported so a non-file tool that takes a path — `upload_file` — enforces
   * containment through the SAME check the file tools do, rather than a second
   * implementation that could drift from it.
   */
  resolve(path: string | undefined): string;
}

// ---------------------------------------------------------------------------
// grep: pi's tool over the in-memory tree, no ripgrep needed.
// ---------------------------------------------------------------------------

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

const GREP_LIMIT = 100;
const GREP_MAX_LINE_LENGTH = 500;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Remote bash: a sandbox-pinned conversation runs its commands in the remote
// runtime through the host, while file tools remain in memory.
// ---------------------------------------------------------------------------

/** How the host runs one command in the remote runtime sandbox. */
export interface RemoteRuntime {
  exec(request: RuntimeExecRequest): Promise<RuntimeExecResult>;
}

/** The agent-facing half of the honest-degradation contract for a failed package install. */
function provisionNotice(sandbox: unknown): string | undefined {
  if (!sandbox || typeof sandbox !== 'object') return undefined;
  const packages = (sandbox as { packages?: unknown }).packages;
  if (!packages || typeof packages !== 'object') return undefined;
  const failed = ((packages as { failed?: unknown }).failed ?? []) as unknown[];
  const names = Array.isArray(failed) ? failed.filter((f): f is string => typeof f === 'string' && f.length > 0) : [];
  if (names.length === 0) return undefined;
  const error = (packages as { error?: unknown }).error;
  const why = typeof error === 'string' && error.trim() ? ` (${error.trim()})` : '';
  return (
    `lobu: these tools could not be installed and are NOT available in this sandbox: ${names.join(', ')}${why}. ` +
    'Commands that need them will fail — do not try to install them yourself; ' +
    'an admin must fix the package configuration.\n'
  );
}

async function runRemoteBash(remote: RemoteRuntime, command: string, timeout: number | undefined): Promise<string> {
  const result = await remote.exec({
    command,
    ...(timeout !== undefined && timeout > 0 ? { timeoutMs: timeout * 1000 } : {}),
  });
  if (result.status < 200 || result.status >= 300) {
    const message = result.error ?? `Runtime exec failed with HTTP ${result.status}`;
    if (result.kind === 'infrastructure') {
      // The SANDBOX failed, not the command; say so, or the model rewrites a
      // correct command and retries into an already failing endpoint.
      const ran =
        result.outcome === 'not_started'
          ? 'your command did not run'
          : result.outcome === 'completed'
            ? 'your command RAN but its output could not be retrieved'
            : 'it is unknown whether your command ran';
      const advice =
        result.outcome === 'not_started'
          ? result.retryable
            ? ' This is usually transient — the same command may succeed shortly.'
            : ''
          : ' Do NOT re-run it blindly; check whether it took effect first.';
      return `lobu: sandbox runtime error — ${ran}.${advice}\n${message}\n\nCommand exited with code 126`;
    }
    return `${message}\n\nCommand exited with code 1`;
  }
  let output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const notice = provisionNotice(result.sandbox);
  if (notice) output += `${output.length > 0 && !output.endsWith('\n') ? '\n' : ''}${notice}`;
  const truncation = truncateTail(output);
  let rendered = truncation.content || '(no output)';
  if (truncation.truncated) {
    const start = truncation.totalLines - truncation.outputLines + 1;
    rendered += `\n\n[Showing lines ${start}-${truncation.totalLines} of ${truncation.totalLines}${truncation.truncatedBy === 'bytes' ? ` (${formatSize(MAX_BYTES)} limit)` : ''}]`;
  }
  // The route reports a missing exit code as the command failing with 1.
  const exitCode = result.exitCode ?? 1;
  if (exitCode !== 0) rendered += `\n\nCommand exited with code ${exitCode}`;
  return rendered;
}

/**
 * Build the workspace tools the turn admits, over one fresh filesystem. The
 * local shell and every file tool share it, so what local `bash` writes `read`
 * sees. A supplied remote runtime replaces only `bash`; file tools remain on
 * this in-memory filesystem.
 */
export function createWorkspace(
  names: readonly AgentTurnBuiltinTool[],
  bashPolicy?: AgentTurnBashPolicy,
  remote?: RemoteRuntime
): AgentWorkspace {
  const fs = new InMemoryFs();
  const ready = fs.mkdir(WORKSPACE_ROOT, { recursive: true });
  const shell = new Bash({ fs, cwd: WORKSPACE_ROOT, executionLimits: BASH_LIMITS });
  // Every file-tool path resolves inside the workspace root. `resolvePath`
  // happily normalizes `..` and an absolute path past it, and the in-memory
  // tree just-bash builds has `/etc`, `/usr` and the rest in it, so without
  // this the tools would read and write outside the directory they document.
  const resolve = (path: string | undefined): string => {
    const absolute = fs.resolvePath(WORKSPACE_ROOT, path && path !== '' ? path : '.');
    if (absolute !== WORKSPACE_ROOT && !absolute.startsWith(`${WORKSPACE_ROOT}/`)) {
      throw new Error(`Path is outside the workspace (${WORKSPACE_ROOT}): ${path}`);
    }
    return absolute;
  };
  // Pi owns mutation ordering, matching, cancellation, and result formatting.
  // Only filesystem access changes: every operation stays in this turn's tree.
  const writeFile = async (path: string, content: string): Promise<void> => {
    await ready;
    await fs.writeFile(resolve(path), content);
  };
  // Host-placed files. Bytes go in as a Uint8Array rather than a string: a
  // decoded-to-UTF-8 round trip would corrupt every attachment that is not
  // text, and an attachment is exactly the case this exists for.
  const seed = async (files: readonly WorkspaceSeedFile[]): Promise<void> => {
    await ready;
    for (const file of files) {
      const absolute = resolve(file.path);
      const parent = absolute.slice(0, absolute.lastIndexOf('/'));
      if (parent && parent !== absolute) await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(
        absolute,
        file.data !== undefined ? new Uint8Array(Buffer.from(file.data, 'base64')) : file.text
      );
    }
  };
  const write = withLobuFileParameters(createWriteTool(WORKSPACE_ROOT, { operations: {
    writeFile,
    mkdir: async (path) => { await ready; await fs.mkdir(resolve(path), { recursive: true }); },
  } }), 'write');
  const edit = withLobuFileParameters(createEditTool(WORKSPACE_ROOT, { operations: {
    writeFile,
    readFile: async (path) => { await ready; return Buffer.from(await fs.readFileBuffer(resolve(path))); },
    access: async (path) => { await ready; await fs.stat(resolve(path)); },
  } }), 'edit');

  const piRead: AgentTool = withLobuFileParameters(createReadTool(WORKSPACE_ROOT, { operations: {
    access: async (path) => {
      await ready;
      const absolute = resolve(path);
      if (!(await fs.exists(absolute))) throw new Error(`File not found: ${absolute}`);
      if ((await fs.stat(absolute)).isDirectory) throw new Error(`Not a file: ${absolute}`);
    },
    readFile: async (path) => {
      const bytes = await fs.readFileBuffer(resolve(path));
      if (looksBinary(bytes)) throw new BinaryWorkspaceFile(bytes.length);
      return Buffer.from(bytes);
    },
  } }), 'read');
  const read: AgentTool = {
    ...piRead,
    description: `Read the contents of a text file in the workspace. Output is truncated to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    async execute(...args: Parameters<typeof piRead.execute>) {
      try { return await piRead.execute(...args); }
      catch (error) {
        if (error instanceof BinaryWorkspaceFile) return text(`[Binary file: ${formatSize(error.size)}. This workspace reads text files only.]`);
        throw error;
      }
    },
  };
  const exists = async (path: string): Promise<boolean> => { await ready; return fs.exists(resolve(path)); };
  const ls = withPositiveLimit(createLsTool(WORKSPACE_ROOT, { operations: {
    exists,
    stat: async (path) => { await ready; const stat = await fs.stat(resolve(path)); return { isDirectory: () => stat.isDirectory }; },
    readdir: async (path) => { await ready; return fs.readdir(resolve(path)); },
  } }), LS_LIMIT);
  const find = { ...withPositiveLimit(createFindTool(WORKSPACE_ROOT, { operations: {
    exists,
    glob: async (pattern, cwd, { limit }) => {
      await ready;
      const root = resolve(cwd);
      const prefix = `${root}/`;
      const matcher = globToRegExp(pattern);
      const wholePath = pattern.includes('/');
      const matches: string[] = [];
      for (const candidate of fs.getAllPaths().sort()) {
        if (candidate === root || !candidate.startsWith(prefix)) continue;
        const relative = candidate.slice(prefix.length);
        if (FIND_IGNORED.test(relative)) continue;
        if (!matcher.test(wholePath ? relative : (relative.split('/').pop() ?? relative))) continue;
        matches.push(candidate);
        if (matches.length >= limit) break;
      }
      return matches;
    },
  } }), FIND_LIMIT),
    description: `Find files by glob pattern in the workspace. Returns paths relative to the search directory, one per line, skipping node_modules and .git. Output is truncated to ${FIND_LIMIT} results or ${MAX_BYTES / 1024}KB (whichever is hit first).`,
  };

  const tools: Record<AgentTurnBuiltinTool, AgentTool> = {
    bash: {
      name: 'bash',
      label: 'bash',
      description: remote
        ? `Execute a bash command in the conversation's pinned remote sandbox. The sandbox does not share the file tools' in-memory workspace. Returns stdout and stderr. Output is truncated to last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). Network and installed tools follow the sandbox configuration; direct package installation is blocked. Optionally provide a timeout in seconds.`
        : `Execute a bash command in the workspace (${WORKSPACE_ROOT}). Returns stdout and stderr. Output is truncated to last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). The workspace has no network access and no package manager. Optionally provide a timeout in seconds.`,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Bash command to execute' },
          timeout: { type: 'number', description: 'Timeout in seconds (optional, no default timeout)' },
        },
        required: ['command'],
      } as never,
      execute: async (_id, args) => {
        const command = requireString(args, 'command');
        const timeout = optionalNumber(args, 'timeout');
        if (bashPolicy) enforceBashCommandPolicy(command, bashPolicy);
        if (isDirectPackageInstallCommand(command)) {
          throw new Error(
            remote
              ? 'DIRECT PACKAGE INSTALL BLOCKED. Use the sandbox packages configured by an admin.'
              : 'DIRECT PACKAGE INSTALL BLOCKED. This workspace has no package manager and no network; use your other tools to reach data instead.'
          );
        }
        if (remote) return text(await runRemoteBash(remote, command, timeout));
        await ready;
        const result = await shell.exec(command, {
          cwd: WORKSPACE_ROOT,
          ...(timeout !== undefined && timeout > 0 ? { signal: AbortSignal.timeout(timeout * 1000) } : {}),
        });
        const combined = [result.stdout, result.stderr].filter((part) => part.length > 0).join('');
        const truncation = truncateTail(combined);
        let output = truncation.content || '(no output)';
        if (truncation.truncated) {
          const start = truncation.totalLines - truncation.outputLines + 1;
          output += `\n\n[Showing lines ${start}-${truncation.totalLines} of ${truncation.totalLines}${truncation.truncatedBy === 'bytes' ? ` (${formatSize(MAX_BYTES)} limit)` : ''}]`;
        }
        if (result.exitCode !== 0) output += `\n\nCommand exited with code ${result.exitCode}`;
        return text(output);
      },
    },
    read,
    write,
    edit,
    grep: {
      name: 'grep',
      label: 'grep',
      description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Output is truncated to ${GREP_LIMIT} matches or ${MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search pattern (regex or literal string)' },
          path: { type: 'string', description: 'Directory or file to search (default: the workspace root)' },
          glob: { type: 'string', description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
          ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default: false)' },
          literal: { type: 'boolean', description: 'Treat pattern as literal string instead of regex (default: false)' },
          context: { type: 'number', description: 'Number of lines to show before and after each match (default: 0)' },
          limit: { type: 'number', description: `Maximum number of matches to return (default: ${GREP_LIMIT})` },
        },
        required: ['pattern'],
      } as never,
      execute: async (_id, args) => {
        const pattern = requireString(args, 'pattern');
        const path = optionalString(args, 'path');
        const glob = optionalString(args, 'glob');
        const record = args as Record<string, unknown>;
        const ignoreCase = record.ignoreCase === true;
        const literal = record.literal === true;
        const contextLines = Math.max(0, Math.floor(optionalNumber(args, 'context') ?? 0));
        const limit = positiveLimit(optionalNumber(args, 'limit'), GREP_LIMIT);
        await ready;
        const root = resolve(path);
        if (!(await fs.exists(root))) throw new Error(`Path not found: ${root}`);
        const isDirectory = (await fs.stat(root)).isDirectory;
        let matcher: RegExp;
        try {
          matcher = new RegExp(literal ? escapeRegExp(pattern) : pattern, ignoreCase ? 'i' : '');
        } catch (error) {
          throw new Error(`Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`);
        }
        const globMatcher = glob ? globToRegExp(glob) : null;
        const globWholePath = glob?.includes('/') ?? false;
        const prefix = `${root}/`;
        const files = isDirectory
          ? fs
              .getAllPaths()
              .sort()
              .filter((candidate) => candidate !== root && candidate.startsWith(prefix))
              .filter((candidate) => {
                const relative = candidate.slice(prefix.length);
                if (FIND_IGNORED.test(relative)) return false;
                if (!globMatcher) return true;
                return globMatcher.test(globWholePath ? relative : (relative.split('/').pop() ?? relative));
              })
          : [root];
        const relativeName = (file: string) => (isDirectory ? file.slice(prefix.length) : (file.split('/').pop() ?? file));
        const rows: string[] = [];
        let matches = 0;
        let limitReached = false;
        let linesTruncated = false;
        for (const file of files) {
          if (limitReached) break;
          if ((await fs.stat(file)).isDirectory) continue;
          const bytes = await fs.readFileBuffer(file);
          if (looksBinary(bytes)) continue;
          const lines = normalizeToLF(decoder.decode(bytes)).split('\n');
          const name = relativeName(file);
          for (let i = 0; i < lines.length; i++) {
            if (!matcher.test(lines[i] ?? '')) continue;
            matches += 1;
            const lineNumber = i + 1;
            const start = contextLines > 0 ? Math.max(1, lineNumber - contextLines) : lineNumber;
            const end = contextLines > 0 ? Math.min(lines.length, lineNumber + contextLines) : lineNumber;
            for (let current = start; current <= end; current++) {
              const truncated = truncateLine(lines[current - 1] ?? '', GREP_MAX_LINE_LENGTH);
              if (truncated.wasTruncated) linesTruncated = true;
              rows.push(current === lineNumber ? `${name}:${current}: ${truncated.text}` : `${name}-${current}- ${truncated.text}`);
            }
            if (matches >= limit) {
              limitReached = true;
              break;
            }
          }
        }
        if (matches === 0) return text('No matches found');
        const truncation = truncateHead(rows.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER });
        let output = truncation.content;
        const notices: string[] = [];
        if (limitReached) notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
        if (truncation.truncated) notices.push(`${formatSize(MAX_BYTES)} limit reached`);
        if (linesTruncated) notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
        if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`;
        return text(output);
      },
    },
    ls,
    find,
  };

  return {
    fs,
    ready,
    resolve,
    seed,
    tools: names.filter((name, index) => name in tools && names.indexOf(name) === index).map((name) => tools[name]),
  };
}
