import { Hono } from 'hono';
import type { Env } from '../index';
import { createAuth } from '../auth';
import { resolveSession, serveAuthRequest, sessionCookieCandidates } from '../auth/resolve-session';
import { resolveBaseUrl } from '../auth/base-url';
import { loginProviderForChatPlatform } from '../auth/chat-login-identities';
import {
  adoptChatIdentityOntoMember,
  provisionMemberAndCoreIdentities,
  withChatIdentityLock,
} from '../auth/subject-identities';
import { type DbClient, getDb } from '../db/client';
import { resolveMemberOrgsForUser } from '../identity/member-orgs';
import {
  type ChatIdentityLinkClaim,
  chatIdentityLinkKey,
  deleteChatIdentityLink,
  readChatIdentityLink,
} from '../lobu/stores/chat-identity-link';
import { runtimeConnectionPredicate } from '../lobu/stores/connections-projection';
import { getScopedConnectorDefinition } from '../catalog/connector-definitions';
import { connectorDisplayName } from '../catalog/connector-group-display';
import { renderLobuPage } from '../gateway/auth/oauth-templates';
import { getChatInstanceManager } from '../lobu/gateway';
import { escapeHtml } from '../utils/html';
import logger from '../utils/logger';
import { joinPublicOrganization } from '../workspace/join-public';

/**
 * One-click chat identity linking (see lobu/stores/chat-identity-link.ts).
 *
 * GET renders a confirmation page and never mutates. POST is a same-origin
 * browser form submission carrying the signed-in session cookie; it re-checks
 * membership of the claim's organization and, in one transaction, burns the
 * claim and stamps the chat identity onto the member through the existing
 * conflict-safe writer. Platform-neutral: the identity key comes from the
 * platform's own descriptor, never from this file.
 */

const PATH = '/connect/chat-identity';

type LinkStatus =
  | { status: 'linked'; organization: OrganizationInfo; joined: boolean; claim: ChatIdentityLinkClaim }
  | { status: 'invalid' }
  | { status: 'not_member'; organization: OrganizationInfo }
  | { status: 'conflict'; organization: OrganizationInfo; joined: boolean };

interface SessionUser {
  id: string;
  email?: string | null;
  name?: string | null;
}

interface ChatIdentityRouteDeps {
  session(request: Request, env: Env): Promise<{ user: SessionUser } | null>;
  /** End the browser's Lobu session; returns the `Set-Cookie` values to send. */
  signOut(request: Request, env: Env): Promise<string[]>;
  origin(request: Request): string;
}

/**
 * Better Auth's own sign-out, dispatched through the same chokepoint as
 * `/api/auth/*` so the cookie jar is collapsed and converged exactly as a
 * sign-out from the web app would be.
 */
async function signOutBrowserSession(request: Request, env: Env): Promise<string[]> {
  const auth = await createAuth(env, request);
  const headers = new Headers(request.headers);
  headers.set('content-type', 'application/json');
  headers.delete('content-length');
  const response = await serveAuthRequest(
    auth,
    new Request(new URL('/api/auth/sign-out', resolveBaseUrl({ request })), {
      method: 'POST',
      headers,
      body: '{}',
    })
  );
  if (!response.ok) throw new Error(`Sign-out returned ${response.status}`);
  return response.headers.getSetCookie();
}

const DEFAULT_DEPS: ChatIdentityRouteDeps = {
  session: async (request, env) => resolveSession(await createAuth(env, request), request.headers),
  signOut: signOutBrowserSession,
  origin: (request) => resolveBaseUrl({ request }),
};

/**
 * Sign in, then land back on this link. With `provider`, the login page starts
 * that provider's sign-in straight away (it falls back to the normal page when
 * the provider is not enabled).
 */
function loginContinuation(origin: string, token: string, provider?: string | null): string {
  const callback = new URL(PATH, origin);
  callback.searchParams.set('token', token);
  const query = new URLSearchParams({ ...(provider && { provider }), callbackUrl: callback.toString() });
  return `/auth/login?${query}`;
}

/**
 * Sign out, then sign in again and land back on this link. Same-origin POST;
 * the page's strict-origin referrer policy keeps the token out of Referer.
 */
function switchAccountForm(token: string): string {
  return `<form method="post" class="switch">Signed in with the wrong Lobu account? <input type="hidden" name="token" value="${escapeHtml(token)}"><input type="hidden" name="switch_account" value="1"><button class="link-btn" type="submit">Use a different account</button></form>`;
}

const OPEN_LOBU = '<a class="btn btn-secondary" href="/">Open Lobu</a>';

function errorPage(code: string, title: string, body: string): string {
  return renderLobuPage({ title, body, details: code });
}

const INVALID_LINK_PAGE = errorPage(
  'chat_identity_link_invalid',
  'Link expired',
  '<p>This link has expired or was already used, so nothing was linked.</p><p>Send the bot a direct message again to get a new link. Each link works once and expires after a few minutes.</p>' +
    `<div class="actions">${OPEN_LOBU}</div>`
);

const SWITCH_FAILED_PAGE = errorPage(
  'chat_identity_switch_failed',
  'Could not switch accounts',
  '<p>Lobu could not sign you out. Open Lobu, sign out from your account menu, then open the link from your chat again.</p>' +
    `<div class="actions">${OPEN_LOBU}</div>`
);

function notMemberPage(org: OrganizationInfo, lobuAccount: string, token: string): string {
  const name = escapeHtml(org.name);
  return errorPage(
    'chat_identity_not_member',
    'Not a member yet',
    `<p>You are signed in as <strong>${escapeHtml(lobuAccount)}</strong>, which is not a member of <strong>${name}</strong>.</p>` +
      `<p>Ask an admin of ${name} to invite you, then open this link again. If you are a member with another Lobu account, switch to it.</p>` +
      `<div class="actions">${OPEN_LOBU}</div>` +
      switchAccountForm(token)
  );
}

function conflictPage(org: OrganizationInfo, joined: boolean, token: string): string {
  const name = escapeHtml(org.name);
  return errorPage(
    'chat_identity_conflict',
    'Already linked to someone else',
    (joined ? `<p>You joined ${name}, but this chat account could not be linked.</p>` : '') +
      '<p>This chat account is already linked to a different Lobu account. The existing chat account link was not changed.</p>' +
      `<p>If that other Lobu account is yours, switch to it to use this link. Otherwise, ask an admin of ${name} to check who it belongs to.</p>` +
      `<div class="actions">${OPEN_LOBU}</div>` +
      switchAccountForm(token)
  );
}

function linkedPage(org: OrganizationInfo, joined: boolean): string {
  const name = `<strong>${escapeHtml(org.name)}</strong>`;
  const open = org.slug
    ? `<div class="actions"><a class="btn btn-secondary" href="/${encodeURIComponent(org.slug)}">Open ${escapeHtml(org.name)} in Lobu</a></div>`
    : '';
  return renderLobuPage({
    title: 'Chat account linked',
    body:
      `<p>${joined ? `You joined ${name}, and your` : 'Your'} chat account is linked to your Lobu account in ${name}.</p>` +
      '<p>You can close this tab and go back to your chat. Message the bot again to continue.</p>' +
      open,
  });
}

interface OrganizationInfo {
  name: string;
  slug: string | null;
  /** Anyone signed in may join a public organization (workspace/join-public.ts). */
  isPublic: boolean;
}

async function organizationInfo(sql: DbClient, organizationId: string): Promise<OrganizationInfo> {
  const [org] = await sql<{ name: string | null; slug: string | null; visibility: string | null }>`
    SELECT name, slug, visibility FROM "organization" WHERE id = ${organizationId} LIMIT 1
  `;
  return {
    name: org?.name || org?.slug || 'this workspace',
    slug: org?.slug ?? null,
    isPublic: org?.visibility === 'public',
  };
}

async function memberRole(sql: DbClient, userId: string, organizationId: string): Promise<string | null> {
  const rows = await sql<{ role: string }>`
    SELECT role FROM "member"
    WHERE "userId" = ${userId} AND "organizationId" = ${organizationId}
    LIMIT 2
  `;
  return rows.length === 1 ? rows[0].role : null;
}

/** The connection that delivered the offer must still be a live chat connection. */
async function connectionIsLive(sql: DbClient, claim: ChatIdentityLinkClaim): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM connections
    WHERE ${runtimeConnectionPredicate(sql, claim.connectionId, {
      id: sql`id`,
      slug: sql`slug`,
      credentialMode: sql`credential_mode`,
    })}
      AND connector_key = ${claim.platform}
      AND status = 'active'
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * The claim's identity key, re-derived from the platform's CURRENT descriptor.
 * A platform whose registry entry is gone, or whose key shape changed since
 * the offer, links nothing.
 */
function claimKey(claim: ChatIdentityLinkClaim): { namespace: string; identityKey: string } | null {
  const key = chatIdentityLinkKey(claim.platform, claim.teamId, claim.senderId);
  return key && key.identityKey === claim.identityKey ? key : null;
}

/** The `$member` entity the user has in the org, provisioning it if missing. */
async function memberEntityIdFor(
  sql: DbClient,
  user: SessionUser,
  organizationId: string,
  role: string
): Promise<number | null> {
  const existing = (await resolveMemberOrgsForUser(user.id)).find(
    (org) => org.tenantOrganizationId === organizationId
  );
  if (existing) return existing.memberEntityId;
  const [row] = await sql<{ email: string | null; name: string | null }>`
    SELECT email, name FROM "user" WHERE id = ${user.id} LIMIT 1
  `;
  if (!row?.email) return null;
  const { memberEntityId } = await provisionMemberAndCoreIdentities(organizationId, {
    userId: user.id,
    email: row.email,
    name: row.name,
    role,
  });
  return memberEntityId;
}

/**
 * Redeem a link for the signed-in user. The caller has proven the session;
 * this proves membership of the claim's organization and writes the link.
 * With `join`, a non-member of a PUBLIC organization first joins it through
 * the same self-serve path as its public page, so one click both joins and
 * links; a private organization still needs an invitation.
 */
async function redeemChatIdentityLink(token: string, user: SessionUser, join: boolean): Promise<LinkStatus> {
  const sql = getDb();
  const claim = await readChatIdentityLink(token, sql);
  const initialKey = claim ? claimKey(claim) : null;
  if (!claim || !initialKey) return { status: 'invalid' };
  const org = await organizationInfo(sql, claim.organizationId);
  let role = await memberRole(sql, user.id, claim.organizationId);
  let joined = false;
  if (!role && join && org.isPublic && org.slug) {
    // Membership persists independently of the identity-link transaction below.
    if (!(await connectionIsLive(sql, claim))) return { status: 'invalid' };
    const result = await joinPublicOrganization({ userId: user.id, orgSlug: org.slug });
    if (result.status === 'joined' || result.status === 'already_member') {
      role = result.role;
      joined = result.status === 'joined';
    }
  }
  if (!role) return { status: 'not_member', organization: org };
  // Idempotent and outside the transaction: provisioning goes through the
  // entity write path, which owns its own connection.
  const memberEntityId = await memberEntityIdFor(sql, user, claim.organizationId, role);
  if (memberEntityId === null) return { status: 'not_member', organization: org };

  return withChatIdentityLock(initialKey.namespace, initialKey.identityKey, async (tx): Promise<LinkStatus> => {
    const locked = await readChatIdentityLink(token, tx);
    const key = locked ? claimKey(locked) : null;
    if (!locked || !key || locked.organizationId !== claim.organizationId) return { status: 'invalid' };
    if (!(await memberRole(tx, user.id, locked.organizationId))) {
      return { status: 'not_member', organization: org };
    }
    if (!(await connectionIsLive(tx, locked))) return { status: 'invalid' };
    const outcome = await adoptChatIdentityOntoMember(
      tx,
      locked.organizationId,
      memberEntityId,
      key.namespace,
      key.identityKey,
      user.id,
      'link'
    );
    if (outcome === 'conflict') return { status: 'conflict', organization: org, joined };
    await deleteChatIdentityLink(token, tx);
    logger.info(
      { userId: user.id, organizationId: locked.organizationId, platform: locked.platform, outcome },
      'Linked a chat identity from a chat identity link'
    );
    return { status: 'linked', organization: org, joined, claim: locked };
  });
}

/**
 * Tell the chat the link worked, in the conversation it was offered in, through
 * the connection that delivered it. Best-effort and after the link committed:
 * the link stands whether or not this lands, and a crash before it loses only
 * the message. A claim minted without a target has nowhere to confirm.
 */
async function confirmLinkInChat(claim: ChatIdentityLinkClaim, org: OrganizationInfo): Promise<void> {
  const target = claim.replyTarget;
  if (!target) return;
  const manager = getChatInstanceManager();
  if (!manager) {
    logger.warn({ platform: claim.platform }, 'Chat gateway unavailable; skipped the chat link confirmation');
    return;
  }
  await manager.postToConversation(claim.connectionId, {
    platform: claim.platform,
    channelKey: `${claim.platform}:${target.channelId}`,
    channelId: target.channelId,
    threadId: target.threadId,
    content: `You're connected. Messages you send me here now act as you in ${org.name}.`,
  });
}

/** The platform's human name, preferring the org's installed connector definition. */
async function platformName(claim: ChatIdentityLinkClaim): Promise<string> {
  const installed = await getScopedConnectorDefinition({
    organizationId: claim.organizationId,
    connectorKey: claim.platform,
  });
  return connectorDisplayName(claim.platform, installed?.name ?? null);
}

/** The sender's name, or their platform id only when the platform gave no name. */
async function accountsList(claim: ChatIdentityLinkClaim, lobuAccount: string): Promise<string> {
  const sender = escapeHtml(claim.senderDisplayName || claim.senderId);
  return (
    `<dl><div><dt>${escapeHtml(await platformName(claim))} account</dt><dd>${sender}</dd></div>` +
    `<div><dt>Lobu account</dt><dd>${escapeHtml(lobuAccount)}</dd></div></dl>`
  );
}

function linkForm(token: string, join: boolean, label: string): string {
  return (
    `<form method="post"><input type="hidden" name="token" value="${escapeHtml(token)}">` +
    (join ? '<input type="hidden" name="join" value="1">' : '') +
    `<button class="btn" type="submit">${escapeHtml(label)}</button></form>`
  );
}

function sessionAccount(user: SessionUser): string {
  return user.email || user.name || user.id;
}

export function createChatIdentityRoutes(overrides: Partial<ChatIdentityRouteDeps> = {}) {
  const deps: ChatIdentityRouteDeps = { ...DEFAULT_DEPS, ...overrides };
  const routes = new Hono<{ Bindings: Env }>();

  routes.get(PATH, async (c) => {
    c.header('Cache-Control', 'no-store');
    // Keep the token out of Referer without making a form POST's Origin null.
    c.header('Referrer-Policy', 'strict-origin');
    const token = c.req.query('token') ?? '';
    const sql = getDb();
    const claim = await readChatIdentityLink(token, sql);
    if (!claim || !claimKey(claim)) return c.html(INVALID_LINK_PAGE, 410);
    const session = await deps.session(c.req.raw, c.env);
    // Signed out: sign in with the chat platform's own login where it has one,
    // which also proves the chat identity this link is for.
    if (!session?.user) {
      const provider = loginProviderForChatPlatform(claim.platform);
      return c.redirect(loginContinuation(deps.origin(c.req.raw), token, provider), 302);
    }
    const org = await organizationInfo(sql, claim.organizationId);
    const name = `<strong>${escapeHtml(org.name)}</strong>`;
    const lobuAccount = sessionAccount(session.user);
    const isMember = Boolean(await memberRole(sql, session.user.id, claim.organizationId));
    if (!isMember && !org.isPublic) return c.html(notMemberPage(org, lobuAccount, token), 403);
    const accounts = await accountsList(claim, lobuAccount);
    if (!isMember) {
      return c.html(
        renderLobuPage({
          title: 'Join and link your chat account',
          body:
            `<p>You are not a member of ${name} yet. It is a public workspace, so you can join it and link this chat account in one step.</p>` +
            `<p>Direct messages you send the bot will then act as you in ${name}, with member access. Group messages will continue to use only shared workspace access.</p>` +
            accounts +
            linkForm(token, true, 'Join and link') +
            switchAccountForm(token),
        })
      );
    }
    return c.html(
      renderLobuPage({
        title: 'Link your chat account',
        body:
          `<p>Link this chat account to your Lobu account through ${name}. Direct messages you send the bot will then act as you in ${name}. Group messages will continue to use only shared workspace access.</p>` +
          accounts +
          linkForm(token, false, 'Link account') +
          switchAccountForm(token),
      })
    );
  });

  routes.post(PATH, async (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'strict-origin');
    const origin = deps.origin(c.req.raw);
    // A browser form with the session cookie, from this origin only: a foreign
    // page cannot set Origin, and a bearer token is not a person at a browser.
    if (
      c.req.header('authorization') ||
      c.req.header('origin') !== origin ||
      !sessionCookieCandidates(c.req.header('cookie')).length
    )
      return c.json({ error: 'Use the signed-in browser link page.' }, 403);
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const token = typeof body.token === 'string' ? body.token : '';

    if (body.switch_account === '1') {
      // A dead link signs nobody out: there would be nothing to come back to.
      const claim = await readChatIdentityLink(token, getDb());
      if (!claim || !claimKey(claim)) return c.html(INVALID_LINK_PAGE, 410);
      let cookies: string[];
      try {
        cookies = await deps.signOut(c.req.raw, c.env);
      } catch (error) {
        logger.warn({ error }, 'Chat identity link could not sign the browser out to switch accounts');
        return c.html(SWITCH_FAILED_PAGE, 502);
      }
      for (const cookie of cookies) c.header('Set-Cookie', cookie, { append: true });
      return c.redirect(loginContinuation(origin, token), 303);
    }

    const session = await deps.session(c.req.raw, c.env);
    if (!session?.user) return c.redirect(loginContinuation(origin, token), 303);

    const result = await redeemChatIdentityLink(token, session.user, body.join === '1');
    switch (result.status) {
      case 'linked':
        // Not awaited: a connector transport can take a while to send, and the
        // page must not wait on the chat.
        void confirmLinkInChat(result.claim, result.organization).catch((error) =>
          logger.warn(
            { platform: result.claim.platform, error: String(error) },
            'Failed to post the chat link confirmation'
          )
        );
        return c.html(linkedPage(result.organization, result.joined));
      case 'not_member':
        return c.html(notMemberPage(result.organization, sessionAccount(session.user), token), 403);
      case 'conflict':
        return c.html(conflictPage(result.organization, result.joined, token), 409);
      default:
        return c.html(INVALID_LINK_PAGE, 410);
    }
  });

  return routes;
}

export const chatIdentityRoutes = createChatIdentityRoutes();
