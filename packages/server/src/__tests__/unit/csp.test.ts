import { describe, expect, it } from 'bun:test';
import { isValidFrameAncestor } from '../../utils/csp';

describe('isValidFrameAncestor', () => {
  it('accepts well-formed host-sources', () => {
    expect(isValidFrameAncestor('https://lobu.ai')).toBe(true);
    expect(isValidFrameAncestor('https://*.lobu.ai')).toBe(true);
    expect(isValidFrameAncestor('https://app.lobu.ai:8080')).toBe(true);
    expect(isValidFrameAncestor('http://localhost:3000')).toBe(true);
  });

  it('accepts scheme-only sources', () => {
    expect(isValidFrameAncestor('https:')).toBe(true);
    expect(isValidFrameAncestor('wss:')).toBe(true);
  });

  it('rejects entries with embedded whitespace', () => {
    expect(isValidFrameAncestor('https:// lobu.ai')).toBe(false);
    expect(isValidFrameAncestor('https://lobu .ai')).toBe(false);
    expect(isValidFrameAncestor(' https://lobu.ai')).toBe(false);
  });

  it('rejects entries with paths or queries', () => {
    expect(isValidFrameAncestor('https://lobu.ai/embed')).toBe(false);
    expect(isValidFrameAncestor('https://lobu.ai?x=1')).toBe(false);
    expect(isValidFrameAncestor('https://lobu.ai#f')).toBe(false);
  });

  it('rejects malformed or suspicious entries', () => {
    expect(isValidFrameAncestor('')).toBe(false);
    expect(isValidFrameAncestor('lobu.ai')).toBe(false); // no scheme
    expect(isValidFrameAncestor("'self'")).toBe(false); // keyword already added separately
    expect(isValidFrameAncestor('javascript:alert(1)')).toBe(false);
    expect(isValidFrameAncestor('https://')).toBe(false);
    expect(isValidFrameAncestor('https://lobu.ai attacker.com')).toBe(false);
  });
});
