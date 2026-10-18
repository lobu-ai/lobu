/** Gateway wiring for connector-backed Chat SDK adapters. */

import { randomUUID } from "node:crypto";
import type { Env } from "../../../index.js";
import { isConnectionRowRuntimeId } from "../../../lobu/stores/connections-projection.js";
import { handleExecute } from "../../../tools/admin/manage_operations/handlers/execute.js";
import type { ToolContext } from "../../../tools/registry.js";
import type { PlatformConnection } from "../types.js";
import type {
  ConnectorChatAdapter,
  ConnectorChatAdapterOptions,
  ConnectorChatOperationExecutor,
} from "./connector-chat.js";
import type { ChatPlatformDescriptor } from "./types.js";

/**
 * Run one connector operation on the connection, as the member who paired it.
 * The paired device belongs to that member, so its sends are admitted under
 * their connector policy exactly as a manual `operations.execute` would be.
 */
export function connectionOperationsExecutor(
  connection: PlatformConnection,
): ConnectorChatOperationExecutor {
  const connectionId = Number(connection.id);
  const organizationId = connection.organizationId;
  if (!isConnectionRowRuntimeId(connection.id) || !organizationId) {
    throw new Error(
      `Connector chat needs a persisted connector connection, got ${connection.id}`,
    );
  }
  const ownerId = connection.createdBy;
  if (!ownerId) {
    throw new Error("Connector chat needs its connection owner for operation admission");
  }
  return async ({ operationKey, input, idempotencyKey }) => {
    const ctx: ToolContext = {
      organizationId,
      // No chat turn behind this call (authz/device-access.ts).
      sourceContext: null,
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

/**
 * The `PLATFORM_REGISTRY` descriptor for a connector-transport platform.
 * `create` builds the platform's adapter from the shared options; the
 * connection's bot username (when its metadata carries one) or `defaultUserName`
 * names the account.
 */
export function connectorChatPlatform(
  defaultUserName: string,
  create: (options: ConnectorChatAdapterOptions) => ConnectorChatAdapter<any>,
): ChatPlatformDescriptor {
  return {
    connectorTransport: true,
    parseSourceMessage: (adapter, row) =>
      (adapter as ConnectorChatAdapter<unknown>).parseSourceRow(row),
    createAdapter: async (_config, context) => {
      const connection = context?.connection;
      if (!connection) {
        throw new Error(`${defaultUserName} chat needs its connector connection`);
      }
      return create({
        connectionId: connection.id,
        userName:
          typeof connection.metadata?.botUsername === "string"
            ? connection.metadata.botUsername
            : defaultUserName,
        execute: connectionOperationsExecutor(connection),
        newIdempotencyKey: () => `chat-reply:${randomUUID()}`,
      });
    },
  };
}
