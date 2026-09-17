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
import { createRequire } from 'node:module';
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

/** sha256 of the source, first 16 hex — same source, same hash, no write. */
export function contentHash(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
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

/** Resolve react funds inside the server's own installation, so source
 * compiled from stdin (no file context) still bundles the runtime. Anything
 * else resolves by esbuild's default walk and fails loudly when unresolvable
 * (`@lobu/views` lands in PR2; relative files go through `lobu apply`). */
function reactResolvePlugin(): Plugin {
  const funds: Record<string, string> = {};
  for (const specifier of ['react', 'react-dom', 'react/jsx-runtime']) {
    try {
      funds[specifier] = require.resolve(specifier);
    } catch {
      // left absent — esbuild reports the unresolvable import instead
    }
  }
  return {
    name: 'lobu-view-react',
    setup(b) {
      b.onResolve({ filter: /^(react|react-dom|react\/jsx-runtime)$/ }, (args) => {
        const resolved = funds[args.path];
        return resolved ? { path: resolved } : null;
      });
    },
  };
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
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      minify: true,
      jsx: 'automatic',
      logLevel: 'silent',
      write: false,
      plugins: [reactResolvePlugin()],
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
