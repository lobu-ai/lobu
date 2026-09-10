import { createHmac } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { getDb } from "../../db/client.js";
import {
  createInstallRoutes,
} from "../routes/public/app-install.js";
import type { ConnectorWebhookSchema } from "@lobu/connector-sdk";
import {
  type AppWebhookProvider,
  createAppWebhookRoutes,
  createChatWebhookDelivery,
  createDeclaredAppWebhookProvider,
  verifyDeclaredWebhook,
} from "../routes/public/app-webhooks.js";
import { createPostgresAppInstallationStore } from "../../lobu/stores/app-installation-store.js";
import { __resetPublicOriginCachesForTests } from "../../utils/public-origin.js";

/** Slack's DECLARED webhook schema (mirror of the slack connector's block). */
const SLACK_WEBHOOK_SCHEMA: ConnectorWebhookSchema = {
  signatureHeader: "x-slack-signature",
  algorithm: "sha256",
  signaturePrefix: "v0=",
  signingBaseTemplate: "v0:{timestamp}:{body}",
  timestampHeader: "x-slack-request-timestamp",
  freshnessSeconds: 300,
  delivery: "app_installation",
  routingKeyPaths: ["team_id", "team.id", "event.team_id"],
};

/** verifySlackSignature shim over the generic engine (preserves the old call shape). */
function verifySlackSignature(
  rawBody: Uint8Array,
  headers: Headers,
  signingSecret: string,
): boolean {
  return verifyDeclaredWebhook(rawBody, headers, signingSecret, SLACK_WEBHOOK_SCHEMA);
}

/** Build a slack app-webhook provider from the declared schema + delivery hook. */
function slackProvider(
  handleChatAppWebhook: (request: Request) => Promise<Response>,
): AppWebhookProvider {
  return createDeclaredAppWebhookProvider({
    provider: "slack",
    appId: "slack-app",
    webhookSchema: SLACK_WEBHOOK_SCHEMA,
    handleDelivery: createChatWebhookDelivery({ handleChatAppWebhook }),
  });
}
import { ensureDbForGatewayTests, resetTestDatabase } from "./helpers/db-setup.js";

/** Seed a Slack connector_definitions row so getOrgAppInstallationMethod resolves. */
async function seedSlackConnectorDef(
  organizationId: string,
  clientId = "client-123",
  scopes = ["chat:write", "commands"],
): Promise<void> {
  const sql = getDb();
  // Ensure the org row exists first (FK constraint).
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${organizationId}, ${organizationId}, ${organizationId})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO connector_definitions (organization_id, key, name, version, auth_schema, status)
    VALUES (
      ${organizationId}, ${"slack"}, ${"Slack"}, ${"1.0.0"},
      ${sql.json({
        methods: [
          {
            type: "app_installation",
            provider: "slack",
            providerInstance: "cloud",
            clientIdKey: "SLACK_CLIENT_ID",
            clientSecretKey: "SLACK_CLIENT_SECRET",
            webhookSecretKey: "SLACK_SIGNING_SECRET",
            permissions: scopes,
          },
        ],
      })},
      ${"active"}
    )
    ON CONFLICT DO NOTHING
  `;
  // The resolver reads from env by the DECLARED key name, so set it.
  process.env.SLACK_CLIENT_ID = clientId;
}

describe("slack OAuth install routes", () => {
  const originalClientId = process.env.SLACK_CLIENT_ID;
  const originalPublicGatewayUrl = process.env.PUBLIC_GATEWAY_URL;

  let completeSlackOAuthInstall: ReturnType<typeof mock>;
  let parkSlackPendingInstall: ReturnType<typeof mock>;
  let app: Hono;
  // Per-test org id injected into the Hono context — mirrors what
  // `lobuApp.use('*', ...)` sets in production (see lobu/gateway.ts). The
  // /slack/install + /slack/oauth_callback handlers require a non-empty
  // value to scope install state to the initiating tenant.
  let sessionOrgId: string | null;

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();

    // The claim redirect resolves the public web origin from PUBLIC_GATEWAY_URL
    // (getConfiguredPublicOrigin), NOT the injected getPublicGatewayUrl dep, so
    // the install callback can send the installer to the generic claim page.
    process.env.PUBLIC_GATEWAY_URL = "https://gateway.example.com";
    __resetPublicOriginCachesForTests();

    completeSlackOAuthInstall = mock(async () => ({
      teamId: "T123",
      teamName: "Acme",
      installationId: "slackinst-1",
    }));
    parkSlackPendingInstall = mock(async () => ({
      externalRef: "T123",
      subjectName: "Acme",
    }));

    sessionOrgId = "org-default";

    await seedSlackConnectorDef(sessionOrgId);

    const installRouter = createInstallRoutes({
      installationStore: createPostgresAppInstallationStore(),
      resolveInstallOrgId: async (c) => {
        const fromCtx = c.get("organizationId" as never) as string | null | undefined;
        return typeof fromCtx === "string" && fromCtx.length > 0 ? fromCtx : null;
      },
      // Membership stand-in: the completing user is a member of the target org
      // iff their session-context org equals it. Drives the cross-org 403 test.
      verifyInstallOrgAccess: async (c, organizationId) => {
        const fromCtx = c.get("organizationId" as never) as string | null | undefined;
        return typeof fromCtx === "string" && fromCtx === organizationId;
      },
      verifyInstallOrgAdminAccess: async () => false,
      getPublicGatewayUrl: () => "https://gateway.example.com",
      // The generic engine mounts /slack/install + /slack/oauth_callback from
      // this declared oauth-code-exchange integration; EVERY callback now parks
      // pending via completeChatPendingInstall → the claim flow (no binding).
      integrations: [
        {
          connectorKey: "slack",
          provider: "slack",
          method: {
            type: "app_installation",
            provider: "slack",
            installShape: "oauth-code-exchange",
            authorizeUrl: "https://slack.com/oauth/v2/authorize",
            tokenUrl: "https://slack.com/api/oauth.v2.access",
            clientIdKey: "SLACK_CLIENT_ID",
          },
          deliveryKind: "chat",
        },
      ],
      // Both stateless AND state-carrying callbacks now park pending → claim.
      // The org hint (peeked from state, when present) is passed for BYO
      // per-org cred resolution, but NEVER binds the install.
      completeChatPendingInstall: (_provider, req, redirectUri, orgId) =>
        parkSlackPendingInstall(req, redirectUri, orgId),
    });

    app = new Hono();
    app.use("*", async (c, next) => {
      if (sessionOrgId !== null) c.set("organizationId" as never, sessionOrgId);
      await next();
    });
    app.route("", installRouter);
  });

  afterEach(() => {
    if (originalClientId === undefined) {
      delete process.env.SLACK_CLIENT_ID;
    } else {
      process.env.SLACK_CLIENT_ID = originalClientId;
    }
    if (originalPublicGatewayUrl === undefined) {
      delete process.env.PUBLIC_GATEWAY_URL;
    } else {
      process.env.PUBLIC_GATEWAY_URL = originalPublicGatewayUrl;
    }
    __resetPublicOriginCachesForTests();
  });

  test("GET /slack/install redirects to Slack OAuth and stores state", async () => {
    const response = await app.request("/slack/install");

    expect(response.status).toBe(302);

    const location = response.headers.get("location");
    expect(location).toBeTruthy();

    const redirectUrl = new URL(location!);
    expect(redirectUrl.origin).toBe("https://slack.com");
    expect(redirectUrl.pathname).toBe("/oauth/v2/authorize");
    expect(redirectUrl.searchParams.get("client_id")).toBe("client-123");
    expect(redirectUrl.searchParams.get("scope")).toBe("chat:write,commands");
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      "https://gateway.example.com/slack/oauth_callback"
    );

    const state = redirectUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    const sql = getDb();
    const rows = await sql`
      SELECT payload FROM oauth_states
      WHERE id = ${state} AND scope = 'slack:oauth:state' AND expires_at > now()
    `;
    expect(rows.length).toBe(1);
    const payload = (rows[0] as any).payload;
    expect(payload.redirectUri).toBe(
      "https://gateway.example.com/slack/oauth_callback"
    );
    expect(payload.organizationId).toBe("org-default");
    expect(typeof payload.createdAt).toBe("number");
  });

  test("GET /slack/install no longer hard-401s a logged-out user; without resolvable creds it reports not_configured", async () => {
    // Bug C fix: a bound org is NO LONGER a gate on starting the install — the
    // claim flow owns sign-in and tenant selection. With no org AND no primed
    // bundled (hosted) creds, there's simply nothing to build the authorize URL
    // from, so we report `not_configured` (503) — NOT the old "Sign in to an
    // organization" 401. When hosted bundled creds ARE primed at boot, this same
    // logged-out request instead redirects to Slack (landing-page "Add to Slack").
    sessionOrgId = null;
    const response = await app.request("/slack/install");
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).not.toContain("Sign in to an organization");
    expect(body).toContain("Connection setup required");
    expect(body).toContain("Return to Lobu");
    expect(body).toContain("slack_not_configured");
  });

  test("GET /slack/oauth_callback (no state, marketplace) parks pending and redirects to claim", async () => {
    // A Slack-INITIATED (marketplace) install: `code`, no Lobu state. Parks the
    // workspace as an unclaimed pending install and sends the installer into the
    // claim flow. No org hint to pass (no state), so hosted/bundled creds.
    const response = await app.request(
      "/slack/oauth_callback?code=test-code&state=missing"
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://gateway.example.com/connector/slack/connection?ref=T123"
    );
    // Never binds via the completion adapter — no org to bind to.
    expect(completeSlackOAuthInstall).not.toHaveBeenCalled();
    expect(parkSlackPendingInstall).toHaveBeenCalledTimes(1);
    // No state peeked → no org hint.
    expect(parkSlackPendingInstall.mock.calls[0]?.[2] ?? null).toBeNull();
  });

  test("BUG C: a state-carrying (logged-in) callback does NOT bind to the state's org; it parks pending and redirects to claim", async () => {
    const sql = getDb();
    const expiresAt = new Date(Date.now() + 600_000);
    await sql`
      INSERT INTO oauth_states (id, scope, payload, expires_at)
      VALUES (
        'test-state',
        'slack:oauth:state',
        ${sql.json({
          createdAt: Date.now(),
          redirectUri: "https://gateway.example.com/slack/oauth_callback",
          organizationId: "org-default",
        })},
        ${expiresAt}
      )
    `;

    const response = await app.request(
      "/slack/oauth_callback?code=test-code&state=test-state"
    );

    // Converged automation: EVEN WITH state, the workspace lands in the claim
    // flow (org picker), NOT silently bound to the state's org. This is the
    // Bug C fix — no `/{orgSlug}/agents?connected=slack` redirect.
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://gateway.example.com/connector/slack/connection?ref=T123"
    );
    // The binding completion adapter must NOT be called.
    expect(completeSlackOAuthInstall).not.toHaveBeenCalled();
    // Pending parking runs; the state's org is passed ONLY as a creds hint.
    expect(parkSlackPendingInstall).toHaveBeenCalledTimes(1);
    expect(parkSlackPendingInstall.mock.calls[0]?.[2]).toBe("org-default");
    // State may be consumed for replay hygiene, but binding must not depend on it.
    const remaining = await sql`
      SELECT 1 FROM oauth_states WHERE id = 'test-state'
    `;
    expect(remaining.length).toBe(0);
  });

  test("GET /slack/oauth_callback does NOT reject when callback session org differs from install state", async () => {
    const sql = getDb();
    const expiresAt = new Date(Date.now() + 600_000);
    await sql`
      INSERT INTO oauth_states (id, scope, payload, expires_at)
      VALUES (
        'cross-org-state',
        'slack:oauth:state',
        ${sql.json({
          createdAt: Date.now(),
          redirectUri: "https://gateway.example.com/slack/oauth_callback",
          organizationId: "org-a",
        })},
        ${expiresAt}
      )
    `;
    // Caller signs in to org-b. Previously a 403 org_mismatch; now membership is
    // irrelevant — nothing binds to the state's org, so the callback converges to
    // the claim flow like every other install. No org-mismatch page.
    sessionOrgId = "org-b";
    const response = await app.request(
      "/slack/oauth_callback?code=test-code&state=cross-org-state"
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://gateway.example.com/connector/slack/connection?ref=T123"
    );
    expect(completeSlackOAuthInstall).not.toHaveBeenCalled();
    expect(parkSlackPendingInstall).toHaveBeenCalledTimes(1);
    // The peeked state's org (org-a) is passed as the creds hint.
    expect(parkSlackPendingInstall.mock.calls[0]?.[2]).toBe("org-a");
  });
});

// The Slack event webhook now flows through the generic app-webhook router
// (`POST /api/v1/app-webhooks/slack`). The Slack provider performs the edge
// `v0` signing verify and then delegates the FULL routing precedence (BYO
// agent_connections → active OAuth install → preview → OAuth fallback) to
// `ChatInstanceManager.handleSlackAppWebhook` — which is stubbed here so these
// tests pin the router→provider contract (verify + delegate), not the
// coordinator's internal precedence (covered in slack-connection-coordinator.test.ts).
const SLACK_SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

/** Compute a valid Slack `v0` signature header over (timestamp, body). */
function slackSignature(body: string, timestamp: string): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${createHmac("sha256", SLACK_SIGNING_SECRET).update(base).digest("hex")}`;
}

function nowTs(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe("verifySlackSignature", () => {
  test("accepts a fresh, correctly-signed delivery", () => {
    const body = JSON.stringify({ type: "event_callback" });
    const ts = nowTs();
    const headers = new Headers({
      "x-slack-request-timestamp": ts,
      "x-slack-signature": slackSignature(body, ts),
    });
    expect(
      verifySlackSignature(
        new TextEncoder().encode(body),
        headers,
        SLACK_SIGNING_SECRET,
      ),
    ).toBe(true);
  });

  test("rejects a stale timestamp (replay outside the 5-minute window)", () => {
    const body = "{}";
    const staleTs = String(Math.floor(Date.now() / 1000) - 60 * 6);
    const headers = new Headers({
      "x-slack-request-timestamp": staleTs,
      "x-slack-signature": slackSignature(body, staleTs),
    });
    expect(
      verifySlackSignature(
        new TextEncoder().encode(body),
        headers,
        SLACK_SIGNING_SECRET,
      ),
    ).toBe(false);
  });

  test("rejects a forged signature", () => {
    const body = "{}";
    const ts = nowTs();
    const headers = new Headers({
      "x-slack-request-timestamp": ts,
      "x-slack-signature": "v0=deadbeef",
    });
    expect(
      verifySlackSignature(
        new TextEncoder().encode(body),
        headers,
        SLACK_SIGNING_SECRET,
      ),
    ).toBe(false);
  });

  test("rejects a signature computed with the wrong secret", () => {
    const body = "{}";
    const ts = nowTs();
    const wrong = `v0=${createHmac("sha256", "not-the-secret").update(`v0:${ts}:${body}`).digest("hex")}`;
    const headers = new Headers({
      "x-slack-request-timestamp": ts,
      "x-slack-signature": wrong,
    });
    expect(
      verifySlackSignature(
        new TextEncoder().encode(body),
        headers,
        SLACK_SIGNING_SECRET,
      ),
    ).toBe(false);
  });

  test("rejects when headers are missing", () => {
    expect(
      verifySlackSignature(
        new TextEncoder().encode("{}"),
        new Headers(),
        SLACK_SIGNING_SECRET,
      ),
    ).toBe(false);
  });

  test("rejects a non-numeric timestamp", () => {
    const headers = new Headers({
      "x-slack-request-timestamp": "not-a-number",
      "x-slack-signature": "v0=abc",
    });
    expect(
      verifySlackSignature(
        new TextEncoder().encode("{}"),
        headers,
        SLACK_SIGNING_SECRET,
      ),
    ).toBe(false);
  });
});

describe("slack app-webhook route", () => {
  let handleSlackAppWebhook: ReturnType<typeof mock>;
  let app: Hono;

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    handleSlackAppWebhook = mock(async (request: Request) => {
      const body = await request.text();
      return new Response(`handled:${body}`, { status: 200 });
    });
    app = createAppWebhookRoutes({
      installationStore: createPostgresAppInstallationStore(),
      secretStore: { get: async () => null },
      providers: [slackProvider(handleSlackAppWebhook)],
      resolveAppWebhookSecret: async () => SLACK_SIGNING_SECRET,
    });
  });

  function slackDelivery(body: string, ts = nowTs(), signature?: string): Request {
    return new Request("http://gateway.test/api/v1/app-webhooks/slack", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": signature ?? slackSignature(body, ts),
      },
      body,
    });
  }

  test("a valid signed delivery delegates to handleSlackAppWebhook with the same bytes", async () => {
    // Capture the forwarded body inside the stub (the stub consumes the stream,
    // so it can't be re-read from the call args afterward). Byte-identity proves
    // the adapter's own downstream v0 verify over the same bytes still passes.
    let forwardedBody: string | undefined;
    handleSlackAppWebhook = mock(async (request: Request) => {
      forwardedBody = await request.text();
      return new Response(`handled:${forwardedBody}`, { status: 200 });
    });
    app = createAppWebhookRoutes({
      installationStore: createPostgresAppInstallationStore(),
      secretStore: { get: async () => null },
      providers: [slackProvider(handleSlackAppWebhook)],
      resolveAppWebhookSecret: async () => SLACK_SIGNING_SECRET,
    });

    const body = JSON.stringify({ team_id: "T123", type: "event_callback" });
    const res = await app.fetch(slackDelivery(body));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`handled:${body}`);
    expect(handleSlackAppWebhook).toHaveBeenCalledTimes(1);
    expect(forwardedBody).toBe(body);
  });

  test("a stale-timestamp delivery is rejected 401 BEFORE delegating", async () => {
    const body = "{}";
    const staleTs = String(Math.floor(Date.now() / 1000) - 60 * 6);
    const res = await app.fetch(slackDelivery(body, staleTs));
    expect(res.status).toBe(401);
    expect(handleSlackAppWebhook).not.toHaveBeenCalled();
  });

  test("a forged signature is rejected 401 and never delegates", async () => {
    const res = await app.fetch(slackDelivery("{}", nowTs(), "v0=forged"));
    expect(res.status).toBe(401);
    expect(handleSlackAppWebhook).not.toHaveBeenCalled();
  });

  test("a coordinator throw surfaces as 500", async () => {
    handleSlackAppWebhook = mock(async () => {
      throw new Error("boom");
    });
    app = createAppWebhookRoutes({
      installationStore: createPostgresAppInstallationStore(),
      secretStore: { get: async () => null },
      providers: [slackProvider(handleSlackAppWebhook)],
      resolveAppWebhookSecret: async () => SLACK_SIGNING_SECRET,
    });
    const res = await app.fetch(slackDelivery("{}"));
    expect(res.status).toBe(500);
  });

  test("fails closed 401 when the signing secret is unconfigured", async () => {
    app = createAppWebhookRoutes({
      installationStore: createPostgresAppInstallationStore(),
      secretStore: { get: async () => null },
      providers: [slackProvider(handleSlackAppWebhook)],
      resolveAppWebhookSecret: async () => undefined,
    });
    const res = await app.fetch(slackDelivery("{}"));
    expect(res.status).toBe(401);
    expect(handleSlackAppWebhook).not.toHaveBeenCalled();
  });
});
