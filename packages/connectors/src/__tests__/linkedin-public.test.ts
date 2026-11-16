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
