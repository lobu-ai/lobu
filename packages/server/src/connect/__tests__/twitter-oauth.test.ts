import dns from 'node:dns/promises';
import XConnector from '@lobu/connectors/x';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchUserInfoWithRaw } from '../oauth-providers';

afterEach(() => { vi.restoreAllMocks(); });

it('preserves X source account identity when login uses the native adapter', async () => {
  vi.spyOn(dns, 'lookup').mockResolvedValue([
    { address: '8.8.8.8', family: 4 },
  ] as Awaited<ReturnType<typeof dns.lookup>>);
  const profile = { id: '100000000000000000001', name: 'Alice', username: 'synthetic_x_user' };
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe('https://api.x.com/2/users/me?user.fields=username');
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-access');
    expect(request.redirect).toBe('error');
    return Response.json({ data: profile });
  });
  const oauth = new XConnector().definition.authSchema.methods.find((method) => method.type === 'oauth');
  if (!oauth || oauth.type !== 'oauth') throw new Error('X OAuth method missing');
  expect(oauth.userinfoUrl).toBeUndefined();
  const identity = await fetchUserInfoWithRaw({
    provider: oauth.provider,
    accessToken: 'synthetic-access',
    userinfoUrl: oauth.userinfoUrl,
  });
  expect(identity).toEqual({
    raw: profile,
    normalized: { id: profile.id, name: profile.name, email: null },
  });
  expect(network).toHaveBeenCalledOnce();
});
