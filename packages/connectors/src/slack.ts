/**
 * Slack (catalog connector — declaration only)
 *
 * Slack is a CHAT platform, not a data feed: inbound traffic is Chat SDK events
 * delivered to the shared app-webhook endpoint, and per-message routing is via
 * `/lobu link` Event Automations — NOT a connector `sync()`. This file exists so
 * the Slack app's credentials + install/webhook scheme flow through the SAME
 * declaration-driven resolver as GitHub/Jira/Linear: the gateway reads the
 * declared env-var NAMES here (`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`,
 * `SLACK_SIGNING_SECRET`) instead of hardcoding `process.env.SLACK_*` literals.
 *
 * Declared as `kind: 'integration'` (see {@link IntegrationConnector}): a pure
 * app/auth declaration, deliberately INERT as a catalog entry (see the
 * bundled-connector side-effect audit):
 *  - NO `feeds` → no auto-provisioned data feeds, nothing for device-reconcile
 *    to wire, and the install callback writes only the `app_installations` row.
 *  - NO `runtime` / `requiredCapability` → `getBundledDeviceConnectors()` filters
 *    it out, so it is never auto-installed onto a device fleet.
 *  - NO `sync()` → an integration connector has no syncable feeds; the
 *    `IntegrationConnector` base throws if one is ever scheduled (a wiring bug).
 *
 * The webhook `delivery: 'app_installation'` + `routingKeyPaths` tells the
 * app-webhook router this connector's deliveries route by Slack `team_id` through
 * `/api/v1/app-webhooks/slack`. Verify is FULLY DECLARATIVE — the generic engine
 * computes Slack's `v0:{ts}:{rawBody}` HMAC straight from this schema; there is no
 * Slack-specific verify plugin.
 */

import {
	type ConnectorDefinition,
	IntegrationConnector,
} from "@lobu/connector-sdk";
import { CHAT_AUTOMATION_EVENTS } from "./chat-automation-events.js";

/**
 * Bot scopes requested by `/slack/install`. The Slack manifest does not drive
 * that route: the generic install engine reads this connector declaration.
 * Keep this list exactly aligned with the manifest, and never drop
 * `mcp:connect` — without it Slackbot cannot discover Lobu's MCP server.
 */
const SLACK_BOT_SCOPES = [
	"app_mentions:read",
	"assistant:write",
	"channels:history",
	"channels:read",
	"chat:write",
	"chat:write.public",
	"commands",
	"files:read",
	"files:write",
	"groups:history",
	"groups:read",
	"im:history",
	"im:read",
	"im:write",
	"mcp:connect",
	"mpim:history",
	"mpim:read",
	"reactions:read",
	"reactions:write",
	"users:read",
];

/** Bot events the hosted app subscribes to (manifest `bot_events`). */
const SLACK_BOT_EVENTS = [
	"app_home_opened",
	"app_mention",
	"member_joined_channel",
	"member_left_channel",
	"message.channels",
	"message.groups",
	"message.im",
	"message.mpim",
	"team_join",
];

export default class SlackConnector extends IntegrationConnector {
  readonly definition: ConnectorDefinition = {
		key: "slack",
		kind: "integration",
		name: "Slack",
    description:
			"Connect a Slack workspace to Lobu. Mention the bot, DM it, or run /lobu in any channel to drive a sandboxed agent.",
		version: "1.0.0",
		automationEvents: CHAT_AUTOMATION_EVENTS,
		faviconDomain: "slack.com",
    webhook: {
      // App-level delivery: one webhook is configured ONCE on the Slack app, and
      // inbound deliveries route via the shared `/api/v1/app-webhooks/slack`
      // endpoint. Slack's signature scheme is FULLY declarative: HMAC-SHA256 over
      // `v0:{timestamp}:{body}` compared against `x-slack-signature` (prefix
      // `v0=`), plus a 300s timestamp-freshness replay guard — the generic engine
      // verifies it with no Slack-specific code.
			delivery: "app_installation",
      // Verified deliveries forward to the chat adapter (the routing chain in
      // SlackConnectionCoordinator), not the data-ingest path. The generic engine
      // dispatches on this, never on the `slack` name.
			deliveryKind: "chat",
			signatureHeader: "x-slack-signature",
			algorithm: "sha256",
			signaturePrefix: "v0=",
			signingBaseTemplate: "v0:{timestamp}:{body}",
			timestampHeader: "x-slack-request-timestamp",
      freshnessSeconds: 300,
      // The team id sits in different places across Slack event shapes; first
      // match wins.
			routingKeyPaths: ["team_id", "team.id", "event.team_id"],
    },
    authSchema: {
      methods: [
        {
					type: "app_installation",
					provider: "slack",
					providerInstance: "cloud",
          // "Add to Slack" is a standard OAuth code exchange: the gateway's
          // generic install engine mounts /slack/install + /slack/oauth_callback,
          // redirects to `authorizeUrl` with the client id + scopes, and on
          // callback exchanges the code at `tokenUrl`. The engine dispatches on
          // this shape, never on the `slack` name.
					installShape: "oauth-code-exchange",
					authorizeUrl: "https://slack.com/oauth/v2/authorize",
					tokenUrl: "https://slack.com/api/oauth.v2.access",
          // The hosted Lobu Slack app's OAuth client (used for the "Add to Slack"
          // install handshake) + the signing secret used to verify inbound
          // events. Declared as env-var NAMES; the gateway resolves the values.
					clientIdKey: "SLACK_CLIENT_ID",
					clientSecretKey: "SLACK_CLIENT_SECRET",
					webhookSecretKey: "SLACK_SIGNING_SECRET",
          permissions: SLACK_BOT_SCOPES,
          events: SLACK_BOT_EVENTS,
          required: false,
          description:
						"Install the Lobu app on your Slack workspace to grant the bot token. Routing to agents is per-channel via /lobu link.",
        },
        {
          // "Sign in with Slack" (OpenID Connect). Fully self-describing: the
          // declaration carries Slack's OIDC endpoints + login scopes, so the
          // gateway wires it through Better Auth's provider-agnostic
          // `genericOAuth` plugin (NOT the built-in `socialProviders` allowlist —
          // Slack is not a Better Auth built-in social provider). Core stays
          // provider-name-free; everything provider-specific lives here. Reuses
          // the SAME hosted Lobu Slack app client as the install method above
          // (env-var NAMES; the gateway resolves the values). Signing in
          // auto-provisions the user's personal org + default agent via Better
          // Auth's `user.create` hook (OIDC `sub` → Slack user id); no data feed.
					type: "oauth",
					provider: "slack",
					loginScopes: ["openid", "email", "profile"],
					requiredScopes: [],
					authorizationUrl: "https://slack.com/openid/connect/authorize",
					tokenUrl: "https://slack.com/api/openid.connect.token",
					userinfoUrl: "https://slack.com/api/openid.connect.userInfo",
					clientIdKey: "SLACK_CLIENT_ID",
					clientSecretKey: "SLACK_CLIENT_SECRET",
          required: false,
          description:
						"Sign in with Slack to create or access your Lobu account using your Slack identity.",
				},
				{
					type: "none",
					label: "Use your own Slack app",
        },
      ],
    },
		optionsSchema: {
			type: "object",
			"x-lobu-chat-platform": "slack",
			properties: {
				botToken: {
					type: "string",
					format: "password",
					title: "Bot token",
					description:
						"The xoxb- token issued when you install your Slack app.",
				},
				signingSecret: {
					type: "string",
					format: "password",
					title: "Signing secret",
					description: "Used to verify every inbound Slack request.",
				},
			},
			required: ["botToken", "signingSecret"],
		},
  };
}
