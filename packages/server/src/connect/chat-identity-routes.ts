import { Hono } from 'hono';
import type { Env } from '../index';
import { createAuth } from '../auth';
import { resolveSession, sessionCookieCandidates } from '../auth/resolve-session';
import { resolveBaseUrl } from '../auth/base-url';
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
import { renderOAuthErrorPage } from '../gateway/auth/oauth-templates';
import { escapeHtml } from '../utils/html';
import logger from '../utils/logger';
import { joinPublicOrganization } from '../workspace/join-public';
import { connectPage } from './setup-routes';

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
  | { status: 'linked'; organizationName: string; joined: boolean }
  | { status: 'invalid' }
  | { status: 'not_member'; organizationName: string }
  | { status: 'conflict'; organizationName: string; joined: boolean };

interface SessionUser {
  id: string;
  email?: string | null;
  name?: string | null;
}

interface ChatIdentityRouteDeps {
  session(request: Request, env: Env): Promise<{ user: SessionUser } | null>;
  origin(request: Request): string;
}

const DEFAULT_DEPS: ChatIdentityRouteDeps = {
  session: async (request, env) => resolveSession(await createAuth(env, request), request.headers),
  origin: (request) => resolveBaseUrl({ request }),
};

function loginContinuation(origin: string, token: string): string {
  const callback = new URL(PATH, origin);
  callback.searchParams.set('token', token);
  return `/auth/login?callbackUrl=${encodeURIComponent(callback.toString())}`;
}

function errorPage(code: string, title: string, description: string): string {
  return renderOAuthErrorPage(code, description, {
    title,
    actionUrl: '/',
    actionLabel: 'Return to Lobu',
  });
}

const INVALID_LINK_PAGE = errorPage(
  'chat_identity_link_invalid',
  'Link expired',
  'This link has expired or was already used. Message the bot again in a direct message to get a new one.'
);

function notMemberPage(organizationName: string): string {
  return errorPage(
    'chat_identity_not_member',
    'Not a member yet',
    `Your Lobu account is not a member of ${organizationName}. Ask an admin of ${organizationName} to invite you, then link this chat account again.`
  );
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
  const orgName = org.name;
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
  if (!role) return { status: 'not_member', organizationName: orgName };
  // Idempotent and outside the transaction: provisioning goes through the
  // entity write path, which owns its own connection.
  const memberEntityId = await memberEntityIdFor(sql, user, claim.organizationId, role);
  if (memberEntityId === null) return { status: 'not_member', organizationName: orgName };

  return withChatIdentityLock(initialKey.namespace, initialKey.identityKey, async (tx): Promise<LinkStatus> => {
    const locked = await readChatIdentityLink(token, tx);
    const key = locked ? claimKey(locked) : null;
    if (!locked || !key || locked.organizationId !== claim.organizationId) return { status: 'invalid' };
    if (!(await memberRole(tx, user.id, locked.organizationId))) {
      return { status: 'not_member', organizationName: orgName };
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
    if (outcome === 'conflict') return { status: 'conflict', organizationName: orgName, joined };
    await deleteChatIdentityLink(token, tx);
    logger.info(
      { userId: user.id, organizationId: locked.organizationId, platform: locked.platform, outcome },
      'Linked a chat identity from a chat identity link'
    );
    return { status: 'linked', organizationName: orgName, joined };
  });
}

function chatAccountLabel(claim: ChatIdentityLinkClaim): string {
  const who = claim.senderDisplayName ? `${claim.senderDisplayName} (${claim.senderId})` : claim.senderId;
  return `${claim.platform}: ${who}`;
}

export function createChatIdentityRoutes(deps: ChatIdentityRouteDeps = DEFAULT_DEPS) {
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
    if (!session?.user) return c.redirect(loginContinuation(deps.origin(c.req.raw), token), 302);
    const org = await organizationInfo(sql, claim.organizationId);
    const orgName = org.name;
    const lobuAccount = session.user.email || session.user.name || session.user.id;
    const accounts = `<p>Chat account: <code>${escapeHtml(chatAccountLabel(claim))}</code><br>Lobu account: <code>${escapeHtml(lobuAccount)}</code></p>`;
    if (!(await memberRole(sql, session.user.id, claim.organizationId))) {
      if (!org.isPublic) return c.html(notMemberPage(orgName), 403);
      return c.html(
        connectPage(
          'Join and link your chat account',
          `<p>You are not a member of <strong>${escapeHtml(orgName)}</strong> yet. It is a public workspace, so you can join it as a member and link this chat account in one step. Direct messages you send the bot will then act as you in <strong>${escapeHtml(orgName)}</strong>, with member access. Group messages will continue to use only shared workspace access.</p>` +
            accounts +
            `<form method="post"><input type="hidden" name="token" value="${escapeHtml(token)}"><input type="hidden" name="join" value="1"><button type="submit">Join and link</button></form>` +
            '<p>Not you? Sign in to Lobu with the right account first.</p>'
        )
      );
    }
    return c.html(
      connectPage(
        'Link your chat account',
        `<p>Link this chat account to your Lobu account through <strong>${escapeHtml(orgName)}</strong>. Direct messages you send the bot will then act as you in <strong>${escapeHtml(orgName)}</strong>. Group messages will continue to use only shared workspace access.</p>` +
          accounts +
          `<form method="post"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">Link account</button></form>` +
          '<p>Not you? Sign in to Lobu with the right account first.</p>'
      )
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
    const session = await deps.session(c.req.raw, c.env);
    if (!session?.user) return c.redirect(loginContinuation(origin, token), 303);

    const result = await redeemChatIdentityLink(token, session.user, body.join === '1');
    switch (result.status) {
      case 'linked': {
        const joinedText =
          result.joined
            ? `You joined <strong>${escapeHtml(result.organizationName)}</strong>, and your`
            : 'Your';
        return c.html(
          connectPage(
            'Chat account linked',
            `<p>${joinedText} chat account is linked to your Lobu account in <strong>${escapeHtml(result.organizationName)}</strong>. Message the bot again to continue.</p>`
          )
        );
      }
      case 'not_member':
        return c.html(notMemberPage(result.organizationName), 403);
      case 'conflict':
        return c.html(
          errorPage(
            'chat_identity_conflict',
            'Already linked to someone else',
            (result.joined ? `You joined ${result.organizationName}, but this chat account could not be linked. ` : '') +
              'This chat account is already linked to a different Lobu account. The existing chat account link was not changed. Ask an admin of the workspace to check who it belongs to.'
          ),
          409
        );
      default:
        return c.html(INVALID_LINK_PAGE, 410);
    }
  });

  return routes;
}

export const chatIdentityRoutes = createChatIdentityRoutes();
