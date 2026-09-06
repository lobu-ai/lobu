/**
 * The turn's workspace tools: `bash`, `read`, `write`, `ls` and `find` over a
 * filesystem that exists for this turn only.
 *
 * GUEST code, bundled with the agent entry, so it must stay portable: no
 * `node:` import, no host module, no root `@lobu/core` import (that root drags
 * the Node logger and tracing SDKs). The shell is just-bash's browser build —
 * the same shell the subprocess lane ran its `bash` tool on, minus the real
 * binaries and the network it could reach there. The file tools implement pi's
 * `read`/`write`/`ls`/`find` contracts (schemas, limits and the notices the
 * model has been reading) directly over just-bash's `IFileSystem`: pi's own
 * factories pull the terminal UI, syntax highlighting and an image codec into
 * any bundle that imports them, none of which loads in an isolate.
 *
 * The filesystem is in-memory and empty at the start of every turn. Nothing
 * written here outlives the turn, and nothing here can reach the network: the
 * shell is built without `fetch`, so `curl` and `wget` do not exist in it.
 */

import { enforceBashCommandPolicy, isDirectPackageInstallCommand } from '@lobu/core/tool-policy';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Bash, InMemoryFs } from 'just-bash/browser';
import type { AgentTurnBashPolicy, AgentTurnBuiltinTool } from './types.js';

/** Where a turn's files live; also the shell's working directory. */
export const WORKSPACE_ROOT = '/workspace';

/** pi's output caps, so a file or a command reads the same on both lanes. */
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const LS_LIMIT = 500;
const FIND_LIMIT = 1000;
const FIND_IGNORED = /(^|\/)(node_modules|\.git)(\/|$)/;

/** The same interpreter budget the subprocess lane gave its shell. */
const BASH_LIMITS = { maxCommandCount: 50_000, maxLoopIterations: 50_000 };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

interface Truncation {
  content: string;
  truncated: boolean;
  truncatedBy: 'lines' | 'bytes' | null;
  totalLines: number;
  outputLines: number;
  outputBytes: number;
  firstLineExceedsLimit: boolean;
}

/** Keep the first lines that fit, as pi's `truncateHead` does. */
function truncateHead(content: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES): Truncation {
  const lines = content.split('\n');
  const totalLines = lines.length;
  const totalBytes = byteLength(content);
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { content, truncated: false, truncatedBy: null, totalLines, outputLines: totalLines, outputBytes: totalBytes, firstLineExceedsLimit: false };
  }
  if (byteLength(lines[0] ?? '') > maxBytes) {
    return { content: '', truncated: true, truncatedBy: 'bytes', totalLines, outputLines: 0, outputBytes: 0, firstLineExceedsLimit: true };
  }
  const kept: string[] = [];
  let bytes = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const lineBytes = byteLength(lines[i] ?? '') + (i > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      break;
    }
    kept.push(lines[i] ?? '');
    bytes += lineBytes;
  }
  const out = kept.join('\n');
  return { content: out, truncated: true, truncatedBy, totalLines, outputLines: kept.length, outputBytes: byteLength(out), firstLineExceedsLimit: false };
}

/** Keep the last lines that fit, as pi's `truncateTail` does for command output. */
function truncateTail(content: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES): Truncation {
  const lines = content.split('\n');
  const totalLines = lines.length;
  const totalBytes = byteLength(content);
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { content, truncated: false, truncatedBy: null, totalLines, outputLines: totalLines, outputBytes: totalBytes, firstLineExceedsLimit: false };
  }
  const kept: string[] = [];
  let bytes = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
    const lineBytes = byteLength(lines[i] ?? '') + (kept.length > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      break;
    }
    kept.unshift(lines[i] ?? '');
    bytes += lineBytes;
  }
  const out = kept.join('\n');
  return { content: out, truncated: true, truncatedBy, totalLines, outputLines: kept.length, outputBytes: byteLength(out), firstLineExceedsLimit: false };
}

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
 * The turn's filesystem, and the tools that act on it.
 *
 * Returned together because more than the file tools need the FS: `upload_file`
 * reads the very same in-memory tree, so the workspace the model wrote with
 * `bash` is the workspace it can hand to the user. Handing out the `InMemoryFs`
 * is what keeps that one filesystem, rather than giving the media port a second
 * one that would always look empty.
 */
export interface AgentWorkspace {
  /** The turn's filesystem. Empty at the start of the turn, gone at the end. */
  fs: InMemoryFs;
  /** Resolved once the root directory exists; every tool awaits it first. */
  ready: Promise<unknown>;
  tools: AgentTool[];
  /**
   * Resolve a model-supplied path inside the workspace root, or throw.
   * Exported so a non-file tool that takes a path — `upload_file` — enforces
   * containment through the SAME check the file tools do, rather than a second
   * implementation that could drift from it.
   */
  resolve(path: string | undefined): string;
}

/**
 * Build the workspace tools the turn admits, over one fresh filesystem. The
 * shell and every file tool share it, so what `bash` writes `read` sees.
 */
export function createWorkspace(names: readonly AgentTurnBuiltinTool[], bashPolicy?: AgentTurnBashPolicy): AgentWorkspace {
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
  // `resolve` guarantees a path under the workspace root, so the last slash is
  // always at a positive index.
  const dirname = (path: string): string => path.slice(0, path.lastIndexOf('/'));

  const tools: Record<AgentTurnBuiltinTool, AgentTool> = {
    bash: {
      name: 'bash',
      label: 'bash',
      description: `Execute a bash command in the workspace (${WORKSPACE_ROOT}). Returns stdout and stderr. Output is truncated to last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). The workspace has no network access and no package manager. Optionally provide a timeout in seconds.`,
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
            'DIRECT PACKAGE INSTALL BLOCKED. This workspace has no package manager and no network; use your other tools to reach data instead.'
          );
        }
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
    read: {
      name: 'read',
      label: 'read',
      description: `Read the contents of a text file in the workspace. Output is truncated to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file to read (relative to the workspace, or absolute)' },
          offset: { type: 'number', description: 'Line number to start reading from (1-indexed)' },
          limit: { type: 'number', description: 'Maximum number of lines to read' },
        },
        required: ['file_path'],
      } as never,
      execute: async (_id, args) => {
        const path = requireString(args, 'file_path');
        const offset = optionalNumber(args, 'offset');
        const limit = optionalNumber(args, 'limit');
        await ready;
        const absolute = resolve(path);
        if (!(await fs.exists(absolute))) throw new Error(`File not found: ${absolute}`);
        const stat = await fs.stat(absolute);
        if (stat.isDirectory) throw new Error(`Not a file: ${absolute}`);
        const bytes = await fs.readFileBuffer(absolute);
        if (looksBinary(bytes)) {
          return text(`[Binary file: ${formatSize(bytes.length)}. This workspace reads text files only.]`);
        }
        const lines = decoder.decode(bytes).split('\n');
        const start = offset ? Math.max(0, offset - 1) : 0;
        if (start >= lines.length) throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);
        const end = limit !== undefined ? Math.min(start + limit, lines.length) : lines.length;
        const selected = lines.slice(start, end).join('\n');
        const truncation = truncateHead(selected);
        const startDisplay = start + 1;
        if (truncation.firstLineExceedsLimit) {
          return text(
            `[Line ${startDisplay} is ${formatSize(byteLength(lines[start] ?? ''))}, exceeds ${formatSize(MAX_BYTES)} limit. Use bash: sed -n '${startDisplay}p' ${path} | head -c ${MAX_BYTES}]`
          );
        }
        let output = truncation.content;
        if (truncation.truncated) {
          const endDisplay = startDisplay + truncation.outputLines - 1;
          output += `\n\n[Showing lines ${startDisplay}-${endDisplay} of ${lines.length}${truncation.truncatedBy === 'bytes' ? ` (${formatSize(MAX_BYTES)} limit)` : ''}. Use offset=${endDisplay + 1} to continue.]`;
        } else if (end < lines.length) {
          output += `\n\n[Showing lines ${startDisplay}-${end} of ${lines.length}. ${lines.length - end} more lines. Use offset=${end + 1} to continue.]`;
        }
        return text(output);
      },
    },
    write: {
      name: 'write',
      label: 'write',
      description: "Write content to a file in the workspace. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file to write (relative to the workspace, or absolute)' },
          content: { type: 'string', description: 'Content to write to the file' },
        },
        required: ['file_path', 'content'],
      } as never,
      execute: async (_id, args) => {
        const path = requireString(args, 'file_path');
        const content = args && typeof args === 'object' ? (args as Record<string, unknown>).content : undefined;
        if (typeof content !== 'string') throw new Error('Missing required parameter: content');
        await ready;
        const absolute = resolve(path);
        await fs.mkdir(dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, content);
        return text(`Successfully wrote ${byteLength(content)} bytes to ${path}`);
      },
    },
    ls: {
      name: 'ls',
      label: 'ls',
      description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${LS_LIMIT} entries or ${MAX_BYTES / 1024}KB (whichever is hit first).`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to list (default: the workspace root)' },
          limit: { type: 'number', description: `Maximum number of entries to return (default: ${LS_LIMIT})` },
        },
      } as never,
      execute: async (_id, args) => {
        const path = optionalString(args, 'path');
        const limit = positiveLimit(optionalNumber(args, 'limit'), LS_LIMIT);
        await ready;
        const absolute = resolve(path);
        if (!(await fs.exists(absolute))) throw new Error(`Path not found: ${absolute}`);
        if (!(await fs.stat(absolute)).isDirectory) throw new Error(`Not a directory: ${absolute}`);
        const entries = (await fs.readdir(absolute)).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        const rows: string[] = [];
        let entryLimitReached = false;
        for (const entry of entries) {
          if (rows.length >= limit) {
            entryLimitReached = true;
            break;
          }
          const stat = await fs.stat(`${absolute}/${entry}`);
          rows.push(stat.isDirectory ? `${entry}/` : entry);
        }
        if (rows.length === 0) return text('(empty directory)');
        const truncation = truncateHead(rows.join('\n'), Number.MAX_SAFE_INTEGER);
        let output = truncation.content;
        const notices: string[] = [];
        if (entryLimitReached) notices.push(`${limit} entries limit reached. Use limit=${limit * 2} for more`);
        if (truncation.truncated) notices.push(`${formatSize(MAX_BYTES)} limit reached`);
        if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`;
        return text(output);
      },
    },
    find: {
      name: 'find',
      label: 'find',
      description: `Find files by glob pattern in the workspace. Returns paths relative to the search directory, one per line, skipping node_modules and .git. Output is truncated to ${FIND_LIMIT} results or ${MAX_BYTES / 1024}KB (whichever is hit first).`,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" },
          path: { type: 'string', description: 'Directory to search in (default: the workspace root)' },
          limit: { type: 'number', description: `Maximum number of results (default: ${FIND_LIMIT})` },
        },
        required: ['pattern'],
      } as never,
      execute: async (_id, args) => {
        const pattern = requireString(args, 'pattern');
        const path = optionalString(args, 'path');
        const limit = positiveLimit(optionalNumber(args, 'limit'), FIND_LIMIT);
        await ready;
        const root = resolve(path);
        if (!(await fs.exists(root))) throw new Error(`Path not found: ${root}`);
        const prefix = `${root}/`;
        // A pattern without a slash names a file wherever it is, as `fd --glob`
        // does; one with a slash is matched against the path under the search root.
        const matcher = globToRegExp(pattern);
        const wholePath = pattern.includes('/');
        const matches: string[] = [];
        for (const candidate of fs.getAllPaths().sort()) {
          if (candidate === root || !candidate.startsWith(prefix)) continue;
          const relative = candidate.slice(prefix.length);
          if (FIND_IGNORED.test(relative)) continue;
          const subject = wholePath ? relative : (relative.split('/').pop() ?? relative);
          if (!matcher.test(subject)) continue;
          matches.push(relative);
          if (matches.length >= limit) break;
        }
        if (matches.length === 0) return text('No files found matching pattern');
        const truncation = truncateHead(matches.join('\n'), Number.MAX_SAFE_INTEGER);
        let output = truncation.content;
        const notices: string[] = [];
        if (matches.length >= limit) notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`);
        if (truncation.truncated) notices.push(`${formatSize(MAX_BYTES)} limit reached`);
        if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`;
        return text(output);
      },
    },
  };

  return {
    fs,
    ready,
    resolve,
    tools: names.filter((name, index) => name in tools && names.indexOf(name) === index).map((name) => tools[name]),
  };
}

/**
 * The turn's workspace tools alone, for a caller that has no use for the
 * filesystem behind them.
 */
export function createWorkspaceTools(names: readonly AgentTurnBuiltinTool[], bashPolicy?: AgentTurnBashPolicy): AgentTool[] {
  return createWorkspace(names, bashPolicy).tools;
}
