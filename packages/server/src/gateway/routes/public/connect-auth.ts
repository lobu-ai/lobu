import { randomBytes } from "node:crypto";
import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import { getDb } from "../../../db/client.js";
import { escapeHtml } from "../../../utils/html.js";
import { renderLobuPage } from "../../auth/oauth-templates.js";
import type { ExternalAuthClient } from "../../auth/external/client.js";
import { resolvePublicUrl } from "../../utils/public-url.js";
import {
  setSettingsSessionCookie,
  verifySettingsSession,
  verifySettingsToken,
} from "./settings-auth.js";

const logger = createLogger("connect-auth-routes");
const AUTH_REQUEST_TTL_SECONDS = 10 * 60;
const CONNECT_OAUTH_TTL_SECONDS = 10 * 60;
const SCOPE_CONNECT = "cli:auth:connect";

interface ConnectOauthState {
  returnUrl: string;
  codeVerifier: string;
}

interface ConnectAuthRoutesConfig {
  externalAuthClient?: ExternalAuthClient;
}

function normalizeReturnUrl(
  returnUrl: string | null | undefined
): string | null {
  const value = returnUrl?.trim();
  if (!value?.startsWith("/")) {
    return null;
  }
  // Reject protocol-relative URLs and any second character that browsers
  // normalise toward a host portion. `//evil.com`, `/\evil.com`, `/\/evil.com`
  // all redirect off-origin once the browser collapses `\` → `/` in the path,
  // so only allow values whose second character is a normal path segment.
  if (value.length > 1) {
    const second = value[1];
    if (second === "/" || second === "\\") {
      return null;
    }
  }
  // CR/LF in a redirect target lets an attacker smuggle a header break into
  // any caller that interpolates this into `Location:` without re-escaping.
  // Hono escapes its own writes, but reject defensively at the trust boundary.
  if (/[\r\n]/.test(value)) {
    return null;
  }
  return value;
}

function renderPage(title: string, message: string) {
  return renderLobuPage({
    title,
    body: `<p>${escapeHtml(message)}</p><p class="note">You can return to the terminal after this page updates.</p>`,
  });
}

async function loadOauthState<T>(
  scope: string,
  id: string
): Promise<T | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT payload FROM oauth_states
    WHERE id = ${id} AND scope = ${scope} AND expires_at > now()
  `;
  return ((rows[0] as { payload: T } | undefined)?.payload ?? null) as T | null;
}

async function saveOauthState<T>(
  scope: string,
  id: string,
  value: T,
  ttlSeconds: number
): Promise<void> {
  const sql = getDb();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await sql`
    INSERT INTO oauth_states (id, scope, payload, expires_at)
    VALUES (${id}, ${scope}, ${sql.json(value as object)}, ${expiresAt})
    ON CONFLICT (id) DO UPDATE SET
      scope = EXCLUDED.scope,
      payload = EXCLUDED.payload,
      expires_at = EXCLUDED.expires_at
  `;
}

async function deleteOauthState(scope: string, id: string): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM oauth_states WHERE id = ${id} AND scope = ${scope}`;
}

/**
 * Browser-based OAuth handoff used to claim a settings session via a bot
 * link or to sign in to the agent settings UI through the external IdP.
 *
 * - `GET /connect/oauth/login?returnUrl=…`   — kicks off the upstream OAuth.
 * - `GET /connect/claim?claim=…&agent=…`     — exchanges a signed claim token
 *                                              for a settings session cookie.
 * - `GET /connect/oauth/callback`             — completes the handoff.
 */
export function createConnectAuthRoutes(config: ConnectAuthRoutesConfig): Hono {
  const router = new Hono();

  async function loadConnectState(
    state: string
  ): Promise<ConnectOauthState | null> {
    return loadOauthState<ConnectOauthState>(SCOPE_CONNECT, state);
  }

  router.get("/connect/oauth/login", async (c) => {
    if (!config.externalAuthClient) {
      return c.html(
        renderPage(
          "OAuth Unavailable",
          "Browser OAuth login is not configured on this gateway."
        ),
        501
      );
    }

    const returnUrl = normalizeReturnUrl(c.req.query("returnUrl"));
    if (!returnUrl) {
      return c.html(
        renderPage(
          "OAuth Login Failed",
          "Missing or invalid returnUrl."
        ),
        400
      );
    }

    const existingSession = await verifySettingsSession(c);
    if (existingSession) {
      return c.redirect(returnUrl);
    }

    try {
      const state = randomBytes(24).toString("base64url");
      const codeVerifier = config.externalAuthClient.generateCodeVerifier();
      await saveOauthState<ConnectOauthState>(
        SCOPE_CONNECT,
        state,
        { returnUrl, codeVerifier },
        CONNECT_OAUTH_TTL_SECONDS
      );

      const redirectUri = resolvePublicUrl("/connect/oauth/callback", {
        requestUrl: c.req.url,
      });
      const authUrl = await config.externalAuthClient.buildAuthUrl(
        state,
        codeVerifier,
        redirectUri
      );

      return c.redirect(authUrl);
    } catch (error) {
      logger.error("Failed to start browser OAuth handoff", { error });
      return c.html(
        renderPage(
          "OAuth Login Failed",
          "The gateway could not start the browser OAuth flow."
        ),
        500
      );
    }
  });

  router.get("/connect/claim", async (c) => {
    const claim = c.req.query("claim")?.trim();
    const agentParam = c.req.query("agent")?.trim();
    if (!claim) {
      return c.html(
        renderPage("Invalid Link", "Missing claim token."),
        400
      );
    }

    const payload = await verifySettingsToken(claim);
    if (!payload) {
      return c.html(
        renderPage(
          "Link Expired",
          "This settings link has expired or is invalid. Ask the bot to send a new one."
        ),
        410
      );
    }

    setSettingsSessionCookie(c, payload);

    const targetAgentId = agentParam || payload.agentId;
    const redirectUrl = targetAgentId
      ? `/api/v1/agents/${encodeURIComponent(targetAgentId)}/config`
      : "/api/v1/agents";
    return c.redirect(redirectUrl);
  });

  router.get("/connect/oauth/callback", async (c) => {
    if (!config.externalAuthClient) {
      return c.html(
        renderPage(
          "OAuth Unavailable",
          "Browser OAuth login is not configured on this gateway."
        ),
        501
      );
    }

    const code = c.req.query("code")?.trim();
    const state = c.req.query("state")?.trim();
    if (!code || !state) {
      return c.html(
        renderPage(
          "OAuth Login Failed",
          "Missing OAuth code or state."
        ),
        400
      );
    }

    const connectState = await loadConnectState(state);
    await deleteOauthState(SCOPE_CONNECT, state);
    if (!connectState) {
      return c.html(
        renderPage(
          "OAuth Login Expired",
          "This OAuth login request has expired. Start the flow again."
        ),
        410
      );
    }

    try {
      const redirectUri = resolvePublicUrl("/connect/oauth/callback", {
        requestUrl: c.req.url,
      });
      const credentials = await config.externalAuthClient.exchangeCodeForToken(
        code,
        connectState.codeVerifier,
        redirectUri
      );
      const user = await config.externalAuthClient.fetchUserInfo(
        credentials.accessToken
      );

      setSettingsSessionCookie(c, {
        userId: user.sub,
        platform: "external",
        oauthUserId: user.sub,
        email: user.email,
        name: user.name,
        exp: Date.now() + AUTH_REQUEST_TTL_SECONDS * 1000,
      });

      return c.redirect(connectState.returnUrl);
    } catch (error) {
      logger.error("Failed to complete browser OAuth handoff", { error });
      return c.html(
        renderPage(
          "OAuth Login Failed",
          "The gateway could not complete the browser OAuth flow."
        ),
        500
      );
    }
  });

  return router;
}
