export type OperationKind = 'read' | 'write';
export type OperationBackend = 'local_action' | 'mcp_tool' | 'http_operation' | 'chat_transport';

export interface OperationAnnotations {
  destructiveHint?: boolean;
  openWorldHint?: boolean;
  idempotentHint?: boolean;
}

export interface AvailableOperation {
  connector_key: string;
  connector_name: string;
  operation_key: string;
  name: string;
  description?: string;
  kind: OperationKind;
  backend: OperationBackend;
  required_scopes?: string[];
  annotations?: OperationAnnotations;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  /**
   * For `local_action` operations: whether the compiled connector runtime
   * actually overrides execute(). `false` means the op is declared in the
   * catalog but the code would throw "Actions not supported" — readiness must
   * report it as unsupported (#2033 item 2). `undefined`/`true` = supported
   * (or a backend where this does not apply, e.g. mcp_tool / http_operation).
   */
  supports_execute?: boolean;
}

interface LocalActionBackendConfig {
  backend: 'local_action';
  actionKey: string;
  /** The action's `outputFiles` declaration (see the connector SDK's ActionDefinition). */
  outputFiles?: 'source-copy';
  /** The connector declares a browser: its actions drive a paired Chrome. */
  browser?: true;
}

/**
 * A connector action the gateway's chat transport delivers through the
 * connection's chat adapter (`ActionDefinition.delivery: 'chat_transport'`).
 * Its runs are created by an agent's `send_message`, never by a direct execute.
 */
interface ChatTransportBackendConfig {
  backend: 'chat_transport';
  actionKey: string;
}

interface McpToolBackendConfig {
  backend: 'mcp_tool';
  toolName: string;
  upstreamUrl: string;
}

interface HttpOperationBackendConfig {
  backend: 'http_operation';
  method: string;
  pathTemplate: string;
  serverUrl: string;
  /** Path params the spec marks `x-multi-segment`: their value may span `/`. */
  multiSegmentPathParams?: string[];
}

export type OperationBackendConfig =
  | LocalActionBackendConfig
  | ChatTransportBackendConfig
  | McpToolBackendConfig
  | HttpOperationBackendConfig;

export interface OperationDescriptor extends AvailableOperation {
  backend_config: OperationBackendConfig;
  /** Internal MCP catalog provenance; only these accounts advertised this schema. */
  discovery_connection_ids?: number[];
}
