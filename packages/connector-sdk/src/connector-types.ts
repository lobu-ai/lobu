/**
 * Connector Types
 *
 * Type definitions for the V1 integration platform.
 * Defines the contract between connectors, the runtime, and the platform.
 */

// Metric-reflection contract shapes live in ./metrics.ts (the persisted metric
// contract — see that file for why connector-sdk, not core). Imported for local
// use (ReflectResult) and re-exported below for connector authors.
import type { EntityTypeContribution, ReflectedMeasure } from './metrics.js';
import type {
  ConnectorAutomationEvent,
  ConnectorAutomationSignalDraft,
} from './automation-triggers.js';

// =============================================================================
// Connector Definition
// =============================================================================

export interface ConnectorDefinition {
  /** Unique connector key, e.g. 'google.gmail' */
  key: string;
  /** Human-readable name */
  name: string;
  /** Description of what this connector does */
  description?: string;
  /** Semantic version */
  version: string;
  /**
   * What this connector IS, which decides whether it carries syncable data.
   * - `'data'` (default, absent) — the dominant case: a source the platform
   *   POLLS via `sync()` and/or receives data webhooks for. Declares `feeds`.
   *   GitHub/Jira/Linear are data even though they're App installs.
   * - `'integration'` — a pure app/auth declaration (e.g. Slack): it carries an
   *   `authSchema` (`app_installation`) + `webhook` but NO `feeds` and NO
   *   `sync()`. Inbound traffic is forwarded to a chat adapter, never polled.
   *   Extend {@link IntegrationConnector} (sync is invalid for this kind).
   */
  kind?: 'data' | 'integration';
  /** Auth configuration */
  authSchema?: ConnectorAuthSchema;
  /** Available feed definitions (keyed by feed_key) */
  feeds?: Record<string, FeedDefinition>;
  /** Available action definitions (keyed by action_key) */
  actions?: Record<string, ActionDefinition>;
  /** Connector-normalized events that can activate Automations. */
  automationEvents?: ConnectorAutomationEvent[];
  /**
   * Declarative inbound-webhook config. Presence means this connector receives
   * real-time provider deliveries at `POST /api/v1/webhooks/:connectionId`,
   * which are landed RAW into `events` (extract-load — the agent/downstream
   * stages interpret them; no transform on the ingest hot path). The gateway
   * verifies the signature IN-PROCESS using this schema + the secret stored on
   * the connection, so the hot path never loads connector code. Pair with
   * {@link ConnectorRuntime.registerWebhook}, which subscribes with the provider
   * at connect time and stamps the signing secret onto the connection.
   */
  webhook?: ConnectorWebhookSchema;
  /** Global connector options schema (JSON Schema) */
  optionsSchema?: Record<string, unknown>;
  /** Domain for favicon lookup (e.g. 'x.com') */
  faviconDomain?: string;
  /** Optional upstream MCP configuration */
  mcpConfig?: {
    upstreamUrl: string;
  };
  /** Optional OpenAPI operation source */
  openapiConfig?: {
    specUrl: string;
    includeOperations?: string[];
    excludeOperations?: string[];
    includeTags?: string[];
    serverUrl?: string;
  };
  /**
   * Optional worker capability required to run this connector. Workers advertise
   * capabilities on poll; the runs scheduler only hands a connector run to a
   * worker whose capabilities array includes this value. Unset = any worker
   * (default API/browser fleet). Example: `'screentime'` for apple.screen_time
   * (only Lobu for Mac, with Full Disk Access, can read the Knowledge store).
   */
  requiredCapability?: string;
  /**
   * Present only for device-bound connectors. Omitting this field means the
   * connector runs on the server-side worker fleet (cloud). `platforms` lists
   * the host platforms a device worker (e.g. Lobu for Mac) must be running on
   * to serve this connector's runs.
   */
  runtime?: ConnectorRuntimeInfo;
  /**
   * What a CONNECTION of this connector contributes to the AGENT sandbox — the
   * CLI, the env var it authenticates with, and the hosts it must reach. An
   * App-installation-backed GitHub connection gives the sandbox an authenticated
   * `gh`; other GitHub auth methods contribute the binary without a credential.
   *
   * Distinct from {@link runtime}.`nix`, which provisions the CONNECTOR WORKER's
   * own execution environment. The two never merge: a connector may need
   * `ffmpeg` to sync while contributing `gh` to the agent, or contribute agent
   * tooling while running on the default fleet with no runtime deps at all.
   */
  agentTooling?: ConnectorAgentTooling;
}

/**
 * Agent-sandbox contribution of a connector's connections. Resolved per
 * deployment by the gateway: packages join the agent's nix union, `env` entries
 * are materialized per {@link ConnectorAgentToolingEnv.credential}, and
 * `domains` are granted on the worker's egress allowlist.
 */
export interface ConnectorAgentTooling {
  /**
   * Native tools the contributed CLI needs on PATH inside the agent sandbox, as
   * nixpkgs attribute references (e.g. `["gh"]`). Unioned with the agent's own
   * packages — never last-writer-wins.
   *
   * Portable across runtimes: the built-in runtime wraps the worker spawn in
   * `nix-shell`, and remote runtimes provision the same set into the sandbox
   * before the first command (nix profile install, PATH-prepended). Provisioning
   * degrades honestly — if it fails, or a runtime cannot provision at all, the
   * CLI is absent and the exec result says so rather than the turn failing.
   */
  nix?: { packages: string[] };
  /** Environment variables the contributed tooling authenticates with. */
  env?: ConnectorAgentToolingEnv[];
  /**
   * Hosts the contributed tooling must reach, added to the agent's egress
   * grants for the lifetime of the deployment (e.g.
   * `["api.github.com", "github.com"]`). Worker egress is deny-by-default, so a
   * CLI with no domain grant authenticates and then hangs on the proxy.
   */
  domains?: string[];
}

export interface ConnectorAgentToolingEnv {
  /** Env var name set inside the agent sandbox, e.g. `GH_TOKEN`. */
  name: string;
  /**
   * How the gateway materializes the value. `'lease'` is the only tier: the
   * provider can derive short-lived scoped tokens, so the gateway mints one per
   * deployment and injects the REAL token. Safe under the
   * workers-never-receive-durable-credentials invariant because it expires on
   * its own (GitHub installation tokens: ~1h). Requires the connection to
   * resolve to a mintable installation; without one the var is simply absent
   * (the CLI reports unauthenticated — never a durable secret).
   *
   * There is deliberately no tier for static credentials: the worker egress
   * proxy raw-tunnels HTTPS CONNECT traffic, so an opaque placeholder in a CLI
   * env var would reach the provider verbatim. Providers without derived
   * tokens can contribute packages and domains but no credential until a
   * credential-aware relay exists.
   *
   * The lease is minted at deployment time, and a sandbox reads its env once at
   * startup — so a WARM deployment keeps the credential it was born with. On a
   * conversation continuously active past the token's life the CLI starts
   * reporting itself unauthenticated, until the idle reaper rebuilds the worker
   * (`WORKER_IDLE_CLEANUP_MINUTES`, default 60). Renewing before that point is
   * deliberately out of scope here; see `packages/server/AGENTS.md`.
   */
  credential: 'lease';
}

export interface ConnectorRuntimeInfo {
  /** Platforms this connector can run on. */
  platforms: Array<'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'headless' | 'chrome-extension'>;
  /**
   * Permission/auth scopes forwarded verbatim to the native platform adapter.
   * Optional — omit when the platform adapter needs no fine-grained scope list.
   */
  scopes?: string[];
  /**
   * Native system dependencies this connector needs on PATH at execution time,
   * as nixpkgs attribute references (e.g. `["ffmpeg", "imagemagick"]`). npm
   * dependencies are bundled into the connector at compile time and do NOT go
   * here — only native tools the runtime must provision. Backends that can run
   * native deps (embedded, container, machine) satisfy these via nix; backends
   * that can't (e.g. edge workers) reject a connector that declares them.
   */
  nix?: { packages: string[] };
}

/**
 * Declarative scheme the gateway uses to verify an inbound provider webhook in
 * the request hot path — no connector code runs before the 202 ack. The shared
 * secret is NOT here: it is minted by {@link ConnectorRuntime.registerWebhook}
 * at connect time and stored on the connection.
 */
export interface ConnectorWebhookSchema {
  /**
   * Request header carrying the provider's HMAC signature over the raw body,
   * e.g. `x-hub-signature-256` (GitHub), `linear-signature`. Omit for providers
   * that don't sign — verification is then skipped (relies on the unguessable
   * per-connection URL + token), so prefer signing whenever the provider offers it.
   */
  signatureHeader?: string;
  /** HMAC digest algorithm used to compute the signature. Default `sha256`. */
  algorithm?: 'sha256' | 'sha1';
  /**
   * Prefix the provider prepends to the hex digest in the signature header,
   * e.g. `sha256=`. Stripped before the constant-time compare. Default none.
   */
  signaturePrefix?: string;
  /**
   * Template for the bytes the HMAC is computed over. Supports `{body}` (the raw
   * request body) and `{timestamp}` (the value of {@link timestampHeader}).
   * Default `'{body}'` (plain raw-body HMAC: GitHub/Jira/Linear). Slack signs
   * `'v0:{timestamp}:{body}'`, so its whole signing scheme is expressible here —
   * no hand-written verify plugin needed. The compared signature is
   * `signaturePrefix + hex(HMAC(secret, renderedBase))`.
   */
  signingBaseTemplate?: string;
  /**
   * Request header carrying the timestamp substituted into
   * {@link signingBaseTemplate} as `{timestamp}` (e.g. `x-slack-request-timestamp`).
   * Required when the template references `{timestamp}`.
   */
  timestampHeader?: string;
  /**
   * Optional replay guard: reject a delivery whose {@link timestampHeader} value
   * (unix seconds) is more than this many seconds from now. Slack uses 300.
   * Omit to skip the freshness check.
   */
  freshnessSeconds?: number;
  /**
   * Request header carrying the provider's unique delivery id, used for
   * idempotent dedupe (e.g. `x-github-delivery`, `linear-delivery`). Falls back
   * to a body hash when unset.
   */
  dedupeHeader?: string;
  /**
   * How the gateway routes inbound deliveries to a connection.
   * - `'registered'` (default — back-compat): per-connection webhook URL
   *   (`/api/v1/webhooks/:connectionId`) created by
   *   {@link ConnectorRuntime.registerWebhook}; the connection id is in the path.
   * - `'app_installation'`: shared provider endpoint
   *   (`/api/v1/app-webhooks/:provider`) for an org/workspace-scoped App install.
   *   In this mode {@link ConnectorRuntime.registerWebhook} /
   *   `unregisterWebhook` are NO-OPS (the App subscription is provisioned at
   *   install time, not per connection), and delivery routing + signature
   *   verification are performed by a server-side provider plugin (verifier +
   *   tenant extractor) — NOT by `routingKeyPath` or this schema's HMAC fields
   *   alone, which are insufficient for provider-specific signing (GitHub
   *   raw-body HMAC, Slack `v0:{ts}:{rawBody}` with timestamp freshness, etc.).
   */
  delivery?: 'registered' | 'app_installation';
  /**
   * `app_installation` mode only: how a VERIFIED delivery is dispatched once the
   * generic engine has checked its signature.
   * - `'data'` (default, absent) — land/trigger through the data path: the
   *   connector's poll-canonical trigger/store hook when it has one (GitHub), else
   *   the raw event-ingest path (Jira/Linear).
   * - `'chat'` — forward to the chat adapter for the connector's provider (Slack;
   *   reusable by any future chat platform), bypassing the data-ingest pipeline.
   * The engine dispatches on THIS, never on a provider name.
   */
  deliveryKind?: 'data' | 'chat';
  /**
   * `app_installation` mode only: JSON path to the external tenant id within the
   * delivery body, e.g. `'installation.id'`. The generic app-webhook engine reads
   * this (or {@link routingKeyPaths}) to extract the tenant — no per-provider
   * extractor. A single path; use {@link routingKeyPaths} when the id can sit in
   * more than one place.
   */
  routingKeyPath?: string;
  /**
   * `app_installation` mode only: an ORDERED list of JSON paths tried in turn for
   * the external tenant id; first non-empty match wins. Use when the id sits in
   * multiple places across event shapes (Slack: `team_id` | `team.id` |
   * `event.team_id`). Takes precedence over {@link routingKeyPath}.
   */
  routingKeyPaths?: string[];
  /**
   * `app_installation` mode only: transform applied to the value found at
   * {@link routingKeyPath} / {@link routingKeyPaths} before it becomes the tenant
   * id. `'url-host'` parses the value as a URL and uses its host (Jira: every
   * entity carries a REST `self` URL on its site host, which is the tenant).
   * Omit for the identity transform (the value IS the tenant id).
   */
  routingKeyTransform?: 'url-host';
}

// =============================================================================
// Auth
// =============================================================================

export interface ConnectorAuthSchema {
  methods: ConnectorAuthMethod[];
}

export type ConnectorAuthMethod =
  | ConnectorAuthNone
  | ConnectorAuthEnvKeys
  | ConnectorAuthOAuth
  | ConnectorAuthBrowser
  | ConnectorAuthInteractive
  | ConnectorAuthAppInstallation;

export interface ConnectorAuthNone {
  type: 'none';
  /** User-facing label when `none` represents provider-managed credentials. */
  label?: string;
}

export interface ConnectorAuthEnvField {
  key: string;
  label?: string;
  description?: string;
  example?: string;
  secret?: boolean;
  required?: boolean;
}

export interface ConnectorAuthEnvKeys {
  type: 'env_keys';
  required?: boolean;
  scope?: 'connection' | 'organization';
  fields: ConnectorAuthEnvField[];
  description?: string;
}

export interface OAuthLoginProvisioningConfig {
  /** Auto-create/reuse a connector connection when the user logs in with this provider. */
  autoCreateConnection?: boolean;
}

export interface ConnectorAuthOAuth {
  type: 'oauth';
  provider: string;
  requiredScopes: string[];
  optionalScopes?: string[];
  required?: boolean;
  description?: string;
  scope?: 'connection' | 'organization';
  authorizationUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  authParams?: Record<string, string>;
  tokenEndpointAuthMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
  usePkce?: boolean;
  loginScopes?: string[];
  clientIdKey?: string;
  clientSecretKey?: string;
  setupInstructions?: string;
  loginProvisioning?: OAuthLoginProvisioningConfig;
}

/**
 * Declares that this connector runs an interactive auth flow via
 * `ConnectorRuntime.authenticate()`. The UI responds by enqueuing an auth run
 * and rendering the artifacts it emits (QR, pairing code, redirect, prompt).
 */
export interface ConnectorAuthInteractive {
  type: 'interactive';
  required?: boolean;
  description?: string;
  scope?: 'connection' | 'organization';
  /**
   * Hint for the UI about the primary artifact kind the connector emits first.
   * Used to pick a sensible loading state before the first artifact arrives.
   */
  expectedArtifact?: 'qr' | 'code' | 'redirect' | 'prompt' | 'status';
  /** Max seconds the whole auth flow is allowed to run. Default 300. */
  timeoutSec?: number;
}

export interface ConnectorAuthBrowser {
  type: 'browser';
  required?: boolean;
  description?: string;
  /**
   * How browser auth is captured:
   * - 'cli': Extract cookies from Chrome profile via `lobu memory browser-auth`
   * - 'cdp': Connect to a running Chrome instance via Chrome DevTools Protocol.
   *          Requires Chrome launched with --remote-debugging-port=9222.
   *          Used for services (like Google) that block headless browsers.
   */
  capture?: 'cli' | 'cdp';
  /** Required cookie domains for 'cli' capture (e.g. ['x.com', '.x.com']) */
  requiredDomains?: string[];
  /** Default CDP URL for 'cdp' capture (default: http://127.0.0.1:9222) */
  defaultCdpUrl?: string;
}

/**
 * Org/workspace-scoped App install (GitHub App, Slack app, Jira site, …).
 * Install once per external tenant → a tenant-scoped token + webhook events
 * flow. Distinct from {@link ConnectorAuthOAuth}, which is user-scoped; a single
 * connector may declare both (resolver precedence is defined server-side).
 *
 * The credential is minted/refreshed gateway-side and never reaches connector
 * code as a raw token: it arrives as `credentials.accessToken` on the worker
 * HOST, which hands the run a `lobu_secret_<uuid>` placeholder and swaps the
 * value back in at egress (same grammar the secret-proxy uses on its route).
 */
export interface ConnectorAuthAppInstallation {
  type: 'app_installation';
  /** Provider key, e.g. `'github' | 'slack' | 'jira'`. */
  provider: string;
  /**
   * The install HANDSHAKE shape. The gateway's generic install engine mounts a
   * start + callback route per integration connector and dispatches the actual
   * handshake on THIS — never on a provider name:
   * - `'oauth-code-exchange'` — the standard "Add to <app>" OAuth flow: redirect
   *   to {@link authorizeUrl} with the declared `clientIdKey` + scopes
   *   ({@link permissions}), then on callback exchange the `code` at
   *   {@link tokenUrl} and complete the install (Slack; reusable by any future
   *   OAuth-code app). Mounted at `/{provider}/install` + `/{provider}/oauth_callback`.
   * - `'github-app'` — GitHub's App-installation flow (installation_id, ownership
   *   verification, repo/team provisioning, recovery via user-authorization).
   *   Mounted at the GitHub App's fixed `/github/app/install[/callback]` paths.
   * Omit to declare no hosted install route for this method.
   */
  installShape?: 'oauth-code-exchange' | 'github-app';
  /**
   * `oauth-code-exchange` only: the provider's OAuth authorize URL the install
   * start route redirects to (e.g. Slack `https://slack.com/oauth/v2/authorize`).
   * Gateway-side; carries no secret.
   */
  authorizeUrl?: string;
  /**
   * `oauth-code-exchange` only: the provider's token-exchange URL used to turn the
   * callback `code` into an access token (e.g. Slack
   * `https://slack.com/api/oauth.v2.access`). Gateway-side; the exchange runs WITH
   * the client secret in core and never reaches connector/worker code.
   */
  tokenUrl?: string;
  /**
   * Provider instance: `'cloud'` (default) for the public SaaS, a GitHub
   * Enterprise Server host, or an Atlassian site class. Lets one connector serve
   * multiple deployments of the same provider.
   */
  providerInstance?: string;
  /** Env var holding the Lobu App's id (e.g. `GITHUB_APP_ID`). Gateway-side. */
  appIdKey?: string;
  /** Env var holding the App private key used to mint tokens (GitHub). Gateway-side. */
  privateKeyKey?: string;
  /**
   * Env var holding the App's URL slug (e.g. `GITHUB_APP_SLUG`), substituted into
   * {@link installUrlTemplate} as `{{app_slug}}`. Gateway-side.
   */
  appSlugKey?: string;
  /**
   * Env var holding the App's OAuth client id used for the user-authorization
   * leg of installation (e.g. `GITHUB_APP_CLIENT_ID`). Distinct from a separate
   * user-login OAuth method's `clientIdKey`. Gateway-side.
   */
  clientIdKey?: string;
  /** Env var holding the App's OAuth client secret (e.g. `GITHUB_APP_CLIENT_SECRET`). Gateway-side. */
  clientSecretKey?: string;
  /**
   * Env var holding the secret used to verify inbound app-webhook deliveries
   * (e.g. `GITHUB_APP_WEBHOOK_SECRET`). Gateway-side.
   */
  webhookSecretKey?: string;
  /** Template URL the UI sends the user to in order to install the App. */
  installUrlTemplate?: string;
  /** Declared App permissions (informational; surfaced in the install UI). */
  permissions?: string[];
  /** Webhook event types the App subscribes to (informational; install UI). */
  events?: string[];
  required?: boolean;
  description?: string;
}

/**
 * Resolved app-installation context for the run, attached to every execution and
 * webhook-registration context a connector method receives. Carries the external
 * tenant identity + routing keys, never the raw credential (see
 * {@link ConnectorAuthAppInstallation}).
 */
export interface ConnectorInstallationContext {
  /** `app_installations.id` — the Lobu install row id. */
  id: string;
  /** Provider key, e.g. `'github'`. */
  provider: string;
  /** Provider instance, e.g. `'cloud'`. */
  providerInstance: string;
  /** Which Lobu App minted this install (supports >1 App per provider). */
  providerAppId?: string;
  /** External tenant id: installation_id / team_id / cloudId. */
  externalTenantId: string;
  /** Provider-specific install metadata (bot_user_id, account login, …). */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Feed Definition
// =============================================================================

export interface FeedDefinition {
  /** Feed key, e.g. 'threads' */
  key: string;
  /** Human-readable name */
  name: string;
  /** Description */
  description?: string;
  /** OAuth scopes required to keep this feed active. */
  requiredScopes?: string[];
  /** Template for generating feed display names from config values, e.g. "{subreddit} - {content_type}" */
  displayNameTemplate?: string;
  /**
   * JSON Schema for the persisted feed-instance config. It governs the feed
   * itself, so top-level `required` fields are enforced for read-only,
   * sync-only, and hybrid feeds alike.
   */
  configSchema?: Record<string, unknown>;
  /**
   * When true, auto-wire (device-reconcile + bundled-connector install) skips
   * this feed — every feed instance is created explicitly by the user (or by
   * the device worker on their behalf). Use this for feeds whose configSchema
   * has required fields that can only be supplied by an external actor, e.g.
   * `local.directory.files` needs a per-folder `folder_id` from the Mac app.
   */
  userManaged?: boolean;
  /**
   * Operations implemented by this feed. Compiled connectors derive this list
   * from their per-feed handlers; metadata-only device/MCP connectors declare
   * it because their implementation is remote. Users never select a feed mode.
   */
  operations?: FeedOperation[];
  /**
   * Routes inbound app-webhook deliveries to this feed. Lives on the feed (not
   * the connector's webhook schema) because feeds_schema is the persisted,
   * server-readable surface — the app-webhook router reads this to dispatch a
   * delivery WITHOUT hardcoding provider event types. The connector owns this
   * knowledge (which event updates which feed, and whether the payload is
   * complete enough to store):
   *  - `mode: 'trigger'` (default) — the poll brings more than the webhook, so
   *    mark this feed due and let the poll fetch the complete record (deduped by
   *    origin_id). Use for events whose poll endpoint returns richer data.
   *  - `mode: 'store'` — the payload is event-complete (e.g. a GitHub `star`
   *    carries the actor + starred_at) and re-polling the whole list is wasteful,
   *    so the router stores the structured event directly, consolidating with the
   *    poll on the same origin_id.
   */
  webhook?: {
    /** Provider webhook event types (e.g. `x-github-event` values) that update this feed. */
    events: string[];
    /** How a matching delivery is handled. Default `'trigger'`. */
    mode?: 'trigger' | 'store';
  };
  /** Event kinds this feed produces, keyed by kind slug */
  eventKinds?: Record<
    string,
    {
      description?: string;
      metadataSchema?: Record<string, unknown>;
      /**
       * Generic event attribution declarations. New connector work should model
       * "who authored / what resource this event belongs to / what it is about"
       * here. Durable cross-connector identity is expressed as entity
       * identities (see `identities` on the entity-link rule), not as facts.
       */
      attributions?: EventAttributionRule[];
      /**
       * Relationships between entities resolved by named attributions in this
       * event kind. The attribution declarations remain the only identity
       * resolution surface; these entries reference them by name.
       */
      relationships?: Array<{
        /** Relationship-type slug, preserved verbatim. */
        type: string;
        /** Name of the source attribution in this event kind. */
        from: string;
        /** Name of the target attribution in this event kind. */
        to: string;
      }>;
    }
  >;
}

export type EventAttributionRole =
  | 'authored_by'
  | 'performed_by'
  | 'about'
  | 'mentions'
  | 'belongs_to';

/**
 * Declarative event attribution target. The identity selectors are normalized
 * and resolved against the identity graph/projection.
 */
export interface EventAttributionTargetSpec {
  entityType?: string;
  identities?: EntityIdentitySpec[];
  titlePath?: string;
  createWhen?: EntityLinkPredicate;
}

/**
 * Event-to-entity attribution surface.
 *
 * Identity facts answer "who is this account/person across connectors"; event
 * attribution answers "what resolved entity should this particular event be
 * connected to for recall, ACL, and world-model traversal".
 */
export interface EventAttributionRule {
  /** Stable local name when another declaration in this event kind references this rule. */
  name?: string;
  role: EventAttributionRole;
  target: EventAttributionTargetSpec;
  /** Whether an unmatched target may be materialized by the attribution engine. */
  autoCreate?: boolean;
  /** Optional descriptive fields to merge onto the target entity when resolved. */
  traits?: Record<string, EntityTraitSpec>;
}

/**
 * Normalized identifier that uniquely names an entity within a namespace.
 * Stored as a row in `entity_identities` with UNIQUE on
 * (organization_id, namespace, identifier, COALESCE(scope_key, ''))
 * — matching, creation races, and
 * accrete all collapse onto this constraint.
 */
export interface EntityIdentitySpec {
  /**
   * Identifier namespace string (e.g. `email`, `github_login`). Each
   * connector owns its namespace constants; connectors sharing a namespace
   * must agree on its format.
   */
  namespace: string;
  /** Dot path into the event to extract the raw identifier. */
  eventPath: string;
  /**
   * When true, the identifier is used for matching existing entities but
   * not persisted on create or accrete. Defaults to false.
   */
  matchOnly?: boolean;
  /**
   * Marks an IMMUTABLE, authoritative identifier (e.g. a numeric provider user
   * id that survives renames). When a primary identity is PRESENT on an event:
   *   - if it matches an existing entity → that entity is used;
   *   - if it is present but matches nothing → resolution does NOT fall through
   *     to a non-primary match (a fresh primary id means a distinct account; a
   *     stale, since-reused secondary identifier like a renamed login must not
   *     conflate the two). A new entity is created keyed on the primary id.
   * Defaults to false: non-primary identities match equal-weight (a person is
   * matched by ANY of them — cross-channel WhatsApp/email matching relies on this).
   */
  primary?: boolean;
  /**
   * Does this identifier mean the same thing across upstream tenants?
   *
   * - `organization` (default) — globally meaningful within the org. A Slack
   *   user id names the same person no matter which connection observed it, so
   *   two connections seeing it must converge on ONE entity.
   * - `tenant` — meaningful only within the upstream tenant/account/database
   *   named by `scopeKeyPath`. `erp_customer` `CARI-001` in two ERP tenants is
   *   two customers, while two Lobu connections to the same tenant converge.
   *
   * Only the connector knows which it is: the namespace string is declared by
   * the manifest, and nothing about `invoice_no` or `customer_code` tells the
   * platform whether it is globally unique. Declaring it wrong in the
   * `tenant` direction fragments one entity into several; declaring it
   * wrong in the `organization` direction merges two tenants' records, so the
   * default is the conservative one only for connectors whose namespaces really
   * are global.
   *
   * Distinct from the deleted `uniquePerOrg` flag, which was CARDINALITY — does
   * this value name one entity or many (`email_domain` names many). Scope is
   * orthogonal: `email_domain` is many-per-org yet globally meaningful.
   *
   * NOT the same concept as `scope` on the auth schema, which scopes a
   * credential and retains its separate `connection | organization` values.
   * The preview-only identity value `connection` was never adopted and is
   * intentionally rejected: a Lobu connection row is not an upstream tenant.
   */
  scope?: 'organization' | 'tenant';
  /**
   * Dot path into the event containing the stable upstream tenant key.
   * Required exactly when `scope === 'tenant'`; forbidden for organization
   * scope. The extracted value must be a string, number, or boolean; it is
   * stringified, trimmed, and must be non-empty.
   */
  scopeKeyPath?: string;
}

/**
 * Descriptive field stored on `entities.metadata`. Its merge strategy determines
 * how the ingestion pipeline reconciles the value on match vs create.
 */
export interface EntityTraitSpec {
  /** Dot path into the event to extract the value. */
  eventPath: string;
  /**
   * - `init_only`        — write once on create, never touch after.
   * - `prefer_non_empty` — set only when current is null/empty, and skip empty event values.
   * - `overwrite`        — always write (for last_seen_at, status, etc.).
   */
  mergeStrategy: 'init_only' | 'prefer_non_empty' | 'overwrite';
}

/**
 * A small, JSON-serializable predicate evaluated against the ingested event
 * item (`{ metadata, title, origin_type }`) to gate `autoCreate`. All declared
 * conditions are ANDed; an omitted condition is ignored. `path` is a dot-path
 * resolved the same way as identity `eventPath` (e.g. `metadata.is_group`).
 * Deliberately closed — no expressions, no SQL — so it stays cheap to evaluate
 * inline at ingest.
 */
export interface EntityLinkPredicate {
  /** Dot-path into the event item, e.g. `metadata.is_group`. */
  path: string;
  /** Create only when the value strictly equals this (`===`). */
  equals?: string | number | boolean;
  /** Create only when the value does NOT strictly equal this. */
  notEquals?: string | number | boolean;
  /** `true` → value must be present (not null/undefined/`''`); `false` → must be absent. */
  exists?: boolean;
}

// =============================================================================
// Action Definition
// =============================================================================

export interface ActionDefinition {
  /** Action key, e.g. 'draft_email' */
  key: string;
  /** Human-readable name */
  name: string;
  /** Description */
  description?: string;
  /** Whether this action requires human approval before execution */
  requiresApproval: boolean;
	/** Semantic effect used by operation discovery and policy. Defaults to write. */
	kind?: 'read' | 'write';
	/**
	 * OAuth scopes this action needs beyond `authSchema.requiredScopes`.
	 * Readiness is gated when the connection's recorded grant lacks them.
	 */
	requiredScopes?: string[];
  /** MCP tool annotations for client-side confirmation UX */
  annotations?: {
		readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
    idempotentHint?: boolean;
  };
  /** JSON Schema for action input */
  inputSchema?: Record<string, unknown>;
  /** JSON Schema for action output */
  outputSchema?: Record<string, unknown>;
}

// =============================================================================
// Connection
// =============================================================================

export interface Connection {
  id: number;
  organizationId: string;
  connectorKey: string;
  displayName?: string;
  status: 'active' | 'paused' | 'error' | 'revoked';
  accountId?: string;
  credentials?: Record<string, unknown>;
  entityIds?: number[];
  config?: Record<string, unknown>;
  errorMessage?: string;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// Feed
// =============================================================================

export interface Feed {
  id: number;
  organizationId: string;
  connectionId: number;
  feedKey: string;
  status: 'active' | 'paused' | 'error';
  entityIds?: number[];
  config?: Record<string, unknown>;
  checkpoint?: Record<string, unknown>;
  syncIntervalMs?: number;
  nextSyncAt?: Date;
  lastSyncAt?: Date;
  lastSyncStatus?: string;
  lastError?: string;
  consecutiveFailures: number;
  itemsCollected: number;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// Run
// =============================================================================

export type RunType = 'sync' | 'action' | 'code' | 'automation' | 'auth';
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
// 'expired' is the system giving up on an undecided approval after the TTL
// (scheduled/expire-pending-approvals.ts). It is deliberately distinct from
// 'rejected', which is a HUMAN decision the Automation learns from — an agent
// must not train on silence as if it were disapproval.
export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'auto';

export interface Run {
  id: number;
  organizationId: string;
  runType: RunType;
  feedId?: number;
  connectionId?: number;
  actionKey?: string;
  actionInput?: Record<string, unknown>;
  actionOutput?: Record<string, unknown>;
  approvalStatus: ApprovalStatus;
  status: RunStatus;
  claimedBy?: string;
  claimedAt?: Date;
  lastHeartbeatAt?: Date;
  completedAt?: Date;
  connectorKey?: string;
  connectorVersion?: string;
  checkpoint?: Record<string, unknown>;
  itemsCollected: number;
  errorMessage?: string;
  createdAt: Date;
}

// =============================================================================
// Event Envelope
// =============================================================================

/**
 * EventEnvelope is the standard output format for connector sync operations.
 * Each envelope becomes a row in the events table.
 */
export interface EventEnvelope {
  /** Platform's unique ID for this item */
  origin_id: string;
  /** Source-native item type (e.g. post, message, issue) */
  origin_type?: string;
  /** Content format: 'text' (default), 'markdown', 'json_template', 'media', 'empty' */
  payload_type?: 'text' | 'markdown' | 'json_template' | 'media' | 'empty';
  /** Main text content */
  payload_text: string;
  /** Structured data (template data for json_template, or structured metadata for media) */
  payload_data?: Record<string, unknown>;
  /** JSON template for rendering (required when payload_type is 'json_template') */
  payload_template?: Record<string, unknown> | null;
  /** File or media attachments */
  attachments?: unknown[];
  /** Title / subject line */
  title?: string;
  /** Author name or email */
  author_name?: string;
  /** Link to original content */
  source_url?: string;
  /** When the content was originally created/published */
  occurred_at: Date;
  /** Semantic type (e.g. content, note, summary, fact) */
  semantic_type?: string;
  /** Engagement/relevance score (0-100) */
  score?: number;
  /** Parent reference for hierarchical content */
  origin_parent_id?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
  /** Pre-computed embedding vector */
  embedding?: number[];
  /** Connector-normalized Automation activations derived from this event. */
  automation_signals?: ConnectorAutomationSignalDraft[];
}

// =============================================================================
// Sync Context & Result
// =============================================================================

/**
 * Context passed to ConnectorRuntime.sync().
 *
 * Generic parameters:
 * - `C` — checkpoint shape (defaults to `Record<string, unknown>`)
 * - `F` — feed config shape (defaults to `Record<string, unknown>`)
 */
export interface SyncContext<C = Record<string, unknown>, F = Record<string, unknown>> {
  /** Feed key */
  feedKey: string;
  /**
   * Stable id of this feed INSTANCE (the `feeds` row), when run by the platform.
   * Distinct per feed even when several feeds share one `feedKey` on a single
   * connection — use it to namespace emitted `origin_id`s so two feeds can't
   * supersede each other's events. Undefined for direct/programmatic sync calls.
   */
  feedId?: number | null;
  /** Feed configuration (typed via F) */
  config: F;
  /** Previous checkpoint (null on first sync) */
  checkpoint: C | null;
  /** OAuth credentials (if applicable) */
  credentials: SyncCredentials | null;
  /** Entity IDs this feed is linked to */
  entityIds: number[];
  /** Connection session state (browser cookies, tokens, etc.) */
  sessionState?: Record<string, unknown> | null;
  /** App-installation context when this connection is backed by an App install. */
  installation?: ConnectorInstallationContext;
  /** Optional hook for streaming event chunks while sync is in progress */
  emitEvents?: (events: EventEnvelope[]) => Promise<void>;
  /** Optional hook for persisting progress checkpoints during long syncs */
  updateCheckpoint?: (checkpoint: C | null) => Promise<void>;
}

/**
 * The credential a run is handed. On the isolate lane `accessToken` is a
 * per-run `lobu_secret_<uuid>` placeholder the host resolves into the request
 * header, so send it in a header — never in a URL. `refreshToken` is never
 * populated for a run: the gateway refreshes tokens itself and the wire
 * contract (`OAuthCredentialsSchema` in `@lobu/core`) carries the access token
 * alone.
 */
export interface SyncCredentials {
  provider: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: string | null;
  scope?: string | null;
}

/**
 * Result from ConnectorRuntime.sync().
 *
 * Generic parameter `C` matches the connector's checkpoint shape.
 */
export interface SyncResult<C = Record<string, unknown>> {
  /** Events to write to the events table */
  events: EventEnvelope[];
  /** Updated checkpoint to persist */
  checkpoint: C | null;
  /** Updated auth state to persist on the linked auth profile (browser cookies, etc.) */
  auth_update?: Record<string, unknown> | null;
  /** Optional metadata about the sync */
  metadata?: {
    items_found?: number;
    items_skipped?: number;
    [key: string]: unknown;
  };
}

// =============================================================================
// Webhooks (inbound real-time push)
// =============================================================================

/**
 * Context passed to {@link ConnectorRuntime.registerWebhook} /
 * `unregisterWebhook` at connect/disconnect time.
 */
export interface WebhookRegistrationContext<F = Record<string, unknown>> {
  /** Feed/connector configuration (typed via F). */
  config: F;
  /** OAuth credentials used to authorize the subscription call. */
  credentials: SyncCredentials | null;
  /** Connection session state (browser cookies, tokens, etc.). */
  sessionState?: Record<string, unknown> | null;
  /**
   * Public URL the provider must POST deliveries to — the gateway builds this
   * from `PUBLIC_*_URL` + the connection id. The connector registers it verbatim.
   */
  callbackUrl: string;
  /** Provider-side subscription id to tear down (unregister only). */
  externalId?: string;
  /**
   * App-installation context when the webhook is backed by an App install. In
   * `app_installation` delivery mode register/unregister are no-ops, so this is
   * informational; subscriptions are provisioned at install time.
   */
  installation?: ConnectorInstallationContext;
}

/** Result from {@link ConnectorRuntime.registerWebhook}. */
export interface WebhookRegistration {
  /** Provider-side id of the created subscription, for later teardown. */
  externalId: string;
  /**
   * Shared secret the provider will sign deliveries with. Persisted on the
   * connection so the gateway can verify deliveries per {@link ConnectorWebhookSchema}.
   */
  secret?: string;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Feed source reads + connection queries
// =============================================================================

export type FeedOperation = 'sync' | 'read';

/**
 * A source read for one configured feed. The connector interprets `query` in
 * its native vocabulary and pushes pagination/sort into the source. Results are
 * returned to the caller without being persisted by this contract.
 */
export interface FeedReadContext<F = Record<string, unknown>> {
  feedId?: number;
  feedKey: string;
  query?: string;
  /** Source-native continuation token from the previous page, when supported. */
  cursor?: string;
  config: F;
  credentials: SyncCredentials | null;
  sessionState?: Record<string, unknown> | null;
  installation?: ConnectorInstallationContext;
  limit?: number;
  offset?: number;
  sort?: { column: string; order: 'asc' | 'desc' };
}

export interface FeedReadResult {
  rows: Record<string, unknown>[];
  columns?: { name: string; type: string }[];
  total?: number;
  /** Source-native continuation token. The platform wraps this before exposing it. */
  nextCursor?: string;
  /** Explicit page exhaustion signal for sources without a continuation token. */
  hasMore?: boolean;
}

export type FeedSyncHandler<C = Record<string, unknown>, F = Record<string, unknown>> = (
  ctx: SyncContext<C, F>
) => Promise<SyncResult<C>>;

export type FeedReadHandler<F = Record<string, unknown>> = (
  ctx: FeedReadContext<F>
) => Promise<FeedReadResult>;

/** Executable feed definition held only inside a connector runtime. */
export interface RuntimeFeedDefinition<
  C = Record<string, unknown>,
  F = Record<string, unknown>,
> extends Omit<FeedDefinition, 'operations'> {
  sync?: FeedSyncHandler<C, F>;
  read?: FeedReadHandler<F>;
}

/** Runtime-only connector definition. Metadata extraction strips handlers. */
export interface RuntimeConnectorDefinition<
  C = Record<string, unknown>,
  F = Record<string, unknown>,
> extends Omit<ConnectorDefinition, 'feeds'> {
  feeds?: Record<string, RuntimeFeedDefinition<C, F>>;
}

/**
 * Context passed to ConnectorRuntime.query(). The connector runs `query` LIVE
 * against its source and returns rows WITHOUT persisting anything. This is the
 * connection-level governed query seam used by SQL/warehouse connectors; feed
 * reads use the per-feed `read` handler instead.
 */
export interface QueryContext<F = Record<string, unknown>> {
  /** The read-only query to run. */
  query: string;
  /** Connection-level query configuration (typed via F). */
  config: F;
  /** OAuth/env credentials (if applicable). */
  credentials: SyncCredentials | null;
  /** Connection session state (browser cookies, tokens, etc.). */
  sessionState?: Record<string, unknown> | null;
  /** App-installation context when this connection is backed by an App install. */
  installation?: ConnectorInstallationContext;
  /** Pagination + sort the platform wants applied; the connector pushes these down. */
  limit?: number;
  offset?: number;
  sort?: { column: string; order: 'asc' | 'desc' };
}

/** Result from ConnectorRuntime.query(). Rows are returned to the caller, never persisted. */
export interface QueryResult {
  rows: Record<string, unknown>[];
  columns?: { name: string; type: string }[];
  /** Total matching rows (for pagination), when cheaply available. */
  total?: number;
}

// =============================================================================
// Metric reflection (warehouse federation)
// =============================================================================

// The contributed shapes (EntityTypeContribution, ReflectedMeasure) are the
// persisted metric contract and live in ./metrics.ts (imported above).
// Re-exported here for connector authors.
export type { EntityTypeContribution, ReflectedMeasure };

/**
 * Context for {@link ConnectorRuntime.reflectMetrics} — enough to introspect the
 * source's native semantic layer (e.g. list Snowflake semantic views).
 */
export interface ReflectContext<F = Record<string, unknown>> {
  /**
   * The Lobu connection slug being reflected. Stamp this into each
   * {@link EntityTypeContribution} `backing.connection` so live queries route
   * back through the right connection (the connector cannot otherwise know it).
   */
  connectionSlug: string;
  /** Connector options (typed via F). */
  config: F;
  /** OAuth/env credentials (if applicable). */
  credentials: SyncCredentials | null;
  /** Connection session state (browser cookies, tokens, etc.). */
  sessionState?: Record<string, unknown> | null;
  /** App-installation context when this connection is backed by an App install. */
  installation?: ConnectorInstallationContext;
}

/** Result from ConnectorRuntime.reflectMetrics() — federated entity types. */
export type ReflectResult = EntityTypeContribution[];

// =============================================================================
// Authentication Lifecycle
// =============================================================================

/**
 * Artifact streamed from connector.authenticate() to the UI during an
 * interactive auth flow. Exactly one artifact is active at a time; calling
 * `ctx.emit()` replaces the previously active artifact in the run checkpoint.
 *
 * Core doesn't interpret these — UI renders by `type`.
 */
export type AuthArtifact =
  | {
      type: 'qr';
      /** Raw string to encode in the QR. */
      value: string;
      /** ISO timestamp. UI shows countdown and expects a replacement emit. */
      expiresAt?: string;
      instructions?: string;
    }
  | {
      type: 'code';
      /** Short human-typed code, e.g. "ABCD-1234". */
      value: string;
      expiresAt?: string;
      instructions?: string;
    }
  | {
      type: 'redirect';
      /** URL the user must visit (OAuth authorize, etc.). */
      url: string;
      mode: 'popup' | 'same-tab';
      /** Signal name the connector awaits. UI POSTs to /api/auth-runs/:id/signal with this name. */
      awaitSignal: string;
      instructions?: string;
    }
  | {
      type: 'prompt';
      fields: Array<{
        key: string;
        label: string;
        kind: 'text' | 'password' | 'otp';
        required?: boolean;
      }>;
      /** Signal name the connector awaits once the user submits. */
      submitSignal: string;
      instructions?: string;
    }
  | {
      type: 'status';
      /** Progress message requiring no user action, e.g. "Waiting for phone…". */
      message: string;
    };

/**
 * Context passed to ConnectorRuntime.authenticate().
 */
export interface AuthContext {
  /** Optional connector-specific input (rare — most interactive flows need no input). */
  config: Record<string, unknown>;
  /**
   * Previous credentials if re-authenticating an existing profile. Connectors
   * may use these to preserve identity (e.g. refresh an OAuth token).
   */
  previousCredentials: Record<string, unknown> | null;
  /** Stream an artifact to the UI. Replaces the previously active artifact. */
  emit: (artifact: AuthArtifact) => Promise<void>;
  /**
   * Pause until the UI sends a signal with the given name. Returns the
   * signal payload (shape is connector-defined).
   */
  awaitSignal: (name: string, options?: { timeoutMs?: number }) => Promise<Record<string, unknown>>;
  /** Aborts on timeout, user cancel, or worker shutdown. */
  signal: AbortSignal;
}

/**
 * Result from ConnectorRuntime.authenticate(). Credentials are persisted to
 * the linked auth profile's `credentials` column. Metadata goes to
 * `auth_profiles.metadata` and powers UI session-state display.
 */
export interface AuthResult {
  credentials: Record<string, unknown>;
  metadata?: {
    /** Stable external identifier (wa_jid, OAuth `sub`, etc.) for dedupe. */
    account_id?: string;
    /** Display label shown in the UI, e.g. "Burak · +14155551234". */
    display_name?: string;
    /** For credentials that expire (OAuth refresh tokens). */
    expires_at?: string;
    [key: string]: unknown;
  };
}

// =============================================================================
// Action Context & Result
// =============================================================================

/**
 * Context passed to ConnectorRuntime.execute()
 */
export interface ActionContext {
  /** Action key to execute */
  actionKey: string;
  /** Action input parameters */
  input: Record<string, unknown>;
  /** OAuth credentials (if applicable) */
  credentials: SyncCredentials | null;
  /** Connection config */
  config: Record<string, unknown>;
  /**
   * Per-run session state. The connector-worker splices a live
   * `chrome_dispatcher` (a `ChromeActionDispatcher`) onto this for action runs
   * the same way it does for syncs, so on-demand actions can drive the paired
   * Owletto Chrome extension (e.g. scrape a page the agent chose at runtime).
   * Null when no session/dispatcher applies.
   */
  sessionState?: Record<string, unknown> | null;
  /** App-installation context when this connection is backed by an App install. */
  installation?: ConnectorInstallationContext;
}

/**
 * Result from ConnectorRuntime.execute()
 */
export interface ActionResult {
  /** Whether the action succeeded */
  success: boolean;
  /** Output data */
  output?: Record<string, unknown>;
  /** Error message if failed */
  error?: string;
}

// =============================================================================
// Content Item (API response shape)
// =============================================================================

/**
 * Content item as returned by the read_knowledge API.
 * This is the canonical shape for content data across the platform.
 */
export interface ContentItem {
  id: number;
  entity_ids: number[];
  platform: string;
  origin_id: string;
  semantic_type: string;
  origin_type?: string | null;
  payload_type?: 'text' | 'markdown' | 'json_template' | 'media' | 'empty';
  author_name: string | null;
  title: string | null;
  text_content: string;
  payload_text?: string | null;
  /**
   * True when a query/list response returns only the bounded payload_text head.
   * Re-read the event by `content_ids` for the full body.
   */
  payload_truncated?: boolean;
  /** Full original payload_text character count (PostgreSQL length semantics). */
  content_length?: number;
  payload_data?: Record<string, unknown>;
  payload_template?: Record<string, unknown> | null;
  attachments?: Array<Record<string, unknown>>;
  /**
   * True when oversized attachment contents were omitted and `attachments` is
   * empty. Re-read the event by `content_ids` for the full array.
   */
  attachments_truncated?: boolean;
  /** Full serialized attachment-array size in UTF-8 bytes when truncated. */
  attachments_bytes?: number;
  rating: string | null;
  source_url: string | null;
  score: number;
  normalized_score?: number;
  metadata: Record<string, unknown>;
  classifications: Record<string, unknown>;
  created_at: string;
  occurred_at: string;
  content_date?: string;
  /** Excerpt for highlighted evidence (when filtering by classification value) */
  excerpt?: string;
  /** Search score fields (only present when query is provided) */
  similarity?: number;
  text_rank?: number;
  combined_score?: number;
  /** Score breakdown (only present when sort_by=score, for debugging) */
  score_breakdown?: {
    engagement: number;
    criticality: number;
    depth: number;
    authority: number;
    recency: number;
    quality: number;
    raw_signals?: {
      depth_raw: number;
      engagement_raw: number;
    };
    weights: {
      engagement: number;
      criticality: number;
      depth: number;
      authority: number;
      recency: number;
      quality: number;
      platform: number;
    };
  };
  /** OAuth client id that created this event (authenticated workspace reads only). */
  client_id?: string | null;
  /** OAuth client name that created this event */
  client_name?: string | null;
  /** Source connection that collected the event (when connector-sourced). */
  connection_id?: number | null;
  /** Human-facing connection name (authenticated workspace reads only). */
  connection_name?: string | null;
  /** Feed the event was collected through (when connector-sourced). */
  feed_id?: number | null;
  /** Feed key (e.g. "tweets", "home_feed") the event was collected through. */
  feed_key?: string | null;
  /** Human-facing feed display name (e.g. "X Home Timeline"). */
  feed_name?: string | null;
  /** Automation that produced the event (when automation-output-sourced). */
  automation_id?: number | null;
  /** Human-facing automation name (when automation-output-sourced). */
  automation_name?: string | null;
  /** Managed agent that produced the event (authenticated workspace reads only). */
  agent_id?: string | null;
  /** Human-facing managed agent name. */
  agent_name?: string | null;
  /** Device runtime involved in producing the event (authenticated workspace reads only). */
  device_worker_id?: string | null;
  /** Human-facing device label. */
  device_label?: string | null;
  /** Device platform used to select the device icon. */
  device_platform?: string | null;
  /** Immediate parent origin_id */
  origin_parent_id: string | null;
  /** Thread root origin_id */
  root_origin_id: string;
  /** 0 = root, 1+ = nested */
  depth: number;
  /** Only if parent not in current results */
  parent_context?: {
    author_name: string;
    title: string | null;
    text_content: string;
    occurred_at: string;
    source_url: string;
    score: number;
  } | null;
  /** Only if root not in results AND depth > 0 */
  root_context?: {
    author_name: string;
    title: string;
    occurred_at: string;
    source_url: string;
    score: number;
  } | null;
  /** Permalink URL for this specific knowledge item */
  permalink?: string | null;
  interaction_type?: 'none' | 'approval';
  interaction_status?: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed' | null;
  interaction_input_schema?: Record<string, unknown> | null;
  interaction_input?: Record<string, unknown> | null;
  interaction_output?: Record<string, unknown> | null;
  interaction_error?: string | null;
  supersedes_event_id?: number | null;
  /** The newer event that superseded this one, when this row is the stale/
   *  tombstone side of a supersede chain (denormalized forward edge). */
  superseded_by?: number | null;
  /** True when a newer row in the same supersede chain replaced this one — i.e.
   *  this is not the live head. Lets callers reading the full chain (content_ids
   *  resolution returns the whole lineage) tell the head from the history. */
  is_superseded?: boolean;
  /** The run this event belongs to, when it originated from one (operation
   *  chains, approval notifications). Lets the client group a run's satellite
   *  events (the "needs approval" notification) onto the same timeline node as
   *  its operation chain, and surface a "Run #N" identity. */
  run_id?: number | null;
  /** Entity display info (only present in some responses) */
  entity_name?: string;
  entity_type?: string;
  entity_slug?: string;
}
