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
