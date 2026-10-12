import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import XConnector from "@lobu/connectors/x";
import { clearLoginProviderCachesForTests } from "../../../auth/config";
import { normalizeScopeList } from "../../../auth/oauth/scopes";
import { clearAuthCacheForTests, createAuth } from "../../../auth/index";
import { getEnvFromProcess } from "../../../utils/env";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestOrganization } from "../../setup/test-fixtures";

const ORIGIN = "http://localhost";
const ACCOUNT_ID = "100000000000000000001";
const SCOPES = ["users.read", "tweet.read", "users.email"];
const definition = new XConnector().definition;

function cookies(response: Response): string {
  return response.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
}

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
      VALUES (${org.id}, ${definition.key}, ${definition.name}, ${definition.version},
        ${sql.json(definition.authSchema)}, true, 'active', now(), now())`;

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
    expect(authorize.searchParams.get("scope")?.split(" ")).toEqual(SCOPES);
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
        return Response.json({ access_token: "synthetic-access", token_type: "bearer", scope: SCOPES.join(" "), expires_in: 7200 });
      }
      expect(target.pathname).toBe("/2/users/me");
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-access");
      return Response.json({ data: {
        id: ACCOUNT_ID, name: "Alice", username: "synthetic_x_user",
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
    expect(account).toMatchObject({ accountId: ACCOUNT_ID, userId: session.user.id, refreshToken: null });
    expect(normalizeScopeList(account.scope)).toEqual(SCOPES);
    expect(requests).toEqual([
      "/2/oauth2/token", "/2/users/me?user.fields=profile_image_url", "/2/users/me?user.fields=confirmed_email",
    ]);
    expect(await sql`SELECT id FROM connections WHERE organization_id = ${org.id} AND connector_key = 'x'`).toHaveLength(0);
    expect(await sql`SELECT id FROM auth_profiles WHERE organization_id = ${org.id} AND profile_kind = 'oauth_account'`).toHaveLength(0);
    expect(await sql`SELECT id FROM feeds WHERE organization_id = ${org.id}`).toHaveLength(0);
  });
});
