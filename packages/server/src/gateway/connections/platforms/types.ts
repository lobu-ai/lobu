/**
 * Per-platform capability descriptors for Chat SDK connections.
 *
 * Each chat platform contributes one `ChatPlatformDescriptor` to the registry
 * in `./index.ts` (keyed by platform name, merged with the adapter factory
 * that used to live in `ADAPTER_FACTORIES`). `ChatInstanceManager` stays
 * platform-agnostic: it looks up the descriptor for a connection's platform
 * and calls the optional capability hooks, falling back gracefully when a
 * hook is absent. Adding a platform means adding one module under
 * `./platforms/` and registering it in `./index.ts` — no manager edits.
 */

import type { InstructionProvider, StoredConnection } from "@lobu/core";
import type { IFileHandler } from "../../platform/file-handler.js";
import type { WritableSecretStore } from "../../secrets/index.js";
import type { ChatInstanceManager } from "../chat-instance-manager.js";
import type { PlatformAdapterConfig, PlatformConnection } from "../types.js";

/** Routing info parsed from a platform-specific request body. */
export interface PlatformRoutingInfo {
  channelId: string;
  conversationId?: string;
  teamId?: string;
}

/**
 * The slice of a managed Chat instance that capability hooks may touch —
 * structurally compatible with `ChatInstanceManager`'s internal
 * `ManagedInstance` without exposing its lifecycle fields.
 */
export interface ChatPlatformInstance {
  connection: PlatformConnection;
  chat: any;
}

/** A slash command surfaced to a platform's native command menu. */
export interface PlatformCommand {
  command: string;
  description: string;
}

/**
 * Manager-owned persistence callbacks handed to `ensureWebhookSecret` so the
 * descriptor never needs the manager itself (or its private stores).
 */
export interface WebhookSecretDeps {
  secretStore: WritableSecretStore;
  persistConnection(connection: PlatformConnection): Promise<void>;
  getStoredConnection(id: string): Promise<StoredConnection | null>;
}

/** Manager-owned values that are known only once a connection is hydrated. */
export interface AdapterCreationContext {
  /** Canonical public URL that receives this connection's webhooks. */
  webhookUrl?: string;
}

/**
 * Capability descriptor for one chat platform. `createAdapter` is required
 * (it's the old `ADAPTER_FACTORIES` entry); everything else is optional and
 * the manager treats an absent hook as "platform doesn't support this".
 */
export interface ChatPlatformDescriptor {
  /** Lazily construct the `@chat-adapter/*` adapter for a resolved config. */
  createAdapter(config: any, context?: AdapterCreationContext): Promise<any>;

  /**
   * Parse platform-specific routing fields out of a messaging-API request
   * body (e.g. `body.slack.channel`). Return null when the fields are
   * missing/invalid so the caller falls back to its defaults.
   */
  extractRoutingInfo?(
    body: Record<string, unknown>
  ): PlatformRoutingInfo | null;

  /**
   * Build an outbound file handler bound to a running instance. Return
   * undefined when the connection lacks what the platform needs (e.g. no
   * bot token).
   */
  createFileHandler?(instance: ChatPlatformInstance): IFileHandler | undefined;

  /** Per-agent instruction provider (e.g. the Slack identity block). */
  getInstructionProvider?(manager: ChatInstanceManager): InstructionProvider;

  /**
   * Return a human-readable reason when this config must be refused (both at
   * create time, where the manager throws it, and at boot, where the manager
   * marks the row errored with it). Undefined means the config is acceptable.
   */
  getConfigRejection?(config: PlatformAdapterConfig): string | undefined;

  /**
   * Mutate a brand-new connection's config before it is persisted (e.g.
   * auto-generate a webhook secret the platform requires for verification).
   */
  prepareNewConnectionConfig?(config: PlatformAdapterConfig): void;

  /**
   * Config keys the server stamps onto the stored config (e.g. an
   * auto-generated webhook secret). The declarative no-op check ignores them
   * when the incoming declaration doesn't set them — otherwise every apply
   * of an unchanged declaration would look like a credential change.
   */
  serverStampedConfigKeys?: readonly string[];

  /**
   * Backfill/converge a webhook verification secret for an existing
   * connection at start time. Runs after the config is resolved to plaintext.
   */
  ensureWebhookSecret?(
    connection: PlatformConnection,
    deps: WebhookSecretDeps
  ): Promise<void>;

  /**
   * How the connection's config wants inbound delivery resolved. The manager
   * treats anything other than an explicit `"webhook"` / `"polling"` as
   * `"auto"` (webhook when a public gateway URL exists).
   */
  resolveWebhookMode?(config: PlatformAdapterConfig): string;

  /**
   * True when this config makes the connection an *exclusive* transport: a
   * persistent outbound loop (e.g. Telegram long-polling) where two replicas
   * running it concurrently is incorrect, not just wasteful. Exclusive
   * connections are started only by the lease-holding replica
   * (`connection_claims`), never by request-path hydration. Absent hook /
   * false = stateless webhook transport, hydratable on any replica.
   */
  requiresExclusiveStart?(
    config: PlatformAdapterConfig,
    ctx: { publicGatewayUrl: string }
  ): boolean;

  /** Register the public per-connection webhook URL with the platform. */
  configureWebhook?(
    connection: PlatformConnection,
    webhookUrl: string
  ): Promise<void>;

  /**
   * The platform's canonical form of a channel id — the spelling bindings and
   * Automation projections are keyed by. A platform whose inbound events and
   * its own slash commands disagree normalizes here: Slack hands a slash
   * command the bare `C…`/`D…` while every binding is stored `slack:C…`.
   * Absent hook = the id the caller already holds is canonical.
   */
  canonicalChannelId?(channelId: string): string;

  /**
   * Render a channel's display name the way a reader of THIS platform expects
   * it. `#general` on Slack, where `#` is simply how a channel is written;
   * bare everywhere else, because a Google Chat space or a Telegram group
   * names itself and a `#` would be noise. Absent hook = use the stored name.
   */
  formatChannelLabel?(name: string): string;

  /**
   * True when `teamId` is a real workspace id this platform can converge a
   * teamless Automation subscription onto. Slack Grid is the case: a
   * subscription written before its workspace was known carries no team, and
   * inbound events reliably carry the REAL `T…` (never the enterprise `E…`).
   * Absent hook = the platform has no workspace axis, so nothing to heal.
   */
  healableTeamId?(teamId: string): boolean;

  /**
   * True when a top-level channel message gets a FRESH thread id, so an
   * Automation bound to the CHANNEL can never pre-subscribe the ids of future
   * messages. Those events fall past the Chat SDK's subscribed → mention →
   * pattern routing into the pattern handlers, so the bridge registers a
   * catch-all to pick them up. Absent/false = channel messages keep a stable
   * conversation id and the SDK's own branches already deliver them.
   */
  channelMessagesMintFreshThreadIds?: boolean;

  /**
   * Config keys this platform cannot run without, checked before the row is
   * persisted. A nested array is an EITHER-OR group ("at least one of these"),
   * reported as `a or b` — Google Chat takes a service-account JSON key or
   * Application Default Credentials, never neither. A key counts as supplied
   * when it holds a non-blank string or boolean `true` (an ADC-style flag).
   * Format is not checked here, only presence: see `assertCredentialsUsable`.
   */
  requiredConfigKeys?: readonly (string | readonly string[])[];

  /**
   * Throw when a credential that IS present is unusable — malformed
   * service-account JSON, say. Runs after `requiredConfigKeys`, so the value
   * is known to exist; a platform whose credentials are opaque strings needs
   * no hook.
   */
  assertCredentialsUsable?(config: Record<string, unknown>): void;

  /** Register slash commands with the platform's native command menu. */
  registerCommands?(
    connection: PlatformConnection,
    commands: PlatformCommand[]
  ): Promise<void>;
}
