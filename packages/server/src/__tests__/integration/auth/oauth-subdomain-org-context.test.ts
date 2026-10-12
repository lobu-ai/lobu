import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearLoginProviderCachesForTests, getAuthConfig, resolveRequestOrganizationId } from "../../../auth/config";
import { bindOAuthOrganization } from "../../../auth/oauth-organization-context";
import type { Env } from "../../../index";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestOrganization } from "../../setup/test-fixtures";

const PROVIDER = "acme-oidc";

/**
 * Org subdomains omit the org path prefix. Auth must preserve that context
 * when selecting login providers and restoring state-bound OAuth callbacks.
 */
describe("subdomain-aware auth org resolution", () => {
  const backup: Record<string, string | undefined> = {};

  beforeAll(async () => { await initWorkspaceProvider(); });

  beforeEach(async () => {
    await cleanupTestDatabase();
    clearLoginProviderCachesForTests();
    for (const key of ["AUTH_COOKIE_DOMAIN"]) backup[key] = process.env[key];
    process.env.AUTH_COOKIE_DOMAIN = ".lobu.ai";
  });

  afterEach(async () => {
    clearLoginProviderCachesForTests();
    for (const [key, value] of Object.entries(backup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("resolves the org from the request URL subdomain host", async () => {
    const org = await createTestOrganization({ name: "acme", slug: "acme", visibility: "public" });
    const request = new Request("https://acme.lobu.ai/api/auth-config");
    expect(await resolveRequestOrganizationId(request)).toBe(org.id);
  });

  it("uses the Host header when a proxy rewrites the request URL", async () => {
    const org = await createTestOrganization({ name: "acme", slug: "acme", visibility: "public" });
    await createTestOrganization({ name: "other", slug: "other", visibility: "public" });
    const request = new Request("http://localhost/other/page", {
      headers: { host: "ACME.Lobu.AI:443" },
    });
    expect(await resolveRequestOrganizationId(request)).toBe(org.id);
  });

  it("resolves the org from a subdomain referer", async () => {
    const org = await createTestOrganization({ name: "acme", slug: "acme", visibility: "public" });
    const request = new Request("http://localhost/api/auth-config", {
      headers: { referer: "https://acme.lobu.ai/" },
    });
    expect(await resolveRequestOrganizationId(request)).toBe(org.id);
  });

  it.each(["callbackURL", "callbackUrl"])("resolves subdomain %s in query strings and JSON bodies", async (key) => {
    const org = await createTestOrganization({ name: "acme", slug: "acme", visibility: "public" });
    const callbackURL = "https://acme.lobu.ai/";
    const query = new URLSearchParams({ [key]: callbackURL });
    expect(await resolveRequestOrganizationId(new Request(`https://app.lobu.ai/api/auth-config?${query}`))).toBe(org.id);
    const request = new Request("https://app.lobu.ai/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [key]: callbackURL }),
    });
    expect(await resolveRequestOrganizationId(request)).toBe(org.id);
    expect(await request.json()).toEqual({ [key]: callbackURL });
  });

  it.each(["app", "www", "api"])("ignores reserved %s subdomains", async (slug) => {
    await createTestOrganization({ name: "acme", slug: "acme", visibility: "public" });
    const request = new Request(`https://${slug}.lobu.ai/api/auth-config?callbackUrl=https://${slug}.lobu.ai/`, {
      headers: { host: `${slug}.lobu.ai`, referer: `https://${slug}.lobu.ai/` },
    });
    expect(await resolveRequestOrganizationId(request)).toBeNull();
  });

  it("ignores a reserved subdomain even when an org holds that slug", async () => {
    // The org_slug_not_reserved DB check forbids www/api-like slugs but
    // permits 'app', so resolution itself must refuse it.
    await createTestOrganization({ name: "app", slug: "app", visibility: "public" });
    const request = new Request("https://app.lobu.ai/api/auth-config?callbackUrl=https://app.lobu.ai/");
    expect(await resolveRequestOrganizationId(request)).toBeNull();
  });

  it.each(["acme.example.test", "acme.lobu.ai.example.test", "nested.acme.lobu.ai", "lobu.ai"])("ignores non-org host %s", async (host) => {
    await createTestOrganization({ name: "acme", slug: "acme", visibility: "public" });
    const request = new Request(`https://${host}/api/auth-config`);
    expect(await resolveRequestOrganizationId(request)).toBeNull();
  });

  it("keeps path-based org selection on the canonical host", async () => {
    const org = await createTestOrganization({ name: "acme", slug: "acme", visibility: "public" });
    const request = new Request("https://app.lobu.ai/api/auth-config?callbackUrl=/acme/");
    expect(await resolveRequestOrganizationId(request)).toBe(org.id);
  });

  it("exposes org login providers without applying the global-only allowlist", async () => {
    await createTestOrganization({ name: "acme", slug: "acme", visibility: "public" });
    const env = {
      GOOGLE_CLIENT_ID: "synthetic-google-client",
      GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
      LOBU_GLOBAL_LOGIN_PROVIDERS: "github",
    } as Env;
    const orgConfig = await getAuthConfig(env, { request: new Request("https://acme.lobu.ai/api/auth-config") });
    const pathConfig = await getAuthConfig(env, { request: new Request("https://app.lobu.ai/api/auth-config?callbackUrl=/acme/") });
    const globalConfig = await getAuthConfig(env, { request: new Request("https://app.lobu.ai/api/auth-config") });
    expect(orgConfig.social.google).toBe(true);
    expect(orgConfig.social).toEqual(pathConfig.social);
    expect(globalConfig.social.google).toBeUndefined();
  });

  it("prefers the request host over a conflicting path slug", async () => {
    const acme = await createTestOrganization({ name: "acme", slug: "acme", visibility: "public" });
    await createTestOrganization({ name: "other", slug: "other", visibility: "public" });
    const request = new Request("https://acme.lobu.ai/other/page");
    expect(await resolveRequestOrganizationId(request)).toBe(acme.id);
  });

  it("keeps state-bound callback org ahead of a mismatched host", async () => {
    const acme = await createTestOrganization({ name: "acme", slug: "acme", visibility: "public" });
    await createTestOrganization({ name: "other", slug: "other", visibility: "public" });
    const state = "synthetic-subdomain-state";
    const bound = bindOAuthOrganization(
      { identifier: state, value: JSON.stringify({ oauthState: state, expiresAt: Date.now() + 60_000 }) },
      acme.id,
      { path: "/sign-in/social", body: { provider: PROVIDER } },
    );
    await getTestDb()`INSERT INTO verification (id, identifier, value, "expiresAt", "createdAt")
      VALUES (gen_random_uuid(), ${state}, ${bound}, now() + interval '5 minutes', now())`;
    const request = new Request(`https://other.lobu.ai/api/auth/callback/${PROVIDER}?state=${state}&code=synthetic-code`);
    expect(await resolveRequestOrganizationId(request)).toBe(acme.id);
  });
});
