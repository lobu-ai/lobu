/**
 * WhatsApp Web capability descriptor. The transport is the `whatsapp.web`
 * connector connection itself (`connectorTransport`): outbound verbs become
 * connector operations on the paired device, executed through the same
 * admission path `operations.execute` uses, so policy, approval and the
 * durable run record all apply and the gateway never holds a credential.
 */

import { randomUUID } from "node:crypto";
import type { Env } from "../../../index.js";
import { isConnectionRowRuntimeId } from "../../../lobu/stores/connections-projection.js";
import { handleExecute } from "../../../tools/admin/manage_operations/handlers/execute.js";
import type { ToolContext } from "../../../tools/registry.js";
import type { PlatformConnection } from "../types.js";
import type { ChatPlatformDescriptor } from "./types.js";
import {
  WhatsAppWebAdapter,
  type WhatsAppWebOperationExecutor,
} from "./whatsapp-web-adapter.js";

/**
 * Run one connector operation on the connection, as the member who paired it.
 * The paired device belongs to that member, so its sends are admitted under
 * their connector policy exactly as a manual `operations.execute` would be.
 */
export function connectionOperationsExecutor(
  connection: PlatformConnection,
): WhatsAppWebOperationExecutor {
  const connectionId = Number(connection.id);
  const organizationId = connection.organizationId;
  if (!isConnectionRowRuntimeId(connection.id) || !organizationId) {
    throw new Error(
      `WhatsApp Web chat needs a persisted connector connection, got ${connection.id}`,
    );
  }
  const ownerId = connection.createdBy;
  if (!ownerId) {
    throw new Error("WhatsApp Web chat needs its connection owner for operation admission");
  }
  return async ({ operationKey, input, idempotencyKey }) => {
    const ctx: ToolContext = {
      organizationId,
      userId: ownerId,
      memberRole: null,
      isAuthenticated: true,
      tokenType: "pat",
      scopedToOrg: true,
      allowCrossOrg: false,
      grantedOrganizationIds: [organizationId],
      directSearchFederation: false,
    };
    const result = await handleExecute(
      {
        action: "execute",
        connection_id: connectionId,
        operation_key: operationKey,
        input,
        idempotency_key: idempotencyKey,
      },
      ctx,
      {} as Env,
    );
    if ("error" in result) {
      return { status: "failed", error: String(result.error) };
    }
    if (result.action !== "execute") {
      return { status: "failed", error: "Unexpected operation result" };
    }
    if (result.status === "completed") {
      return {
        status: "completed",
        output: (result.output ?? {}) as Record<string, unknown>,
      };
    }
    const error =
      ("error_message" in result && result.error_message) ||
      ("message" in result && result.message) ||
      `operation ${result.status}`;
    return {
      status: result.status,
      error: String(error),
    };
  };
}

export const whatsappWebPlatform: ChatPlatformDescriptor = {
  connectorTransport: true,

  parseSourceMessage: (adapter, row) =>
    (adapter as WhatsAppWebAdapter).parseSourceRow(row),

  createAdapter: async (_config, context) => {
    const connection = context?.connection;
    if (!connection) {
      throw new Error("WhatsApp Web chat needs its connector connection");
    }
    return new WhatsAppWebAdapter({
      connectionId: connection.id,
      userName:
        typeof connection.metadata?.botUsername === "string"
          ? connection.metadata.botUsername
          : "whatsapp",
      execute: connectionOperationsExecutor(connection),
      newIdempotencyKey: () => `chat-reply:${randomUUID()}`,
    });
  },
};
