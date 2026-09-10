import { Hono } from 'hono';
import type { Env } from '../index';
import { createAuth } from '../auth';
import { resolveSession, sessionCookieCandidates } from '../auth/resolve-session';
import { findExistingPersonalOrg } from '../auth/personal-org-provisioning';
import { resolveBaseUrl } from '../auth/base-url';
import { getDb } from '../db/client';
import { publicSetupOptions } from './setup-options';
import { resolveManagedAuthConnectorOffer } from '../workspace/managed-auth-discovery';
import { handleConnectManaged } from '../tools/admin/manage_connections/handlers/connect-managed';
import { escapeHtml } from '../utils/html';

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.6 system-ui;margin:0;padding:24px;background:#fafafa;color:#171717;display:grid;place-items:center;min-height:90vh}main{max-width:480px}h1{font-size:24px}a{color:inherit}button{font:inherit;padding:8px 16px;cursor:pointer}code{overflow-wrap:anywhere}</style></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
}

/** GET only advertises public metadata. Consent is an explicit same-origin POST. */
export interface SetupRouteDeps {
  publicOptions: typeof publicSetupOptions;
  resolveOffer: typeof resolveManagedAuthConnectorOffer;
  session(request: Request, env: Env): Promise<{ user: { id: string } } | null>;
  home(userId: string): Promise<{ id: string } | null>;
  connect: typeof handleConnectManaged;
  origin(request: Request): string;
}
const DEFAULT_DEPS: SetupRouteDeps = {
  publicOptions: publicSetupOptions, resolveOffer: resolveManagedAuthConnectorOffer,
  session: async (request, env) => resolveSession(await createAuth(env, request), request.headers),
  home: userId => findExistingPersonalOrg(userId, getDb()),
  connect: handleConnectManaged, origin: request => resolveBaseUrl({ request }),
};
export function createSetupRoutes(deps: SetupRouteDeps = DEFAULT_DEPS) {
const setupRoutes = new Hono<{ Bindings: Env }>();
setupRoutes.get('/api/connection-options', async (c) => {
  const key = c.req.query('connector_key');
  if (!key || key.length > 200) return c.json({ error: 'connector_key is required' }, 400);
  c.header('Cache-Control', 'no-store');
  return c.json(await deps.publicOptions(key, deps.origin(c.req.raw)));
});

setupRoutes.get('/connect/managed', async (c) => {
  const org = c.req.query('org') ?? '';
  const connector = c.req.query('connector') ?? '';
  if (!org || !connector || org.length > 200 || connector.length > 200 || !await deps.resolveOffer({ organizationSlug: org, connectorKey: connector })) {
    return c.html(page('Connection option unavailable', '<p>This managed app is no longer available. Return to Lobu and refresh connection options.</p>'), 404);
  }
  const session = await deps.session(c.req.raw, c.env);
  c.header('Cache-Control', 'no-store');
  if (!session?.user) {
    const callback = new URL('/connect/managed', deps.origin(c.req.raw));
    callback.searchParams.set('org', org); callback.searchParams.set('connector', connector);
    const login = `/auth/login?callbackUrl=${encodeURIComponent(callback.toString())}`;
    return c.html(page('Connect with a managed app', `<p>Sign in to Lobu Cloud, then authorize the account you want to use locally. No app credentials are needed.</p><a href="${escapeHtml(login)}">Sign in to continue</a>`));
  }
  return c.html(page(`Connect ${connector}`, `<p>Use the managed app provided by ${escapeHtml(org)}. This creates or reuses a private authorization for your account. It does not sync provider data into this cloud workspace.</p><form method="post"><button type="submit">Continue to account authorization</button></form><p>You can use the authorized connection with your local Lobu runtime after signing its CLI into this cloud.</p>`));
});

setupRoutes.post('/connect/managed', async (c) => {
  const origin = deps.origin(c.req.raw);
  // Better Auth also accepts bearer sessions; this form must use its browser cookie.
  if (c.req.header('authorization') || c.req.header('origin') !== origin || !sessionCookieCandidates(c.req.header('cookie')).length) return c.json({ error: 'Use the signed-in browser setup page.' }, 403);
  const session = await deps.session(c.req.raw, c.env);
  if (!session?.user) return c.json({ error: 'Sign in to continue.' }, 401);
  const org = c.req.query('org') ?? '';
  const connector = c.req.query('connector') ?? '';
  if (!org || !connector || org.length > 200 || connector.length > 200) return c.json({ error: 'Invalid setup option' }, 400);
  const home = await deps.home(session.user.id);
  if (!home) return c.json({ error: 'Open Lobu to finish account setup, then return here.' }, 409);
  const result = await deps.connect({ action: 'connect_managed', managed_by_org: org, connector_key: connector }, {
    organizationId: home.id, userId: session.user.id, memberRole: 'owner',
    isAuthenticated: true, tokenType: 'session', scopedToOrg: true,
    allowCrossOrg: false, grantedOrganizationIds: null, directSearchFederation: false,
    requestUrl: c.req.url, baseUrl: origin,
  });
  c.header('Cache-Control', 'no-store');
  if ('error' in result) return c.html(page('Connection setup needs attention', `<p>${escapeHtml(result.error)}</p>`), 400);
  if ('connect_url' in result && result.connect_url) return c.redirect(result.connect_url, 303);
  if (!('status' in result) || result.status !== 'active') {
    const instructions = 'instructions' in result ? result.instructions : 'Complete connection setup in Lobu, then return here.';
    return c.html(page('Connection setup needs attention', `<p>${escapeHtml(instructions)}</p>`), 409);
  }
  const slug = 'slug' in result && typeof result.slug === 'string' ? result.slug : null;
  return c.html(page('Managed connection ready', `<p>Your managed authorization is ready. Provider data has not been synced.</p><p>In your local CLI, use the same cloud login and run:</p><pre><code>${escapeHtml(`lobu init --from-org ${org}`)}</code></pre><p>For an existing project, import the generated managedBy connection without replacing your project.${slug ? ` Grant: ${escapeHtml(slug)}.` : ''}</p>`));
});

return setupRoutes;
}
export const setupRoutes = createSetupRoutes();
