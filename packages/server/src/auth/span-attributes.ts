import { getCurrentSpan } from '@lobu/core';

// OTel semantic-convention name, as the HTTP span in server-lifecycle.ts sets it.
const USER_ID_ATTRIBUTE = 'user.id';

/**
 * Span attribute names for authentication decisions on the active request
 * span. A rejected bearer returns before the request context names a user, so
 * without these a 401 on `/mcp` cannot be told apart from a client that never
 * called, nor attributed to the OAuth app that sent it. The client id is the
 * OAuth client id, or a PAT's synthetic `pat_<id>`.
 */
export const AUTH_CLIENT_ID_ATTRIBUTE = 'lobu.auth.client_id';
export const AUTH_CLIENT_NAME_ATTRIBUTE = 'lobu.auth.client_name';
export const AUTH_CONSENT_DECISION_ATTRIBUTE = 'lobu.auth.consent_decision';
export const AUTH_REJECT_REASON_ATTRIBUTE = 'lobu.auth.reject_reason';

/** The auth gate branch that refused the request, one value per branch. */
export type AuthRejectReason =
  /** No credential on a request that requires one. */
  | 'missing_token'
  /** The bearer is not a live PAT, OAuth access token, or session token. */
  | 'invalid_token'
  /** The token verified but carries no user. */
  | 'token_missing_user'
  /** A PAT detached from its deleted workspace. */
  | 'pat_unscoped'
  /** An RFC 8707-bound OAuth token presented to a different resource. */
  | 'resource_mismatch'
  /** An OAuth token naming a workspace slug that does not exist. */
  | 'workspace_not_found'
  /** An OAuth token whose immutable grant excludes the target workspace. */
  | 'workspace_not_granted'
  /** A PAT bound to one workspace used on another workspace's route. */
  | 'token_org_mismatch'
  /** The token's user is not a member of the target workspace. */
  | 'not_a_member'
  /** An OAuth token from the retired default-workspace grant model. */
  | 'retired_default_workspace'
  /** An OAuth-initiated MCP session continued without its OAuth bearer. */
  | 'oauth_bearer_required';

type OAuthConsentDecision = 'approve' | 'deny';

/**
 * Tag the request span with why the auth gate refused it, and with the user
 * and client once the token has named them.
 */
export function recordAuthRejection(
  reason: AuthRejectReason,
  token?: { userId: string | null; clientId: string | null } | null
): void {
  const span = getCurrentSpan();
  if (!span) return;
  span.setAttribute(AUTH_REJECT_REASON_ATTRIBUTE, reason);
  if (token?.userId) span.setAttribute(USER_ID_ATTRIBUTE, token.userId);
  if (token?.clientId) span.setAttribute(AUTH_CLIENT_ID_ATTRIBUTE, token.clientId);
}

/** Tag the request span with the OAuth client a consent step concerns. */
export function recordOAuthClient(clientId: string, clientName?: string | null): void {
  const span = getCurrentSpan();
  if (!span) return;
  span.setAttribute(AUTH_CLIENT_ID_ATTRIBUTE, clientId);
  if (clientName) span.setAttribute(AUTH_CLIENT_NAME_ATTRIBUTE, clientName);
}

export function recordOAuthConsentDecision(decision: OAuthConsentDecision): void {
  getCurrentSpan()?.setAttribute(AUTH_CONSENT_DECISION_ATTRIBUTE, decision);
}
