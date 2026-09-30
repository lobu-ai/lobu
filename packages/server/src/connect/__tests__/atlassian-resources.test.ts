/**
 * Unit tests for Atlassian 3LO site discovery (Jira cloud_id stamping).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  fetchAtlassianAccessibleResources,
  mergeJiraSiteIntoConnectionConfig,
  pickUniqueJiraSite,
  resolveJiraCloudSite,
} from '../atlassian-resources';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('fetchAtlassianAccessibleResources', () => {
  it('parses resources and ignores malformed rows', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        {
          id: 'cloud-a',
          url: 'https://a.atlassian.net',
          name: 'A',
          scopes: ['read:jira-work'],
        },
        { id: 123 }, // ignored — id not string
        { url: 'https://orphan.atlassian.net' }, // no id
        {
          id: 'cloud-b',
          url: 'https://b.atlassian.net',
          name: 'B',
          scopes: ['read:confluence-content.summary'],
        },
      ])
    );

    const resources = await fetchAtlassianAccessibleResources('tok', fetchImpl as typeof fetch);
    expect(resources).toEqual([
      {
        id: 'cloud-a',
        url: 'https://a.atlassian.net',
        name: 'A',
        scopes: ['read:jira-work'],
      },
      {
        id: 'cloud-b',
        url: 'https://b.atlassian.net',
        name: 'B',
        scopes: ['read:confluence-content.summary'],
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.atlassian.com/oauth/token/accessible-resources',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer tok',
        }),
        // Bounded: this runs inline on the OAuth callback.
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('returns [] on non-2xx without throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    await expect(
      fetchAtlassianAccessibleResources('tok', fetchImpl as typeof fetch)
    ).resolves.toEqual([]);
  });

  it('returns [] on network error without throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(
      fetchAtlassianAccessibleResources('tok', fetchImpl as typeof fetch)
    ).resolves.toEqual([]);
  });
});

describe('pickUniqueJiraSite', () => {
  it('selects the sole Jira-scoped resource', () => {
    const site = pickUniqueJiraSite([
      {
        id: 'confluence-only',
        url: 'https://c.atlassian.net',
        name: 'C',
        scopes: ['read:confluence-content.summary'],
      },
      {
        id: 'jira-site',
        url: 'https://j.atlassian.net',
        name: 'J',
        scopes: ['read:jira-work', 'read:jira-user'],
      },
    ]);
    expect(site?.cloudId).toBe('jira-site');
    expect(site?.siteUrl).toBe('https://j.atlassian.net');
    expect(site?.siteName).toBe('J');
    expect(site?.resourceCount).toBe(2);
  });

  it('rejects ambiguous multi-site Jira grants', () => {
    const site = pickUniqueJiraSite([
      {
        id: 'first',
        url: 'https://1.atlassian.net',
        name: 'One',
        scopes: ['read:jira-work'],
      },
      {
        id: 'second',
        url: 'https://2.atlassian.net',
        name: 'Two',
        scopes: ['read:jira-work'],
      },
    ]);
    expect(site).toBeNull();
  });

  it('uses a sole resource when scopes are absent', () => {
    const site = pickUniqueJiraSite([
      {
        id: 'only',
        url: 'https://only.atlassian.net',
        name: 'Only',
        scopes: [],
      },
    ]);
    expect(site?.cloudId).toBe('only');
  });

  it('deduplicates product entries that refer to the same cloud site', () => {
    const site = pickUniqueJiraSite([
      {
        id: 'shared-cloud',
        url: 'https://shared.atlassian.net',
        name: 'Shared',
        scopes: ['read:jira-work'],
      },
      {
        id: 'shared-cloud',
        url: 'https://shared.atlassian.net',
        name: 'Shared',
        scopes: ['read:confluence-content.summary'],
      },
    ]);
    expect(site?.cloudId).toBe('shared-cloud');
    expect(site?.resourceCount).toBe(1);
  });

  it('returns null for an empty list', () => {
    expect(pickUniqueJiraSite([])).toBeNull();
  });
});

describe('resolveJiraCloudSite', () => {
  it('composes fetch + pick', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        {
          id: 'cloud-1',
          url: 'https://rakam1.atlassian.net',
          name: 'rakam1',
          scopes: ['read:jira-work'],
        },
      ])
    );
    const site = await resolveJiraCloudSite('tok', fetchImpl as typeof fetch);
    expect(site).toMatchObject({
      cloudId: 'cloud-1',
      siteUrl: 'https://rakam1.atlassian.net',
      siteName: 'rakam1',
    });
  });
});

describe('mergeJiraSiteIntoConnectionConfig', () => {
  it('preserves existing keys and stamps site fields', () => {
    const site = pickUniqueJiraSite([
      {
        id: 'cloud-1',
        url: 'https://a.atlassian.net',
        name: 'A',
        scopes: ['read:jira-work'],
      },
    ]);
    if (!site) throw new Error('Expected a unique Jira site fixture');
    const merged = mergeJiraSiteIntoConnectionConfig(
      { project_key: 'DEMO', webhook_external_id: '99' },
      site
    );
    expect(merged).toEqual({
      project_key: 'DEMO',
      webhook_external_id: '99',
      cloud_id: 'cloud-1',
      site_cloud_id: 'cloud-1',
      site_url: 'https://a.atlassian.net',
      site_name: 'A',
    });
  });

  it('handles null existing config', () => {
    const site = pickUniqueJiraSite([
      { id: 'c', url: null, name: null, scopes: [] },
    ]);
    if (!site) throw new Error('Expected a unique Jira site fixture');
    expect(mergeJiraSiteIntoConnectionConfig(null, site)).toEqual({
      cloud_id: 'c',
      site_cloud_id: 'c',
    });
  });

  it('clears stale optional metadata when the selected resource omits it', () => {
    const site = pickUniqueJiraSite([
      { id: 'c', url: null, name: null, scopes: [] },
    ]);
    if (!site) throw new Error('Expected a unique Jira site fixture');
    expect(
      mergeJiraSiteIntoConnectionConfig(
        {
          keep: true,
          site_url: 'https://stale.atlassian.net',
          site_name: 'Stale',
          site_cloud_id: 'stale',
        },
        site
      )
    ).toEqual({ keep: true, cloud_id: 'c', site_cloud_id: 'c' });
  });
});
