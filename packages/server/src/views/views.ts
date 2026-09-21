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
import { createRequire } from 'node:module';
import type {
  ViewAttachment,
  ViewParamDecl,
} from '@lobu/core/contracts/tools/manage-views';
import { build, type Plugin } from 'esbuild';
import { getDb } from '../db/client';
import { ToolUserError } from '../utils/errors';

export type { ViewAttachment, ViewParamDecl };

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

/** Shared content identity (server and CLI derive the key from one function). */
export { contentHash, type ViewContentMetadata } from '@lobu/core/contracts/tools/view-content-hash';

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
 * compiled from stdin (no file context) still bundles the runtime. `@lobu/views`
 * resolves to the workspace package for the chat-agent path (`manage_views.set`
 * with plain source); the CLI bundles relative files and npm deps where
 * node_modules exists and ships the bundle beside the source. Anything else
 * resolves by esbuild's default walk and fails loudly when unresolvable. */
function reactResolvePlugin(): Plugin {
  const funds: Record<string, string> = {};
  for (const specifier of ['react', 'react-dom', 'react/jsx-runtime', '@lobu/views']) {
    try {
      funds[specifier] = require.resolve(specifier);
    } catch {
      // left absent — esbuild reports the unresolvable import instead
    }
  }
  return {
    name: 'lobu-view-react',
    setup(b) {
      b.onResolve({ filter: /^(react|react-dom|react\/jsx-runtime|@lobu\/views)$/ }, (args) => {
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
 * few kilobytes while per-view bundles carry the React guest. It runs the
 * standard `ui/initialize` handshake, then renders the per-view bundle from
 * whichever delivery the host uses: the standard `sandbox-resource-ready`
 * push (Claude), a `resources/read` of `ui://lobu/views/<key>` for the key in
 * the `tool-input` arguments, or the `lobu:views-bundle` message (same-origin
 * hosts that read the shell over REST). With no delivery it stays an honest
 * loading state instead of guessing a protocol.
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
  function status(text) {
    var el = document.getElementById("lobu-views-status");
    if (el) el.textContent = text;
  }
  function show(html) {
    if (settled) return;
    settled = true;
    document.open();
    document.write(html);
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
    // Standard fetch path: tool-input carries the open_view arguments.
    if (data.method === "ui/notifications/tool-input") {
      var args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      if (typeof args.key === "string" && args.key) {
        readViewBundle(args.key, function (err, html) {
          if (err) fail("Could not load view: " + err.message);
          else show(html);
        });
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
  }, function () {
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
