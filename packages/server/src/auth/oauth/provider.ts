/**
 * OAuth 2.1 Server Provider
 *
 * Implements the OAuth 2.1 authorization server for MCP authentication.
 * Supports PKCE, token exchange, and refresh tokens.
 */

import { type DbClient, pgTextArray } from '../../db/client';
import { findExistingPersonalOrg } from '../personal-org-provisioning';
import { PersonalAccessTokenService } from '../tokens';
import { OAuthClientsStore } from './clients';
import {
  DEFAULT_SCOPES_STRING,
  DISCOVERY_SCOPES,
  NON_PUBLIC_OAUTH_SCOPES,
  stripNonPublicOAuthScopes,
} from './scopes';
import {
  listLiveGrantedMemberWorkspaces,
  normalizeStoredGrantedOrganizationIds,
} from './workspace-grants';
import type {
  AuthInfo,
  AuthorizationParams,
  DeviceAuthorizationResponse,
  OAuthClient,
  OAuthTokenResponse,
  StoredAuthorizationCode,
  StoredDeviceCode,
  StoredOAuthToken,
  TokenRequestParams,
} from './types';
import {
  ACCESS_TOKEN_LIFETIME_SECONDS,
  AUTHORIZATION_CODE_LIFETIME_SECONDS,
  calculateExpiry,
  createOAuthError,
  DEVICE_CODE_LIFETIME_SECONDS,
  DEVICE_CODE_POLL_INTERVAL_SECONDS,
  generateAccessToken,
  generateAuthorizationCode,
  generateDeviceCode,
  generateId,
  generateRefreshToken,
  generateUserCode,
  hashToken,
  type OAuthError,
  parseScopes,
  REFRESH_TOKEN_LIFETIME_SECONDS,
  verifyCodeChallenge,
} from './utils';

class OAuthTransactionRollback extends Error {
  constructor(readonly response: OAuthError) {
    super(response.error_description ?? response.error);
    this.name = 'OAuthTransactionRollback';
  }
}

/**
 * OAuth 2.1 Server Provider
 */
export class OAuthProvider {
  public readonly clientsStore: OAuthClientsStore;

  constructor(
    private sql: DbClient,
    private baseUrl: string,
    private multiWorkspaceGrantIssuanceEnabled: boolean = false
  ) {
    this.clientsStore = new OAuthClientsStore(sql);
  }

  // ============================================
  // Authorization Code Flow
  // ============================================

  /**
   * Create an authorization code for a user
   *
   * Called after user authenticates and consents.
   *
   * @param params - Authorization request parameters
   * @param userId - Authenticated user ID
   * @param organizationId - User's active organization
   * @returns Authorization code
   */
  async createAuthorizationCode(
    params: AuthorizationParams,
    userId: string,
    organizationId: string | null,
    grantedOrganizationIds: readonly string[]
  ): Promise<string> {
    const code = generateAuthorizationCode();
    const expiresAt = calculateExpiry(AUTHORIZATION_CODE_LIFETIME_SECONDS);

    await this.sql`
      INSERT INTO oauth_authorization_codes (
        code, client_id, user_id, organization_id, granted_organization_ids,
        code_challenge, code_challenge_method,
        redirect_uri, scope, state, resource, expires_at
      ) VALUES (
        ${code},
        ${params.client_id},
        ${userId},
        ${organizationId},
        ${pgTextArray([...grantedOrganizationIds])}::text[],
        ${params.code_challenge},
        ${params.code_challenge_method},
        ${params.redirect_uri},
        ${params.scope || null},
        ${params.state || null},
        ${params.resource || null},
        ${expiresAt}
      )
    `;

    return code;
  }

  /**
   * Exchange authorization code for tokens
   *
   * Validates PKCE and issues access/refresh tokens.
   */
  async exchangeAuthorizationCode(
    params: TokenRequestParams
  ): Promise<OAuthTokenResponse | OAuthError> {
    if (!params.code || !params.code_verifier) {
      return createOAuthError('invalid_request', 'Missing code or code_verifier');
    }

    const clientValidation = await this.validateClientTokenAuthentication(
      params.client_id,
      params.client_secret
    );
    if ('error' in clientValidation) {
      return clientValidation;
    }
    const client = clientValidation;
    if (!client.grant_types?.includes('authorization_code')) {
      return createOAuthError('unauthorized_client', 'Client does not support authorization_code');
    }

    // Atomically fetch and mark code as used to prevent replay attacks
    const codeResult = await this.sql`
      UPDATE oauth_authorization_codes
      SET used_at = NOW()
      WHERE code = ${params.code}
        AND expires_at > NOW()
        AND used_at IS NULL
        AND (resource IS NULL OR resource = ${params.resource || null})
      RETURNING *
    `;

    if (codeResult.length === 0) {
      return createOAuthError('invalid_grant', 'Invalid or expired authorization code');
    }

    const authCode = codeResult[0] as StoredAuthorizationCode;

    // Validate client_id matches
    if (authCode.client_id !== params.client_id) {
      return createOAuthError('invalid_grant', 'Client ID mismatch');
    }

    // Validate redirect_uri matches (RFC 6749 Section 4.1.3)
    if (authCode.redirect_uri !== params.redirect_uri) {
      return createOAuthError('invalid_grant', 'Redirect URI mismatch');
    }

    // Validate PKCE code_verifier
    if (
      !verifyCodeChallenge(
        params.code_verifier,
        authCode.code_challenge,
        authCode.code_challenge_method as 'S256' | 'plain'
      )
    ) {
      return createOAuthError('invalid_grant', 'Invalid code_verifier');
    }

    // Defense in depth for authorization codes minted before consent started
    // stripping device-flow-only scopes. Auth-code clients must never receive
    // device or managed-connector credentials, even across a rolling deploy.
    const authorizedScope = stripNonPublicOAuthScopes(
      authCode.scope === null ? DEFAULT_SCOPES_STRING : authCode.scope
    );
    if (!authorizedScope) {
      return createOAuthError('invalid_scope', 'Authorization code has no public scopes');
    }

    // Re-read and lock the claimed code while its tokens are inserted. A
    // connected-app workspace revoke may delete a bound code or narrow a
    // secondary grant after the initial claim; using the live row here makes
    // revoke and exchange serialize without resurrecting stale grants.
    return this.sql.begin(async (tx) => {
      await tx`
        SELECT id FROM oauth_clients WHERE id = ${authCode.client_id} FOR UPDATE
      `;
      const liveCodeRows = await tx`
        SELECT organization_id, granted_organization_ids
        FROM oauth_authorization_codes
        WHERE code = ${authCode.code}
          AND used_at IS NOT NULL
        FOR UPDATE
      `;
      if (liveCodeRows.length === 0) {
        return createOAuthError('invalid_grant', 'Invalid or expired authorization code');
      }
      const liveCode = liveCodeRows[0] as Pick<
        StoredAuthorizationCode,
        'organization_id' | 'granted_organization_ids'
      >;
      return this.issueTokens(
        authCode.client_id,
        authCode.user_id,
        authCode.organization_id,
        authorizedScope,
        authCode.resource,
        'authorization_code',
        normalizeStoredGrantedOrganizationIds(
          liveCode.granted_organization_ids
        ),
        tx
      );
    });
  }

  /**
   * Refresh access token (with token rotation)
   *
   * Implements refresh token rotation for security:
   * - Old refresh token is revoked after use
   * - New refresh token is issued with each refresh
   * - Prevents token replay attacks
   */
  async refreshAccessToken(params: TokenRequestParams): Promise<OAuthTokenResponse | OAuthError> {
    if (!params.refresh_token) {
      return createOAuthError('invalid_request', 'Missing refresh_token');
    }

    const clientValidation = await this.validateClientTokenAuthentication(
      params.client_id,
      params.client_secret
    );
    if ('error' in clientValidation) {
      return clientValidation;
    }
    const client = clientValidation;
    if (!client.grant_types?.includes('refresh_token')) {
      return createOAuthError('unauthorized_client', 'Client does not support refresh_token');
    }

    const tokenHash = hashToken(params.refresh_token);

    // Fetch and validate refresh token
    const tokenResult = await this.sql`
      SELECT * FROM oauth_tokens
      WHERE token_hash = ${tokenHash}
        AND token_type = 'refresh'
        AND revoked_at IS NULL
        AND expires_at > NOW()
    `;

    if (tokenResult.length === 0) {
      return createOAuthError('invalid_grant', 'Invalid or expired refresh token');
    }

    const oldRefreshToken = tokenResult[0] as StoredOAuthToken;
    if (
      normalizeStoredGrantedOrganizationIds(
        oldRefreshToken.granted_organization_ids
      ).length > 1 &&
      !this.multiWorkspaceGrantIssuanceEnabled
    ) {
      return createOAuthError('invalid_grant', 'Multiple-workspace authorization is not enabled');
    }

    // Rows created before grant provenance was persisted are safe for ordinary
    // OAuth scopes, but a legacy token carrying a device-flow-only scope could
    // have originated from the old auth-code leak. Fail closed and require a
    // fresh device authorization rather than guessing its provenance.
    const originalScopes = parseScopes(oldRefreshToken.scope);
    const hasNonPublicScope = originalScopes.some((scope) =>
      (NON_PUBLIC_OAUTH_SCOPES as readonly string[]).includes(scope)
    );
    if (hasNonPublicScope && oldRefreshToken.authorization_grant_type !== 'device_code') {
      return createOAuthError('invalid_grant', 'Re-authorization required');
    }

    // Validate client_id matches
    if (oldRefreshToken.client_id !== params.client_id) {
      return createOAuthError('invalid_grant', 'Client ID mismatch');
    }

    if (oldRefreshToken.resource && params.resource !== oldRefreshToken.resource) {
      return createOAuthError('invalid_grant', 'Refresh request resource must match the original resource');
    }

    const resource = oldRefreshToken.resource || params.resource || null;
    // Use requested scope only if it is a subset of the original grant.
    let scope = oldRefreshToken.scope;
    if (params.scope !== undefined) {
      if (params.scope.trim().length === 0) {
        return createOAuthError('invalid_scope', 'Requested scope must not be empty');
      }
      const requestedScopesRaw = params.scope.split(' ').filter(Boolean);
      const requestedScopes = parseScopes(params.scope);
      if (requestedScopesRaw.length !== requestedScopes.length) {
        return createOAuthError('invalid_scope', 'Requested scope contains unsupported values');
      }
      const originalScopeSet = new Set(originalScopes);
      const isSubset = requestedScopes.every((requestedScope) =>
        originalScopeSet.has(requestedScope)
      );
      if (!isSubset) {
        return createOAuthError(
          'invalid_scope',
          'Requested scope exceeds originally granted scope'
        );
      }
      scope = requestedScopes.join(' ');
    }

    // Generate new tokens
    const accessToken = generateAccessToken();
    const newRefreshToken = generateRefreshToken();
    const accessTokenId = generateId();
    const refreshTokenId = generateId();
    const accessExpiresAt = calculateExpiry(ACCESS_TOKEN_LIFETIME_SECONDS);
    const refreshExpiresAt = calculateExpiry(REFRESH_TOKEN_LIFETIME_SECONDS);

    // Revoke old refresh token and issue new tokens atomically
    const rotated = await this.sql.begin(async (tx) => {
      // Registration-row mutex shared with connected-app revoke and every
      // token-issuing grant path. Waiting here completes before the token claim
      // starts, so all later statements observe the revoke's committed grant.
      await tx`
        SELECT id FROM oauth_clients WHERE id = ${oldRefreshToken.client_id} FOR UPDATE
      `;
      // Claim the live refresh row inside the same transaction that mints its
      // children. This serializes with grant removal/revocation and prevents a
      // stale pre-transaction snapshot from resurrecting removed workspaces.
      const claimed = await tx`
        UPDATE oauth_tokens
        SET revoked_at = NOW()
        WHERE id = ${oldRefreshToken.id}
          AND revoked_at IS NULL
          AND expires_at > NOW()
        RETURNING granted_organization_ids, organization_id, authorization_grant_type
      `;
      if (claimed.length === 0) return false;
      const liveRefreshToken = claimed[0] as Pick<
        StoredOAuthToken,
        'granted_organization_ids' | 'organization_id' | 'authorization_grant_type'
      >;
      const grantedOrganizationIds = normalizeStoredGrantedOrganizationIds(
        liveRefreshToken.granted_organization_ids
      );

      await tx`
        INSERT INTO oauth_tokens (
          id, token_type, token_hash,
          client_id, user_id, organization_id, granted_organization_ids,
          authorization_grant_type, scope, resource, parent_token_id, expires_at
        ) VALUES
          (${accessTokenId}, 'access', ${hashToken(accessToken)},
           ${oldRefreshToken.client_id}, ${oldRefreshToken.user_id}, ${oldRefreshToken.organization_id},
           ${pgTextArray(grantedOrganizationIds)}::text[],
           ${liveRefreshToken.authorization_grant_type},
           ${scope}, ${resource}, ${refreshTokenId}, ${accessExpiresAt}),
          (${refreshTokenId}, 'refresh', ${hashToken(newRefreshToken)},
           ${oldRefreshToken.client_id}, ${oldRefreshToken.user_id}, ${oldRefreshToken.organization_id},
           ${pgTextArray(grantedOrganizationIds)}::text[],
           ${liveRefreshToken.authorization_grant_type},
           ${scope}, ${resource}, ${oldRefreshToken.id}, ${refreshExpiresAt})
      `;
      return true;
    });

    if (!rotated) {
      return createOAuthError('invalid_grant', 'Invalid or expired refresh token');
    }

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
      refresh_token: newRefreshToken,
      scope: scope || undefined,
      ...(resource ? { resource } : {}),
    };
  }

  /**
   * Issue new access and refresh tokens
   */
  private async issueTokens(
    clientId: string,
    userId: string,
    organizationId: string | null,
    scope: string | null,
    resource: string | null,
    authorizationGrantType: 'authorization_code' | 'device_code',
    grantedOrganizationIds: readonly string[],
    sql: DbClient = this.sql
  ): Promise<OAuthTokenResponse | OAuthError> {
    if (grantedOrganizationIds.length > 1 && !this.multiWorkspaceGrantIssuanceEnabled) {
      return createOAuthError('invalid_grant', 'Multiple-workspace authorization is not enabled');
    }
    const accessToken = generateAccessToken();
    const refreshToken = generateRefreshToken();

    const accessTokenId = generateId();
    const refreshTokenId = generateId();

    const accessExpiresAt = calculateExpiry(ACCESS_TOKEN_LIFETIME_SECONDS);
    const refreshExpiresAt = calculateExpiry(REFRESH_TOKEN_LIFETIME_SECONDS);

    // Insert both tokens
    await sql`
      INSERT INTO oauth_tokens (
        id, token_type, token_hash,
        client_id, user_id, organization_id, granted_organization_ids,
        authorization_grant_type, scope, resource, expires_at
      ) VALUES
        (${accessTokenId}, 'access', ${hashToken(accessToken)},
         ${clientId}, ${userId}, ${organizationId},
         ${pgTextArray([...grantedOrganizationIds])}::text[],
         ${authorizationGrantType}, ${scope}, ${resource}, ${accessExpiresAt}),
        (${refreshTokenId}, 'refresh', ${hashToken(refreshToken)},
         ${clientId}, ${userId}, ${organizationId},
         ${pgTextArray([...grantedOrganizationIds])}::text[],
         ${authorizationGrantType}, ${scope}, ${resource}, ${refreshExpiresAt})
    `;

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
      refresh_token: refreshToken,
      scope: scope || undefined,
      // RFC 8707: echo the authorized resource so MCP clients can confirm the
      // audience matches the protected resource they started from.
      ...(resource ? { resource } : {}),
    };
  }

  private async validateClientTokenAuthentication(
    clientId: string,
    clientSecret: string | undefined
  ): Promise<OAuthClient | OAuthError> {
    const client = await this.clientsStore.getClient(clientId);
    if (!client) {
      return createOAuthError('invalid_client', 'Unknown client_id');
    }

    const authMethod = client.token_endpoint_auth_method ?? 'none';
    const requiresSecret =
      authMethod === 'client_secret_post' || authMethod === 'client_secret_basic';

    if (requiresSecret && !clientSecret) {
      return createOAuthError('invalid_client', 'client_secret is required for this client');
    }

    // Public clients (token_endpoint_auth_method: none) authenticate with PKCE,
    // not a secret — per OAuth 2.1 §2.2/§9.4. Some clients (e.g. Slack's MCP
    // client) still echo back a client_secret they were issued at registration;
    // ignore it for public clients rather than verifying, since PKCE is the
    // binding. Only confidential clients (client_secret_* auth) verify a secret.
    if (requiresSecret && clientSecret !== undefined) {
      const isValid = await this.clientsStore.verifyClientCredentials(clientId, clientSecret);
      if (!isValid) {
        return createOAuthError('invalid_client', 'Invalid client credentials');
      }
    }

    return client;
  }

  // ============================================
  // Token Verification
  // ============================================

  /**
   * Verify an access token and return auth info.
   *
   * Accepts both OAuth 2.1 access tokens (`oauth_tokens` rows) and Personal
   * Access Tokens (`personal_access_tokens` rows, prefix `owl_pat_`). The
   * `/oauth/userinfo` route delegates here, so making PATs work for OAuth
   * introspection lets a single bearer token authenticate against
   * `/oauth/userinfo`, `/api/<orgSlug>/*`, the gateway's `/lobu/api/v1/*`
   * via `createApiAuthMiddleware`, and the CLI's `lobu apply`
   * org-resolution call. Without this, `lobu chat -c local` against the
   * embedded server fails with a 404/401 even after a successful
   * `/api/local-init` because the gateway can't introspect the PAT.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo | null> {
    if (token.startsWith('owl_pat_')) {
      return new PersonalAccessTokenService(this.sql).verify(token);
    }
    const tokenHash = hashToken(token);

    const result = await this.sql`
      SELECT t.*, u.email, u.name as user_name
      FROM oauth_tokens t
      JOIN "user" u ON t.user_id = u.id
      WHERE t.token_hash = ${tokenHash}
        AND t.token_type = 'access'
        AND t.revoked_at IS NULL
        AND t.expires_at > NOW()
    `;

    if (result.length === 0) return null;

    const tokenData = result[0] as StoredOAuthToken & {
      email: string;
      user_name: string;
    };

    const scopes = parseScopes(tokenData.scope);
    const hasNonPublicScope = scopes.some((scope) =>
      (NON_PUBLIC_OAUTH_SCOPES as readonly string[]).includes(scope)
    );
    if (hasNonPublicScope && tokenData.authorization_grant_type !== 'device_code') {
      return null;
    }

    return {
      userId: tokenData.user_id,
      organizationId: tokenData.organization_id,
      grantedOrganizationIds: normalizeStoredGrantedOrganizationIds(
        tokenData.granted_organization_ids
      ),
      authorizationGrantType: tokenData.authorization_grant_type,
      clientId: tokenData.client_id,
      scopes,
      expiresAt: Math.floor(new Date(tokenData.expires_at).getTime() / 1000),
      resource: tokenData.resource || undefined,
      tokenType: 'access_token',
    };
  }

  // ============================================
  // User Info
  // ============================================

  /**
   * Get user info for a verified access token
   * Requires profile:read scope
   */
  async getUserInfo(token: string): Promise<{
    sub: string;
    email: string;
    name: string | null;
    picture: string | null;
    organization_slug: string | null;
    /**
     * The user's personal-org slug (the org marked
     * `metadata.personal_org_for_user_id`). Device clients (Owletto Mac +
     * Chrome) bind here regardless of the active/selected org, so the menubar
     * and device-data uploads always land in the user's private workspace.
     * Null only when provisioning hasn't completed.
     */
    personal_org_slug: string | null;
    organizations: {
      id: string;
      slug: string;
      name: string;
      /** True for the user's personal org (matches {@link personal_org_slug}). */
      personal: boolean;
    }[];
  } | null> {
    const authInfo = await this.verifyAccessToken(token);
    if (!authInfo) return null;

    if (!authInfo.scopes.includes('profile:read')) {
      return null;
    }

    const result = await this.sql`
      SELECT id, email, name, image FROM "user" WHERE id = ${authInfo.userId}
    `;

    if (result.length === 0) return null;

    // Resolve the user's personal org once. Two consumers need it:
    //   - `organization_slug` falls back to it for tokens with no org binding
    //     (e.g. `device_worker:run` issued via the device-flow consent, which
    //     historically skipped org resolution) — matching where the worker
    //     upload path actually delivers data (see worker-api.ts:184).
    //   - `personal_org_slug` is exposed so device clients (Owletto Mac +
    //     Chrome) can target the personal workspace directly, independent of
    //     whatever org the token is bound to or the CLI has selected as active.
    const personalOrg = await findExistingPersonalOrg(authInfo.userId, this.sql);

    // Return the token-bound org (if any). For tokens with no org binding, fall
    // back to the personal org.
    let organizationSlug: string | null = null;
    if (authInfo.organizationId) {
      const orgResult = await this.sql`
        SELECT slug FROM "organization" WHERE id = ${authInfo.organizationId} LIMIT 1
      `;
      organizationSlug = (orgResult[0]?.slug as string) ?? null;
    } else {
      organizationSlug = personalOrg?.slug ?? null;
    }

    // Any token carrying MCP capabilities OR a nonempty workspace snapshot is
    // limited to that snapshot. Refresh downscoping may remove every `mcp:*`
    // scope while retaining the original workspace consent; it must not turn a
    // selected-workspace token into a full membership-directory credential.
    // Initial profile-only grants intentionally store an empty snapshot and
    // keep their existing account-inventory semantics.
    const hasMcpCapability = authInfo.scopes.some((scope) => scope.startsWith('mcp:'));
    const hasWorkspaceGrant = (authInfo.grantedOrganizationIds?.length ?? 0) > 0;
    const restrictOrganizationInventory = hasMcpCapability || hasWorkspaceGrant;
    const grantedOrgs = restrictOrganizationInventory
      ? await listLiveGrantedMemberWorkspaces({
          sql: this.sql,
          userId: authInfo.userId,
          grantedOrganizationIds: authInfo.grantedOrganizationIds ?? [],
        })
      : null;
    const orgs = grantedOrgs ?? await this.sql`
      SELECT o.id, o.slug, o.name
      FROM "member" m
      JOIN "organization" o ON o.id = m."organizationId"
      WHERE m."userId" = ${authInfo.userId}
      ORDER BY o.name ASC
    `;

    const user = result[0] as {
      id: string;
      email: string;
      name: string | null;
      image: string | null;
    };
    const personalOrgId = personalOrg?.id ?? null;
    return {
      sub: user.id,
      email: user.email,
      name: user.name,
      picture: user.image,
      organization_slug: organizationSlug,
      personal_org_slug:
        !restrictOrganizationInventory || grantedOrgs?.some((org) => org.id === personalOrgId)
          ? (personalOrg?.slug ?? null)
          : null,
      organizations: orgs.map((o) => ({
        id: o.id as string,
        slug: o.slug as string,
        name: o.name as string,
        personal: personalOrgId !== null && o.id === personalOrgId,
      })),
    };
  }

  // ============================================
  // Token Revocation
  // ============================================

  /**
   * Revoke a token
   */
  async revokeToken(token: string, clientId: string): Promise<boolean> {
    const tokenHash = hashToken(token);

    const result = await this.sql`
      UPDATE oauth_tokens
      SET revoked_at = NOW()
      WHERE token_hash = ${tokenHash}
        AND client_id = ${clientId}
        AND revoked_at IS NULL
      RETURNING id
    `;

    return result.length > 0;
  }

  /**
   * Revoke all tokens for a user
   */
  async revokeAllUserTokens(userId: string): Promise<number> {
    const result = await this.sql`
      UPDATE oauth_tokens
      SET revoked_at = NOW()
      WHERE user_id = ${userId}
        AND revoked_at IS NULL
      RETURNING id
    `;

    return result.length;
  }

  // ============================================
  // Client Validation
  // ============================================

  /**
   * Get and validate a client for authorization
   */
  async getClientForAuthorization(
    clientId: string,
    redirectUri: string
  ): Promise<OAuthClient | OAuthError> {
    const client = await this.clientsStore.getClient(clientId);

    if (!client) {
      return createOAuthError('invalid_client', 'Unknown client');
    }

    // Validate redirect_uri
    if (!client.redirect_uris.includes(redirectUri)) {
      return createOAuthError('invalid_request', 'Redirect URI not registered for this client');
    }

    // Validate grant type
    if (!client.grant_types?.includes('authorization_code')) {
      return createOAuthError(
        'unauthorized_client',
        'Client not authorized for authorization_code grant'
      );
    }

    return client;
  }

  // ============================================
  // Device Authorization Grant (RFC 8628)
  // ============================================

  /**
   * Create a device authorization request
   *
   * Returns device_code and user_code for the device flow.
   */
  async createDeviceAuthorization(
    clientId: string,
    scope: string | null,
    resource: string | null
  ): Promise<DeviceAuthorizationResponse | OAuthError> {
    const client = await this.clientsStore.getClient(clientId);
    if (!client) {
      return createOAuthError('invalid_client', 'Unknown client_id');
    }

    if (!client.grant_types?.includes('urn:ietf:params:oauth:grant-type:device_code')) {
      return createOAuthError('unauthorized_client', 'Client does not support device_code grant');
    }

    const deviceCode = generateDeviceCode();
    const userCode = generateUserCode();
    const expiresAt = calculateExpiry(DEVICE_CODE_LIFETIME_SECONDS);

    await this.sql`
      INSERT INTO oauth_device_codes (
        device_code, user_code, client_id,
        scope, resource, status, poll_interval, expires_at
      ) VALUES (
        ${deviceCode},
        ${userCode},
        ${clientId},
        ${scope},
        ${resource},
        'pending',
        ${DEVICE_CODE_POLL_INTERVAL_SECONDS},
        ${expiresAt}
      )
    `;

    const verificationUri = `${this.baseUrl}/oauth/device`;

    return {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${userCode}`,
      expires_in: DEVICE_CODE_LIFETIME_SECONDS,
      interval: DEVICE_CODE_POLL_INTERVAL_SECONDS,
    };
  }

  /**
   * Approve a device code (called after user authenticates and consents).
   *
   * `scopeOverride` lets the consent layer narrow the granted scope based on
   * the user's role (e.g. drop `mcp:admin` for non-admin members) before the
   * device code is exchanged for tokens.
   */
  async approveDeviceCode(
    userCode: string,
    userId: string,
    organizationId: string | null,
    scopeOverride: string | null | undefined,
    grantedOrganizationIds: readonly string[]
  ): Promise<boolean> {
    if (scopeOverride !== undefined) {
      const result = await this.sql`
        UPDATE oauth_device_codes
        SET status = 'approved',
            organization_id = ${organizationId},
            granted_organization_ids = ${pgTextArray([...grantedOrganizationIds])}::text[],
            scope = ${scopeOverride}
        WHERE user_code = ${userCode}
          AND user_id = ${userId}
          AND status = 'pending'
          AND expires_at > NOW()
        RETURNING device_code
      `;
      return result.length > 0;
    }
    const result = await this.sql`
      UPDATE oauth_device_codes
      SET status = 'approved',
          organization_id = ${organizationId},
          granted_organization_ids = ${pgTextArray([...grantedOrganizationIds])}::text[]
      WHERE user_code = ${userCode}
        AND user_id = ${userId}
        AND status = 'pending'
        AND expires_at > NOW()
      RETURNING device_code
    `;
    return result.length > 0;
  }

  /**
   * Deny a device code owned by the authenticated verifier.
   */
  async denyDeviceCode(userCode: string, userId: string): Promise<boolean> {
    const result = await this.sql`
      UPDATE oauth_device_codes
      SET status = 'denied'
      WHERE user_code = ${userCode}
        AND user_id = ${userId}
        AND status = 'pending'
        AND expires_at > NOW()
      RETURNING device_code
    `;
    return result.length > 0;
  }

  /**
   * Validate an unclaimed pending code before sending its consent email.
   *
   * Unauthenticated, so it must not confirm a code another user already owns:
   * once claimed, the email path reports the same miss as an unknown code.
   */
  async isUnclaimedDeviceCodePending(userCode: string): Promise<boolean> {
    const result = await this.sql`
      SELECT 1 FROM oauth_device_codes
      WHERE user_code = ${userCode}
        AND user_id IS NULL
        AND status = 'pending'
        AND expires_at > NOW()
    `;
    return result.length > 0;
  }

  /**
   * Atomically bind an unclaimed pending code to the authenticated verifier.
   *
   * Repeated verification by the same user is idempotent. Every other user
   * observes the same miss as an unknown or expired code.
   */
  async claimDeviceCodeForUser(
    userCode: string,
    userId: string
  ): Promise<StoredDeviceCode | null> {
    const result = await this.sql`
      UPDATE oauth_device_codes
      SET user_id = ${userId}
      WHERE user_code = ${userCode}
        AND (user_id IS NULL OR user_id = ${userId})
        AND status = 'pending'
        AND expires_at > NOW()
      RETURNING *
    `;
    if (result.length === 0) return null;
    return result[0] as StoredDeviceCode;
  }

  /**
   * Read a pending code only when it belongs to the authenticated verifier.
   */
  async getDeviceCodeForUser(
    userCode: string,
    userId: string
  ): Promise<StoredDeviceCode | null> {
    const result = await this.sql`
      SELECT * FROM oauth_device_codes
      WHERE user_code = ${userCode}
        AND user_id = ${userId}
        AND status = 'pending'
        AND expires_at > NOW()
    `;
    if (result.length === 0) return null;
    return result[0] as StoredDeviceCode;
  }

  /**
   * Exchange device code for tokens (polling endpoint)
   *
   * Returns tokens if approved, or appropriate error for pending/denied/expired.
   */
  async exchangeDeviceCode(params: TokenRequestParams): Promise<OAuthTokenResponse | OAuthError> {
    if (!params.device_code) {
      return createOAuthError('invalid_request', 'Missing device_code');
    }

    const clientValidation = await this.validateClientTokenAuthentication(
      params.client_id,
      params.client_secret
    );
    if ('error' in clientValidation) {
      return clientValidation;
    }

    // Atomically claim approved device codes to prevent TOCTOU race conditions.
    // DELETE...RETURNING ensures only one concurrent request can consume the code.
    // Returning an OAuth error from a postgres.js transaction would commit the
    // DELETE, so throw expected errors and translate them back after rollback.
    let approvedExchange: OAuthTokenResponse | null;
    try {
      approvedExchange = await this.sql.begin(async (tx) => {
        await tx`
          SELECT id FROM oauth_clients WHERE id = ${params.client_id} FOR UPDATE
        `;
        const approved = await tx`
          DELETE FROM oauth_device_codes
          WHERE device_code = ${params.device_code}
            AND client_id = ${params.client_id}
            AND status = 'approved'
            AND (resource IS NULL OR resource = ${params.resource || null})
            AND expires_at > NOW()
          RETURNING *
        `;

        if (approved.length === 0) return null;
        const deviceCode = approved[0] as StoredDeviceCode;
        if (!deviceCode.user_id) {
          throw new OAuthTransactionRollback(
            createOAuthError('server_error', 'Approved device code missing user_id')
          );
        }
        const issued = await this.issueTokens(
          deviceCode.client_id,
          deviceCode.user_id,
          deviceCode.organization_id,
          deviceCode.scope,
          deviceCode.resource,
          'device_code',
          normalizeStoredGrantedOrganizationIds(
            deviceCode.granted_organization_ids
          ),
          tx
        );
        if ('error' in issued) {
          throw new OAuthTransactionRollback(issued);
        }
        return issued;
      });
    } catch (error) {
      if (error instanceof OAuthTransactionRollback) {
        return error.response;
      }
      throw error;
    }

    if (approvedExchange) return approvedExchange;

    // Atomic claim returned nothing — check why (pending, denied, expired, or unknown)
    const result = await this.sql`
      SELECT status, client_id, expires_at, resource FROM oauth_device_codes
      WHERE device_code = ${params.device_code}
    `;

    if (result.length === 0) {
      return createOAuthError('invalid_grant', 'Unknown device_code');
    }

    const deviceCode = result[0] as Pick<StoredDeviceCode, 'status' | 'client_id' | 'expires_at' | 'resource'>;

    if (deviceCode.client_id !== params.client_id) {
      return createOAuthError('invalid_grant', 'Client ID mismatch');
    }

    if (deviceCode.resource && params.resource !== deviceCode.resource) {
      return createOAuthError('invalid_grant', 'Token request resource must match the device authorization resource');
    }

    if (new Date(deviceCode.expires_at) <= new Date()) {
      return createOAuthError('expired_token', 'Device code has expired');
    }

    switch (deviceCode.status) {
      case 'pending':
        return createOAuthError('authorization_pending', 'User has not yet authorized');
      case 'denied':
        return createOAuthError('access_denied', 'User denied the authorization request');
      default:
        return createOAuthError('server_error', 'Unexpected device code status');
    }
  }

  // ============================================
  // Metadata
  // ============================================

  /**
   * Get Authorization Server Metadata (RFC 8414)
   */
  getAuthorizationServerMetadata() {
    return {
      issuer: this.baseUrl,
      authorization_endpoint: `${this.baseUrl}/oauth/authorize`,
      token_endpoint: `${this.baseUrl}/oauth/token`,
      registration_endpoint: `${this.baseUrl}/oauth/register`,
      revocation_endpoint: `${this.baseUrl}/oauth/revoke`,
      // Only scopes grantable to third-party auth-code MCP clients. Device-
      // only scopes stay off discovery so clients like Slack do not request
      // them (they often ask for every entry in scopes_supported).
      scopes_supported: [...DISCOVERY_SCOPES],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      device_authorization_endpoint: `${this.baseUrl}/oauth/device_authorization`,
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:device_code',
      ],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      code_challenge_methods_supported: ['S256'],
      userinfo_endpoint: `${this.baseUrl}/oauth/userinfo`,
      service_documentation: `${this.baseUrl}/docs`,
      // auth.md agent-registration discovery. We support the "user_claimed"
      // flow only: the agent supplies an email and the user confirms via a
      // magic link. The ID-JAG "agent_verified" zero-touch flow is not offered
      // yet, so it is intentionally absent from flows_supported. The human/
      // agent-readable walkthrough is the auth.md file linked below.
      agent_auth: {
        flows_supported: ['user_claimed'],
        claim_methods_supported: ['email'],
        registration_endpoint: `${this.baseUrl}/oauth/register`,
        device_authorization_endpoint: `${this.baseUrl}/oauth/device_authorization`,
        claim_email_endpoint: `${this.baseUrl}/oauth/device/email`,
        token_endpoint: `${this.baseUrl}/oauth/token`,
        auth_md: `${this.baseUrl}/auth.md`,
      },
    };
  }

  /**
   * Get Protected Resource Metadata (RFC 9728)
   */
  getProtectedResourceMetadata() {
    return {
      resource: `${this.baseUrl}/mcp`,
      authorization_servers: [this.baseUrl],
      scopes_supported: [...DISCOVERY_SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'Lobu',
      resource_documentation: `${this.baseUrl}/docs`,
      // Pointer to the auth.md agent-registration walkthrough (RFC 9728 allows
      // extra members). Agents that hit a 401 here can follow this to learn how
      // to register on a user's behalf.
      auth_md: `${this.baseUrl}/auth.md`,
    };
  }
}
