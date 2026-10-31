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
  });
});
