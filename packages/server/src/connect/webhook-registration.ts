/**
 * Connector webhook subscription lifecycle (connect-time register / teardown).
 *
 * When a connector connection becomes active and its connector declares a
 * `webhook` block AND a feed target is configured, we subscribe with the
 * provider once (extract-load: deliveries then POST to
 * `/api/v1/webhooks/:connectionId`). The minted secret + the connector's
 * declarative verification scheme are stamped onto the connection `config` so
 * the gateway ingest hot path can verify provider HMACs without running any
 * connector code per delivery (see gateway/connections/webhook-ingest.ts +
 * the two-table bridge in chat-instance-manager.handleIngestWebhook).
 *
 * Multi-replica: registration runs exactly once per connection (on activation),
 * never per delivery, and all state (externalId, secret ref, scheme) lives on
 * the Postgres `connections` row. No in-memory cross-pod state.
 */

import { connectorRunEnv } from '@lobu/connector-worker/env';
import { executeCompiledConnector } from '@lobu/connector-worker/executor/runtime';
import type { ConnectorWebhookSchema } from '@lobu/connector-sdk';
import { getDb } from '../db/client';
import { PostgresSecretStore } from '../lobu/stores/postgres-secret-store';
import { orgContext } from '../lobu/stores/org-context';
import { persistSecretValue } from '../gateway/secrets/index';
import { resolveBaseUrl } from '../auth/base-url';
import { isCloudMode } from '../utils/cloud-mode';
import { findBundledConnectorFile } from '../utils/connector-catalog';
import { resolveConnectorCodeForKey } from '../utils/ensure-connector-installed';
import { mergeExecutionConfig, resolveExecutionAuth } from '../utils/execution-context';
import logger from '../utils/logger';
import { getErrorMessage } from "@lobu/core";
import {
  ensureAtlassianMcpJiraWebhook,
  unregisterAtlassianMcpJiraWebhook,
} from './atlassian-mcp-webhook';

interface ConnectorConnectionRow {
  id: number;
  organization_id: string;
  connector_key: string;
  config: Record<string, unknown> | null;
  auth_profile_id: number | string | null;
  app_auth_profile_id: number | string | null;
}

/**
 * `connections.config` keys this module owns. They live in the same trusted
 * jsonb the rest of the connect flow writes; the secret is a `secret://` ref.
 */
export interface ConnectionWebhookState {
  /** Provider subscription id, for teardown. */
  webhook_external_id?: string;
  /** `secret://` ref to the unguessable token embedded in a callback URL. */
  webhook_callback_token?: string;
  /** `secret://` ref to the signing secret the provider HMACs deliveries with. */
  webhook_signature_secret?: string;
  /** The connector's declarative verification scheme, stamped at register time. */
  webhook_signature_header?: string;
  webhook_algorithm?: 'sha256' | 'sha1';
  webhook_signature_prefix?: string;
  webhook_dedupe_header?: string;
  webhook_expires_at?: string;
  webhook_status?: 'active' | 'error';
  webhook_error?: string | null;
}

function toNumberOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build a default writable secret store backed by Postgres (`agent_secrets`).
 * The connect routes run outside the gateway's CoreServices, so they can't
 * reach its injected store; a fresh PostgresSecretStore writes the same
 * org-scoped rows and mints the same `secret://` refs. AWS-SM is only needed
 * to READ `aws-sm://` refs, which freshly-minted webhook secrets never are.
 */
function defaultSecretStore(): PostgresSecretStore {
  return new PostgresSecretStore();
}

/**
 * Load the connector connection row + its compiled code + auth, ready to run
 * an executor job. Returns null when the connection is gone.
 */
async function loadConnection(
  organizationId: string,
  connectionId: number
): Promise<ConnectorConnectionRow | null> {
  const rows = await getDb()`
    SELECT id, organization_id, connector_key, config, auth_profile_id, app_auth_profile_id
    FROM connections
    WHERE id = ${connectionId}
      AND organization_id = ${organizationId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return (rows[0] as ConnectorConnectionRow | undefined) ?? null;
}

/**
 * Whether this connection should own a live provider webhook. We only register
 * when the connector declares a `webhook` block AND the connection opts into a
 * live feed — signalled by either an explicit `webhook_enabled` config flag or
 * a configured target the connector's registerWebhook needs (GitHub: `org`, or
 * `repo_owner`+`repo_name`; Linear/Jira register org/instance-wide so the
 * presence of the block is enough). registerWebhook itself throws when no
 * target is resolvable, so this gate just avoids firing for connections that
 * clearly aren't asking for one.
 */
export function connectionWantsWebhook(
  config: Record<string, unknown> | null | undefined
): boolean {
  if (!config) return false;
  if (config.webhook_enabled === true || config.webhook_enabled === 'true') return true;
  // Common target shapes across the webhook-capable connectors.
  if (typeof config.org === 'string' && config.org.length > 0) return true;
  if (
    typeof config.repo_owner === 'string' &&
    config.repo_owner.length > 0 &&
    typeof config.repo_name === 'string' &&
    config.repo_name.length > 0
  ) {
    return true;
  }
  return false;
}

/**
 * Register a provider webhook for a freshly-activated connector connection and
 * persist the subscription state onto the connection. Idempotent: if a webhook
 * is already registered (state present), it no-ops. Best-effort — failures are
 * logged and swallowed so a registration hiccup never blocks the connection
 * from going active (the user can re-trigger by reconnecting).
 */
export async function registerConnectorWebhook(params: {
  organizationId: string;
  connectionId: number;
  /** When this connector doesn't declare a webhook block, callers can skip. */
  request?: Request | null;
  /** Explicit public gateway origin for request-less admin/scheduled callers. */
  baseUrl?: string;
  /** Config mutations that disable durable delivery must fail closed. */
  throwOnError?: boolean;
}): Promise<void> {
  const { organizationId, connectionId } = params;
  try {
    const atlassian = await ensureAtlassianMcpJiraWebhook({
      organizationId,
      connectionId,
      baseUrl:
        params.baseUrl ??
        resolveBaseUrl({ request: params.request ?? null }).replace(/\/+$/, ''),
    });
    if (atlassian.handled) return;
    await orgContext.run({ organizationId }, async () => {
      const connection = await loadConnection(organizationId, connectionId);
      if (!connection) return;

      const config = (connection.config ?? {}) as Record<string, unknown> & ConnectionWebhookState;
      // Already registered — don't create a duplicate provider subscription.
      if (config.webhook_external_id) return;
      if (!connectionWantsWebhook(config)) return;

      const compiledCode = await resolveConnectorCodeForKey(
        connection.connector_key,
        organizationId
      );

      const { credentials, connectionCredentials, sessionState } = await resolveExecutionAuth({
        organizationId,
        connectionId,
        authProfileId: toNumberOrNull(connection.auth_profile_id),
        appAuthProfileId: toNumberOrNull(connection.app_auth_profile_id),
        credentialDb: getDb(),
        logContext: { connection_id: connectionId },
        logMessage: 'Failed to resolve webhook registration credentials',
      });

      const baseUrl = resolveBaseUrl({ request: params.request ?? null }).replace(/\/+$/, '');
      const callbackUrl = `${baseUrl}/api/v1/webhooks/${connectionId}`;

      const envStrings = connectorRunEnv({
        organizationSupplied: findBundledConnectorFile(connection.connector_key) === null,
        cloud: isCloudMode(),
      });

      const result = await executeCompiledConnector({
        compiledCode,
        job: {
          mode: 'webhook_register',
          config: mergeExecutionConfig(connection.config, connectionCredentials),
          credentials,
          sessionState,
          callbackUrl,
          env: envStrings,
        },
      });

      if (result.mode !== 'webhook_register') {
        throw new Error(`Expected webhook_register result, got mode=${result.mode}`);
      }

      const { registration, webhookScheme } = result;
      const scheme: ConnectorWebhookSchema = webhookScheme ?? {};

      const secretStore = defaultSecretStore();
      const secretRef = registration.secret
        ? await persistSecretValue(
            secretStore,
            `webhook/${connectionId}/signature-secret`,
            registration.secret
          )
        : undefined;

      const webhookState: ConnectionWebhookState = {
        webhook_external_id: registration.externalId,
        ...(secretRef ? { webhook_signature_secret: secretRef } : {}),
        ...(scheme.signatureHeader ? { webhook_signature_header: scheme.signatureHeader } : {}),
        ...(scheme.algorithm ? { webhook_algorithm: scheme.algorithm } : {}),
        ...(scheme.signaturePrefix ? { webhook_signature_prefix: scheme.signaturePrefix } : {}),
        ...(scheme.dedupeHeader ? { webhook_dedupe_header: scheme.dedupeHeader } : {}),
      };

      const mergedConfig = { ...(connection.config ?? {}), ...webhookState };
      await getDb()`
        UPDATE connections
        SET config = ${getDb().json(mergedConfig)}, updated_at = NOW()
        WHERE id = ${connectionId} AND organization_id = ${organizationId}
      `;

      logger.info(
        {
          connection_id: connectionId,
          connector_key: connection.connector_key,
          external_id: registration.externalId,
          scope: registration.metadata?.scope,
        },
        'Registered connector webhook subscription'
      );
    });
  } catch (error) {
    logger.warn(
      {
        connection_id: connectionId,
        error: getErrorMessage(error),
      },
      'Connector webhook registration failed (connection stays active)'
    );
    if (params.throwOnError) throw error;
  }
}

/**
 * Tear down a provider webhook subscription for a connection being
 * disconnected/deleted. Best-effort; clears the stored state on success so a
 * later reconnect re-registers cleanly. Reads the externalId from the
 * connection config (the source of truth persisted at register time).
 */
export async function unregisterConnectorWebhook(params: {
  organizationId: string;
  connectionId: number;
  /** Deletion must fail closed when external teardown fails. */
  throwOnError?: boolean;
  /** Explicit public gateway origin used to reconcile ambiguous provider state. */
  baseUrl?: string;
}): Promise<void> {
  const { organizationId, connectionId } = params;
  try {
    const atlassian = await unregisterAtlassianMcpJiraWebhook({
      organizationId,
      connectionId,
      baseUrl: params.baseUrl,
    });
    if (atlassian.handled) return;
    await orgContext.run({ organizationId }, async () => {
      const connection = await loadConnection(organizationId, connectionId);
      if (!connection) return;
      const config = (connection.config ?? {}) as Record<string, unknown> & ConnectionWebhookState;
      const externalId = config.webhook_external_id;
      if (!externalId) return;

      const compiledCode = await resolveConnectorCodeForKey(
        connection.connector_key,
        organizationId
      );
      const { credentials, connectionCredentials, sessionState } = await resolveExecutionAuth({
        organizationId,
        connectionId,
        authProfileId: toNumberOrNull(connection.auth_profile_id),
        appAuthProfileId: toNumberOrNull(connection.app_auth_profile_id),
        credentialDb: getDb(),
        logContext: { connection_id: connectionId },
        logMessage: 'Failed to resolve webhook teardown credentials',
      });

      const envStrings = connectorRunEnv({
        organizationSupplied: findBundledConnectorFile(connection.connector_key) === null,
        cloud: isCloudMode(),
      });

      const result = await executeCompiledConnector({
        compiledCode,
        job: {
          mode: 'webhook_unregister',
          config: mergeExecutionConfig(connection.config, connectionCredentials),
          credentials,
          sessionState,
          externalId,
          env: envStrings,
        },
      });
      if (result.mode !== 'webhook_unregister') {
        throw new Error(`Expected webhook_unregister result, got mode=${result.mode}`);
      }

      // Best-effort secret cleanup, then strip the webhook state from config.
      const secretStore = defaultSecretStore();
      if (config.webhook_signature_secret) {
        await secretStore
          .delete(config.webhook_signature_secret)
          .catch(() => undefined);
      }
      const nextConfig = { ...(connection.config ?? {}) } as Record<string, unknown>;
      delete nextConfig.webhook_external_id;
      delete nextConfig.webhook_signature_secret;
      delete nextConfig.webhook_signature_header;
      delete nextConfig.webhook_algorithm;
      delete nextConfig.webhook_signature_prefix;
      delete nextConfig.webhook_dedupe_header;
      await getDb()`
        UPDATE connections
        SET config = ${getDb().json(nextConfig)}, updated_at = NOW()
        WHERE id = ${connectionId} AND organization_id = ${organizationId}
      `;

      logger.info(
        { connection_id: connectionId, external_id: externalId },
        'Unregistered connector webhook subscription'
      );
    });
  } catch (error) {
    logger.warn(
      {
        connection_id: connectionId,
        error: getErrorMessage(error),
      },
      'Connector webhook teardown failed'
    );
    if (params.throwOnError) throw error;
  }
}

/**
 * Resolve a connector connection's stored webhook scheme + signing secret into
 * the shape `handleWebhookIngest` consumes (a `platform: "webhook"` config).
 * Used by the two-table ingest bridge. Returns null when the connection has no
 * registered webhook (so the route can 404 rather than accept blindly).
 */
export async function resolveConnectionWebhookConfig(
  config: Record<string, unknown> | null | undefined,
  connectorKey?: string
): Promise<Record<string, unknown> | null> {
  const c = (config ?? {}) as Record<string, unknown> & ConnectionWebhookState;
  // Documented generic-webhook schema keys (packages/connectors/src/webhook.ts
  // optionsSchema: token, dedupeHeader, …) fall back when the provider-
  // registration webhook_* keys are absent — otherwise a connection created
  // via the documented schema 404s forever on ingest. Gated to the webhook
  // connector: any other connector storing a plain `token` config key must
  // keep 404ing rather than silently becoming a bearer-auth receiver.
  const documentedKeys = connectorKey === undefined || connectorKey === 'webhook';
  const token = c.webhook_callback_token ?? (documentedKeys && typeof c.token === 'string' ? c.token : undefined);
  const dedupeHeader =
    c.webhook_dedupe_header ?? (documentedKeys && typeof c.dedupeHeader === 'string' ? c.dedupeHeader : undefined);
  if (!c.webhook_signature_secret && !token && !c.webhook_external_id) {
    return null;
  }
  return {
    platform: 'webhook',
    ...(token ? { token, allowQueryAuth: true } : {}),
    ...(c.webhook_signature_secret ? { signatureSecret: c.webhook_signature_secret } : {}),
    ...(c.webhook_signature_header ? { signatureHeader: c.webhook_signature_header } : {}),
    ...(c.webhook_algorithm ? { algorithm: c.webhook_algorithm } : {}),
    ...(c.webhook_signature_prefix ? { signaturePrefix: c.webhook_signature_prefix } : {}),
    ...(dedupeHeader ? { dedupeHeader } : {}),
    // Carry through any ingest-shaping the connection set (semantic type, etc.).
    ...(typeof c.semanticType === 'string' ? { semanticType: c.semanticType } : {}),
    ...(typeof c.titlePath === 'string' ? { titlePath: c.titlePath } : {}),
    ...(c.searchable !== undefined ? { searchable: c.searchable } : {}),
  };
}
