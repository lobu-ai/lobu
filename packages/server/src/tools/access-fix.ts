import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { TokenType } from './registry';
import { getOrganizationSlug, getPublicWebUrl } from '../utils/url-builder';
import { isAdminOrOwnerRole } from './access-control';

/**
 * What would lift a denial, recorded where the denial is decided: the throw
 * site knows whether the login lacked a workspace or a scope, while only the
 * MCP boundary knows the caller's client and web origin. The boundary turns a
 * remedy into a {@link AccessFix} the agent can hand to its human.
 */
export type AccessRemedy =
  | { kind: 'grant_workspace'; workspace: string }
  | { kind: 'raise_access'; organizationId: string | null; level: 'read' | 'write' | 'admin' }
  | { kind: 'ask_admin'; organizationId: string | null };

/** The wire shape at `structuredContent.error.fix` (MCP). */
export const AccessFixSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal('grant_workspace'),
      Type.Literal('raise_access'),
      Type.Literal('edit_rule'),
      Type.Literal('edit_allowlist'),
      Type.Literal('ask_admin'),
    ]),
    url: Type.Optional(Type.String()),
    who: Type.Union([Type.Literal('you'), Type.Literal('workspace_admin')]),
    workspace: Type.Union([Type.String(), Type.Null()]),
  },
  { description: 'What would lift this denial and who can do it; `url` opens the page to do it.' }
);

export interface AccessFix {
  action: 'grant_workspace' | 'raise_access' | 'edit_rule' | 'edit_allowlist' | 'ask_admin';
  url?: string;
  who: 'you' | 'workspace_admin';
  workspace: string | null;
}

const REMEDY = Symbol('lobu.accessRemedy');

/** Record what would lift this denial. Returns the same error for `throw`. */
export function withAccessRemedy<E extends Error>(error: E, remedy: AccessRemedy): E {
  Object.defineProperty(error, REMEDY, { value: remedy, enumerable: false });
  return error;
}

export function accessRemedyOf(error: unknown): AccessRemedy | null {
  if (!error || typeof error !== 'object') return null;
  return ((error as Record<symbol, unknown>)[REMEDY] as AccessRemedy | undefined) ?? null;
}

interface FixContext {
  tokenType?: TokenType | null;
  clientId?: string | null;
  requestUrl?: string;
  baseUrl?: string;
}

/**
 * A login fix is a link to this login's page in that workspace, where its
 * owner can widen it in one click. Only an OAuth login can be widened that
 * way: a PAT is fixed by minting a new token, and a web session has no login.
 */
export async function buildAccessFix(remedy: AccessRemedy, ctx: FixContext): Promise<AccessFix | null> {
  // Only reached on a denial, so one slug lookup is fine; a failed lookup
  // costs the link, never the denial.
  const workspace =
    remedy.kind === 'grant_workspace'
      ? remedy.workspace
      : await getOrganizationSlug(remedy.organizationId).catch(() => null);
  if (remedy.kind === 'ask_admin') {
    return { action: 'ask_admin', who: 'workspace_admin', workspace };
  }
  if (!workspace) return null;
  const url = loginGrantUrl(workspace, remedy.kind === 'raise_access' ? remedy.level : null, ctx);
  return url ? { action: remedy.kind, url, who: 'you', workspace } : null;
}

/** This OAuth login's page in a workspace, opened on its grant form. */
export function loginGrantUrl(
  workspace: string,
  level: 'read' | 'write' | 'admin' | null,
  ctx: FixContext
): string | null {
  if (ctx.tokenType !== 'oauth' || !ctx.clientId) return null;
  const origin = getPublicWebUrl(ctx.requestUrl, ctx.baseUrl);
  if (!origin) return null;
  const query = new URLSearchParams({ grant: '1' });
  if (level) query.set('level', level);
  return `${origin}/${encodeURIComponent(workspace)}/agents/connected/${encodeURIComponent(ctx.clientId)}?${query}`;
}

/** The fix on an already-serialized error, when it is one. */
export function accessFixOf(value: unknown): AccessFix | null {
  return Value.Check(AccessFixSchema, value) ? (value as AccessFix) : null;
}

/** The message with the fix's text form, for clients that only show text. */
export function appendAccessFix(message: string, fix: AccessFix | null): string {
  const text = fix ? describeAccessFix(fix) : '';
  if (!text) return message;
  const ended = ['.', '!', '?'].includes(message.trimEnd().slice(-1));
  return `${message.trimEnd()}${ended ? '' : '.'}${text}`;
}

function describeAccessFix(fix: AccessFix): string {
  const where = fix.workspace ? ` in ${fix.workspace}` : '';
  if (fix.action === 'ask_admin') return '';
  if (!fix.url) return '';
  switch (fix.action) {
    case 'grant_workspace':
      return ` Quicker, without reconnecting: open ${fix.url} to allow this app${where}.`;
    case 'raise_access':
      return ` Quicker, without reconnecting: open ${fix.url} to give this app more access${where}.`;
    case 'edit_rule':
      return ` To change the rule${where}, open ${fix.url}`;
    case 'edit_allowlist':
      return ` To change this app's allowed actions${where}, open ${fix.url}`;
  }
}

/**
 * A workspace rule or an allowed-actions list blocked a connector write. Only
 * an owner or admin manages them, so they get a link to the Policies page
 * narrowed to that connection (and the calling app, when there is one); anyone
 * else is told to ask one.
 */
export async function buildPolicyFix(
  input: {
    reason: 'matched_rule' | 'guardrail' | 'allowlist';
    organizationId: string;
    connectionId: number;
    appPrincipalId: string | null;
    memberRole: string | null | undefined;
  },
  ctx: Pick<FixContext, 'requestUrl' | 'baseUrl'>
): Promise<AccessFix> {
  const workspace = await getOrganizationSlug(input.organizationId).catch(() => null);
  const action = input.reason === 'allowlist' ? 'edit_allowlist' : 'edit_rule';
  if (!isAdminOrOwnerRole(input.memberRole)) {
    return { action: 'ask_admin', who: 'workspace_admin', workspace };
  }
  const origin = getPublicWebUrl(ctx.requestUrl, ctx.baseUrl);
  if (!origin || !workspace) return { action, who: 'you', workspace };
  // An allowed-actions list is not a connector rule, so a connection filter
  // would hide it; it is found by its app.
  const query = new URLSearchParams(
    input.reason === 'allowlist' ? {} : { connection: String(input.connectionId) }
  );
  if (input.appPrincipalId) query.set('app', input.appPrincipalId);
  return {
    action,
    url: `${origin}/${encodeURIComponent(workspace)}/settings/policies${query.size > 0 ? `?${query}` : ''}`,
    who: 'you',
    workspace,
  };
}
