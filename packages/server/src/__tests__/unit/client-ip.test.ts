import { afterEach, describe, expect, it } from "bun:test";
import { getClientIP } from '../../utils/rate-limiter';

const request = (headers: Record<string, string>) => new Request('http://localhost/', { headers });

// Cloudflare edge → ingress → app: the ingress appended the edge it saw.
const behindCloudflare = request({
  'CF-Connecting-IP': '203.0.113.7',
  'X-Forwarded-For': '203.0.113.7, 172.70.1.1',
});

describe('getClientIP', () => {
  const previous = process.env.TRUSTED_PROXY;
  afterEach(() => {
    if (previous === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = previous;
  });

  it('cloudflare mode keys on the visitor, not the edge', () => {
    process.env.TRUSTED_PROXY = 'cloudflare';
    expect(getClientIP(behindCloudflare, '10.0.0.5')).toBe('203.0.113.7');
  });

  it('cloudflare mode falls back to the forwarded chain without the header', () => {
    process.env.TRUSTED_PROXY = 'cloudflare';
    expect(getClientIP(request({ 'X-Forwarded-For': '198.51.100.4' }), '10.0.0.5')).toBe('198.51.100.4');
  });

  it('generic trusted-proxy mode keeps the proxy-observed address, so a forged header cannot win', () => {
    process.env.TRUSTED_PROXY = 'true';
    expect(getClientIP(behindCloudflare, '10.0.0.5')).toBe('172.70.1.1');
  });

  it('ignores forwarded headers without a trusted proxy', () => {
    delete process.env.TRUSTED_PROXY;
    expect(getClientIP(behindCloudflare, '10.0.0.5')).toBe('10.0.0.5');
    expect(getClientIP(behindCloudflare, null)).toBe('unknown');
  });
});
