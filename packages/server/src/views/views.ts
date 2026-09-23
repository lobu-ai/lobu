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
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import type { ViewAttachment } from '@lobu/core/contracts/tools/manage-views';
import type { SourceFiles, SourceDependencies } from '@lobu/core/contracts/tools/source-files';
import { sourceDependencies } from '@lobu/connector-worker/compile';
import { build, type Plugin } from 'esbuild';
import { getDb } from '../db/client';
import { ToolUserError } from '../utils/errors';

export type { ViewAttachment };

const require = createRequire(import.meta.url);

/** View keys match the migration CHECK: lowercase, dashes, 1-64 chars. */
export const VIEW_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** View action names are identifiers and may use camelCase. */
export const VIEW_ACTION_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
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

/** Shared content identity (server and CLI derive the key from one function). */
export { contentHash, type ViewContentMetadata } from '@lobu/core/contracts/tools/view-content-hash';

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
  source_files: SourceFiles | null;
  dependencies: SourceDependencies | null;
  source_complete: boolean;
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
  source_files?: SourceFiles | null;
  dependencies?: SourceDependencies | null;
  source_complete?: boolean;
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
  source_files: SourceFiles | null;
  dependencies: SourceDependencies | null;
  source_complete: boolean | null;
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
    source_files: row.source_files ?? null,
    dependencies: row.dependencies ?? null,
    source_complete: row.source_complete === true,
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
      source_files, dependencies, source_complete,
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
      source_files, dependencies, source_complete,
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
      content_hash, source_files, dependencies, source_complete, attach, params, actions, last_writer, updated_at
    ) VALUES (
      ${organizationId}, ${input.key}, ${input.name}, ${input.description},
      ${input.source_code}, ${input.compiled_code}, ${input.content_hash},
      ${input.source_files ? sql.json(input.source_files) : null},
      ${input.dependencies ? sql.json(input.dependencies) : null}, ${input.source_complete ?? false},
      ${sql.json(input.attach)}, ${sql.json(input.params)},
      ${sql.json(input.actions)}, ${input.last_writer}, NOW()
    )
    ON CONFLICT (organization_id, key) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      source_code = EXCLUDED.source_code,
      compiled_code = EXCLUDED.compiled_code,
      content_hash = EXCLUDED.content_hash,
      source_files = EXCLUDED.source_files,
      dependencies = EXCLUDED.dependencies,
      source_complete = EXCLUDED.source_complete,
      attach = EXCLUDED.attach,
      params = EXCLUDED.params,
      actions = EXCLUDED.actions,
      last_writer = EXCLUDED.last_writer,
      updated_at = NOW()
    RETURNING key, name, description, source_code, compiled_code, content_hash,
      source_files, dependencies, source_complete,
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
  'compiled_code' | 'source_code' | 'source_files' | 'dependencies' | 'source_complete'
> & { compiled_bytes: number; source_bytes: number } {
  const { compiled_code, source_code, source_files: _files, dependencies: _deps, source_complete: _complete, ...rest } = view;
  return {
    ...rest,
    compiled_bytes: Buffer.byteLength(compiled_code, 'utf8'),
    source_bytes: Buffer.byteLength(source_code, 'utf8'),
  };
}

/**
 * The ONLY importable specifiers in phase-1 view compilation. A view author is
 * an org owner/admin, but the bundle is served to every viewer of the page —
 * so compilation resolves nothing off disk except these pinned runtime funds:
 * react for rendering and `@lobu/views` for the hooks bridge (params, scope,
 * reads, actions). Relative/absolute imports (which could reach server files)
 * and every other bare specifier fail closed; the CLI bundles relative files
 * and npm deps where node_modules exists and ships the bundle beside the
 * source.
 */
const VIEW_ALLOWED_BARE_SPECIFIERS = new Set([
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  '@lobu/views',
]);
/** The server compiler always mounts through these installed runtime packages. */
export function viewSourceDependencies(): SourceDependencies {
  return sourceDependencies(['react', 'react-dom/client', '@lobu/views'].map((name) => require.resolve(name)));
}

/** Virtual specifier carrying the authored source into the bundle. */
const VIEW_SOURCE_SPECIFIER = 'lobu-view-source';

/**
 * The package directory a resolved fund file lives in: the gate lets imports
 * FROM these trees through to default resolution. For installed packages this
 * is the whole node_modules tree (transitive deps like the scheduler react-dom
 * pulls in bare live there too); for workspace realpaths outside any
 * node_modules (a symlinked package's dist) it is the nearest ancestor
 * holding a package.json, so exactly that package passes.
 */
function fundPackageDir(file: string): string | null {
  const idx = file.lastIndexOf('/node_modules/');
  if (idx >= 0) return file.slice(0, idx + '/node_modules'.length);
  let dir = file.slice(0, file.lastIndexOf('/'));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dir.slice(0, dir.lastIndexOf('/'));
    if (!parent || parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Server-owned mounting bootstrap. The authored module is bundled as a
 * separate virtual module; this entry renders its default export inside the
 * `@lobu/views` provider (params, scope, reads, actions) and mounts it into
 * #root. Authors write `export const view = defineView({ key, attach, … })`
 * plus an ordinary default-export component and never touch the document
 * themselves; a module without a `view` export still renders, with params
 * defaulted and actions unavailable.
 */
const VIEW_BOOTSTRAP_SOURCE = `import React from "react";
import { createRoot } from "react-dom/client";
import { Provider as LobuViewProvider } from "@lobu/views";
import * as viewModule from "${VIEW_SOURCE_SPECIFIER}";
const View = viewModule.default;
const viewDef = viewModule.view ?? { key: "", attach: [] };
const mountNode = document.getElementById("root");
if (mountNode && View) {
  createRoot(mountNode).render(
    React.createElement(LobuViewProvider, { def: viewDef }, React.createElement(View))
  );
}
`;

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
  // Package directories the allowed funds live in. Imports FROM files in
  // these trees (react's own `./cjs/...` internals, the scheduler react-dom
  // pulls in bare, `@lobu/views`'s own sibling modules) resolve by default
  // node resolution — the gate applies to the view source's imports, not the
  // pinned installation content they reach. A view author cannot trigger this
  // path: authored imports always arrive with the stdin/virtual importer,
  // which lives in no fund package.
  const fundDirs = new Set<string>();
  for (const file of Object.values(funds)) {
    const dir = fundPackageDir(file);
    if (dir) fundDirs.add(dir);
  }
  return {
    name: 'lobu-view-resolve',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        // Normalize first: esbuild hands over unresolved paths (react-dom
        // reaches scheduler as `../node_modules/scheduler/index.js`), and an
        // un-normalized prefix check would miss them.
        const importer = args.importer ? posix.normalize(args.importer) : null;
        if (
          importer &&
          [...fundDirs].some(
            (root) => importer === root || importer.startsWith(`${root}/`)
          )
        ) {
          return undefined;
        }
        // The bootstrap's own import of the virtual authored module.
        if (args.path === VIEW_SOURCE_SPECIFIER) {
          return { path: args.path, namespace: 'lobu-view-source' };
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
              text: `Unknown view import "${args.path}": phase-1 views bundle react and @lobu/views only; relative files and other dependencies ship through lobu apply`,
            },
          ],
        };
      });
    },
  };
}

/**
 * Serves the authored source to the bundler as a virtual TSX module. The
 * module is never imported or executed server-side — it only reaches the
 * browser bundle through the bootstrap entry above.
 */
function viewSourcePlugin(source: string): Plugin {
  return {
    name: 'lobu-view-source',
    setup(b) {
      b.onLoad(
        { filter: /.*/, namespace: 'lobu-view-source' },
        () => ({ contents: source, loader: 'tsx' })
      );
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
        contents: VIEW_BOOTSTRAP_SOURCE,
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
      plugins: [viewResolvePlugin(), viewSourcePlugin(source)],
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
 * few kilobytes while per-view bundles carry the React guest. It runs the
 * standard `ui/initialize` handshake, then renders the per-view bundle from
 * whichever delivery the host uses: the standard `sandbox-resource-ready`
 * push (Claude), a `resources/read` of `ui://lobu/views/<key>` for the key in
 * the `tool-input` arguments, or the `lobu:views-bundle` message (same-origin
 * hosts that read the shell over REST). Before replacing its document it
 * injects the collected bootstrap state (host context, last tool input,
 * queued event notifications, request counter) as `window.__lobuViewHandoff`,
 * so the mounted guest continues the session instead of starting unseeded.
 * With no delivery it stays an honest loading state instead of guessing a
 * protocol.
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
  var PROTOCOL = "2026-01-26";
  var nextId = 1;
  var pending = {};
  var settled = false;
  // Bootstrap state for the mounted guest, collected across this document's
  // life and injected into the per-view HTML before replacing it. A host that
  // delivers the opening tool input once has fulfilled that delivery; without
  // the handoff the new guest would start unseeded and wait forever.
  var hostContext = {};
  var toolInput = null;
  var queue = [];
  var QUEUE_CAP = 50;
  function status(text) {
    var el = document.getElementById("lobu-views-status");
    if (el) el.textContent = text;
  }
  function handoffTag() {
    var handoff = { v: 1, hostContext: hostContext, toolInput: toolInput, queue: queue, nextId: nextId };
    var json = JSON.stringify(handoff).replace(/</g, "\\\\u003c");
    return "<script>window.__lobuViewHandoff=" + json + ";</scr" + "ipt>";
  }
  function injectHandoff(html) {
    var tag = handoffTag();
    var m = /<head[^>]*>/i.exec(html);
    if (m) {
      var end = m.index + m[0].length;
      return html.slice(0, end) + tag + html.slice(end);
    }
    return tag + html;
  }
  function show(html) {
    if (settled) return;
    settled = true;
    document.open();
    document.write(injectHandoff(html));
    document.close();
  }
  function fail(text) {
    if (settled) return;
    settled = true;
    status(text);
  }
  function send(message) {
    window.parent.postMessage(message, "*");
  }
  function request(method, params, onResult) {
    var id = nextId++;
    pending[id] = onResult;
    setTimeout(function () {
      if (pending[id]) {
        delete pending[id];
        onResult(new Error('request "' + method + '" timed out'), null);
      }
    }, 60000);
    send({ jsonrpc: "2.0", id: id, method: method, params: params });
  }
  function readViewBundle(key, onDone) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) {
      onDone(new Error('unknown view "' + String(key) + '"'));
      return;
    }
    request("resources/read", { uri: "ui://lobu/views/" + key }, function (err, result) {
      if (err) {
        onDone(err);
        return;
      }
      var text = result && result.contents && result.contents[0] && result.contents[0].text;
      if (typeof text !== "string" || !text) {
        onDone(new Error("view bundle came back empty"));
        return;
      }
      onDone(null, text);
    });
  }
  window.addEventListener("message", function (event) {
    // Only the host frame may deliver the bundle. Any other source — another
    // frame, an opener, or a stray broadcast — is ignored so untrusted content
    // can never inject HTML into the view.
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.jsonrpc !== "2.0") return;
    // A host request (ping, teardown): acknowledge so it never hangs.
    if (typeof data.method === "string" && (typeof data.id === "string" || typeof data.id === "number")) {
      send({ jsonrpc: "2.0", id: data.id, result: {} });
      return;
    }
    if (typeof data.id === "string" || typeof data.id === "number") {
      var cb = pending[data.id];
      if (!cb) return;
      delete pending[data.id];
      if (data.error) cb(new Error(String((data.error && data.error.message) || "host request failed")), null);
      else cb(null, data.result);
      return;
    }
    if (typeof data.method !== "string") return;
    var params = data.params && typeof data.params === "object" ? data.params : {};
    // Standard push path: the host delivers the per-view HTML itself.
    if (data.method === "ui/notifications/sandbox-resource-ready" && typeof params.html === "string") {
      show(params.html);
      return;
    }
    // Standard fetch path: tool-input carries the open_view arguments. The
    // input is kept as the handoff even when it carries no view key: the
    // mounted guest seeds scope and params from it either way.
    if (data.method === "ui/notifications/tool-input") {
      var args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      toolInput = args;
      if (typeof args.key === "string" && args.key) {
        readViewBundle(args.key, function (err, html) {
          if (err) fail("Could not load view: " + err.message);
          else show(html);
        });
      }
      return;
    }
    // Event notifications that arrive after the opening input are queued for
    // the mounted guest, which adopts them on connect instead of missing them
    // across the document replacement. Context merges into the adopted
    // hostContext (state, not an event) rather than queueing.
    if (data.method === "ui/notifications/tool-result" || data.method === "ui/notifications/tool-cancelled") {
      queue.push({ method: data.method, params: params });
      if (queue.length > QUEUE_CAP) queue.shift();
      return;
    }
    if (data.method === "ui/notifications/host-context-changed") {
      for (var k in params) {
        if (k === "__proto__") continue;
        hostContext[k] = params[k];
      }
      return;
    }
    // Same-origin fast path: the host read the shell over REST and posts it.
    if (data.type === "lobu:views-bundle" && typeof data.html === "string") {
      show(data.html);
    }
  });
  request("ui/initialize", {
    appInfo: { name: "Lobu views", version: "0.0.1" },
    appCapabilities: {},
    protocolVersion: PROTOCOL
  }, function (err, result) {
    if (result && typeof result.hostContext === "object" && result.hostContext) {
      hostContext = result.hostContext;
    }
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
  });
  setTimeout(function () {
    if (!settled) fail("The host did not deliver a view. Reopen it from Lobu.");
  }, 90000);
})();
</script>
</body>
</html>`;
}
