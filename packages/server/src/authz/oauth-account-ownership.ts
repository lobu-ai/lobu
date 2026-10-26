import type { DbClient } from '../db/client';
import { ToolUserError } from '../utils/errors';

export const OAUTH_ACCOUNT_BINDING_ERROR = 'This account is already bound to a different OAuth app or owner. Use your own account profile with its selected app.';

export function oauthAccountAppMismatch(storedAppId: unknown, selectedAppId: number | null): boolean {
  return typeof storedAppId === 'number' && storedAppId !== selectedAppId;
}

/** The grant, profile and connection must agree before either writes or use. */
export function oauthAccountGrantError(
  profile: { created_by: string | null; provider: string | null },
  account: { userId: string | null; providerId: string | null } | undefined,
): 'backing_account_absent' | 'backing_account_owner' | 'backing_account_provider' | null {
  if (!account) return 'backing_account_absent';
  if (!profile.created_by || account.userId !== profile.created_by) return 'backing_account_owner';
  if (!profile.provider || account.providerId?.toLowerCase() !== profile.provider.toLowerCase()) return 'backing_account_provider';
  return null;
}

export async function assertOAuthAccountGrant(
  sql: DbClient,
  profile: { created_by: string | null; provider: string | null; account_id: string | null },
): Promise<void> {
  if (!profile.account_id) return;
  const [account] = await sql<{ userId: string; providerId: string }>`
    SELECT "userId", "providerId" FROM account WHERE id = ${profile.account_id}
  `;
  if (oauthAccountGrantError(profile, account)) {
    throw new ToolUserError('The OAuth grant must belong to the account profile owner and provider. Reconnect using your own account profile.', 409);
  }
}

/** Personal grants stay with their owner, including when the caller is an admin. */
export function oauthAccountOwnershipError(
  profile: { profile_kind: string; created_by: string | null; auth_data?: Record<string, unknown> | null },
  userId: string | null | undefined,
  connectionOwnerId: string | null | undefined = userId,
): string | null {
  const liveBrowser = profile.profile_kind === 'browser_session' && profile.auth_data?.mode === 'live';
  if (profile.profile_kind !== 'oauth_account' && !liveBrowser) return null;
  if (!userId || profile.created_by !== userId || connectionOwnerId !== userId) {
    return liveBrowser
      ? 'You can only manage browser accounts you created, on your own connections. Ask the account owner to reconnect.'
      : 'You can only manage OAuth account profiles you created, on your own connections. Ask the account owner to reconnect.';
  }
  return null;
}
