/**
 * Connector Compiler — thin wrapper over compiler-core.ts
 *
 * Provides connector-specific esbuild config (node20, CJS banner)
 * and metadata extraction (finds ConnectorRuntime subclass with sync()+execute()).
 */

import { createIsolateConnectorCompiler } from '@lobu/connector-worker/compile';
import type { ConnectorAgentTooling } from '@lobu/connector-sdk';
import { type CompileResult, computeCodeHash, extractMetadata } from './compiler-core';
import { isReservedConnectorKey } from './reserved';
import { validateConnectorRelationshipDeclarations } from './connector-relationship-declarations';
import { connectorIdentityScopeDeclarations } from './connector-identity-scopes';

export interface ConnectorMetadata {
  key: string;
  name: string;
  description?: string;
  version: string;
  /** `'data'` (default/absent) vs `'integration'` (pure app/auth, no feeds/sync). */
  kind?: 'data' | 'integration' | null;
  authSchema: Record<string, unknown> | null;
  /** Declarative inbound-webhook schema (signing scheme + routing), if any. */
  webhook: Record<string, unknown> | null;
  feeds: Record<string, unknown> | null;
  actions: Record<string, unknown> | null;
  automationEvents: Array<Record<string, unknown>> | null;
  optionsSchema: Record<string, unknown> | null;
  faviconDomain?: string | null;
  mcpConfig?: Record<string, unknown> | null;
  openapiConfig?: Record<string, unknown> | null;
  requiredCapability?: string | null;
  runtime?: {
    platforms: Array<
      'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'headless' | 'chrome-extension'
    >;
    scopes?: string[];
  } | null;
  /**
   * What a connection of this connector contributes to the AGENT sandbox (nix
   * packages, credential-backed env vars, egress domains). Persisted verbatim to
   * `connector_definitions.agent_tooling`; the deployment resolver reads it from
   * there, never from connector code.
   */
  agentTooling?: ConnectorAgentTooling | null;
  /**
   * Whether the concrete runtime class OVERRIDES `execute()` (i.e. owns its own
   * `execute` on its prototype rather than inheriting the base class's rejecting
   * default). This is the capability signal readiness uses so it agrees with
   * execution — a connector that declares actions but never overrides execute()
   * would otherwise report "ready" and then throw "Actions not supported"
   * (#2033 item 2). Computed once at compile time. Absent for metadata sources
   * with no local runtime (e.g. MCP-proxy connectors) — persisted as NULL,
   * treated as "assume supported".
   */
  supportsExecute?: boolean;
}

/**
 * Emitted when a compiled file exports no ConnectorRuntime class.
 *
 * This is the "it isn't a connector" signal, not a malfunction: the catalog
 * scan compiles every `.ts` in the connectors directory, and that directory
 * legitimately also holds support modules (identity modules, egress guards,
 * automation-event definitions) which were never meant to be connectors.
 *
 * It is a shared constant rather than two copies of a sentence because the
 * throw happens inside CONNECTOR_RUNNER_CODE — a subprocess — and comes back
 * over `process.send({ error: error.message })`. A string is the only channel
 * available, so the two sides are pinned to one exported literal instead of
 * matching prose that a later reword would silently desynchronise.
 */
export const NO_CONNECTOR_RUNTIME_ERROR =
  "No ConnectorRuntime class found in compiled code. Expected a class with sync() and execute() methods.";

const CONNECTOR_RUNNER_CODE = `
import { pathToFileURL } from 'node:url';

async function main() {
  try {
    const mod = await import(pathToFileURL(process.argv[2]).href);
    // A CJS bundle imported from ESM arrives as { default: module.exports }.
    const target = (mod.default && typeof mod.default === 'object') ? mod.default : mod;

    let RuntimeClass = null;
    for (const key of Object.keys(target)) {
      const val = target[key];
      if (
        typeof val === 'function' &&
        val.prototype &&
        typeof val.prototype.sync === 'function' &&
        typeof val.prototype.execute === 'function'
      ) {
        RuntimeClass = val;
        break;
      }
    }

    if (!RuntimeClass && target.default) {
      const val = target.default;
      if (
        typeof val === 'function' &&
        val.prototype &&
        typeof val.prototype.sync === 'function' &&
        typeof val.prototype.execute === 'function'
      ) {
        RuntimeClass = val;
      }
    }

    if (!RuntimeClass) {
      throw new Error(${JSON.stringify(NO_CONNECTOR_RUNTIME_ERROR)});
    }

    const instance = new RuntimeClass();
    const def = instance.definition;

    if (!def || typeof def !== 'object') {
      throw new Error('ConnectorRuntime class must expose a definition property.');
    }

    // Capability probe (#2033 item 2): does the concrete class OVERRIDE execute()?
    // The base ConnectorRuntime defines execute() (which rejects), so
    // \`typeof prototype.execute === 'function'\` is always true and can't tell an
    // override from the inherited default. An OWN \`execute\` on the class's own
    // prototype means the connector actually implements execution.
    const supportsExecute =
      Object.getOwnPropertyNames(RuntimeClass.prototype).includes('execute');

    const feeds = def.feeds == null
      ? null
      : Object.fromEntries(Object.entries(def.feeds).map(([feedKey, rawFeed]) => {
          const feed = rawFeed && typeof rawFeed === 'object' ? rawFeed : {};
          const { sync, read, onDelivery, ...serializable } = feed;
          const operations = [];
          if (typeof sync === 'function') operations.push('sync');
          if (typeof read === 'function') operations.push('read');
          if (typeof onDelivery === 'function') operations.push('delivery');
          if (operations.length === 0) {
            throw new Error(
              'Connector feed ' + JSON.stringify(feedKey) +
              ' must implement sync, read or onDelivery on its feed definition.'
            );
          }
          return [feedKey, { ...serializable, operations }];
        }));

    const metadata = {
      key: def.key || null,
      name: def.name || null,
      description: def.description || null,
      version: def.version || null,
      kind: def.kind || null,
      authSchema: def.authSchema || null,
      webhook: def.webhook || null,
      feeds,
      actions: def.actions || null,
      automationEvents: def.automationEvents || null,
      optionsSchema: def.optionsSchema || null,
      faviconDomain: def.faviconDomain || null,
      mcpConfig: def.mcpConfig || null,
      openapiConfig: def.openapiConfig || null,
      requiredCapability: def.requiredCapability || null,
      runtime: def.runtime || null,
      agentTooling: def.agentTooling || null,
      supportsExecute,
    };

    process.send({ success: true, metadata });
  } catch (error) {
    process.send({ success: false, error: error.message });
  }
}

main();
`;

const isolateCompiler = createIsolateConnectorCompiler();

export async function compileConnectorSource(sourceCode: string): Promise<CompileResult> {
  const compiledCode = await isolateCompiler.compileConnectorForIsolateFromSource(sourceCode);
  const compiledCodeHash = computeCodeHash(compiledCode);
  return { compiledCode, compiledCodeHash };
}

export async function extractConnectorMetadata(compiledCode: string): Promise<ConnectorMetadata> {
  return extractMetadata<ConnectorMetadata>(compiledCode, {
    tmpPrefix: '.connector-meta-',
    runnerCode: CONNECTOR_RUNNER_CODE,
  });
}

/**
 * Assert that extracted connector metadata carries the required identity
 * fields. Throws with the canonical message used across the install paths.
 */
export function validateConnectorMetadata(metadata: ConnectorMetadata): void {
  if (!metadata.key || !metadata.name || !metadata.version) {
    throw new Error('Connector must have key, name, and version.');
  }
  // The web app routes `/connectors/<key>/<connectionId>` against a catch-all
  // param, and static sibling segments (CONNECTOR_SUBROUTE_SEGMENTS) win the
  // match. A connector installed under one of those names would have every
  // connection page it owns shadowed by an unrelated route — reject the
  // install rather than ship a connector whose pages are unreachable.
  if (isReservedConnectorKey(metadata.key)) {
    throw new Error(
      `Connector key '${metadata.key}' is reserved by a /connectors/ route. Pick another key.`
    );
  }
  connectorIdentityScopeDeclarations(metadata);
  validateConnectorRelationshipDeclarations(metadata);
}
