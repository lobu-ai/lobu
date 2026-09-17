/**
 * Lobu views, server side (phase 1).
 *
 * A view is an ordinary React module stored in the `views` table with its
 * current source, compiled browser bundle, content hash and the
 * attach/params/actions metadata extracted from the module by the saver
 * (`lobu apply` extracts them from the file; direct tool callers declare
 * them). The server compiles with esbuild at save and NEVER executes view
 * code: each view is served as one HTML shell with the bundle inlined, read
 * back over the MCP resource or the shell route and mounted `srcdoc` into the
 * sandboxed frame the MCP apps already use.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ViewAttachment } from '@lobu/core/contracts/tools/manage-views';
import { build, type Plugin } from 'esbuild';
import { getDb } from '../db/client';
import { ToolUserError } from '../utils/errors';

export type { ViewAttachment };

const require = createRequire(import.meta.url);

/** View keys match the migration CHECK: lowercase, dashes, 1-64 chars. */
export const VIEW_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Stable generic loader every `open_view` binds (one tool, one resource). */
export const LOBU_VIEWS_RESOURCE_URI = 'ui://lobu/views';
const VIEW_RESOURCE_PREFIX = 'ui://lobu/views/';
/** Inlined bundle cap; the interaction bundle gate is 395 KB, views get more room. */
export const VIEW_COMPILED_MAX_BYTES = 2 * 1024 * 1024;
/** Source cap so one save cannot feed esbuild an unbounded input. */
export const VIEW_SOURCE_MAX_CHARS = 1_000_000;
/** Param names the host owns on type/record pages; a view cannot declare them. */
export const RESERVED_VIEW_PARAMS = new Set(['view', 'version']);

export function isValidViewKey(key: string): boolean {
  return VIEW_KEY_RE.test(key);
}

export function viewResourceUri(key: string): string {
  return `${VIEW_RESOURCE_PREFIX}${key}`;
}

/** The per-view key for a `ui://lobu/views/<key>` uri, else null. */
export function viewKeyFromResourceUri(uri: string): string | null {
  if (!uri.startsWith(VIEW_RESOURCE_PREFIX)) return null;
  const key = uri.slice(VIEW_RESOURCE_PREFIX.length);
  return VIEW_KEY_RE.test(key) ? key : null;
}

/** Deterministic JSON for hashing: object keys sorted, arrays kept in order. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Declared metadata that affects the stored view (everything but provenance). */
export interface ViewContentMetadata {
  name: string;
  description: string;
  attach: unknown;
  params: unknown;
  actions: unknown;
}

/**
 * sha256 of the source plus the declared metadata, first 16 hex. Same source
 * AND same metadata means the row is already current and nothing is written.
 * `last_writer` is provenance of the last write, not content: including it
 * would defeat the no-op detection, since every apply run mints a new
 * apply_id.
 */
export function contentHash(source: string, metadata?: ViewContentMetadata): string {
  return createHash('sha256')
    .update(source)
    .update('\n')
    .update(stableStringify(metadata ?? null))
    .digest('hex')
    .slice(0, 16);
}

export interface ViewParamDecl {
  type: 'string' | 'number' | 'boolean';
  default?: unknown;
  description?: string;
}

export interface ViewActionDecl {
  emits: string;
}

export interface StoredView {
  key: string;
  name: string;
  description: string;
  source_code: string;
  compiled_code: string;
  content_hash: string;
  attach: ViewAttachment[];
  params: Record<string, ViewParamDecl>;
  actions: Record<string, ViewActionDecl>;
  last_writer: string;
  updated_at: string;
}

export interface SetViewInput {
  key: string;
  name: string;
  description: string;
  source_code: string;
  compiled_code: string;
  content_hash: string;
  attach: ViewAttachment[];
  params: StoredView['params'];
  actions: StoredView['actions'];
  last_writer: string;
}

interface ViewRow {
  key: string;
  name: string;
  description: string;
  source_code: string;
  compiled_code: string;
  content_hash: string;
  attach: unknown;
  params: unknown;
  actions: unknown;
  last_writer: string;
  updated_at: Date;
}

function mapViewRow(row: ViewRow): StoredView {
  return {
    key: String(row.key),
    name: String(row.name),
    description: String(row.description ?? ''),
    source_code: String(row.source_code),
    compiled_code: String(row.compiled_code ?? ''),
    content_hash: String(row.content_hash),
    attach: (row.attach ?? []) as ViewAttachment[],
    params: (row.params ?? {}) as StoredView['params'],
    actions: (row.actions ?? {}) as StoredView['actions'],
    last_writer: String(row.last_writer),
    updated_at:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at),
  };
}

export async function getView(
  organizationId: string,
  key: string
): Promise<StoredView | null> {
  const sql = getDb();
  const rows = await sql<ViewRow>`
    SELECT key, name, description, source_code, compiled_code, content_hash,
      attach, params, actions, last_writer, updated_at
    FROM views
    WHERE organization_id = ${organizationId} AND key = ${key}
    LIMIT 1
  `;
  return rows.length > 0 ? mapViewRow(rows[0]) : null;
}

export async function listViews(organizationId: string): Promise<StoredView[]> {
  const sql = getDb();
  const rows = await sql<ViewRow>`
    SELECT key, name, description, source_code, compiled_code, content_hash,
      attach, params, actions, last_writer, updated_at
    FROM views
    WHERE organization_id = ${organizationId}
    ORDER BY key ASC
  `;
  return rows.map(mapViewRow);
}

/**
 * Upsert by (organization_id, key). Same source hash AND same compiled bytes
 * means the row is already current and nothing is written (updated_at proves
 * it in tests). Returns whether a write happened.
 */
export async function setView(
  organizationId: string,
  input: SetViewInput
): Promise<{ view: StoredView; written: boolean }> {
  const sql = getDb();
  const existing = await getView(organizationId, input.key);
  if (
    existing &&
    existing.content_hash === input.content_hash &&
    existing.compiled_code === input.compiled_code
  ) {
    return { view: existing, written: false };
  }
  const rows = await sql<ViewRow>`
    INSERT INTO views (
      organization_id, key, name, description, source_code, compiled_code,
      content_hash, attach, params, actions, last_writer, updated_at
    ) VALUES (
      ${organizationId}, ${input.key}, ${input.name}, ${input.description},
      ${input.source_code}, ${input.compiled_code}, ${input.content_hash},
      ${sql.json(input.attach)}, ${sql.json(input.params)},
      ${sql.json(input.actions)}, ${input.last_writer}, NOW()
    )
    ON CONFLICT (organization_id, key) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      source_code = EXCLUDED.source_code,
      compiled_code = EXCLUDED.compiled_code,
      content_hash = EXCLUDED.content_hash,
      attach = EXCLUDED.attach,
      params = EXCLUDED.params,
      actions = EXCLUDED.actions,
      last_writer = EXCLUDED.last_writer,
      updated_at = NOW()
    RETURNING key, name, description, source_code, compiled_code, content_hash,
      attach, params, actions, last_writer, updated_at
  `;
  return { view: mapViewRow(rows[0]), written: true };
}

export async function removeView(
  organizationId: string,
  key: string
): Promise<boolean> {
  const sql = getDb();
  const rows = await sql<{ id: number }>`
    DELETE FROM views
    WHERE organization_id = ${organizationId} AND key = ${key}
    RETURNING id
  `;
  return rows.length > 0;
}

/** Public projection: metadata only, never source or bundle. */
export function projectView(view: StoredView): Omit<
  StoredView,
  'compiled_code' | 'source_code'
> & { compiled_bytes: number; source_bytes: number } {
  const { compiled_code, source_code, ...rest } = view;
  return {
    ...rest,
    compiled_bytes: Buffer.byteLength(compiled_code, 'utf8'),
    source_bytes: Buffer.byteLength(source_code, 'utf8'),
  };
}

/**
 * The ONLY importable specifiers in phase-1 view compilation. A view author is
 * an org owner/admin, but the bundle is served to every viewer of the page —
 * so compilation resolves nothing off disk except these pinned runtime funds.
 * Relative/absolute imports (which could reach server files) and every other
 * bare specifier fail closed. PR2 adds `@lobu/views` plus the CLI-bundled path.
 */
const VIEW_ALLOWED_BARE_SPECIFIERS = new Set([
  'react',
  'react-dom',
  'react/jsx-runtime',
]);

/** Resolve the allowed runtime funds inside the server's own installation, so
 * source compiled from stdin (no file context) still bundles the runtime. */
function viewResolvePlugin(): Plugin {
  const funds: Record<string, string> = {};
  for (const specifier of VIEW_ALLOWED_BARE_SPECIFIERS) {
    try {
      funds[specifier] = require.resolve(specifier);
    } catch {
      // left absent — esbuild reports the unresolvable import instead
    }
  }
  // Package roots the allowed funds live under. Imports FROM these files
  // (react's own `./cjs/...` internals) resolve normally — the gate applies
  // to the view source's imports, not the runtime's.
  const fundRoots = new Set<string>();
  for (const [specifier, file] of Object.entries(funds)) {
    const scope = specifier.split('/')[0] ?? '';
    const marker = `node_modules/${scope}/`;
    const idx = file.lastIndexOf(marker);
    if (idx >= 0) fundRoots.add(file.slice(0, idx + marker.length - 1));
  }
  return {
    name: 'lobu-view-resolve',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (
          args.importer &&
          [...fundRoots].some(
            (root) => args.importer === root || args.importer.startsWith(`${root}/`)
          )
        ) {
          return undefined;
        }
        if (args.path.startsWith('.') || args.path.startsWith('/')) {
          return {
            errors: [
              {
                text: `View imports must be bare package specifiers: relative and absolute imports are not supported (got "${args.path}")`,
              },
            ],
          };
        }
        if (VIEW_ALLOWED_BARE_SPECIFIERS.has(args.path)) {
          const resolved = funds[args.path];
          return resolved ? { path: resolved } : null;
        }
        return {
          errors: [
            {
              text: `Unknown view import "${args.path}": phase-1 views bundle react only; other dependencies arrive with @lobu/views in PR2`,
            },
          ],
        };
      });
    },
  };
}

/**
 * Inert resolution base for stdin compilation. The resolve plugin above
 * rejects every relative/absolute path before the filesystem is consulted, so
 * this directory is never read — it exists only so esbuild never falls back
 * to the process working directory (which could resolve server files).
 */
function inertResolveDir(): string {
  const dir = join(tmpdir(), 'lobu-views-inert-resolve');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Compile a view module to a minified browser IIFE with the bundle inlined by
 * the shell. Pure text transform — the module is never imported or executed.
 * Throws ToolUserError(422) on diagnostics or when the bundle exceeds the cap.
 */
export async function compileView(
  source: string,
  opts?: { maxBytes?: number }
): Promise<string> {
  let compiled: string;
  try {
    const result = await build({
      stdin: {
        contents: source,
        loader: 'tsx',
        resolveDir: inertResolveDir(),
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      minify: true,
      jsx: 'automatic',
      logLevel: 'silent',
      write: false,
      plugins: [viewResolvePlugin()],
    });
    compiled = result.outputFiles?.[0]?.text ?? '';
  } catch (err) {
    const message =
      err instanceof Error ? err.message.split('\n').slice(0, 5).join('\n') : String(err);
    throw new ToolUserError(`View source failed to compile: ${message}`, 422);
  }
  if (!compiled) {
    throw new ToolUserError('View source compiled to an empty bundle', 422);
  }
  const bytes = Buffer.byteLength(compiled, 'utf8');
  const maxBytes = opts?.maxBytes ?? VIEW_COMPILED_MAX_BYTES;
  if (bytes > maxBytes) {
    throw new ToolUserError(
      `View bundle is ${bytes} bytes, over the ${maxBytes} byte cap`,
      422
    );
  }
  return compiled;
}

/** Registry entry shaped like `MCP_APP_RESOURCES` so `mcpAppResourceMeta` applies unchanged. */
export function viewResourceMeta(view: StoredView): {
  name: string;
  description: string;
  appDir: string;
  csp: { connectDomains: string[]; resourceDomains: string[]; frameDomains: string[] };
  prefersBorder: boolean;
} {
  return {
    name: view.name,
    description: view.description || `Lobu view ${view.key}`,
    appDir: `views/${view.key}`,
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
    prefersBorder: true,
  };
}

// Minimal theme tokens; the host's `theme` flips `.dark` on <html>.
const BASE_CSS = `
:root{color-scheme:light;--fg:#0a0a0a;--muted:#6b7280;--border:#e5e7eb;--accent:#2563eb}
html.dark{color-scheme:dark;--fg:#fafafa;--muted:#9ca3af;--border:#27272a;--accent:#60a5fa}
html,body{margin:0;background:transparent;color:var(--fg);font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
*{box-sizing:border-box}
`;

/** One view's shell: the compiled bundle inlined, no relative asset URLs and
 * no `<base href>` (claude.ai hardcodes `base-uri 'self'`, so both 404 there). */
export function renderViewShell(view: StoredView): string {
  const script = view.compiled_code.replaceAll('</script', '<\\/script');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="lobu-view" content="${view.key}">
<meta name="lobu-view-hash" content="${view.content_hash}">
<title>Lobu — ${view.name.replaceAll('<', '&lt;')}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<div id="root"></div>
<script>${script}</script>
</body>
</html>`;
}

/**
 * The generic loader shell every `open_view` binds. Hand-written postMessage —
 * no `@modelcontextprotocol/ext-apps`, no React, no framework — so it stays a
 * few kilobytes while per-view bundles carry the 500KB+ guest SDK chain the
 * spike measured. It announces itself to the host and renders the per-view
 * bundle the host hands it (`ui://lobu/views/<key>` read through the host
 * resource channel); with no host message it stays a neutral loading state
 * instead of guessing a protocol. The `@lobu/views` guest bridge (PR2) and
 * the owletto host (PR3) complete the handshake.
 */
export function renderViewsLoaderShell(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="lobu-views-loader" content="1">
<title>Lobu views</title>
<style>${BASE_CSS}#lobu-views-status{padding:12px;color:var(--muted)}</style>
</head>
<body>
<div id="root"><div id="lobu-views-status">Loading view…</div></div>
<script>
(function () {
  "use strict";
  var READY = { type: "lobu:views-loader-ready", version: 1 };
  function announce() {
    try {
      if (window.parent && window.parent !== window) window.parent.postMessage(READY, "*");
    } catch (err) { /* sandboxed without a host — stay in loading state */ }
  }
  window.addEventListener("message", function (event) {
    // Only the host frame may deliver the bundle. Any other source — another
    // frame, an opener, or a stray broadcast — is ignored so untrusted content
    // can never inject HTML into the view.
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object") return;
    // The host delivers the per-view bundle read from ui://lobu/views/<key>.
    if (data.type === "lobu:views-bundle" && typeof data.html === "string") {
      document.open();
      document.write(data.html);
      document.close();
    }
  });
  if (document.readyState === "complete") announce();
  else window.addEventListener("load", announce);
})();
</script>
</body>
</html>`;
}
