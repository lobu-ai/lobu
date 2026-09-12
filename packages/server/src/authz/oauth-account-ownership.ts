/** Personal grants stay with their owner, including when the caller is an admin. */
export function oauthAccountOwnershipError(
  profile: { profile_kind: string; created_by: string | null },
  userId: string | null | undefined,
  connectionOwnerId: string | null | undefined = userId,
): string | null {
  if (profile.profile_kind !== 'oauth_account') return null;
  if (!userId || profile.created_by !== userId || connectionOwnerId !== userId) {
    return 'You can only manage OAuth account profiles you created, on your own connections. Ask the account owner to reconnect.';
  }
  return null;
}
