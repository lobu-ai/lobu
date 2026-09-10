import { describe, expect, test } from 'vitest';
import { connectionSetupOptions, fetchCloudSetupOptions, type SetupOptionsDeps } from '../setup-options';
import type { ConnectionSetupOption, ConnectionSetupOptions } from '@lobu/core/contracts/tools/manage-connections';
import { withSetupOptions } from '../../tools/admin/manage_connections';

const managed: ConnectionSetupOption = { kind: 'managed_oauth', label: 'Connect with Example', description: 'Managed OAuth', execution: 'local', configured: true, managed_by_org: 'public-provider', url: 'https://cloud.example/connect/managed?org=public-provider&connector=mail', instructions: 'Consent, then bootstrap locally.' };
const local: ConnectionSetupOption = { kind: 'local', label: 'Use your own app', description: 'Local setup', execution: 'local', configured: false, url: 'http://localhost:8787/test/connectors/mail', instructions: 'Configure app' };
const response = (options = [managed]): ConnectionSetupOptions => ({ action: 'setup_options', connector_key: 'mail', cloud_status: 'available', options });
function deps(overrides: Partial<SetupOptionsDeps> = {}): SetupOptionsDeps {
  return { cloudOrigin: async () => 'https://cloud.example', cloudMode: () => false, publicOptions: async () => response(), remoteOptions: async () => response(), localOption: async () => local, ...overrides };
}

describe('shared connection setup discovery', () => {
  test('fresh local runtime offers managed OAuth before BYO without a cloud login', async () => {
    const result = await connectionSetupOptions('mail', 'local-org', 'http://localhost:8787', deps());
    expect(result.options.map(o => o.kind)).toEqual(['managed_oauth', 'local']);
    expect(result.options[0].execution).toBe('local');
    expect(result.options[1].configured).toBe(false);
  });
  test('reserves room for local setup when cloud discovery fills the response limit', async () => {
    const result = await connectionSetupOptions('mail', 'local-org', 'http://localhost:8787', deps({ remoteOptions: async () => response(Array.from({ length: 100 }, () => managed)) }));
    expect(result.options).toHaveLength(100);
    expect(result.options.at(-1)).toEqual(local);
  });
  test('cloud outage is distinct from no offer and preserves local setup', async () => {
    const result = await connectionSetupOptions('mail', 'local-org', 'http://localhost:8787', deps({ remoteOptions: async () => { throw new Error('offline'); } }));
    expect(result.cloud_status).toBe('unavailable');
    expect(result.options).toEqual([local]);
  });
  test('explicitly unconfigured cloud is not replaced with a default', async () => {
    const result = await connectionSetupOptions('mail', 'local-org', 'http://localhost:8787', deps({ cloudOrigin: async () => null, remoteOptions: async () => { throw new Error('must not call'); } }));
    expect(result.cloud_status).toBe('not_configured');
  });
  test('cloud gateway reads its own public offers without remote recursion', async () => {
    let called = false;
    const result = await connectionSetupOptions('mail', 'org', 'https://cloud.example', deps({ cloudMode: () => true, remoteOptions: async () => { called = true; throw new Error('recursive'); } }));
    expect(called).toBe(false); expect(result.cloud_status).toBe('available');
  });
  test('hosted chat retains cloud execution boundary', async () => {
    const chat = { ...managed, kind: 'hosted_chat' as const, execution: 'cloud' as const };
    const result = await connectionSetupOptions('mail', 'org', 'http://localhost:8787', deps({ remoteOptions: async () => response([chat]) }));
    expect(result.options[0].execution).toBe('cloud');
  });
});

describe('public cloud metadata transport', () => {
  test('never sends user credentials and forbids redirects', async () => {
    const transport = (async (url: URL, init: RequestInit) => {
      expect(url.origin).toBe('https://cloud.example');
      expect(url.searchParams.get('connector_key')).toBe('mail');
      expect(init.credentials).toBe('omit'); expect(init.headers).toBeUndefined();
      expect(init.redirect).toBe('error');
      return Response.json(response());
    }) as unknown as typeof fetch;
    expect((await fetchCloudSetupOptions('mail', 'https://cloud.example', transport)).options).toEqual([managed]);
  });
  test('rejects cross-origin action URLs and unexpected secrets', async () => {
    for (const option of [{ ...managed, url: 'https://evil.example/consent' }, { ...managed, token: 'should-not-be-returned' }]) {
      await expect(fetchCloudSetupOptions('mail', 'https://cloud.example', (async () => Response.json(response([option]))) as typeof fetch)).rejects.toThrow();
    }
  });
  test('rejects mismatched connector and overlarge bodies', async () => {
    await expect(fetchCloudSetupOptions('other', 'https://cloud.example', (async () => Response.json(response())) as typeof fetch)).rejects.toThrow();
    await expect(fetchCloudSetupOptions('mail', 'https://cloud.example', (async () => new Response('x'.repeat(65537))) as typeof fetch)).rejects.toThrow('too large');
  });
});

describe('setup-required enrichment', () => {
  test('optional discovery failure preserves an actionable setup continuation', async () => {
    const continuation = { action: 'connect', status: 'setup_required', instructions: 'Configure your OAuth app.', next_action: 'configure_oauth_app' } as Parameters<typeof withSetupOptions>[0];
    const result = await withSetupOptions(continuation, 'mail', { organizationId: 'synthetic-org' } as Parameters<typeof withSetupOptions>[2], async () => { throw new Error('Discovery database unavailable'); });
    expect(result).toBe(continuation);
  });
});
