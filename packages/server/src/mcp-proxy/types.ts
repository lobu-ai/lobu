/**
 * MCP Proxy Type Definitions
 *
 * Types for proxying MCP tool calls to upstream MCP servers
 * defined in connector_definitions.mcp_config.
 */

/**
 * Stored in connector_definitions.mcp_config jsonb column.
 */
export interface McpProxyConfig {
  upstream_url: string;
  tool_prefix: string;
}

/** OAuth metadata discovered from an RFC 9728 protected-resource challenge. */
export interface McpOAuthMetadata {
  resource: string;
  resourceMetadataUrl: string;
  resourceDocumentation?: string;
  authorizationServer: string;
  authorizationUrl: string;
  tokenUrl: string;
  registrationUrl?: string;
  /** The server accepts a client metadata document URL as `client_id`. */
  clientIdMetadataDocumentSupported: boolean;
  /** Scopes requested by the initial WWW-Authenticate challenge, when present. */
  challengeScopes?: string[];
  scopesSupported: string[];
  tokenEndpointAuthMethodsSupported: string[];
  codeChallengeMethodsSupported: string[];
}

/** Dynamic client credentials returned by RFC 7591 registration. */
export interface McpOAuthClientRegistration {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: 'none' | 'client_secret_post' | 'client_secret_basic';
}

/**
 * An MCP tool discovered from an upstream server, with its prefix applied.
 */
export interface DiscoveredTool {
  /** Prefixed name: e.g. "gmail__send_email" */
  name: string;
  /** Original name on the upstream server */
  originalName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
    idempotentHint?: boolean;
  };
  /** The connector key that owns this tool */
  connectorKey: string;
  /** Upstream MCP server URL */
  upstreamUrl: string;
}

/**
 * JSON-RPC 2.0 response shape from upstream MCP servers.
 */
export interface JsonRpcResponse {
  jsonrpc: string;
  id: unknown;
  result?: {
    tools?: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        openWorldHint?: boolean;
        idempotentHint?: boolean;
      };
    }>;
    content?: unknown[];
    isError?: boolean;
    instructions?: string;
    protocolVersion?: string;
    capabilities?: Record<string, unknown>;
    serverInfo?: { name: string; version: string };
  };
  error?: { code: number; message: string };
}
