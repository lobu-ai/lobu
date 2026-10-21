import type { TokenType } from '../tools/registry';

/**
 * Only an OAuth caller's client id belongs in a foreign key to `oauth_clients`.
 * PAT and worker identities (`pat_<id>`, `lobu-worker`) have no registered row.
 * Expects the normalized request/tool token type, not raw AuthInfo.
 */
export function eventClientId(ctx: {
  tokenType?: TokenType | null;
  clientId?: string | null;
}): string | null {
  return ctx.tokenType === 'oauth' ? (ctx.clientId ?? null) : null;
}
