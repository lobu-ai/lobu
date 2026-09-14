/**
 * Telegram capability descriptor. Holds every Telegram-specific implementation that
 * used to be hardcoded in `ChatInstanceManager`: config helpers, the
 * cloud-mode polling guard, webhook-secret generation/backfill, webhook +
 * command registration against the Bot API, body routing extraction, and the
 * outbound file handler.
 */

import { randomUUID } from "node:crypto";
import { createLogger, isSecretRef } from "@lobu/core";
import { getDb } from "../../../db/client.js";
import { runtimeConnectionIdToSlug } from "../../../lobu/stores/connections-projection.js";
import { isCloudMode } from "../../../utils/cloud-mode.js";
import type { IFileHandler } from "../../platform/file-handler.js";
import { persistSecretValue, resolveSecretValue } from "../../secrets/index.js";
import {
  isTelegramConfig,
  type PlatformConnection,
  type TelegramAdapterConfig,
} from "../types.js";
import { streamToBuffer } from "./shared.js";
import type {
  ChatPlatformDescriptor,
  ChatPlatformInstance,
  PlatformCommand,
  WebhookSecretDeps,
} from "./types.js";

const logger = createLogger("chat-platform-telegram");

/** Read `botToken` from a Telegram connection config, or undefined. */
function telegramBotToken(
  config: TelegramAdapterConfig
): string | undefined {
  return typeof config.botToken === "string" ? config.botToken : undefined;
}

/** Read `apiBaseUrl` from a Telegram connection config (with default). */
function telegramApiBase(config: TelegramAdapterConfig): string {
  return typeof config.apiBaseUrl === "string" && config.apiBaseUrl
    ? config.apiBaseUrl
    : "https://api.telegram.org";
}

/**
 * Generate a strong (64 hex char) Telegram webhook secret token. Telegram's
 * `secret_token` allows 1-256 chars of `A-Za-z0-9_-`; hex is a safe subset.
 * Two UUIDs (128 bits of randomness each) with hyphens stripped easily clear
 * the >=32 char bar we want for a non-guessable token.
 */
function generateTelegramSecretToken(): string {
  return `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
}

/**
 * `mode: "polling"` is the only config that forces long-polling regardless
 * of whether the gateway has a public webhook URL. `mode: "auto"` resolves
 * to webhook on cloud (publicGatewayUrl is always set there), so it's fine
 * to allow. Only the explicit polling opt-in is rejected in cloud.
 */
function isPollingTelegramMode(config: { mode?: string }): boolean {
  return config.mode === "polling";
}

const POLLING_REJECTION =
  "Polling mode is not supported in Lobu Cloud — use webhook mode, or self-host.";

/**
 * Ensure a started Telegram connection has a webhook `secretToken`, then
 * assign the effective (plaintext) token onto `connection.config` so this
 * boot's adapter verifies it and `configureWebhook` registers it. No-op for
 * connections that already carry a token.
 *
 * Multi-replica safety: the claim is row-locked. Every replica boots every
 * connection (initialize() starts them all), so a naive get-then-save would
 * let two pods generate DIFFERENT tokens, persist+register whichever wrote
 * last, and leave the other pod's adapter verifying a stale token (transient
 * 401s). Instead we `SELECT ... FOR UPDATE` the row inside a transaction: the
 * first pod generates + persists the secret ref under the lock and writes it
 * into the row's config; later pods see the ref and adopt it — so every pod
 * and Telegram converge on a single token.
 *
 * `connection.config` here is already resolved to plaintext (the manager runs
 * resolveConfigForRuntime first), so a present secretToken is the real value.
 */
async function ensureTelegramWebhookSecret(
  connection: PlatformConnection,
  deps: WebhookSecretDeps
): Promise<void> {
  if (!isTelegramConfig(connection.config)) return;
  const current = connection.config.secretToken;
  if (typeof current === "string" && current.length > 0) return;

  const { secretStore } = deps;
  const secretName = `connections/${connection.id}/secretToken`;
  let generated = false;

  // Row-locked claim: read the stored config under FOR UPDATE; if it still
  // lacks a secretToken, generate + persist a ref and write it back in the
  // same transaction. Concurrent replicas serialize on the row lock, so only
  // the first writer generates and the rest read its ref. Returns the
  // effective `secret://` ref, or null when there is no stored row to lock.
  const slug = runtimeConnectionIdToSlug(connection.id);
  // `connections` is unique per (organization_id, slug) — scope BOTH the lock
  // and the write to this connection's org so a slug shared across orgs can
  // never share or overwrite another tenant's secretToken. A missing org (an
  // unpersisted in-memory connection) matches no row and falls to the
  // persist-then-reread path below.
  const orgId = connection.organizationId ?? null;
  const tokenRef = await getDb().begin(async (tx) => {
    const rows = await tx<{ config: Record<string, unknown> | null }>`
      SELECT config FROM connections
      WHERE slug = ${slug} AND organization_id = ${orgId} AND deleted_at IS NULL
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) {
      return null;
    }
    const storedConfig = (row.config ?? {}) as Record<string, unknown>;
    const existingRef = storedConfig.secretToken;
    if (typeof existingRef === "string" && existingRef.length > 0) {
      return existingRef;
    }
    const ref = await persistSecretValue(
      secretStore,
      secretName,
      generateTelegramSecretToken()
    );
    // `ref` is only absent when there is no secret store to persist into —
    // nothing to write in that degraded case.
    if (typeof ref === "string") {
      await tx`
        UPDATE connections
        SET config = COALESCE(config, '{}'::jsonb)
                     || jsonb_build_object('secretToken', ${ref}::text),
            updated_at = now()
        WHERE slug = ${slug} AND organization_id = ${orgId} AND deleted_at IS NULL
      `;
      generated = true;
    }
    return ref;
  });

  let effectiveRef = tokenRef;
  if (effectiveRef === null) {
    // No stored row to lock (a freshly-built in-memory connection the caller
    // hasn't persisted — the boot/restart paths always have a row). Persist
    // via the normal path and adopt the stored ref.
    connection.config.secretToken = generateTelegramSecretToken();
    await deps.persistConnection(connection);
    generated = true;
    const reread = await deps.getStoredConnection(connection.id);
    const rereadRef =
      reread && typeof (reread.config as any).secretToken === "string"
        ? ((reread.config as any).secretToken as string)
        : null;
    effectiveRef = rereadRef;
  }

  // Resolve the winning ref to plaintext for the adapter + webhook.
  const resolved =
    effectiveRef && isSecretRef(effectiveRef)
      ? await resolveSecretValue(secretStore, effectiveRef)
      : effectiveRef;
  if (typeof resolved === "string" && resolved.length > 0) {
    connection.config.secretToken = resolved;
  }

  if (generated) {
    logger.info(
      { id: connection.id },
      "Backfilled Telegram webhook secret token for existing connection"
    );
  }
}

function createTelegramFileHandler(
  instance: ChatPlatformInstance
): IFileHandler | undefined {
  const { connection } = instance;
  if (!isTelegramConfig(connection.config)) return undefined;
  const botToken = telegramBotToken(connection.config);
  if (!botToken) return undefined;

  const apiBaseUrl = telegramApiBase(connection.config).replace(/\/$/, "");
  const botUsername =
    typeof connection.metadata.botUsername === "string"
      ? connection.metadata.botUsername.replace(/^@/, "")
      : undefined;

  const parseTelegramTarget = (
    channelId: string,
    conversationId?: string
  ): { chatId: string; messageThreadId?: number } => {
    if (conversationId?.startsWith("telegram:")) {
      const [, chatId, rawThreadId] = conversationId.split(":");
      const messageThreadId = Number.parseInt(rawThreadId || "", 10);
      return {
        chatId: chatId || channelId,
        messageThreadId: Number.isFinite(messageThreadId)
          ? messageThreadId
          : undefined,
      };
    }
    return { chatId: channelId };
  };

  const buildTelegramPermalink = (
    chatId: string,
    messageId: number
  ): string => {
    if (/^-100\d+$/.test(chatId)) {
      return `https://t.me/c/${chatId.slice(4)}/${messageId}`;
    }
    if (botUsername) {
      return `https://t.me/${botUsername}`;
    }
    return `telegram://chat/${chatId}/${messageId}`;
  };

  const telegramApiRequest = async (
    method: string,
    body: FormData | URLSearchParams
  ) => {
    const response = await fetch(`${apiBaseUrl}/bot${botToken}/${method}`, {
      method: "POST",
      body,
    });
    const text = await response.text();
    let payload: any = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (!response.ok || payload?.ok === false || !payload?.result) {
      throw new Error(`Telegram ${method} failed: ${response.status} ${text}`);
    }
    return payload.result;
  };

  return {
    uploadFile: async (fileStream, options) => {
      const target = parseTelegramTarget(options.channelId, options.threadTs);
      const buffer = await streamToBuffer(fileStream);
      const form = new FormData();
      form.set("chat_id", target.chatId);
      if (target.messageThreadId) {
        form.set("message_thread_id", String(target.messageThreadId));
      }
      if (options.initialComment) {
        form.set("caption", options.initialComment);
      }
      form.set(
        options.voiceMessage ? "voice" : "document",
        new Blob([buffer]),
        options.filename
      );

      const result = await telegramApiRequest(
        options.voiceMessage ? "sendVoice" : "sendDocument",
        form
      );
      const media = options.voiceMessage ? result.voice : result.document;
      const fileId = String(media?.file_id || result.document?.file_id || "");
      if (!fileId) {
        throw new Error("Telegram upload did not return a file_id");
      }
      const messageId = Number(result.message_id || 0);
      return {
        fileId,
        permalink: buildTelegramPermalink(target.chatId, messageId),
        name: options.filename,
        size: buffer.length,
      };
    },
  };
}

export const telegramPlatform: ChatPlatformDescriptor = {
  requiredConfigKeys: ["botToken"],

  // Pre-existing lazy adapter factory, moved verbatim from the manager's
  // ADAPTER_FACTORIES map (adapter SDKs stay lazy-loaded per platform).
  createAdapter: async (c) =>
    (await import("@chat-adapter/telegram")).createTelegramAdapter(c),

  extractRoutingInfo: (body) => {
    const telegram = body.telegram as { chatId?: string | number } | undefined;
    if (!telegram?.chatId) return null;
    return {
      channelId: String(telegram.chatId),
      conversationId: String(telegram.chatId),
    };
  },

  createFileHandler: createTelegramFileHandler,

  // `mode: "polling"` long-polls Telegram's edge from the gateway pod and
  // bypasses the per-tenant webhook URL we issue. On Lobu Cloud — where
  // the same gateway serves many tenants — that means one org's connection
  // can starve every other tenant's webhook delivery (and produces no
  // audit trail tied to the inbound HTTP request). Refuse the explicit
  // polling opt-in; self-hosters (LOBU_CLOUD_MODE unset/0) still get
  // polling for tunnel-less dev. `mode: "auto"` is fine — it resolves to
  // webhook whenever `publicGatewayUrl` is set, which cloud always has.
  getConfigRejection: (config) =>
    isCloudMode() && isPollingTelegramMode(config as { mode?: string })
      ? POLLING_REJECTION
      : undefined,

  // Telegram's inbound webhook is authenticated solely by the adapter
  // comparing `x-telegram-bot-api-secret-token` against the configured
  // `secretToken` — and the adapter accepts the request when no token is
  // set. The public `POST /api/v1/webhooks/:connectionId` route only checks
  // the connection exists, so a Telegram connection created without a
  // secretToken has an unauthenticated, forgeable webhook. Auto-generate a
  // strong random token when the caller didn't supply one so
  // configureWebhook always registers it and the adapter always verifies.
  // The field name matches `isSecretField`, so it's persisted as a
  // `secret://` ref like any other credential.
  prepareNewConnectionConfig: (config) => {
    const tgConfig = config as TelegramAdapterConfig;
    if (
      typeof tgConfig.secretToken !== "string" ||
      tgConfig.secretToken.length === 0
    ) {
      tgConfig.secretToken = generateTelegramSecretToken();
    }
  },

  serverStampedConfigKeys: ["secretToken"],

  ensureWebhookSecret: ensureTelegramWebhookSecret,

  resolveWebhookMode: (config) =>
    isTelegramConfig(config) ? (config.mode ?? "auto") : "auto",

  // Long-polling is an exclusive transport: two replicas calling getUpdates
  // for the same bot get 409s and drop updates nondeterministically, so the
  // connection must run on exactly one replica (the connection_claims lease
  // holder). Effective polling = explicit `mode: "polling"`, or `auto`
  // resolving to polling because the gateway has no public URL to register
  // a webhook against (tunnel-less dev).
  requiresExclusiveStart: (config, ctx) => {
    if (!isTelegramConfig(config)) return false;
    const mode = config.mode ?? "auto";
    return mode === "polling" || (mode === "auto" && !ctx.publicGatewayUrl);
  },

  configureWebhook: async (connection, webhookUrl) => {
    if (!isTelegramConfig(connection.config)) return;
    const config = connection.config;

    const botToken = telegramBotToken(config);
    if (!botToken) return;

    const apiBase = telegramApiBase(config);
    const body: Record<string, unknown> = { url: webhookUrl };
    const secretToken = config.secretToken;
    if (typeof secretToken === "string" && secretToken.length > 0) {
      body.secret_token = secretToken;
    }

    const resp = await fetch(`${apiBase}/bot${botToken}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Telegram setWebhook failed: ${resp.status} ${text}`);
    }
  },

  registerCommands: async (
    connection: PlatformConnection,
    commands: PlatformCommand[]
  ) => {
    if (!isTelegramConfig(connection.config)) return;
    const botToken = telegramBotToken(connection.config);
    if (!botToken) return;

    const apiBase = telegramApiBase(connection.config);
    const resp = await fetch(`${apiBase}/bot${botToken}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Telegram setMyCommands failed: ${resp.status} ${text}`);
    }

    logger.info(
      { id: connection.id, count: commands.length },
      "Telegram bot commands menu registered"
    );
  },
};
