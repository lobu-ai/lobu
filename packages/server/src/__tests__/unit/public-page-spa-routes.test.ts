import { describe, expect, it } from 'bun:test';
import type { Env } from '../../index';
import { buildPublicPageModel } from '../../public-pages';

// No database is initialized: these app routes must not need public entity
// lookups, or synthesize a cacheable public 404 before the SPA can boot.
describe('public page SPA routes', () => {
  it.each([
    '/account/settings',
    '/auth/login',
    '/oauth/authorize',
    '/me',
    '/agents/connect',
    '/activity',
    '/data',
    '/settings',
  ])('leaves subdomain %s to the SPA without resolving public workspace content', async (path) => {
    await expect(
      buildPublicPageModel(path, {} as Env, `https://acme.example.test${path}`, 'acme')
    ).resolves.toBeNull();
  });

  it.each([
    '/acme/activity',
    '/acme/settings',
    '/acme/memory',
  ])('leaves %s to the SPA without resolving public workspace content', async (path) => {
    await expect(
      buildPublicPageModel(path, {} as Env, `https://app.example.test${path}`, null)
    ).resolves.toBeNull();
  });
});
