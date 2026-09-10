// =============================================================================
// V1 Integration Platform — Connector SDK
// =============================================================================

// TypeBox (schema authoring convenience for connector definitions / fact
// schemas). NOTE: do NOT import these into an automation reaction — bundling
// typebox into the isolate breaks the SDK client proxy (see
// reaction-execute-typebox.test.ts). A reaction declares its `input` as a
// PLAIN JSON Schema object; the host validates `ctx.extracted_data` against it.
export type { Static } from '@sinclair/typebox';
export { Type } from '@sinclair/typebox';
export { Value } from '@sinclair/typebox/value';
// ky (shared HTTP dependency)
export type { KyInstance, Options } from 'ky';
export { default as ky, HTTPError } from 'ky';
// Connector runtime & types (primary API)
export {
  BridgeOnlyConnector,
  ConnectorRuntime,
  IntegrationConnector,
} from './connector-runtime.js';
export { defineConnector } from './define-connector.js';
export {
  canonicalDeviceManifestJson,
  defineDeviceConnector,
  serializeDeviceConnector,
  sortDeviceManifestJson,
} from './device-manifest.js';
export type {
  DeviceActionDefinition,
  DeviceConnectorDefinition,
  DeviceConnectorManifest,
  DeviceConnectorRuntimeInfo,
  DeviceConnectorSpec,
  DeviceFeedDefinition,
  DeviceManifestSchema,
} from './device-manifest.js';
import { validateEntityMetrics } from './metrics.js';
export { validateEntityMetrics };
// Entity-bound metric layer contract (shared by CLI authoring + server
// compile/validate; lives here to satisfy config-isolation — see metrics.ts)
export type {
  Dimension,
  EntityMetrics,
  EventSet,
  FactMatchRule,
  Measure,
  MetricReadMode,
  MetricTier,
  Segment,
} from './metrics.js';
export type {
  ConnectorActionSpec,
  ConnectorClass,
  ConnectorFeedSpec,
  ConnectorSpec,
} from './define-connector.js';
export type {
  ActionContext,
  ActionDefinition,
  ActionResult,
  ApprovalStatus,
  AuthArtifact,
  AuthContext,
  AuthResult,
  Connection,
  ConnectorAgentTooling,
  ConnectorAgentToolingEnv,
  ConnectorAuthAppInstallation,
  ConnectorAuthBrowser,
  ConnectorAuthEnvField,
  ConnectorAuthEnvKeys,
  ConnectorAuthInteractive,
  ConnectorAuthMethod,
  ConnectorAuthNone,
  ConnectorAuthOAuth,
  ConnectorAuthSchema,
  ConnectorDefinition,
  ConnectorInstallationContext,
  ConnectorRuntimeInfo,
  ConnectorWebhookSchema,
  ContentItem,
  EntityIdentitySpec,
  EntityLinkPredicate,
  EntityTraitSpec,
  EventAttributionRole,
  EventAttributionRule,
  EventAttributionTargetSpec,
  EventEnvelope,
  Feed,
  FeedDefinition,
  FeedOperation,
  FeedReadContext,
  FeedReadHandler,
  FeedReadResult,
  FeedSyncHandler,
  EntityTypeContribution,
  QueryContext,
  QueryResult,
  ReflectContext,
  ReflectedMeasure,
  ReflectResult,
  Run,
  RunStatus,
  RunType,
  RuntimeConnectorDefinition,
  RuntimeFeedDefinition,
  SyncContext,
  SyncCredentials,
  SyncResult,
  WebhookRegistration,
  WebhookRegistrationContext,
} from './connector-types.js';
import {
  normalizeAuthUserId,
  normalizeEmail,
  normalizeEmailDomain,
  normalizeIdentifier,
  normalizePhone,
} from './identity-normalize.js';
export {
  normalizeAuthUserId,
  normalizeEmail,
  normalizeEmailDomain,
  normalizeIdentifier,
  normalizePhone,
};
export type {
  IdentityNamespace,
  IdentityNamespaceDefinition,
  IdentityNormalizerKind,
  IdentitySubjectKind,
} from './identity-namespaces.js';
export type {
  AccessIdentitySpec,
  AccessMember,
  AccessResource,
  AclSourceDef,
  ChannelReadIdentity,
} from './acl-source.js';
export {
  ACL_RESOURCE_TYPE,
  ACL_RESOURCE_TYPE_SLUG,
} from './acl-source.js';
import {
  EVENT_RECALL_IDENTITY_NAMESPACES,
  getIdentityNamespaceDefinition,
  IDENTITY,
  IDENTITY_NAMESPACE_REGISTRY,
  isEventRecallIdentityNamespace,
} from './identity-namespaces.js';
export {
  EVENT_RECALL_IDENTITY_NAMESPACES,
  getIdentityNamespaceDefinition,
  IDENTITY,
  IDENTITY_NAMESPACE_REGISTRY,
  isEventRecallIdentityNamespace,
};
// HTTP client (auth + retry + 429 Retry-After)
export type {
  CreateHttpClientOptions,
  HttpClient,
  RequireBearerClientOptions,
} from './http-client.js';
export { createHttpClient, HttpStatusError, requireBearerClient } from './http-client.js';
// Logger
export { sdkLogger, sdkLogger as logger } from './logger.js';
// Pagination generators
export type {
  CursorPage,
  OffsetPage,
  PaginateByCursorOptions,
  PaginateByOffsetOptions,
} from './pagination.js';
export { paginateByCursor, paginateByOffset } from './pagination.js';
// Nix package-name sanitizer (shared by gateway orchestrator + connector-worker)
export { nixPackageAttrRef } from './nix-package.js';
// Retry
export { withHttpRetry } from './retry.js';
// Scoring
export { calculateEngagementScore } from './scoring.js';
export {
  ConnectorAutomationEventSchema,
  ConnectorAutomationSignalDraftSchema,
  SubscriptionCandidateSchema,
} from './automation-triggers.js';
export type {
  AutomationEventTrigger,
  AutomationScheduleTrigger,
  AutomationTrigger,
  AutomationWorkspaceEventTrigger,
  ConnectorAutomationEvent,
  ConnectorAutomationSignalDraft,
  ConnectorTriggerSignal,
  SubscriptionCandidate,
} from './automation-triggers.js';

// =============================================================================
// Browser automation lives behind `@lobu/connector-sdk/browser` (Playwright,
// CDP, error artifacts). The root must stay loadable inside a V8 isolate.
// =============================================================================

export { applyLookbackCutoff } from './checkpoint/lookback.js';
export {
  buildTimestampCheckpoint,
  filterByCheckpoint,
  finalizeTimestampSync,
} from './checkpoint/timestamp-watermark.js';
export { validatePublicUrl, validateUrlDomain } from './url-guards.js';
export { sleep } from './sleep.js';
export type {
  ExtensionDomScrapeResult,
  ExtensionScrapeConfig,
  ExtensionScrapeObservation,
  ExtensionScrapeResult,
} from './extension-dom-scrape.js';
export { extensionDomScrape } from './extension-dom-scrape.js';
export type {
  ChromeActionDispatcher,
  ChromeActionInput,
  ChromeActionOutput,
  ExtensionNetworkConfig,
  ExtensionNetworkPattern,
  ExtensionNetworkResult,
  InterceptedResponse,
  NavigateObservation,
  NetworkInterceptDrainObservation,
  NetworkInterceptStartObservation,
} from './extension-network.js';
export { extensionNetworkSync } from './extension-network.js';
export type { ReactionContext } from './reaction-sdk.js';
export type { ReactionClient } from './reaction-client-types.js';
export type {
  CardElement,
  KnowledgeDeleteInput,
  KnowledgeReadInput,
  KnowledgeSaveInput,
  KnowledgeSaveResult,
  KnowledgeSearchInput,
  NotificationsSendInput,
  NotificationsSendResult,
} from './reaction-client-types.js';
// Every object input a `ReactionClient` method takes is the server contract's
// own per-action type, re-exported so a script can name the argument it builds.
export type { ConnectionListInput } from '@lobu/core/contracts/tools/manage-connections';
export type {
  EntityCreateInput,
  EntityDeleteInput,
  EntityGetInput,
  EntityLinkInput,
  EntityListInput,
  EntityListLinksInput,
  EntityUnlinkInput,
  EntityUpdateInput,
  EntityUpdateLinkInput,
} from '@lobu/core/contracts/tools/manage-entity';
export type {
  OperationExecuteInput,
  OperationListAvailableInput,
  OperationListRunsInput,
} from '@lobu/core/contracts/tools/manage-operations';
export type { Env } from './types.js';

// =============================================================================
// FileSystemSource — reusable primitive for filesystem-shape ingestion sources
// =============================================================================

// Types only: the implementations (git, tarball, local directory) need
// `node:fs`, `node:https` and isomorphic-git, so `fileSystemSourceFromUri` and
// the source classes live behind `@lobu/connector-sdk/sources`.
export type { FileDelta, FileSystemSource, Snapshot } from './file-source.js';

// =============================================================================
// WinterCG Direct Sockets (Cloudflare / Isolate Sockets API)
// =============================================================================
export { connect } from './net.js';
export type {
  ConnectFn,
  Socket,
  SocketAddress,
  SocketOptions,
} from './net.js';
