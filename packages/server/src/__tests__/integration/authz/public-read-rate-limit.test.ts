/**
 * Integration test: a signed-in user reading a public workspace they are not a
 * member of (over MCP, the only route open to them) is metered per account at
 * 300/min and refused with RATE_LIMITED past it. Members and callers without a
 * user are not metered.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AuthContext, checkToolAccess } from '../../../tools/execute';
import {
  getRateLimiter,
  RateLimitPresets,
  resetRateLimiterForTests,
} from '../../../utils/rate-limiter';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { mcpToolsCall } from '../../setup/test-helpers';

describe('public read rate limit', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let outsider: Awaited<ReturnType<typeof createTestUser>>;
  let token: string;

  const callerIn = (overrides: Partial<AuthContext>): AuthContext =>
    ({
      organizationId: org.id,
      tokenOrganizationId: null,
      userId: outsider.id,
      memberRole: null,
      agentId: null,
      requestedAgentId: null,
      isAuthenticated: true,
      clientId: null,
      scopes: ['mcp:read'],
      tokenType: 'oauth',
      requestUrl: `http://localhost/mcp/${org.slug}`,
      baseUrl: 'http://localhost',
      scopedToOrg: true,
      allowCrossOrg: false,
      grantedOrganizationIds: null,
      directSearchFederation: false,
      ...overrides,
    }) as AuthContext;

  const readTimes = (ctx: AuthContext, n: number) => {
    for (let i = 0; i < n; i++) checkToolAccess('search_memory', { query: 'rents' }, ctx);
  };

  const exhaust = (userId: string) => {
    for (let i = 0; i < RateLimitPresets.PUBLIC_READ_PER_USER_MINUTE.limit; i++) {
      getRateLimiter().checkLimit(`rate:public-read:user:${userId}`, RateLimitPresets.PUBLIC_READ_PER_USER_MINUTE);
    }
  };

  const search = () =>
    mcpToolsCall('search_memory', { query: 'rents' }, { token, orgSlug: org.slug });

  beforeAll(async () => {
    await cleanupTestDatabase();
    org = await createTestOrganization({ name: 'Rate Limited Public Org', visibility: 'public' });
    outsider = await createTestUser({ email: 'rate-limit-outsider@example.com' });
    const client = await createTestOAuthClient();
    token = (
      await createTestAccessToken(outsider.id, org.id, client.client_id, {
        scope: 'mcp:read',
        grantedOrganizationIds: [org.id],
      })
    ).token;
  });

  afterAll(() => resetRateLimiterForTests());
  beforeEach(() => resetRateLimiterForTests());

  it('refuses a signed-in non-member over MCP once the account is over 300/min', async () => {
    await expect(search()).resolves.toBeDefined();
    exhaust(outsider.id);
    await expect(search()).rejects.toThrow(/Public read limit reached: 300 requests per minute\. Join the workspace to lift it\. Try again in \d+s\./);
  });

  it('meters per account, at 300/min', () => {
    readTimes(callerIn({}), 300);
    expect(() => readTimes(callerIn({}), 1)).toThrow(
      expect.objectContaining({ httpStatus: 429, code: 'RATE_LIMITED' })
    );
  });

  it('never meters members or callers without a user', () => {
    readTimes(callerIn({ memberRole: 'member' }), 400);
    readTimes(callerIn({ userId: null, isAuthenticated: false, tokenType: 'anonymous' }), 400);
  });
});
