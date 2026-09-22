/**
 * Every view shell must deny outbound network from inside the frame.
 *
 * A view bundle is UNTRUSTED author code: `manage_views.set` accepts plain
 * source from a chat agent, and `lobu apply` ships whatever a repo's `.tsx`
 * contains. The compiler is an import boundary (`viewRuntimeResolvePlugin`)
 * but it is not a runtime one — nothing stops the compiled bundle from calling
 * `fetch`, opening a WebSocket, or pulling a remote `<img>`/`<iframe>` once it
 * is executing in the frame.
 *
 * Both host paths give the frame an opaque origin (`sandbox="allow-scripts"`,
 * no `allow-same-origin`), which blocks reading OUR origin but does nothing
 * about egress: an opaque-origin document can still POST anywhere, and every
 * row the view legitimately read is in its heap. The read broker exists so the
 * guest's data access is mediated (`isViewReadTool`); an unrestricted `fetch`
 * routes straight around it. A remote `<img src>` alone is enough to
 * exfiltrate by URL.
 *
 * So each shell carries a CSP that permits exactly what an inlined authored
 * bundle needs — inline script and inline style, from the document itself —
 * and denies every outbound load. `frame-ancestors` is deliberately NOT set:
 * the shell is meant to be framed by the host.
 */

import { describe, expect, it } from 'bun:test';
import {
  renderViewShell,
  renderViewsLoaderShell,
  type StoredView,
} from '../../views/views';

function storedView(overrides: Partial<StoredView> = {}): StoredView {
  return {
    key: 'connection-health',
    name: 'Connection health',
    description: 'health card',
    source_code: 'export default function V() { return null; }',
    compiled_code: '(()=>{document.title="ok"})();',
    content_hash: 'abc123def4567890',
    attach: [],
    params: {},
    actions: {},
    last_writer: 'user:test',
    updated_at: '2026-09-17T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * The `content` of the shell's CSP <meta>, or null when absent. The policy
 * itself contains single quotes (`'none'`), so only the double-quoted
 * attribute delimiter may terminate the match.
 */
function cspOf(html: string): string | null {
  const match =
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?>/i.exec(
      html
    );
  return match ? match[1] : null;
}

/** One directive's value list from a policy string. */
function directive(policy: string, name: string): string[] | null {
  for (const part of policy.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    if (tokens[0].toLowerCase() === name.toLowerCase()) return tokens.slice(1);
  }
  return null;
}

/**
 * The egress surfaces a policy must close. `default-src 'none'` covers any
 * fetch directive not named explicitly, so a policy either sets the directive
 * to `'none'` or relies on a `'none'` default — both are asserted below.
 */
const EGRESS_DIRECTIVES = [
  'connect-src',
  'img-src',
  'media-src',
  'frame-src',
  'object-src',
  'font-src',
  'manifest-src',
  'worker-src',
  'child-src',
  'form-action',
  'base-uri',
];

function assertDeniesEgress(policy: string, label: string): void {
  const fallback = directive(policy, 'default-src');
  expect(fallback, `${label}: default-src must be set`).not.toBeNull();
  expect(fallback, `${label}: default-src must be 'none'`).toEqual(["'none'"]);

  for (const name of EGRESS_DIRECTIVES) {
    const values = directive(policy, name);
    if (values === null) continue; // falls back to default-src 'none'
    // An explicit directive may only be 'none' — naming any scheme or host
    // (http:, https:, data:, blob:, *) reopens the surface default-src closed.
    expect(values, `${label}: ${name} must be 'none' when set`).toEqual([
      "'none'",
    ]);
  }
}

function assertAllowsInlineBundle(policy: string, label: string): void {
  // The bundle and theme tokens are inlined into the document, so these two
  // are exactly what must stay permitted.
  const script = directive(policy, 'script-src');
  expect(script, `${label}: script-src must be set`).not.toBeNull();
  expect(
    script?.includes("'unsafe-inline'"),
    `${label}: inline bundle must run`
  ).toBe(true);
  // No remote script source may ride along with it.
  for (const token of script ?? []) {
    expect(
      ["'unsafe-inline'", "'self'", "'none'", "'unsafe-eval'"].includes(token) ||
        token.startsWith("'sha256-") ||
        token.startsWith("'nonce-"),
      `${label}: script-src must not name a remote source (${token})`
    ).toBe(true);
  }
  const style = directive(policy, 'style-src');
  expect(style, `${label}: style-src must be set`).not.toBeNull();
  expect(
    style?.includes("'unsafe-inline'"),
    `${label}: inline theme CSS must apply`
  ).toBe(true);
}

describe('view shell CSP', () => {
  it('denies egress from the per-view shell', () => {
    const policy = cspOf(renderViewShell(storedView()));
    expect(policy).not.toBeNull();
    assertDeniesEgress(policy as string, 'per-view shell');
    assertAllowsInlineBundle(policy as string, 'per-view shell');
  });

  it('denies egress from the generic loader shell', () => {
    // The loader is the document Claude mounts first, and the document that
    // survives until a view replaces it.
    const policy = cspOf(renderViewsLoaderShell());
    expect(policy).not.toBeNull();
    assertDeniesEgress(policy as string, 'loader shell');
    assertAllowsInlineBundle(policy as string, 'loader shell');
  });

  it('keeps the per-view shell policy independent of view content', () => {
    // A view must not be able to influence its own policy through its
    // metadata: name/key/hash are all interpolated into the same <head>.
    const hostile = storedView({
      key: 'evil',
      name: '"><meta http-equiv="Content-Security-Policy" content="default-src *">',
      content_hash: '"><script>fetch("//x")</script>',
    });
    const html = renderViewShell(hostile);
    // Exactly one policy in the document — an injected second <meta> would
    // otherwise be the one the browser honours for directives the first omits.
    const all = html.match(/http-equiv=["']Content-Security-Policy["']/gi) ?? [];
    expect(all).toHaveLength(1);
    assertDeniesEgress(cspOf(html) as string, 'hostile view');
  });

  it('serves the CSP before any inline script in the document', () => {
    // A policy that appears after the bundle has already run is decoration:
    // the browser applies <meta> CSP only to what follows it.
    for (const [label, html] of [
      ['per-view shell', renderViewShell(storedView())],
      ['loader shell', renderViewsLoaderShell()],
    ] as Array<[string, string]>) {
      const cspAt = html.search(
        /<meta\s+http-equiv=["']Content-Security-Policy["']/i
      );
      const scriptAt = html.search(/<script/i);
      expect(cspAt, `${label}: CSP meta must be present`).toBeGreaterThan(-1);
      expect(
        scriptAt === -1 || cspAt < scriptAt,
        `${label}: CSP must precede the first <script>`
      ).toBe(true);
    }
  });
});
