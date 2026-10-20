import { afterEach, describe, expect, it } from "bun:test";
import { getClientIP } from '../../utils/rate-limiter';

const request = (headers: Record<string, string>) => new Request('http://localhost/', { headers });

// Visitor → edge proxy → ingress → app. The edge appended the visitor, the
// ingress appended the edge; anything further left came from the client.
const twoProxies = request({ 'X-Forwarded-For': '6.6.6.6, 203.0.113.7, 172.70.1.1' });

describe('getClientIP', () => {
  const previous = process.env.TRUSTED_PROXY;
  afterEach(() => {
    if (previous === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = previous;
  });

  it('with two trusted proxies, keys on the visitor the outer one saw', () => {
    process.env.TRUSTED_PROXY = '2';
    expect(getClientIP(twoProxies, '10.0.0.5')).toBe('203.0.113.7');
  });

  it('with one trusted proxy (true or 1), keys on the rightmost entry', () => {
    process.env.TRUSTED_PROXY = 'true';
    expect(getClientIP(twoProxies, '10.0.0.5')).toBe('172.70.1.1');
    process.env.TRUSTED_PROXY = '1';
    expect(getClientIP(twoProxies, '10.0.0.5')).toBe('172.70.1.1');
  });

  it('never trusts a client-supplied entry beyond the trusted hops', () => {
    process.env.TRUSTED_PROXY = '2';
    // Skipped the outer proxy: only the ingress appended; use what it saw.
    expect(getClientIP(request({ 'X-Forwarded-For': '198.51.100.4' }), '10.0.0.5')).toBe('198.51.100.4');
  });

  it('ignores forwarded headers without a trusted proxy', () => {
    for (const value of [undefined, 'false', '0', 'cloudflare']) {
      if (value === undefined) delete process.env.TRUSTED_PROXY;
      else process.env.TRUSTED_PROXY = value;
      expect(getClientIP(twoProxies, '10.0.0.5')).toBe('10.0.0.5');
    }
    delete process.env.TRUSTED_PROXY;
    expect(getClientIP(twoProxies, null)).toBe('unknown');
  });
});
