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
import type { AgentTurnBashPolicy, AgentTurnBuiltinTool, RuntimeExecRequest, RuntimeExecResult } from './types.js';

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

// ---------------------------------------------------------------------------
// edit: pi's `edit-diff` matching, ported. The messages are pi's verbatim so a
// model that learned them on one lane reads the same thing on the other.
// ---------------------------------------------------------------------------

interface EditBlock {
  oldText: string;
  newText: string;
}

function detectLineEnding(content: string): '\n' | '\r\n' {
  const crlf = content.indexOf('\r\n');
  const lf = content.indexOf('\n');
  if (lf === -1 || crlf === -1) return '\n';
  return crlf < lf ? '\r\n' : '\n';
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function restoreLineEndings(text: string, ending: '\n' | '\r\n'): string {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize('NFKC')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/[  -   　]/g, ' ');
}

function fuzzyFindText(
  content: string,
  oldText: string
): { found: boolean; index: number; matchLength: number; usedFuzzyMatch: boolean } {
  const exact = content.indexOf(oldText);
  if (exact !== -1) return { found: true, index: exact, matchLength: oldText.length, usedFuzzyMatch: false };
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOld = normalizeForFuzzyMatch(oldText);
  const index = fuzzyContent.indexOf(fuzzyOld);
  if (index === -1) return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
  return { found: true, index, matchLength: fuzzyOld.length, usedFuzzyMatch: true };
}

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith('﻿') ? { bom: '﻿', text: content.slice(1) } : { bom: '', text: content };
}

function countOccurrences(content: string, oldText: string): number {
  return normalizeForFuzzyMatch(content).split(normalizeForFuzzyMatch(oldText)).length - 1;
}

/** pi's `applyEditsToNormalizedContent`: every edit against the original, no overlaps, something must change. */
function applyEdits(normalizedContent: string, edits: readonly EditBlock[], path: string): string {
  const normalized = edits.map((edit) => ({ oldText: normalizeToLF(edit.oldText), newText: normalizeToLF(edit.newText) }));
  const total = normalized.length;
  normalized.forEach((edit, i) => {
    if (edit.oldText.length === 0) {
      throw new Error(total === 1 ? `oldText must not be empty in ${path}.` : `edits[${i}].oldText must not be empty in ${path}.`);
    }
  });
  const usedFuzzy = normalized.some((edit) => fuzzyFindText(normalizedContent, edit.oldText).usedFuzzyMatch);
  const base = usedFuzzy ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;
  const matched: Array<{ editIndex: number; matchIndex: number; matchLength: number; newText: string }> = [];
  normalized.forEach((edit, i) => {
    const match = fuzzyFindText(base, edit.oldText);
    if (!match.found) {
      throw new Error(
        total === 1
          ? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
          : `Could not find edits[${i}] in ${path}. The oldText must match exactly including all whitespace and newlines.`
      );
    }
    const occurrences = countOccurrences(base, edit.oldText);
    if (occurrences > 1) {
      throw new Error(
        total === 1
          ? `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
          : `Found ${occurrences} occurrences of edits[${i}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`
      );
    }
    matched.push({ editIndex: i, matchIndex: match.index, matchLength: match.matchLength, newText: edit.newText });
  });
  matched.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matched.length; i++) {
    const previous = matched[i - 1] as (typeof matched)[number];
    const current = matched[i] as (typeof matched)[number];
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`
      );
    }
  }
  let next = base;
  for (let i = matched.length - 1; i >= 0; i--) {
    const edit = matched[i] as (typeof matched)[number];
    next = next.substring(0, edit.matchIndex) + edit.newText + next.substring(edit.matchIndex + edit.matchLength);
  }
  if (next === base) {
    throw new Error(
      total === 1
        ? `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
        : `No changes made to ${path}. The replacements produced identical content.`
    );
  }
  return next;
}

/** The edits a model sent, in either of the shapes pi accepts. */
function readEdits(args: unknown): EditBlock[] {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  let edits: unknown = record.edits;
  // Some models send the array as a JSON string.
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits);
    } catch {
      // Falls through to the shape check below.
    }
  }
  const list: EditBlock[] = Array.isArray(edits)
    ? edits.filter(
        (edit): edit is EditBlock =>
          !!edit && typeof edit === 'object' && typeof (edit as EditBlock).oldText === 'string' && typeof (edit as EditBlock).newText === 'string'
      )
    : [];
  // pi's older single-replacement shape.
  if (typeof record.oldText === 'string' && typeof record.newText === 'string') {
    list.push({ oldText: record.oldText, newText: record.newText });
  }
  if (list.length === 0) throw new Error('Edit tool input is invalid. edits must contain at least one replacement.');
  return list;
}

// ---------------------------------------------------------------------------
// grep: pi's tool over the in-memory tree, no ripgrep needed.
// ---------------------------------------------------------------------------

const GREP_LIMIT = 100;
const GREP_MAX_LINE_LENGTH = 500;

function truncateLine(line: string): { text: string; wasTruncated: boolean } {
  if (line.length <= GREP_MAX_LINE_LENGTH) return { text: line, wasTruncated: false };
  return { text: `${line.slice(0, GREP_MAX_LINE_LENGTH)}... [truncated]`, wasTruncated: true };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Remote bash: a sandbox-pinned conversation runs its commands in the remote
// runtime, through the host. The rendering is the subprocess lane's
// (`generic-runtime-bash`), so the model reads the same words on either lane.
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
 * shell and every file tool share it, so what `bash` writes `read` sees.
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
    edit: {
      name: 'edit',
      label: 'edit',
      description:
        'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to edit (relative to the workspace, or absolute)' },
          edits: {
            type: 'array',
            description:
              'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.',
            items: {
              type: 'object',
              properties: {
                oldText: {
                  type: 'string',
                  description:
                    'Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.',
                },
                newText: { type: 'string', description: 'Replacement text for this targeted edit.' },
              },
              required: ['oldText', 'newText'],
            },
          },
        },
        required: ['path', 'edits'],
      } as never,
      execute: async (_id, args) => {
        const path = requireString(args, 'path');
        const edits = readEdits(args);
        await ready;
        const absolute = resolve(path);
        if (!(await fs.exists(absolute))) throw new Error(`Could not edit file: ${path}. Error code: ENOENT.`);
        if ((await fs.stat(absolute)).isDirectory) throw new Error(`Could not edit file: ${path}. Error code: EISDIR.`);
        // Decoded WITH the BOM: the default decoder drops it, and pi keeps it.
        const { bom, text: content } = stripBom(
          new TextDecoder('utf-8', { ignoreBOM: true }).decode(await fs.readFileBuffer(absolute))
        );
        const ending = detectLineEnding(content);
        const next = applyEdits(normalizeToLF(content), edits, path);
        await fs.writeFile(absolute, bom + restoreLineEndings(next, ending));
        return text(`Successfully replaced ${edits.length} block(s) in ${path}.`);
      },
    },
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
              const truncated = truncateLine(lines[current - 1] ?? '');
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
        const truncation = truncateHead(rows.join('\n'), Number.MAX_SAFE_INTEGER);
        let output = truncation.content;
        const notices: string[] = [];
        if (limitReached) notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
        if (truncation.truncated) notices.push(`${formatSize(MAX_BYTES)} limit reached`);
        if (linesTruncated) notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
        if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`;
        return text(output);
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
