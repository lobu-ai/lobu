import type { DestinationAudienceSource } from "@lobu/connector-sdk";
import { getDb } from "../../db/client.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import { PostgresSecretStore } from "../../lobu/stores/postgres-secret-store.js";
import { resolveSecretValue, SecretStoreRegistry } from "../secrets/index.js";
import { createSlackWebApi } from "./slack-web.js";

/**
 * Who sees a Slack post: read from `conversations.info` with the connection's
 * own bot token. Slack Connect is external even when the channel is private.
 *
 * The policy evaluator imports this module, so it reads the token from the
 * stored connection with leaf modules only. Going through the chat manager
 * pulls the tool registry into the evaluator's import cycle, and an unlucky
 * load order then registers a tool whose handler is still undefined.
 */
export const slackDestinationAudienceSource: DestinationAudienceSource = {
  connectorKey: "slack",
  async destinationAudience(connection, channelId) {
    const { organizationId, connectionId } = connection;
    const [row] = await getDb()<{ bot_token_ref: string | null }>`
      SELECT COALESCE(config->>'botToken', config->'chatMetadata'->>'botToken') AS bot_token_ref
      FROM connections
      WHERE id = ${connectionId}
        AND organization_id = ${organizationId}
        AND connector_key = 'slack'
        AND deleted_at IS NULL
      LIMIT 1
    `;
    // Bot tokens are stored under the default (Postgres) scheme, as the gateway's store reads them.
    const store = new PostgresSecretStore();
    const botToken = await orgContext.run({ organizationId }, () =>
      resolveSecretValue(
        new SecretStoreRegistry(store, { secret: store }),
        row?.bot_token_ref
      )
    );
    if (!botToken) throw new Error("Slack bot token is missing");
    const channel = await createSlackWebApi().conversationInfo(
      botToken,
      channelId
    );
    if (channel.isExtShared) return "external";
    if (channel.isPrivate || channel.isIm || channel.isMpim) return "private";
    return "workspace";
  },
};
