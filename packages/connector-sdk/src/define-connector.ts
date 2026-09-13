/**
 * defineConnector — functional authoring sugar over {@link ConnectorRuntime}.
 *
 * Lets a connector be declared as a plain spec with per-feed `sync` and
 * per-action `execute` handlers (plus an optional `authenticate` flow), instead
 * of hand-writing a class that switches on `ctx.feedKey` / `ctx.actionKey`. The
 * feed/action keys are taken from the record keys, so they're never repeated.
 *
 * It LOWERS to a real `ConnectorRuntime` subclass so the existing
 * connector-worker runs it unchanged: the isolate guest detects a connector by
 * looking for a constructor whose prototype has `sync()` and `execute()`, then
 * instantiates it and reads `instance.definition`. The class returned here
 * satisfies that contract exactly.
 *
 * `@lobu/connector-sdk` is externalized at connector compile time, so this
 * function ships as runtime-provided SDK code while the caller's handler
 * closures get bundled into the connector — the spec object (with its
 * `sync`/`execute`/`authenticate` functions) is captured by the returned class.
 *
 * @example
 * ```ts
 * export default defineConnector({
 *   key: 'github', name: 'GitHub', version: '1.0.0',
 *   feeds: { stars: { name: 'Stars', sync: async (ctx) => ({ events, checkpoint }) } },
 *   actions: { star_repo: { name: 'Star', execute: async (ctx) => ({ success: true }) } },
 * });
 * ```
 */

import { ConnectorRuntime } from "./connector-runtime.js";
import type {
  ActionContext,
  ActionDefinition,
  ActionResult,
  AuthContext,
  AuthResult,
  ConnectorDefinition,
  FeedDefinition,
  FeedDeliveryHandler,
  FeedReadHandler,
  FeedSyncHandler,
  QueryContext,
  QueryResult,
  ReflectContext,
  ReflectResult,
  RuntimeConnectorDefinition,
  WebhookRegistration,
  WebhookRegistrationContext,
} from "./connector-types.js";

/**
 * A feed's metadata plus one or both executable operations. Capabilities are
 * inferred from these handlers when metadata is extracted.
 */
export type ConnectorFeedSpec<
  C = Record<string, unknown>,
  F = Record<string, unknown>,
> = Omit<FeedDefinition, "key" | "operations"> &
  (
    | {
        sync: FeedSyncHandler<C, F>;
        read?: FeedReadHandler<F>;
        onDelivery?: FeedDeliveryHandler<C, F>;
      }
    | {
        sync?: FeedSyncHandler<C, F>;
        read: FeedReadHandler<F>;
        onDelivery?: FeedDeliveryHandler<C, F>;
      }
    | {
        sync?: FeedSyncHandler<C, F>;
        read?: FeedReadHandler<F>;
        onDelivery: FeedDeliveryHandler<C, F>;
      }
  );

/** An action's metadata (minus `key`; `requiresApproval` defaults false) plus its `execute` handler. */
export interface ConnectorActionSpec
  extends Omit<ActionDefinition, "key" | "requiresApproval"> {
  /** Whether the action needs human approval before execution. Defaults to `false`. */
  requiresApproval?: boolean;
  /** Effect handler for this action. Called inline (low-risk) or by the worker. */
  execute(ctx: ActionContext): Promise<ActionResult>;
}

/** Functional connector spec: connector metadata plus handler-bearing feeds/actions. */
export interface ConnectorSpec
  extends Omit<ConnectorDefinition, "feeds" | "actions"> {
  feeds?: Record<string, ConnectorFeedSpec>;
  actions?: Record<string, ConnectorActionSpec>;
  /**
   * Optional interactive auth flow. When provided, lowers to
   * `ConnectorRuntime.authenticate`; when omitted, the connector inherits the
   * base implementation (throws — non-interactive auth needs no handler).
   */
  authenticate?(ctx: AuthContext): Promise<AuthResult>;
  /**
   * Optional connection-level governed query handler for SQL/warehouse
   * pushdown. Configured feed reads belong on `feeds[key].read`.
   */
  query?(ctx: QueryContext): Promise<QueryResult>;
  /**
   * Optional metric-reflection handler. When provided, lowers to
   * `ConnectorRuntime.reflectMetrics` — contributes entity types federating the
   * source's native governed metrics. Omitted ⇒ no contributions.
   */
  reflectMetrics?(ctx: ReflectContext): Promise<ReflectResult>;
  /**
   * Optional webhook-subscription handler. When provided, lowers to
   * `ConnectorRuntime.registerWebhook` — subscribes with the provider at connect
   * time and returns the secret to persist. Omitted ⇒ registration unsupported.
   */
  registerWebhook?(ctx: WebhookRegistrationContext): Promise<WebhookRegistration>;
  /**
   * Optional webhook-teardown handler. When provided, lowers to
   * `ConnectorRuntime.unregisterWebhook` — deletes the provider subscription on
   * disconnect. Omitted ⇒ teardown is a no-op.
   */
  unregisterWebhook?(ctx: WebhookRegistrationContext): Promise<void>;
}

/** Constructor shape the connector-worker's isolate guest detects and instantiates. */
export type ConnectorClass = new () => ConnectorRuntime;

/** Build the executable runtime definition; metadata extraction strips handlers. */
function buildDefinition(spec: ConnectorSpec): RuntimeConnectorDefinition {
  const definition: RuntimeConnectorDefinition = {
    key: spec.key,
    name: spec.name,
    version: spec.version,
    description: spec.description,
    authSchema: spec.authSchema,
    optionsSchema: spec.optionsSchema,
    faviconDomain: spec.faviconDomain,
    mcpConfig: spec.mcpConfig,
    openapiConfig: spec.openapiConfig,
    requiredCapability: spec.requiredCapability,
    runtime: spec.runtime,
    webhook: spec.webhook,
    automationEvents: spec.automationEvents,
  };

  if (spec.feeds) {
    definition.feeds = Object.fromEntries(
      Object.entries(spec.feeds).map(([key, feed]) => [
        key,
        {
          key,
          name: feed.name,
          description: feed.description,
          requiredScopes: feed.requiredScopes,
          displayNameTemplate: feed.displayNameTemplate,
          configSchema: feed.configSchema,
          userManaged: feed.userManaged,
          webhook: feed.webhook,
          eventKinds: feed.eventKinds,
          sync: feed.sync,
          read: feed.read,
          onDelivery: feed.onDelivery,
          readWindowAxis: feed.readWindowAxis,
        },
      ]),
    );
  }

  if (spec.actions) {
    definition.actions = Object.fromEntries(
      Object.entries(spec.actions).map(
        ([key, action]): [string, ActionDefinition] => [
          key,
          {
            key,
            name: action.name,
            description: action.description,
            requiresApproval: action.requiresApproval ?? false,
            // `kind` and `requiredScopes` are semantic policy inputs (read/write
            // classification and the per-action scope gate). Dropping them here
            // would silently publish scoped/observational actions with neither,
            // so a defineConnector() action would bypass the scope gate that a
            // raw ActionDefinition enforces.
            kind: action.kind,
            requiredScopes: action.requiredScopes,
            annotations: action.annotations,
            inputSchema: action.inputSchema,
            outputSchema: action.outputSchema,
          },
        ],
      ),
    );
  }

  return definition;
}

/**
 * Build a {@link ConnectorRuntime} subclass from a functional spec. The default
 * export of a `.connector.ts` should be the returned class.
 */
export function defineConnector(spec: ConnectorSpec): ConnectorClass {
  const definition = buildDefinition(spec);

  return class extends ConnectorRuntime {
    readonly definition = definition;

    async execute(ctx: ActionContext): Promise<ActionResult> {
      const action = spec.actions?.[ctx.actionKey];
      if (!action) {
        return {
          success: false,
          error: `Connector '${spec.key}' has no action handler for '${ctx.actionKey}'`,
        };
      }
      return action.execute(ctx);
    }

    async authenticate(ctx: AuthContext): Promise<AuthResult> {
      if (!spec.authenticate) {
        return super.authenticate(ctx);
      }
      return spec.authenticate(ctx);
    }

    async query(ctx: QueryContext): Promise<QueryResult> {
      if (!spec.query) {
        return super.query(ctx);
      }
      return spec.query(ctx);
    }

    async reflectMetrics(ctx: ReflectContext): Promise<ReflectResult> {
      if (!spec.reflectMetrics) {
        return super.reflectMetrics(ctx);
      }
      return spec.reflectMetrics(ctx);
    }

    async registerWebhook(ctx: WebhookRegistrationContext): Promise<WebhookRegistration> {
      if (!spec.registerWebhook) {
        return super.registerWebhook(ctx);
      }
      return spec.registerWebhook(ctx);
    }

    async unregisterWebhook(ctx: WebhookRegistrationContext): Promise<void> {
      if (!spec.unregisterWebhook) {
        return super.unregisterWebhook(ctx);
      }
      return spec.unregisterWebhook(ctx);
    }
  };
}
