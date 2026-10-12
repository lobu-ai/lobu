import { beforeAll, beforeEach, expect, test } from "vitest";
import LinkedInConnector from "../linkedin.connector";
import {
  cleanupTestDatabase,
  getTestDb,
} from "../../../packages/server/src/__tests__/setup/test-db";
import {
  createTestConnectorDefinition,
  seedOwnerContext,
} from "../../../packages/server/src/__tests__/setup/test-fixtures";
import {
  clearLoginProviderCachesForTests,
  getAuthConfig,
  getEnabledLoginProviderConfigs,
  resolveRequestOrganizationId,
} from "../../../packages/server/src/auth/config";
import { provisionConnectorFromSocialLogin } from "../../../packages/server/src/auth/social-login-provisioning";
import type { Env } from "../../../packages/server/src/index";
import { buildConnectionsNamespace } from "../../../packages/server/src/sandbox/namespaces/connections";
import { createAuthProfile } from "../../../packages/server/src/utils/auth-profiles";
import { initWorkspaceProvider } from "../../../packages/server/src/workspace";

const definition = new LinkedInConnector().definition;
const credentials = {
  LINKEDIN_CLIENT_ID: "synthetic-linkedin-client",
  LINKEDIN_CLIENT_SECRET: "synthetic-linkedin-secret",
};
const env = credentials as unknown as Env;

beforeAll(() => initWorkspaceProvider());
beforeEach(async () => {
  await cleanupTestDatabase();
  clearLoginProviderCachesForTests();
});

async function setup() {
  const owner = await seedOwnerContext({ orgName: "Synthetic LinkedIn login" });
  await createTestConnectorDefinition({
    key: definition.key,
    name: definition.name,
    version: definition.version,
    organization_id: owner.org.id,
    auth_schema: { ...definition.authSchema },
    feeds_schema: {},
  });
  const sql = getTestDb();
  await sql`UPDATE connector_definitions SET browser = ${JSON.stringify(definition.browser)}::jsonb
    WHERE organization_id = ${owner.org.id} AND key = ${definition.key}`;
  await createAuthProfile({
    organizationId: owner.org.id,
    connectorKey: definition.key,
    displayName: "Synthetic LinkedIn app",
    profileKind: "oauth_app",
    provider: "linkedin",
    authData: credentials,
    status: "active",
    createdBy: owner.user.id,
  });
  return { ...owner, client: buildConnectionsNamespace(owner.ctx, env) };
}

test("enabling LinkedIn discovers identity login after browser and export methods", async () => {
  const { org, client } = await setup();
  expect(
    await client.toggleConnectorLogin({
      connector_key: definition.key,
      enabled: true,
    })
  ).toMatchObject({ success: true, login_enabled: true });
  clearLoginProviderCachesForTests();
  const config = await getAuthConfig({} as Env, { organizationId: org.id });
  expect(config.social.linkedin).toBe(true);
  expect(config.socialMeta.linkedin).toMatchObject({ name: "LinkedIn" });
  const providers = await getEnabledLoginProviderConfigs(org.id);
  expect(
    providers.find((provider) => provider.provider === "linkedin")
  ).toMatchObject({
    connectorKey: definition.key,
    loginScopes: ["openid", "profile", "email"],
    authorizationUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    userinfoUrl: "https://api.linkedin.com/v2/userinfo",
    tokenEndpointAuthMethod: "client_secret_post",
  });
});

test.each([
  "create",
  "connect",
] as const)("%s still asks for a browser instead of starting OAuth", async (action) => {
  const { org, client } = await setup();
  const result = await client.manage({ action, connector_key: definition.key });
  expect(result).toMatchObject({
    status: "setup_required",
    setup_family: "browser",
    next_action: "pair_browser",
  });
  expect(result).not.toHaveProperty("connect_url");
  const sql = getTestDb();
  expect(
    await sql`SELECT id FROM auth_profiles
      WHERE organization_id = ${org.id} AND profile_kind = 'oauth_account'`
  ).toHaveLength(0);
  expect(
    await sql`SELECT id FROM connections
      WHERE organization_id = ${org.id} AND connector_key = ${definition.key}`
  ).toHaveLength(0);
});

test("explicit local export stays active without OAuth through a metadata update", async () => {
  const { org, client } = await setup();
  const result = (await client.create({
    connector_key: definition.key,
    auth_profile_slug: null,
    app_auth_profile_slug: null,
  })) as { connection: { id: number } };
  expect(result).toHaveProperty("connection.id");
  await client.update({
    connection_id: result.connection.id,
    display_name: "Synthetic local export",
  });
  const sql = getTestDb();
  const [saved] =
    await sql`SELECT display_name, status, auth_profile_id, app_auth_profile_id
    FROM connections WHERE organization_id = ${org.id} AND id = ${result.connection.id}`;
  expect(saved).toEqual({
    display_name: "Synthetic local export",
    status: "active",
    auth_profile_id: null,
    app_auth_profile_id: null,
  });
});

test("LinkedIn sign-in never provisions source accounts, connections or feeds", async () => {
  const { org, user } = await setup();
  const request = new Request(`https://lobu.example/${org.slug}`);
  expect(await resolveRequestOrganizationId(request)).toBe(org.id);
  await provisionConnectorFromSocialLogin({
    env,
    request,
    account: {
      id: "synthetic-linkedin-account",
      userId: user.id,
      providerId: "linkedin",
      scope: "openid profile email",
    },
  });
  const sql = getTestDb();
  expect(
    await sql`SELECT id FROM auth_profiles
    WHERE organization_id = ${org.id} AND profile_kind = 'oauth_account'`
  ).toHaveLength(0);
  expect(
    await sql`SELECT id FROM connections
    WHERE organization_id = ${org.id} AND connector_key = ${definition.key}`
  ).toHaveLength(0);
  expect(
    await sql`SELECT id FROM feeds WHERE organization_id = ${org.id}`
  ).toHaveLength(0);
});
