import { ConnectorRuntime, type RuntimeConnectorDefinition, type ActionContext, type ActionResult } from '@lobu/connector-sdk';

type PublicKind = 'Person' | 'Organization';
const BASE = 'https://www.linkedin.com';
const MAX_BYTES = 2_000_000;

export function parsePublicLinkedIn(html: string, kind: PublicKind): Record<string, unknown> {
  const scripts = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of scripts) {
    let doc: unknown;
    try { doc = JSON.parse(match[1]!); } catch { continue; }
    const root = doc as Record<string, unknown>;
    const graph = Array.isArray(root['@graph']) ? root['@graph'] : [root];
    const found = graph.find((x: unknown) => {
      if (!x || typeof x !== 'object') return false;
      const t = (x as Record<string, unknown>)['@type'];
      return t === kind || (Array.isArray(t) && t.includes(kind));
    });
    if (found && typeof found === 'object') return found as Record<string, unknown>;
  }
  throw new Error('Public structured profile unavailable or changed');
}

export function normalizePublicLinkedInUrl(value: string, kind: 'company' | 'person'): string {
  const slug = value.startsWith('https://') ? (() => {
    const u = new URL(value);
    if (u.hostname !== 'www.linkedin.com' && u.hostname !== 'linkedin.com') throw new Error('LinkedIn URL required');
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length !== 2 || parts[0] !== (kind === 'person' ? 'in' : 'company')) throw new Error('Unexpected LinkedIn path');
    return parts[1]!;
  })() : value;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(slug)) throw new Error('Invalid LinkedIn slug');
  return BASE + '/' + (kind === 'person' ? 'in' : 'company') + '/' + slug;
}

export async function getPublicLinkedIn(kind: 'company' | 'person', input: string, request: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const url = normalizePublicLinkedInUrl(input, kind);
  const response = await request(url, {
    headers: { 'user-agent': 'linkedin-cli/0.2.0', 'accept': 'text/html' },
    redirect: 'manual',
    signal: AbortSignal.timeout(12000),
  });
  if (response.status === 403 || response.status === 429 || response.status === 999) throw new Error('LinkedIn access restricted: HTTP ' + response.status);
  if (!response.ok) throw new Error('LinkedIn HTTP ' + response.status);
  if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('Unexpected LinkedIn content type');
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_BYTES) throw new Error('LinkedIn page too large');
  const html = await response.text();
  if (html.length > MAX_BYTES) throw new Error('LinkedIn page too large');
  const record = parsePublicLinkedIn(html, kind === 'person' ? 'Person' : 'Organization');
  return { ...record, source_url: url, fetched_at: new Date().toISOString() };
}

export default class LinkedInPublicConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: 'linkedin.public',
    name: 'LinkedIn Public',
    description: 'Read public LinkedIn person and company structured data without an account.',
    version: '0.1.0',
    faviconDomain: 'linkedin.com',
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {},
    actions: {
      get_company: { key: 'get_company', name: 'Get public company', description: 'Fetch a known public company URL or slug.', inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } } },
      get_person: { key: 'get_person', name: 'Get public person', description: 'Fetch a known public person URL or slug.', inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } } },
    },
  };
  async execute(ctx: ActionContext): Promise<ActionResult> {
    const kind = ctx.actionKey === 'get_company' ? 'company' : ctx.actionKey === 'get_person' ? 'person' : null;
    if (!kind) return { success: false, error: 'Unknown action' };
    try {
      const record = await getPublicLinkedIn(kind, String(ctx.input.url ?? ''));
      return { success: true, output: record };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
