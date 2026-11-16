import { describe, expect, test } from 'bun:test';
import { getPublicLinkedIn, normalizePublicLinkedInUrl, parsePublicLinkedIn } from '../linkedin-public';

const person = '<script type="application/ld+json">' + JSON.stringify({ '@graph': [{ '@type': 'Article' }, { '@type': 'Person', name: 'Example', worksFor: [{ name: 'Example Inc' }] }] }) + '</script>';
const company = '<script type="application/ld+json">' + JSON.stringify({ '@type': 'Organization', name: 'Example Inc' }) + '</script>';

describe('linkedin.public', () => {
  test('extracts person from graph and employment', () => {
    expect(parsePublicLinkedIn(person, 'Person').worksFor).toEqual([{ name: 'Example Inc' }]);
  });
  test('extracts organization', () => {
    expect(parsePublicLinkedIn(company, 'Organization').name).toBe('Example Inc');
  });
  test('rejects arbitrary domains and paths', () => {
    expect(() => normalizePublicLinkedInUrl('https://evil.example/company/foo', 'company')).toThrow();
    expect(() => normalizePublicLinkedInUrl('https://linkedin.com/redirect/foo', 'company')).toThrow();
  });
  test('uses native fetch with bounded response and structured output', async () => {
    const fakeFetch = async (_url: string | URL | Request, _init?: RequestInit) => new Response(person, { status: 200, headers: { 'content-type': 'text/html' } });
    const result = await getPublicLinkedIn('person', 'example', fakeFetch as typeof fetch);
    expect(result.name).toBe('Example');
    expect(result.source_url).toBe('https://www.linkedin.com/in/example');
  });
  test('does not retry blocked pages', async () => {
    const fakeFetch = async () => new Response('blocked', { status: 403 });
    expect(getPublicLinkedIn('company', 'example', fakeFetch as typeof fetch)).rejects.toThrow('restricted');
  });
});

test('existing LinkedIn connector can read public person without browser binding', async () => {
  const { default: LinkedInConnector } = await import('../linkedin');
  const fakeFetch = async () => new Response(person, { status: 200, headers: { 'content-type': 'text/html' } });
  const connector = new LinkedInConnector(fakeFetch as typeof fetch);
  expect(connector.definition.key).toBe('linkedin');
  expect(connector.definition.authSchema?.methods?.some(method => method.type === 'none')).toBe(true);
  const result = await connector.execute({ actionKey: 'get_public_person', input: { url: 'example' } } as any);
  expect(result.success).toBe(true);
  expect(result.output?.name).toBe('Example');
});

test('browser-only actions do not silently fall back to public access', async () => {
  const { default: LinkedInConnector } = await import('../linkedin');
  const connector = new LinkedInConnector();
  const result = await connector.execute({ actionKey: 'set_like', input: { liked: true, post_url: 'invalid' } } as any);
  expect(result.success).toBe(false);
});

test('browser-only operation requires a browser even with a valid post URL', async () => {
  const { default: LinkedInConnector } = await import('../linkedin');
  const connector = new LinkedInConnector();
  const result = await connector.execute({ actionKey: 'set_like', input: { liked: true, post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789/' } } as any);
  expect(result.success).toBe(false);
  expect(result.error).toContain('Browser setup is required');
});

test('mixed auth still resolves a browser grant for browser sessions', async () => {
  const { resolveBrowserRequirement } = await import('@lobu/connector-sdk');
  const { default: LinkedInConnector } = await import('../linkedin');
  const browser = new LinkedInConnector().definition.browser;
  expect(resolveBrowserRequirement(browser, 'browser')).not.toBeNull();
  expect(resolveBrowserRequirement(browser, 'none')).toBeNull();
});
