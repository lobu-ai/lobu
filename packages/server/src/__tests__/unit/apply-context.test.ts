import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { AuthInfo } from '../../auth/oauth/types';
import { type ApplyContext, getApplyContext } from '../../utils/apply-context';

async function readApplyContext(
  authInfo: Pick<AuthInfo, 'userId' | 'clientId' | 'tokenType'> | null,
  authSource: 'oauth' | 'pat' | 'session' | null,
  user: { id: string } | null = null,
): Promise<ApplyContext> {
  const app = new Hono();
  app.get('/', (c) => {
    c.set('mcpAuthInfo', authInfo);
    c.set('authSource', authSource);
    c.set('user', user);
    return c.json(getApplyContext(c));
  });
  const response = await app.request('/', { headers: { 'x-lobu-apply-id': 'apl_test' } });
  return response.json() as Promise<ApplyContext>;
}

describe('config mutation attribution', () => {
  it('preserves the registered client from raw OAuth access-token auth info', async () => {
    expect(await readApplyContext({
      userId: 'test-owner', clientId: 'test-oauth-client', tokenType: 'access_token',
    }, 'oauth')).toEqual({
      applyId: 'apl_test', actorSource: 'cli', createdBy: 'test-owner', clientId: 'test-oauth-client',
    });
  });

  it.each(['pat_test-token', 'lobu-worker'])('omits synthetic client %s without losing the actor', async (clientId) => {
    expect(await readApplyContext({
      userId: 'test-owner', clientId, tokenType: 'pat',
    }, 'pat')).toEqual({
      applyId: 'apl_test', actorSource: 'cli', createdBy: 'test-owner', clientId: null,
    });
  });

  it('preserves session attribution without a client', async () => {
    expect(await readApplyContext(null, 'session', { id: 'test-owner' })).toEqual({
      applyId: 'apl_test', actorSource: 'cli', createdBy: 'test-owner', clientId: null,
    });
  });
});
