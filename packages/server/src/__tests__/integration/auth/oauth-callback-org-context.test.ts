import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serializeSigned } from "hono/utils/cookie";
import { app } from "../../../index";
import { buildWrapperApp } from "../../../server-lifecycle";
import { clearLoginProviderCachesForTests, resolveRequestOrganizationId } from "../../../auth/config";
import { clearAuthCacheForTests, createAuth } from "../../../auth/index";
import { getEnvFromProcess } from "../../../utils/env";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { addUserToOrganization, createTestOrganization, createTestUser, createTestSession } from "../../setup/test-fixtures";

const ORIGIN = "http://localhost";
const PROVIDER = "acme-oidc";
const EMAIL = "alice@acme.test";

function cookies(response: Response): string {
  return response.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
}

describe("organization-scoped OAuth callback routing", () => {
  let server: Server;
  let providerOrigin: string;
  let tokenClients: string[];
  const backup: Record<string, string | undefined> = {};

  beforeAll(async () => { await initWorkspaceProvider(); });

  beforeEach(async () => {
    await cleanupTestDatabase();
    clearAuthCacheForTests();
    clearLoginProviderCachesForTests();
    tokenClients = [];
    for (const key of ["BETTER_AUTH_SECRET", "ACME_LOGIN_ID", "ACME_LOGIN_SECRET", "ACME_OTHER_LOGIN_ID", "ACME_OTHER_LOGIN_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) backup[key] = process.env[key];
    process.env.BETTER_AUTH_SECRET = "a".repeat(64);
    process.env.ACME_LOGIN_ID = "acme-test-client";
    process.env.ACME_LOGIN_SECRET = "acme-test-secret";
    process.env.ACME_OTHER_LOGIN_ID = "other-test-client";
    process.env.ACME_OTHER_LOGIN_SECRET = "other-test-secret";
    process.env.GOOGLE_CLIENT_ID = "google-test-client";
    process.env.GOOGLE_CLIENT_SECRET = "google-test-secret";
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/authorize") {
        const callback = new URL(url.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "synthetic-code");
        callback.searchParams.set("state", url.searchParams.get("state")!);
        res.writeHead(302, { location: callback.toString() }).end();
      } else if (url.pathname === "/token") {
        let body = "";
        for await (const chunk of req) body += chunk;
        tokenClients.push(new URLSearchParams(body).get("client_id") ?? "");
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          access_token: "synthetic-token", token_type: "Bearer",
        }));
      } else if (url.pathname === "/userinfo") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          sub: "synthetic-alice", name: "Alice", email: EMAIL, email_verified: true,
        }));
      } else res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    providerOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(backup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearAuthCacheForTests();
    clearLoginProviderCachesForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function fixture(slug = "acme", other = false, provision = false) {
    const sql = getTestDb();
    const org = await createTestOrganization({ name: slug, slug, visibility: "public" });
    const existing = await sql<{ id: string }[]>`SELECT id FROM "user" WHERE email = ${EMAIL}`;
    const user = existing[0] ?? await createTestUser({ name: "Alice", email: EMAIL });
    await addUserToOrganization(user.id, org.id, "member");
    const clientIdKey = other ? "ACME_OTHER_LOGIN_ID" : "ACME_LOGIN_ID";
    const clientSecretKey = other ? "ACME_OTHER_LOGIN_SECRET" : "ACME_LOGIN_SECRET";
    const authSchema = { methods: [{
      type: "oauth", provider: PROVIDER, loginScopes: ["openid", "email", "profile"],
      clientIdKey, clientSecretKey,
      authorizationUrl: `${providerOrigin}/authorize`, tokenUrl: `${providerOrigin}/token`,
      userinfoUrl: `${providerOrigin}/userinfo`, tokenEndpointAuthMethod: "client_secret_post",
      loginProvisioning: { autoCreateConnection: provision },
    }] };
    await sql`INSERT INTO connector_definitions
      (organization_id, key, name, version, auth_schema, login_enabled, status, created_at, updated_at)
      VALUES (${org.id}, 'acme-login', 'Acme Login', '1.0.0', ${sql.json(authSchema)}, true, 'active', now(), now())`;
    return { org, user };
  }

  async function start(slug = "acme", path = "sign-in/social", additionalData?: Record<string, unknown>) {
    const linking = path === "link-social" || path === "oauth2/link";
    let sessionCookie = "";
    if (linking) {
      const [user] = await getTestDb()`SELECT id FROM "user" WHERE email = ${EMAIL}`;
      const session = await createTestSession(user.id);
      sessionCookie = (await serializeSigned("better-auth.session_token", session.token, process.env.BETTER_AUTH_SECRET!)).split(";")[0];
    }
    const callbackURL = `${ORIGIN}/connector/acme/connection`;
    const request = new Request(`${ORIGIN}/api/auth/${path}`, {
      method: "POST", headers: {
        "content-type": "application/json", origin: ORIGIN, referer: `${ORIGIN}/${slug}`,
        ...(sessionCookie ? { cookie: sessionCookie } : {}),
      },
      body: JSON.stringify({
        [path === "sign-in/social" || path === "link-social" ? "provider" : "providerId"]: PROVIDER,
        callbackURL, additionalData,
      }),
    });
    const auth = await createAuth(getEnvFromProcess(), request);
    const response = await auth.handler(request);
    expect(response.status, await response.clone().text()).toBe(200);
    const { url } = await response.json() as { url: string };
    const authorize = await fetch(url, { redirect: "manual" });
    expect(authorize.status).toBe(302);
    const callback = new URL(authorize.headers.get("location")!);
    return { callback, callbackURL, cookie: [cookies(response), sessionCookie].filter(Boolean).join("; ") };
  }

  async function callback(flow: Awaited<ReturnType<typeof start>>, headers?: Record<string, string>) {
    // Rebuild per request just like the gateway, potentially on another replica.
    clearAuthCacheForTests();
    clearLoginProviderCachesForTests();
    const request = new Request(flow.callback, { headers: { cookie: flow.cookie, ...headers } });
    const auth = await createAuth(getEnvFromProcess(), request);
    return { auth, result: await auth.handler(request) };
  }

  it.each(["sign-in/social", "sign-in/oauth2", "link-social", "oauth2/link"])(
    "restores the starting org without a callback referrer or auth cache: %s",
    async (path) => {
      const { org, user } = await fixture();
      const flow = await start("acme", path);
      const { auth, result } = await callback(flow);
      expect(result.status, await result.clone().text()).toBe(302);
      expect(result.headers.get("location")).toBe(flow.callbackURL);
      expect(tokenClients).toEqual(["acme-test-client"]);
      const session = await auth.api.getSession({
        headers: new Headers({ cookie: path.includes("link") ? flow.cookie : cookies(result) }),
      });
      expect(session?.user.id).toBe(user.id);
      const [connections] = await getTestDb()`SELECT count(*)::int AS count FROM connections WHERE organization_id = ${org.id}`;
      expect(connections.count).toBe(0);
      const state = flow.callback.searchParams.get("state")!;
      expect(await getTestDb()`SELECT id FROM verification WHERE identifier = ${state}`).toHaveLength(0);
    },
  );

  it("keeps two orgs' credentials separate and overwrites forged client context", async () => {
    const first = await fixture();
    const second = await fixture("other-acme", true);
    const firstFlow = await start("acme", "sign-in/social", {
      lobuOAuthContext: { organizationId: second.org.id, provider: "google" },
    });
    const secondFlow = await start("other-acme");
    expect(await resolveRequestOrganizationId(new Request(firstFlow.callback))).toBe(first.org.id);
    expect(await resolveRequestOrganizationId(new Request(secondFlow.callback))).toBe(second.org.id);
    expect((await callback(firstFlow, { referer: `${ORIGIN}/other-acme` })).result.headers.get("location")).toBe(firstFlow.callbackURL);
    expect((await callback(secondFlow, { referer: `${ORIGIN}/acme` })).result.headers.get("location")).toBe(secondFlow.callbackURL);
    expect(tokenClients).toEqual(["acme-test-client", "other-test-client"]);
  });

  it("pins global flows to global config even with forged additionalData and callback referrer", async () => {
    const { org } = await fixture();
    const request = new Request(`${ORIGIN}/api/auth/sign-in/social`, {
      method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        provider: "google", callbackURL: `${ORIGIN}/connector/acme/connection`,
        additionalData: { lobuOAuthContext: { organizationId: org.id, provider: PROVIDER } },
      }),
    });
    const auth = await createAuth(getEnvFromProcess(), request);
    const response = await auth.handler(request);
    expect(response.status).toBe(200);
    const { url } = await response.json() as { url: string };
    const callbackUrl = new URL(`${ORIGIN}/api/auth/callback/google`);
    callbackUrl.searchParams.set("state", new URL(url).searchParams.get("state")!);
    expect(await resolveRequestOrganizationId(new Request(callbackUrl, { headers: { referer: `${ORIGIN}/acme` } }))).toBeNull();
    expect(tokenClients).toEqual([]);
  });

  it.each(["GET", "form", "json", "mixed-case-json"])("routes standard callbacks with %s state through the original org", async (method) => {
    const { org } = await fixture();
    const flow = await start();
    const state = flow.callback.searchParams.get("state")!;
    const url = new URL(`${ORIGIN}/api/auth/callback/${PROVIDER}`);
    let request: Request;
    if (method === "GET") {
      url.search = flow.callback.search;
      request = new Request(url, { headers: { cookie: flow.cookie } });
    } else {
      request = new Request(url, {
        method: "POST", headers: {
          cookie: flow.cookie,
          "content-type": method === "mixed-case-json" ? "Application/JSON" : method === "json" ? "application/json" : "application/x-www-form-urlencoded",
        },
        body: method.includes("json") ? JSON.stringify({ state, code: "synthetic-code" }) : new URLSearchParams({ state, code: "synthetic-code" }),
      });
    }
    expect(await resolveRequestOrganizationId(request)).toBe(org.id);
    if (method !== "GET") {
      // Standard callbacks forward POST to GET before validating/consuming state.
      clearAuthCacheForTests();
      const auth = await createAuth(getEnvFromProcess(), request);
      const result = await auth.handler(request);
      expect(result.status).toBe(302);
      const next = new Request(result.headers.get("location")!, { headers: { cookie: flow.cookie } });
      expect(await resolveRequestOrganizationId(next)).toBe(org.id);
      expect(new URL(next.url).searchParams.get("state")).toBe(state);
    }
    expect(tokenClients).toEqual([]);
  });

  it.each(["missing", "unknown", "expired-row", "expired-payload", "unbound", "state-mismatch", "provider-mismatch", "missing-org", "malformed", "duplicate", "empty-query"])(
    "rejects invalid callback context before exchange through the production HTTP wrapper: %s",
    async (kind) => {
      await fixture();
      const flow = await start();
      const sql = getTestDb();
      const state = flow.callback.searchParams.get("state")!;
      const [row] = await sql<{ value: string }[]>`SELECT value FROM verification WHERE identifier = ${state}`;
      const payload = JSON.parse(row.value);
      if (kind === "missing") flow.callback.searchParams.delete("state");
      if (kind === "unknown") flow.callback.searchParams.set("state", "unknown-synthetic-state");
      if (kind === "expired-row") await sql`UPDATE verification SET "expiresAt" = now() - interval '1 minute' WHERE identifier = ${state}`;
      if (kind === "expired-payload") payload.expiresAt = Date.now() - 1;
      if (kind === "unbound") delete payload.lobuOAuthContext;
      if (kind === "state-mismatch") payload.oauthState = "wrong-state";
      if (kind === "provider-mismatch") flow.callback.pathname = "/api/auth/callback/google";
      if (kind === "missing-org") payload.lobuOAuthContext.organizationId = "00000000-0000-4000-8000-000000000000";
      if (kind === "duplicate") flow.callback.searchParams.append("state", "another-state");
      if (kind === "empty-query") {
        flow.callback.pathname = `/api/auth/callback/${PROVIDER}`;
        flow.callback.searchParams.set("state", "");
      }
      await sql`UPDATE verification SET value = ${kind === "malformed" ? "{" : JSON.stringify(payload)} WHERE identifier = ${state}`;
      const request = new Request(flow.callback, {
        headers: { cookie: flow.cookie, referer: `${ORIGIN}/acme`, ...(kind === "empty-query" ? { "content-type": "application/json" } : {}) },
        ...(kind === "empty-query" ? { method: "POST", body: JSON.stringify({ state, code: "synthetic-code" }) } : {}),
      });
      const wrapper = buildWrapperApp(getEnvFromProcess(), null, app);
      const response = await wrapper.fetch(request);
      expect(response.status, await response.clone().text()).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ message: "Invalid OAuth state. Restart sign-in." });
      expect(tokenClients).toEqual([]);
    },
  );

  it.each(["", "better-auth.state=forged"])("still requires Better Auth's signed cookie: %s", async (cookie) => {
    await fixture();
    const flow = await start();
    const { result } = await callback(flow, { cookie });
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toContain("error=");
    expect(tokenClients).toEqual([]);
    // Rejection must not consume the valid flow.
    expect((await callback(flow)).result.headers.get("location")).toBe(flow.callbackURL);
    expect(tokenClients).toEqual(["acme-test-client"]);
  });

  it("rejects replay after successful consumption", async () => {
    await fixture();
    const flow = await start();
    await callback(flow);
    const response = await buildWrapperApp(getEnvFromProcess(), null, app).fetch(new Request(flow.callback, { headers: { cookie: flow.cookie } }));
    expect(response.status).toBe(400);
    expect(tokenClients).toEqual(["acme-test-client"]);
  });

  it("retains the original org for account-profile provisioning after Better Auth consumes state", async () => {
    const { org } = await fixture("acme", false, true);
    const flow = await start();
    expect((await callback(flow)).result.headers.get("location")).toBe(flow.callbackURL);
    const profiles = await getTestDb()`SELECT organization_id FROM auth_profiles WHERE profile_kind = 'oauth_account'`;
    expect(profiles).toHaveLength(1);
    expect(profiles[0].organization_id).toBe(org.id);
  });
});
