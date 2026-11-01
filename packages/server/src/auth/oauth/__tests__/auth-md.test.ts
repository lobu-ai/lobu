import { describe, expect, it } from 'bun:test';

import { buildAuthMd } from '../auth-md';

describe('auth.md credential guidance', () => {
  it('documents durable storage and refresh-token rotation', () => {
    const doc = buildAuthMd('https://lobu.example');

    expect(doc).toContain('tokens last 24 hours');
    expect(doc).toContain('Refresh tokens last 30 days');
    expect(doc).toContain('revokes the one you sent');
    expect(doc).toContain('secure storage that survives');
    expect(doc).toContain('atomically replace both tokens');
    expect(doc).toContain('include the exact `resource` from device');
    expect(doc).toContain('omitting it is rejected as `invalid_grant`');
    expect(doc).toContain('Cloudflare 403 with code `1010` / `browser_signature_banned` is an edge block');
    expect(doc).toContain('not an app OAuth `invalid_grant`');
    expect(doc).toContain('Keep the saved credential');
    expect(doc).toContain('bypass the security check');
    expect(doc).toContain('Only an HTTP 400 JSON `{ "error": "invalid_grant" }` from');
  });
});
