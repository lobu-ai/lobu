#!/usr/bin/env bun

// Shared exports for @lobu/core consumers (gateway, worker, external tools)

export * from "./agent-policy";
export * from "./tool-policy";
export * from "./turn-control";
// Agent store interface (unified storage abstraction)
export type {
  AgentAccessStore,
  AgentConfigStore,
  AgentConnectionStore,
  AgentMetadata,
  AgentSettings,
  AgentStore,
  ConnectionSettings,
  Grant,
  GrantKind,
  StoredConnection,
} from "./agent-store";
export { inferGrantKind } from "./agent-store";
// Agent Settings API response types (for UI consumers)
export type {
  CatalogProvider,
  Connection,
  McpConfig,
  ModelOption,
  PrefillMcp,
  PrefillSkill,
  Skill,
} from "./api-types";
export * from "./capabilities";
export type { CommandContext, CommandDefinition } from "./command-registry";
// Command registry
export { CommandRegistry } from "./command-registry";
export * from "./connector-query-errors";
export * from "./constants";
// Interaction-envelope wire literals (tool_approval resourceKind / attribution).
// Deep import `@lobu/core/contracts/interaction-envelope` also works under
// bundler/NodeNext resolution; plugin packages with classic `moduleResolution:
// "node"` must use this root re-export.
export * from "./contracts/interaction-envelope";
// Shared credential-store primitives (CLI + embedded server share one impl)
export * from "./credentials";
// Errors & logging
export * from "./errors";
// Guardrail primitive (type + registry + parallel runner + no-op builtin)
export * from "./guardrails";
// Shared base for InstructionProvider implementations (server + worker)
export { BaseInstructionProvider } from "./instruction-provider";
// Integration types
export type {
  ProviderRegistryEntry,
  ProvidersConfigFile,
} from "./integration-types";
// Lobu memory guidance shared by the runtime and bundled skill.
export {
  renderFallbackSystemContext,
  renderSkillMemorySection,
} from "./lobu-guidance";
export * from "./logger";
// Module system
export * from "./modules";
export type { OtelConfig, Span, Tracer } from "./otel";
// OpenTelemetry tracing
export {
  createChildSpan,
  createRootSpan,
  createSpan,
  flushTracing,
  getCurrentSpan,
  getTraceparent,
  getTracer,
  initTracing,
  runInSpanContext,
  SpanKind,
  SpanStatusCode,
  shutdownTracing,
  withChildSpan,
  withSpan,
} from "./otel";
// Config-driven provider types
export type {
  ConfigProviderMeta,
  ProviderConfigEntry,
  ProviderOAuthConfig,
  ProviderOAuthGrantKind,
} from "./provider-config-types";
// Wire-protocol registry (sdkCompat → pi-ai adapter)
export {
  isSdkCompat,
  type PiAiApi,
  resolveSdkCompat,
  SDK_COMPAT_PROTOCOLS,
  type SdkCompat,
  type SdkCompatProtocol,
} from "./sdk-compat";
export * from "./secret-refs";
// Reserved path / entity-type slug lists + kind helpers (single source)
export * from "./reserved";
// Observability
export { getSentry, initSentry } from "./sentry";
export { extractTraceId, generateTraceId } from "./trace";
// Core types
export type {
  AgentErrorContext,
  AgentInlineGuardrail,
  AgentOptions,
  AuthProfile,
  CliBackendConfig,
  ConversationMessage,
  DeclaredCredential,
  HistoryMessage,
  InstructionContext,
  InstructionProvider,
  LogLevel,
  McpOAuthConfig,
  NetworkConfig,
  NixConfig,
  RegistryEntry,
  SessionContext,
  SkillConfig,
  SkillsConfig,
  SuggestedPrompt,
  ThinkingLevel,
  ThreadResponsePayload,
  ToolsConfig,
} from "./types";
export { hasCredentialSource } from "./types";
export { SUGGESTION_LIMITS, sanitizeSuggestionPrompts } from "./types";
// Shared message/interaction base shape
export type { BaseMessage } from "./types/message";

// Utilities
export * from "./utils/encryption";
export * from "./utils/env";
export * from "./utils/json";
export type { McpStatus, McpToolDef } from "./utils/mcp-tool-instructions";
export * from "./utils/network-domains";
export * from "./utils/retry";
export * from "./utils/sanitize";
export * from "./utils/secret-redaction";
export * from "./utils/sentry-scrubber";
// Shared Lobu runtime session.jsonl parser (gateway + worker).
export {
  type BashExecutionContent,
  entryToMessage,
  type ParsedMessage,
  type ParsedMessageType,
  parseSessionEntries,
  type SessionEntry,
  titleFromSessionJsonl,
} from "./utils/session-file";
export { slugify } from "./utils/slug";
export * from "./utils/urls";
export * from "./worker/auth";
export type {
  WorkerTransport,
  WorkerTransportConfig,
} from "./worker/transport";
// Gateway ↔ worker wire contract (MessagePayload, JobType, QueuedMessage).
export type {
  BangBashCommand,
  DeviceExecutionTarget,
  JobType,
  MessagePayload,
  QueuedMessage,
} from "./worker/wire";
export { parseBangBashCommand } from "./worker/wire";
