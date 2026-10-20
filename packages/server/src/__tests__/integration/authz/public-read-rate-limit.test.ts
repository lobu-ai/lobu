/**
 * Integration test: reads of a public workspace by callers outside it are
 * metered and refused with RATE_LIMITED past the limit — signed-in non-members
 * per account (300/min, over MCP, the only route open to them), anonymous
 * visitors per IP (60/min, over MCP and the public REST API). Members,
 * internal calls and unknown IPs are never metered.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AuthContext, checkToolAccess } from '../../../tools/execute';
import {
  getRateLimiter,
  RateLimitPresets,
  resetRateLimiterForTests,
} from '../../../utils/rate-limiter';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  createTestAccessToken,
  createTestEvent,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { MCP_PROTOCOL_VERSION } from '@lobu/core';
import { get, mcpToolsCall, post } from '../../setup/test-helpers';

describe('public read rate limit', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let outsider: Awaited<ReturnType<typeof createTestUser>>;
  let token: string;
  let eventId: number;

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

  const exhaustIP = (ip: string) => {
    for (let i = 0; i < RateLimitPresets.PUBLIC_READ_PER_IP_MINUTE.limit; i++) {
      getRateLimiter().checkLimit(`rate:public-read:ip:${ip}`, RateLimitPresets.PUBLIC_READ_PER_IP_MINUTE);
    }
  };

  const fromIP = (ip: string) => ({ 'X-Forwarded-For': ip });

  const publicRest = (ip: string) =>
    get(`/api/${org.slug}/public/knowledge/search?query=rents`, { headers: fromIP(ip) }).then(
      (r) => r.status
    );

  /** One anonymous MCP session, opened from `ip`. */
  async function anonymousSession(ip: string): Promise<string> {
    const init = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'rate-limit-test', version: '1.0' },
        },
      },
      headers: fromIP(ip),
    });
    const sessionId = init.headers.get('mcp-session-id');
    if (!sessionId) throw new Error(`initialize failed: ${init.status}`);
    await post(`/mcp/${org.slug}`, {
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      headers: { ...fromIP(ip), 'mcp-session-id': sessionId, 'mcp-protocol-version': MCP_PROTOCOL_VERSION },
    });
    return sessionId;
  }

  /** The error text of an anonymous attachment read on `sessionId` from `ip`. */
  async function anonymousResourceError(sessionId: string, ip: string): Promise<string> {
    const res = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/read',
        params: { uri: `lobu://event/${eventId}/attachment/0` },
      },
      headers: { ...fromIP(ip), 'mcp-session-id': sessionId, 'mcp-protocol-version': MCP_PROTOCOL_VERSION },
    });
    return (await res.json()).error?.message ?? '';
  }

  /** The tool error text of an anonymous search on `sessionId` from `ip`, or null on success. */
  async function anonymousSearchError(sessionId: string, ip: string): Promise<string | null> {
    const res = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_memory', arguments: { query: 'rents' } },
      },
      headers: {
        ...fromIP(ip),
        'X-MCP-Format': 'json',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
    });
    const json = await res.json();
    if (json.error) return json.error.message;
    return json.result?.isError ? (json.result.content?.[0]?.text ?? 'error') : null;
  }

  const search = () =>
    mcpToolsCall('search_memory', { query: 'rents' }, { token, orgSlug: org.slug });

  const previousTrustedProxy = process.env.TRUSTED_PROXY;

  beforeAll(async () => {
    process.env.TRUSTED_PROXY = '1';
    await cleanupTestDatabase();
    org = await createTestOrganization({ name: 'Rate Limited Public Org', visibility: 'public' });
    outsider = await createTestUser({ email: 'rate-limit-outsider@example.com' });
    eventId = (await createTestEvent({ organization_id: org.id, content: 'Rents rose 4%' })).id;
    const client = await createTestOAuthClient();
    token = (
      await createTestAccessToken(outsider.id, org.id, client.client_id, {
        scope: 'mcp:read',
        grantedOrganizationIds: [org.id],
      })
    ).token;
  });

  afterAll(() => {
    if (previousTrustedProxy === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = previousTrustedProxy;
    resetRateLimiterForTests();
  });
  // The limiter's window is clock-aligned; a frozen clock keeps one test from
  // straddling a minute boundary, where the window would reset mid-test.
  beforeEach(() => {
    resetRateLimiterForTests();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
  });
  afterEach(() => vi.useRealTimers());

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

  it('meters anonymous public REST reads per IP, at 60/min', async () => {
    for (let i = 0; i < 60; i++) expect(await publicRest('203.0.113.7')).toBe(200);
    expect(await publicRest('203.0.113.7')).toBe(429);
    expect(await publicRest('203.0.113.8')).toBe(200);
  });

  it('charges an anonymous MCP session to the IP of each request, not the one it opened from', async () => {
    const sessionId = await anonymousSession('198.51.100.1');
    expect(await anonymousSearchError(sessionId, '198.51.100.1')).toBeNull();
    exhaustIP('198.51.100.2');
    expect(await anonymousSearchError(sessionId, '198.51.100.2')).toMatch(/Public read limit reached: 60/);
    expect(await anonymousSearchError(sessionId, '198.51.100.1')).toBeNull();

    // Attachment reads run read_knowledge too, so they follow the same IP.
    // The event has no attachment: an admitted read reports it unknown.
    expect(await anonymousResourceError(sessionId, '198.51.100.2')).toMatch(/Public read limit reached: 60/);
    expect(await anonymousResourceError(sessionId, '198.51.100.1')).toMatch(/Unknown resource/);
  });

  it('never meters members, internal calls, or an unknown anonymous IP', () => {
    const anonymous = { userId: null, isAuthenticated: false, tokenType: 'anonymous' } as const;
    readTimes(callerIn({ memberRole: 'member' }), 400);
    readTimes(callerIn({ ...anonymous, clientIP: null }), 400);
    readTimes(callerIn({ ...anonymous, clientIP: 'unknown' }), 400);
  });
});
