/**
 * Connector Runtime
 *
 * Abstract base class that all connectors must implement.
 * Provides the contract for feed sync, source reads, and connector actions.
 */

import type {
  ActionContext,
  ActionResult,
  AuthContext,
  AuthResult,
  FeedDeliveryContext,
  FeedReadContext,
  FeedReadResult,
  QueryContext,
  QueryResult,
  ReflectContext,
  ReflectResult,
  RuntimeConnectorDefinition,
  SyncContext,
  SyncResult,
  WebhookRegistration,
  WebhookRegistrationContext,
} from './connector-types.js';
import { assertFeedReadWindow, validateFeedReadWindow } from './feed-read-window.js';

/**
 * ConnectorRuntime is the base class for all connectors.
 *
 * Generic parameters:
 * - `C` — checkpoint shape (defaults to `Record<string, unknown>`)
 * - `F` — feed config shape (defaults to `Record<string, unknown>`)
 *
 * Subclasses set `definition` with connector metadata and per-feed handlers.
 *
 * Subclasses may optionally override `execute()` and `authenticate()`; both
 * have safe defaults (action rejected with `{ success: false, ... }`, auth
 * throws). Connectors that don't declare any `actions` in their definition
 * need not override `execute()`.
 *
 * @example
 * ```ts
 * interface MyCheckpoint { last_sync_at?: string }
 * interface MyConfig { label?: string }
 *
 * class GmailConnector extends ConnectorRuntime<MyCheckpoint, MyConfig> {
 *   definition = {
 *     key: 'google.gmail', name: 'Gmail', version: '1.0.0',
 *     feeds: { threads: { key: 'threads', name: 'Threads', sync: syncThreads, read: readThreads } }
 *   };
 * }
 * ```
 */
export abstract class ConnectorRuntime<C = Record<string, unknown>, F = Record<string, unknown>> {
  /** Connector definition with metadata, feed handlers, and action schemas. */
  abstract readonly definition: RuntimeConnectorDefinition<C, F>;

  /**
   * Sync data from the connected service.
   *
   * Called by the worker when a sync run is executed.
   * Should return events to ingest and an updated checkpoint.
   * Long-running connectors may optionally use `ctx.emitEvents()` and
   * `ctx.updateCheckpoint()` to stream progress before returning.
   *
   * @param ctx - Sync context with feed config, checkpoint, and credentials
   * @returns Events and updated checkpoint
   */
  async sync(ctx: SyncContext<C, F>): Promise<SyncResult<C>> {
    const handler = this.definition.feeds?.[ctx.feedKey]?.sync;
    if (!handler) {
      throw new Error(
        `${this.definition.key} feed '${ctx.feedKey}' does not support sync`
      );
    }
    return handler(ctx);
  }

  /** Process delivered source data; the handler decides whether a fetch is needed. */
  async onDelivery(ctx: FeedDeliveryContext<C, F>): Promise<SyncResult<C>> {
    const handler = this.definition.feeds?.[ctx.feedKey]?.onDelivery;
    if (!handler) {
      throw new Error(
        `${this.definition.key} feed '${ctx.feedKey}' does not support delivery`
      );
    }
    return handler(ctx);
  }

  /**
   * Read one configured feed directly from its source. Feed handlers own native
   * filtering and pagination; the platform never infers semantics from a feed
   * kind or persistence flag.
   */
  async read(ctx: FeedReadContext<F>): Promise<FeedReadResult> {
    if (ctx.window) validateFeedReadWindow(ctx.window);
    const feed = this.definition.feeds?.[ctx.feedKey];
    const handler = feed?.read;
    if (!handler) {
      throw new Error(
        `${this.definition.key} feed '${ctx.feedKey}' does not support source reads`
      );
    }
    const result = await handler(ctx);
    assertFeedReadWindow(result, ctx.window, feed.readWindowAxis);
    return result;
  }

  /**
   * Execute an action on the connected service.
   *
   * Called either inline (low-risk) or by the worker (high-risk with approval).
   * Default implementation rejects with "Actions not supported" — connectors
   * that don't declare any `actions` in their definition need not override.
   * The `ctx` parameter is part of the public contract (subclasses overriding
   * this method receive the full `ActionContext`); the base impl ignores it.
   *
   * @param ctx - Action context with action key, input, and credentials
   * @returns Action result with output data
   */
  // biome-ignore lint/correctness/noUnusedFunctionParameters: contract signature — subclasses receive the full ActionContext
  async execute(ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: 'Actions not supported' };
  }

  /**
   * Run a governed read-only query against the connection. This is intentionally
   * separate from feed source reads: SQL/warehouse connections use it for ad-hoc
   * pushdown and externally backed derived entities.
   */
  // biome-ignore lint/correctness/noUnusedFunctionParameters: contract signature — subclasses receive the full QueryContext
  async query(ctx: QueryContext<F>): Promise<QueryResult> {
    throw new Error(`${this.definition.key} does not support live queries`);
  }

  /**
   * Subscribe to provider webhooks at connect time (or re-auth), using the
   * connection's OAuth credentials, so deliveries flow to `ctx.callbackUrl`
   * (`/api/v1/webhooks/:connectionId`). Returns the provider subscription id and
   * the signing secret to persist on the connection for in-gateway verification.
   * Default throws — connectors that declare a `webhook` block MUST override.
   */
  async registerWebhook(_ctx: WebhookRegistrationContext<F>): Promise<WebhookRegistration> {
    throw new Error(`${this.definition.key} does not support webhook registration`);
  }

  /**
   * Tear down the provider subscription created by {@link registerWebhook} when
   * the connection is removed. Default is a no-op — override to call the
   * provider's delete-subscription endpoint with `ctx.externalId`.
   */
  // biome-ignore lint/correctness/noUnusedFunctionParameters: contract signature — subclasses receive the full WebhookRegistrationContext
  async unregisterWebhook(ctx: WebhookRegistrationContext<F>): Promise<void> {
    // no-op by default
  }

  /**
   * Contribute entity types by FEDERATING the source's own governed metrics
   * (e.g. Snowflake semantic views, dbt metrics). Returns derived entity types
   * `backing`'d by live SQL over this connection — Lobu stores a pointer +
   * governance, never re-authoring the metric. Default returns `[]` — connectors
   * with no native semantic layer contribute none.
   */
  // biome-ignore lint/correctness/noUnusedFunctionParameters: contract signature — subclasses receive the full ReflectContext
  async reflectMetrics(ctx: ReflectContext<F>): Promise<ReflectResult> {
    return [];
  }

  /**
   * Run an interactive authentication flow that produces credentials for the
   * linked auth profile. Invoked during connection creation (or re-auth) when
   * the connector declares an interactive auth method.
   *
   * Stream artifacts (QR, pairing code, redirect URL, status) via `ctx.emit()`
   * and pause on `ctx.awaitSignal()` for UI-delivered input (OAuth callback,
   * form submit). Throw to fail the run; the caught error is surfaced to the
   * UI.
   *
   * Default implementation throws — connectors with non-interactive auth
   * (env_keys, static tokens) don't need to override.
   */
  async authenticate(_ctx: AuthContext): Promise<AuthResult> {
    throw new Error(`${this.definition.key} does not support interactive authentication`);
  }
}

/**
 * Base class for device-bound connectors whose real `sync()`/`execute()` run
 * inside a device bridge (the Owletto Chrome extension or the Lobu Mac/iOS app),
 * not on the server-side worker fleet. The server only ever holds the connector
 * DEFINITION; the cloud-side methods exist purely as safety stubs that throw if a
 * worker without the connector's `requiredCapability` somehow claims the run.
 *
 * Subclasses declare only their `definition` and pass the bridge-only message to
 * `super()`; both `sync()` and `execute()` throw that exact message.
 *
 * @example
 * ```ts
 * export default class ChromeHistoryConnector extends BridgeOnlyConnector {
 *   constructor() {
 *     super('chrome.history runs only on a worker advertising capability "browser.history".');
 *   }
 *   readonly definition: RuntimeConnectorDefinition = { ... };
 * }
 * ```
 */
export abstract class BridgeOnlyConnector extends ConnectorRuntime {
  constructor(private readonly bridgeMessage: string) {
    super();
  }

  async sync(): Promise<SyncResult> {
    throw new Error(this.bridgeMessage);
  }

  async execute(): Promise<ActionResult> {
    throw new Error(this.bridgeMessage);
  }
}

/**
 * Base class for `kind: 'integration'` connectors — pure app/auth declarations
 * (e.g. Slack) that carry an `authSchema` + `webhook` but have NO `feeds` and are
 * NEVER polled: inbound traffic is forwarded to a chat adapter, not synced. The
 * base satisfies the `sync()` contract with a hard throw so a scheduled sync
 * (which can only ever be a wiring bug — an integration connector has no feeds)
 * fails loudly instead of silently no-op'ing. Subclasses declare only their
 * `definition` (with `kind: 'integration'`).
 *
 * @example
 * ```ts
 * export default class SlackConnector extends IntegrationConnector {
 *   readonly definition: RuntimeConnectorDefinition = { key: 'slack', kind: 'integration', ... };
 * }
 * ```
 */
export abstract class IntegrationConnector extends ConnectorRuntime {
  async sync(): Promise<SyncResult> {
    throw new Error(
      `${this.definition.key} is an integration connector (kind: 'integration') with no syncable feeds; inbound traffic flows through its app-webhook endpoint, not a poll.`,
    );
  }
}
