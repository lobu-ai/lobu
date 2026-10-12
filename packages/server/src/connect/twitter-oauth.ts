// Connect X still needs account identity for display and reconnect checks when
// sign-in delegates its non-OIDC profile to Better Auth's native adapter.
export const twitterOAuthProvider = {
  authorizationUrl: 'https://x.com/i/oauth2/authorize',
  tokenUrl: 'https://api.x.com/2/oauth2/token',
  userinfoUrl: 'https://api.x.com/2/users/me?user.fields=username',
  tokenEndpointAuthMethod: 'client_secret_basic',
} as const;
