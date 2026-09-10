export type OperationKind = 'read' | 'write';
export type OperationBackend = 'local_action' | 'mcp_tool' | 'http_operation';

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
  requires_approval: boolean;
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
}

export type OperationBackendConfig =
  | LocalActionBackendConfig
  | McpToolBackendConfig
  | HttpOperationBackendConfig;

export interface OperationDescriptor extends AvailableOperation {
  backend_config: OperationBackendConfig;
}
