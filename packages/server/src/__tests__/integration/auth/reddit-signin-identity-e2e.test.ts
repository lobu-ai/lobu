import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import RedditConnector from "@lobu/connectors/reddit";
import XConnector from "@lobu/connectors/x";
import { Hono } from "hono";
import { connectRoutes } from "../../../connect/routes";
import { clearLoginProviderCachesForTests } from "../../../auth/config";
import { normalizeScopeList } from "../../../auth/oauth/scopes";
import { clearAuthCacheForTests, createAuth } from "../../../auth/index";
import { createAuthProfile } from "../../../utils/auth-profiles";
import { getEnvFromProcess } from "../../../utils/env";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestOrganization } from "../../setup/test-fixtures";

const ORIGIN = "http://localhost";
const CLIENT_ID = "synthetic-reddit-client";
const CLIENT_SECRET = "synthetic-reddit-secret";
const definition = new RedditConnector().definition;
const X_ACCOUNT_ID = "100000000000000000001";
const X_SCOPES = ["users.read", "tweet.read", "users.email"];
const xDefinition = new XConnector().definition;
const callbackApp = new Hono().route("/connect", connectRoutes);

function cookies(response: Response): string {
  return response.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
}

describe("Reddit identity-only login through the real Better Auth handler", () => {
  const backup: Record<string, string | undefined> = {};

  async function fixture() {
    const sql = getTestDb();
    const org = await createTestOrganization({ name: "Acme", slug: "acme", visibility: "public" });
    await sql`INSERT INTO connector_definitions
      (organization_id, key, name, version, auth_schema, login_enabled, status, created_at, updated_at)
      VALUES (${org.id}, ${definition.key}, ${definition.name}, ${definition.version},
        ${sql.json(definition.authSchema)}, true, 'active', now(), now())`;
    const app = await createAuthProfile({
      organizationId: org.id, connectorKey: "reddit", displayName: "Reddit app",
      profileKind: "oauth_app", provider: "reddit",
      authData: { REDDIT_CLIENT_ID: CLIENT_ID, REDDIT_CLIENT_SECRET: CLIENT_SECRET },
    });
    return { org, app };
  }

  beforeAll(async () => { await initWorkspaceProvider(); });
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearAuthCacheForTests();
    clearLoginProviderCachesForTests();
    for (const key of ["BETTER_AUTH_SECRET", "REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"]) {
      backup[key] = process.env[key];
    }
    process.env.BETTER_AUTH_SECRET = "a".repeat(64);
    delete process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_CLIENT_SECRET;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(backup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearAuthCacheForTests();
    clearLoginProviderCachesForTests();
  });

  it("reuses the workspace OAuth app and keeps Reddit accounts distinct without creating feeds", async () => {
    const sql = getTestDb();
    const { org, app } = await fixture();

    let profileId = "abc123";
    let profileName = "synthetic_alice";
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const target = new URL(request.url);
      requests.push(target.origin + target.pathname);
      expect(request.headers.get("user-agent")).toBeTruthy();
      if (target.origin === "https://www.reddit.com" && target.pathname === "/api/v1/access_token") {
        expect(request.headers.get("authorization")).toBe(`Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`);
        const form = new URLSearchParams(await request.text());
        expect(form.get("code")).toBe("synthetic-code");
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("redirect_uri")).toBe(`${ORIGIN}/connect/oauth/callback`);
        return Response.json({ access_token: "synthetic-access", token_type: "bearer", scope: "identity", expires_in: 3600 });
      }
      expect(target.origin + target.pathname).toBe("https://oauth.reddit.com/api/v1/me");
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-access");
      return Response.json({
        id: profileId, name: profileName, oauth_client_id: CLIENT_ID,
        // /api/v1/me only reports a verification flag, never the address itself.
        has_verified_email: true, icon_img: "https://images.example.test/avatar.png?size=128",
      });
    });

    const signIn = async () => {
      const startRequest = new Request(`${ORIGIN}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, referer: `${ORIGIN}/acme` },
        body: JSON.stringify({ provider: "reddit", callbackURL: `${ORIGIN}/acme` }),
      });
      const auth = await createAuth(getEnvFromProcess(), startRequest.clone());
      const start = await auth.handler(startRequest);
      expect(start.status, await start.clone().text()).toBe(200);
      const { url } = await start.json() as { url: string };
      const authorize = new URL(url);
      expect(authorize.origin + authorize.pathname).toBe("https://www.reddit.com/api/v1/authorize");
      expect(authorize.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(authorize.searchParams.get("scope")).toBe("identity");
      // Login never asks for a refresh token; `duration=permanent` is the connect path.
      expect(authorize.searchParams.get("duration")).toBeNull();
      expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/connect/oauth/callback`);
      expect(authorize.searchParams.get("state")).toBeTruthy();

      const callback = new URL(authorize.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", authorize.searchParams.get("state")!);
      callback.searchParams.set("code", "synthetic-code");
      callback.searchParams.set("provider", "google"); // Must not select a provider from query input.
      clearAuthCacheForTests();
      clearLoginProviderCachesForTests();
      const callbackRequest = new Request(callback, { headers: { cookie: cookies(start), referer: `${ORIGIN}/wrong-workspace` } });
      const finish = await callbackApp.request(callbackRequest, undefined, getEnvFromProcess());
      expect(finish.status).toBe(302);
      expect(finish.headers.get("location")).toBe(`${ORIGIN}/acme`);
      const sessionCookie = cookies(finish);
      expect(sessionCookie).toContain("session_token=");
      const exchangesBeforeReplay = requests.length;
      const replay = await callbackApp.request(callbackRequest.clone(), undefined, getEnvFromProcess());
      expect(replay.status).toBe(404);
      expect(requests).toHaveLength(exchangesBeforeReplay);
      const sessionResponse = await auth.handler(new Request(`${ORIGIN}/api/auth/get-session`, {
        headers: { cookie: sessionCookie },
      }));
      return await sessionResponse.json() as { user: { id: string; email: string; emailVerified: boolean } };
    };

    const first = await signIn();
    expect(first.user).toMatchObject({ email: "abc123@reddit.invalid", emailVerified: false });
    profileId = "def456";
    profileName = "synthetic_bob";
    const second = await signIn();
    expect(second.user.id).not.toBe(first.user.id);
    expect(second.user).toMatchObject({ email: "def456@reddit.invalid", emailVerified: false });
    profileId = "abc123";
    profileName = "synthetic_alice_changed";
    expect((await signIn()).user.id).toBe(first.user.id);

    const accounts = await sql`SELECT "accountId", "userId", scope, "refreshToken"
      FROM account WHERE "providerId" = 'reddit' ORDER BY "accountId"`;
    expect(accounts).toEqual([
      { accountId: "abc123", userId: first.user.id, scope: "identity", refreshToken: null },
      { accountId: "def456", userId: second.user.id, scope: "identity", refreshToken: null },
    ]);
    expect(requests).toEqual(Array.from({ length: 3 }, () => [
      "https://www.reddit.com/api/v1/access_token", "https://oauth.reddit.com/api/v1/me",
    ]).flat());
    expect(await sql`SELECT id FROM connections WHERE organization_id = ${org.id} AND connector_key = 'reddit'`).toHaveLength(0);
    expect(await sql`SELECT id FROM auth_profiles WHERE organization_id = ${org.id} AND profile_kind = 'oauth_account'`).toHaveLength(0);
    expect(await sql`SELECT id FROM feeds WHERE organization_id = ${org.id}`).toHaveLength(0);
    expect(await sql`SELECT id FROM auth_profiles WHERE organization_id = ${org.id} AND profile_kind = 'oauth_app'`).toEqual([{ id: app.id }]);
  });

  it.each(["missing", "unknown", "expired", "malformed", "wrong-provider", "missing-org", "state-mismatch", "duplicate", "no-cookie", "denied"])(
    "rejects %s state or consent before token exchange at the shared callback", async (kind) => {
      await fixture();
      const sql = getTestDb();
      const request = new Request(`${ORIGIN}/api/auth/sign-in/social`, {
        method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, referer: `${ORIGIN}/acme` },
        body: JSON.stringify({ provider: "reddit", callbackURL: `${ORIGIN}/acme` }),
      });
      const auth = await createAuth(getEnvFromProcess(), request.clone());
      const start = await auth.handler(request);
      expect(start.status).toBe(200);
      const { url } = await start.json() as { url: string };
      const authorize = new URL(url);
      const state = authorize.searchParams.get("state")!;
      const callback = new URL(authorize.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", state);
      callback.searchParams.set("code", "synthetic-code");
      if (kind === "missing") callback.searchParams.delete("state");
      if (kind === "unknown") callback.searchParams.set("state", "unknown-synthetic-state");
      if (kind === "expired") await sql`UPDATE verification SET "expiresAt" = now() - interval '1 minute' WHERE identifier = ${state}`;
      if (kind === "malformed") await sql`UPDATE verification SET value = 'not-json' WHERE identifier = ${state}`;
      if (["wrong-provider", "missing-org", "state-mismatch"].includes(kind)) {
        const [row] = await sql`SELECT value FROM verification WHERE identifier = ${state}`;
        const value = JSON.parse(row.value);
        if (kind === "wrong-provider") value.lobuOAuthContext.provider = "google";
        if (kind === "missing-org") value.lobuOAuthContext.organizationId = "00000000-0000-4000-8000-000000000000";
        if (kind === "state-mismatch") value.oauthState = "different-synthetic-state";
        await sql`UPDATE verification SET value = ${JSON.stringify(value)} WHERE identifier = ${state}`;
      }
      if (kind === "duplicate") callback.searchParams.append("state", "another-synthetic-state");
      if (kind === "denied") {
        callback.searchParams.delete("code");
        callback.searchParams.set("error", "access_denied");
      }
      const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Must not exchange a token"));
      clearAuthCacheForTests();
      clearLoginProviderCachesForTests();
      const result = await callbackApp.request(new Request(callback, {
        headers: kind === "no-cookie" ? {} : { cookie: cookies(start) },
      }), undefined, getEnvFromProcess());
      if (kind === "no-cookie" || kind === "denied") {
        expect(result.status).toBe(302);
        expect(result.headers.get("location")).toContain("error=");
      } else expect(result.status).toBeGreaterThanOrEqual(400);
      expect(cookies(result)).not.toContain("session_token=");
      expect(network).not.toHaveBeenCalled();
      expect(await sql`SELECT id FROM account WHERE "providerId" = 'reddit'`).toHaveLength(0);
    },
  );
});

describe("X identity-only login through the real Better Auth handler", () => {
  const backup: Record<string, string | undefined> = {};

  beforeAll(async () => { await initWorkspaceProvider(); });
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearAuthCacheForTests();
    clearLoginProviderCachesForTests();
    for (const key of ["BETTER_AUTH_SECRET", "TWITTER_CLIENT_ID", "TWITTER_CLIENT_SECRET"]) backup[key] = process.env[key];
    process.env.BETTER_AUTH_SECRET = "a".repeat(64);
    process.env.TWITTER_CLIENT_ID = "synthetic-x-client";
    process.env.TWITTER_CLIENT_SECRET = "synthetic-x-secret";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(backup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearAuthCacheForTests();
    clearLoginProviderCachesForTests();
  });

  it.each([true, false])("creates a session without a source connection (confirmed email: %s)", async (hasEmail) => {
    const sql = getTestDb();
    const org = await createTestOrganization({ name: "Acme", slug: "acme", visibility: "public" });
    await sql`INSERT INTO connector_definitions
      (organization_id, key, name, version, auth_schema, login_enabled, status, created_at, updated_at)
      VALUES (${org.id}, ${xDefinition.key}, ${xDefinition.name}, ${xDefinition.version},
        ${sql.json(xDefinition.authSchema)}, true, 'active', now(), now())`;

    // Exercise the actual connector declaration, not a copied OAuth fixture.
    const startRequest = new Request(`${ORIGIN}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, referer: `${ORIGIN}/acme` },
      body: JSON.stringify({ provider: "twitter", callbackURL: `${ORIGIN}/acme` }),
    });
    const auth = await createAuth(getEnvFromProcess(), startRequest.clone());
    const start = await auth.handler(startRequest);
    expect(start.status, await start.clone().text()).toBe(200);
    const { url } = await start.json() as { url: string };
    const authorize = new URL(url);
    expect(authorize.origin + authorize.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(authorize.searchParams.get("scope")?.split(" ")).toEqual(X_SCOPES);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/twitter`);

    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const target = new URL(request.url);
      requests.push(target.pathname + target.search);
      expect(target.origin).toBe("https://api.x.com");
      if (target.pathname === "/2/oauth2/token") {
        const form = new URLSearchParams(await request.text());
        expect(form.get("code")).toBe("synthetic-code");
        expect(form.get("code_verifier")).toBeTruthy();
        expect(form.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/twitter`);
        return Response.json({ access_token: "synthetic-access", token_type: "bearer", scope: X_SCOPES.join(" "), expires_in: 7200 });
      }
      expect(target.pathname).toBe("/2/users/me");
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-access");
      return Response.json({ data: {
        id: X_ACCOUNT_ID, name: "Alice", username: "synthetic_x_user",
        profile_image_url: "https://images.example.test/alice.png",
        ...(hasEmail && target.searchParams.get("user.fields") === "confirmed_email" ? { confirmed_email: "alice@acme.test" } : {}),
      } });
    });

    const callback = new URL(authorize.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorize.searchParams.get("state")!);
    callback.searchParams.set("code", "synthetic-code");
    // A fresh instance proves org config survives the provider round trip.
    clearAuthCacheForTests();
    clearLoginProviderCachesForTests();
    const callbackRequest = new Request(callback, { headers: { cookie: cookies(start) } });
    const callbackAuth = await createAuth(getEnvFromProcess(), callbackRequest);
    const finish = await callbackAuth.handler(callbackRequest);
    expect(finish.status).toBe(302);
    expect(finish.headers.get("location")).toBe(`${ORIGIN}/acme`);
    const sessionCookie = cookies(finish);
    expect(sessionCookie).toContain("session_token=");
    const sessionResponse = await callbackAuth.handler(new Request(`${ORIGIN}/api/auth/get-session`, {
      headers: { cookie: sessionCookie },
    }));
    const session = await sessionResponse.json() as { user: { id: string; email: string; emailVerified: boolean } };
    expect(session.user).toMatchObject({
      email: hasEmail ? "alice@acme.test" : "synthetic_x_user",
      emailVerified: hasEmail,
    });
    const [account] = await sql`SELECT "accountId", "userId", scope, "refreshToken"
      FROM account WHERE "providerId" = 'twitter'`;
    expect(account).toMatchObject({ accountId: X_ACCOUNT_ID, userId: session.user.id, refreshToken: null });
    expect(normalizeScopeList(account.scope)).toEqual(X_SCOPES);
    expect(requests).toEqual([
      "/2/oauth2/token", "/2/users/me?user.fields=profile_image_url", "/2/users/me?user.fields=confirmed_email",
    ]);
    expect(await sql`SELECT id FROM connections WHERE organization_id = ${org.id} AND connector_key = 'x'`).toHaveLength(0);
    expect(await sql`SELECT id FROM auth_profiles WHERE organization_id = ${org.id} AND profile_kind = 'oauth_account'`).toHaveLength(0);
    expect(await sql`SELECT id FROM feeds WHERE organization_id = ${org.id}`).toHaveLength(0);
  });
});
