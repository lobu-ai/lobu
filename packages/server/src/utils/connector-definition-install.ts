import { readFile } from 'node:fs/promises';
import { COMPILE_CONFIG_HASH, flattenConnectorSourceFromFile } from '@lobu/connector-worker/compile';
import type { getDb } from '../db/client';
import { computeCodeHash } from './compiler-core';
import { cancelResponseBody, readResponseTextWithLimit } from './bounded-response';
import {
  compileConnectorForIsolateFromFile,
  resolveFileSourcePath,
} from './connector-catalog';
import {
  type ConnectorMetadata,
  compileConnectorSource,
  extractConnectorMetadata,
  validateConnectorMetadata,
} from './connector-compiler';
import { fetchPublicUrl, isInternalUrl } from '@lobu/connector-worker/egress';
import type { McpOAuthMetadata } from '../mcp-proxy/types';
import { assertChromeNamespaceInstallIsDeviceManifest } from './connector-execution-placement';
import { preflightConnectorRelationshipTypes } from './connector-relationship-declarations';
import { reconcileConnectorIdentityScopeRegistry } from './connector-identity-scopes';

type SqlClient = ReturnType<typeof getDb>;

export type ConnectorInstallResult = {
  connectorKey: string;
  name: string;
  version: string;
  codeHash: string;
  updated: boolean;
  authSchema: Record<string, unknown> | null;
  mcpConfig?: Record<string, unknown> | null;
  mcpOAuth?: McpOAuthMetadata;
  openapiConfig?: Record<string, unknown> | null;
};

type ConnectorVersionPersistence = {
  compiledCode: string | null;
  compiledCodeHash: string | null;
  /**
   * Fingerprint of the compile configuration that produced `compiledCode` —
   * only set when THIS server's pipeline compiled it. Pre-compiled uploads
   * (`compiled: true` / detected JS) stay NULL: their provenance is unknown
   * (an older CLI may have compiled under a different externals list), so
   * `resolveConnectorCode` normalizes them through the current pipeline on
   * first resolution instead of trusting them.
   */
  compileConfigHash: string | null;
  sourceCode: string | null;
  sourcePath: string | null;
};

type ResolvedConnectorInstallSource = Omit<
  ConnectorVersionPersistence,
  'compiledCode' | 'compiledCodeHash' | 'sourceCode'
> & {
  compiledCode: string;
  compiledCodeHash: string;
  sourceCode: string;
  metadata: ConnectorMetadata;
};

/**
 * Detect whether source code is already compiled JavaScript (not TypeScript).
 * Checks for common esbuild/CJS output markers and absence of TypeScript syntax.
 */
function isPreCompiledJs(code: string): boolean {
  const trimmed = code.trimStart();

  if (
    trimmed.startsWith('"use strict"') ||
    trimmed.startsWith("'use strict'") ||
    trimmed.startsWith('var __defProp') ||
    trimmed.startsWith('var __getOwnPropNames') ||
    trimmed.startsWith('// src/')
  ) {
    return true;
  }

  if (trimmed.startsWith('import { createRequire')) {
    return true;
  }

  return false;
}

// Hosts a connector's `source_url` may be fetched from out of the box. Installing
// from a URL fetches + compiles + runs remote code, so it must be locked down to
// known-good sources. Extend per-deployment via CONNECTOR_SOURCE_ALLOWLIST.
const DEFAULT_CONNECTOR_SOURCE_HOSTS = [
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'objects.githubusercontent.com',
  'github.com',
];

const MAX_CONNECTOR_SOURCE_BYTES = 5 * 1024 * 1024;
const CONNECTOR_SOURCE_FETCH_TIMEOUT_MS = 30_000;
const MAX_CONNECTOR_SOURCE_REDIRECTS = 5;

function allowedConnectorSourceHosts(): string[] {
  const extra = (process.env.CONNECTOR_SOURCE_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_CONNECTOR_SOURCE_HOSTS, ...extra];
}

/**
 * Validate a connector `source_url` before fetching: https only, host on the
 * allowlist, and not resolving to a private/loopback/reserved address (SSRF).
 * `CONNECTOR_SOURCE_ALLOWLIST` adds hosts (`.example.com` matches subdomains);
 * `*` allows any public host (the SSRF/DNS check still applies). Async because
 * the SSRF guard resolves DNS. Re-run on every redirect hop by the fetcher.
 */
async function assertAllowedConnectorSourceUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid source_url: ${rawUrl}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`source_url must use https (got '${url.protocol || rawUrl}').`);
  }
  const allow = allowedConnectorSourceHosts();
  if (!allow.includes('*')) {
    const host = url.hostname.toLowerCase();
    const ok = allow.some((entry) =>
      entry.startsWith('.') ? host === entry.slice(1) || host.endsWith(entry) : host === entry
    );
    if (!ok) {
      throw new Error(
        `source_url host '${host}' is not in the connector source allowlist (${allow.join(', ')}). ` +
          `Set CONNECTOR_SOURCE_ALLOWLIST to add hosts, or '*' to allow any public host.`
      );
    }
  }
  // DNS-resolving check: catches IP literals (incl. IPv4-mapped IPv6) AND
  // hostnames that resolve to reserved/private ranges (DNS-rebinding).
  if (await isInternalUrl(url.toString())) {
    throw new Error(
      `source_url host '${url.hostname}' is blocked (resolves to a private/loopback/reserved address).`
    );
  }
  return url;
}

/**
 * Fetch connector source with a single timeout covering the whole exchange
 * (headers + body), manual redirect following that re-validates EVERY hop with
 * the same scheme/allowlist/SSRF checks, and a streaming byte cap.
 */
async function fetchConnectorSource(initialUrl: URL): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONNECTOR_SOURCE_FETCH_TIMEOUT_MS);
  try {
    let url = initialUrl;
    for (let hop = 0; hop <= MAX_CONNECTOR_SOURCE_REDIRECTS; hop++) {
      const res = await fetchPublicUrl(url, {
        signal: controller.signal,
        redirect: 'manual',
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await cancelResponseBody(res);
        if (!location) throw new Error(`Redirect from ${url.toString()} had no Location header.`);
        url = await assertAllowedConnectorSourceUrl(new URL(location, url).toString());
        continue;
      }
      if (!res.ok) {
        await cancelResponseBody(res);
        throw new Error(`Failed to fetch source from ${url.toString()}: ${res.status}`);
      }
      return await readResponseTextWithLimit(
        res,
        MAX_CONNECTOR_SOURCE_BYTES,
        'Connector source too large'
      );
    }
    throw new Error(
      `Too many redirects fetching connector source (max ${MAX_CONNECTOR_SOURCE_REDIRECTS}).`
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveConnectorInstallSource(params: {
  sourceUrl?: string;
  sourceUri?: string;
  sourceCode?: string;
  compiled?: boolean;
}): Promise<ResolvedConnectorInstallSource> {
  let sourceCode: string;
  let sourcePath: string | null = null;

  if (params.sourceUri) {
    const filePath = resolveFileSourcePath(params.sourceUri);
    if (!filePath) {
      throw new Error(
        `Unsupported source_uri '${params.sourceUri}'. Only local file URIs are supported.`
      );
    }

    sourcePath = filePath;
    // Persist a self-contained snapshot, NOT the raw file text: a file-backed
    // connector may import sibling modules, and the stored source must
    // recompile under the strict single-file source-text compiler when the
    // compile configuration later drifts (#2042). An explicitly pre-compiled
    // file is stored verbatim — it is already an artifact, not source.
    sourceCode = params.compiled
      ? await readFile(filePath, 'utf-8')
      : await flattenConnectorSourceFromFile(filePath);
  } else if (params.sourceUrl) {
    const url = await assertAllowedConnectorSourceUrl(params.sourceUrl);
    sourcePath = url.pathname.replace(/^\//, '') || null;
    sourceCode = await fetchConnectorSource(url);
  } else if (params.sourceCode) {
    sourceCode = params.sourceCode;
  } else {
    throw new Error('Provide source_url or source_code to install a connector.');
  }

  // The pre-compiled sniff only applies to text uploads: a file-backed install
  // stores a flattened source snapshot whose esbuild output shape would
  // false-positive the sniff, and its compile path is explicit anyway.
  const alreadyCompiled = params.compiled || (!params.sourceUri && isPreCompiledJs(sourceCode));

  let compiledCode: string;
  let compiledCodeHash: string;

  if (alreadyCompiled) {
    compiledCode = sourceCode;
    compiledCodeHash = computeCodeHash(sourceCode);
  } else if (params.sourceUri && sourcePath) {
    compiledCode = await compileConnectorForIsolateFromFile(sourcePath);
    compiledCodeHash = computeCodeHash(compiledCode);
  } else {
    const compiled = await compileConnectorSource(sourceCode);
    compiledCode = compiled.compiledCode;
    compiledCodeHash = compiled.compiledCodeHash;
  }

  const metadata = await extractConnectorMetadata(compiledCode);
  validateConnectorMetadata(metadata);

  return {
    metadata,
    sourceCode,
    sourcePath,
    compiledCode,
    compiledCodeHash,
    // Pre-compiled uploads were NOT produced by this server's pipeline — an
    // older client may have compiled under a different externals list — so
    // they carry no fingerprint and get normalized on first resolution.
    compileConfigHash: alreadyCompiled ? null : COMPILE_CONFIG_HASH,
  };
}

type UpsertConnectorDefinitionRecordsParams = {
  sql: SqlClient;
  organizationId: string;
  metadata: ConnectorMetadata;
  versionRecord: ConnectorVersionPersistence;
  /**
   * Which connector_versions namespace the version row belongs to.
   *
   * - 'shared': a pointer at bundled on-disk source (source_path, no code) —
   *   identical for every org, deduped on one organization_id-IS-NULL row.
   * - 'organization': org-supplied bytes (install_connector / source_url /
   *   source_code / mcp_url) land ONLY on the caller org's own
   *   (organization_id, connector_key, version) row — never the shared
   *   namespace (#2045: a shared row of custom code is a cross-org
   *   read/activate surface). Content-empty rollback records preserve the
   *   retained artifact and create a marker only when no visible row exists.
   *   A caller explicitly replacing the artifact (mcp_url) instead writes an
   *   org marker atomically, shadowing but never mutating a shared artifact.
   */
  versionScope: 'shared' | 'organization';
  /** Replace every version artifact/provenance field, including with NULL. */
  replaceVersionArtifact?: boolean;
};

type UpsertConnectorDefinitionResult = {
  updated: boolean;
};

/**
 * Reconcile identity-scope registry state and activate the matching definition
 * in one transaction, so a rejected shape change cannot partially install.
 */
export async function upsertConnectorDefinitionRecords(
  params: UpsertConnectorDefinitionRecordsParams
): Promise<UpsertConnectorDefinitionResult> {
  const run = (sql: SqlClient) =>
    upsertConnectorDefinitionRecordsInTransaction({ ...params, sql });
  const callerOwnsTransaction = typeof params.sql.savepoint === 'function';
  const result = callerOwnsTransaction
    ? await params.sql.savepoint(run)
    : await params.sql.begin(run);
  return result;
}

async function upsertConnectorDefinitionRecordsInTransaction(
  params: UpsertConnectorDefinitionRecordsParams
): Promise<UpsertConnectorDefinitionResult> {
  const { sql } = params;
  const { metadata } = params;

  // This is the shared definition writer for bundled, custom, rollback, and
  // device-manifest connectors, so the relationship gate sits here rather than
  // on the compile path some of them skip. The preflight validates the local
  // declaration graph and resolves it against the org's own relationship
  // vocabulary before any definition or version row can become active.
  // The reserved Chrome namespace is an execution declaration, not a name.
  // Guard it here — the shared writer every install path funnels through —
  // rather than on the compile path a device manifest skips.
  assertChromeNamespaceInstallIsDeviceManifest({
    connectorKey: metadata.key,
    connectorVersion: metadata.version,
    sourcePath: params.versionRecord.sourcePath,
    compiledCode: params.versionRecord.compiledCode,
    sourceCode: params.versionRecord.sourceCode,
  });

  await preflightConnectorRelationshipTypes({
    sql,
    organizationId: params.organizationId,
    metadata,
  });
  await reconcileConnectorIdentityScopeRegistry({
    sql,
    organizationId: params.organizationId,
    metadata,
  });

  const authSchemaJson = metadata.authSchema ? sql.json(metadata.authSchema) : null;
  const feedsSchemaJson = metadata.feeds ? sql.json(metadata.feeds) : null;
  const actionsSchemaJson = metadata.actions ? sql.json(metadata.actions) : null;
  const automationEventsJson = metadata.automationEvents ? sql.json(metadata.automationEvents) : null;
  const optionsSchemaJson = metadata.optionsSchema ? sql.json(metadata.optionsSchema) : null;
  const mcpConfigJson = metadata.mcpConfig ? sql.json(metadata.mcpConfig) : null;
  const openapiConfigJson = metadata.openapiConfig ? sql.json(metadata.openapiConfig) : null;
  const runtimeJson = metadata.runtime ? sql.json(metadata.runtime) : null;
  const agentToolingJson = metadata.agentTooling ? sql.json(metadata.agentTooling) : null;
  // Capability flag (#2033 item 2): readiness reads this instead of assuming a
  // declared action is executable. Older metadata (no field) stays NULL =
  // "assume supported" so nothing regresses.
  const supportsExecute = metadata.supportsExecute ?? null;

  const existing = await sql`
    SELECT id, status, login_enabled
    FROM connector_definitions
    WHERE key = ${metadata.key}
      AND organization_id = ${params.organizationId}
    ORDER BY
      CASE WHEN status = 'active' THEN 0 ELSE 1 END,
      updated_at DESC,
      id DESC
    LIMIT 1
  `;

  const existingRow = existing[0] as
    | { id: number; status: string; login_enabled: boolean }
    | undefined;
  const preservedLoginEnabled = existingRow?.login_enabled ?? false;

  let wasActive = existingRow?.status === 'active';

  if (existingRow?.status === 'active') {
    await sql`
      UPDATE connector_definitions
      SET name = ${metadata.name},
          description = ${metadata.description ?? null},
          version = ${metadata.version},
          auth_schema = ${authSchemaJson},
          feeds_schema = ${feedsSchemaJson},
          actions_schema = ${actionsSchemaJson},
          automation_events = ${automationEventsJson},
          options_schema = ${optionsSchemaJson},
          mcp_config = ${mcpConfigJson},
          openapi_config = ${openapiConfigJson},
          favicon_domain = ${metadata.faviconDomain ?? null},
          required_capability = ${metadata.requiredCapability ?? null},
          runtime = ${runtimeJson},
          agent_tooling = ${agentToolingJson},
          supports_execute = ${supportsExecute},
          login_enabled = ${preservedLoginEnabled},
          updated_at = NOW()
      WHERE id = ${existingRow.id}
    `;
    // Fall through to the shared connector_versions upsert below.
  } else {
    // No active row seen — but the SELECT is not a lock, so a concurrent
    // installer may INSERT the active row between our SELECT and INSERT. ON
    // CONFLICT DO NOTHING makes the loser a no-op (returns no row) WITHOUT
    // aborting an enclosing transaction — critical because a caller
    // (device-reconcile) passes a `tx`, where a raw 23505 would poison the whole
    // transaction (25P02).
    const inserted = await sql`
      INSERT INTO connector_definitions (
        organization_id, key, name, description, version,
        auth_schema, feeds_schema, actions_schema, automation_events, options_schema,
        mcp_config, openapi_config, favicon_domain, required_capability,
        runtime, agent_tooling, supports_execute, status, login_enabled
      ) VALUES (
        ${params.organizationId}, ${metadata.key}, ${metadata.name},
        ${metadata.description ?? null}, ${metadata.version},
        ${authSchemaJson}, ${feedsSchemaJson}, ${actionsSchemaJson}, ${automationEventsJson},
        ${optionsSchemaJson},
        ${mcpConfigJson}, ${openapiConfigJson},
        ${metadata.faviconDomain ?? null}, ${metadata.requiredCapability ?? null},
        ${runtimeJson}, ${agentToolingJson}, ${supportsExecute}, 'active', ${preservedLoginEnabled}
      )
      ON CONFLICT (organization_id, key)
        WHERE organization_id IS NOT NULL AND status = 'active'
        DO NOTHING
      RETURNING id
    `;

    if (inserted.length === 0) {
      // The race loser: the winner already created the active row. Update it so
      // both callers converge on this install's metadata (last-write-wins,
      // matching the sequential UPDATE branch above).
      wasActive = true;
      await sql`
        UPDATE connector_definitions
        SET name = ${metadata.name},
            description = ${metadata.description ?? null},
            version = ${metadata.version},
            auth_schema = ${authSchemaJson},
            feeds_schema = ${feedsSchemaJson},
            actions_schema = ${actionsSchemaJson},
            automation_events = ${automationEventsJson},
            options_schema = ${optionsSchemaJson},
            mcp_config = ${mcpConfigJson},
            openapi_config = ${openapiConfigJson},
            favicon_domain = ${metadata.faviconDomain ?? null},
            required_capability = ${metadata.requiredCapability ?? null},
            runtime = ${runtimeJson},
            agent_tooling = ${agentToolingJson},
            supports_execute = ${supportsExecute},
            updated_at = NOW()
        WHERE key = ${metadata.key}
          AND organization_id = ${params.organizationId}
          AND status = 'active'
      `;
    }
  }

  // Persist the version's executable source for BOTH the create and the
  // active-update paths — a definition must never point at a version with no
  // compiled/source record. Pipeline-compiled artifacts arrive stamped with
  // the fingerprint of the compile configuration that produced them
  // (versionRecord.compileConfigHash), so a later change to
  // EXTERNAL_RUNTIME_DEPS / the compile pipeline invalidates them
  // (resolveConnectorCode recompiles instead of executing a stale bundle).
  const record = params.versionRecord;
  // A version row represents exactly one artifact family. Same-family writes
  // retain the existing patch semantics, but crossing the manifest boundary
  // replaces every source/provenance field atomically so a manifest hash can
  // never attest stale compiled bytes (or a compiled artifact retain a stale
  // device-manifest:// identity).
  const incomingIsDeviceManifest = record.sourcePath?.startsWith('device-manifest://') === true;
  const replaceVersionArtifact = incomingIsDeviceManifest || params.replaceVersionArtifact === true;
  if (params.versionScope === 'shared') {
    // Bundled catalog pointer: identical for every org, deduped on the one
    // shared organization_id-IS-NULL row.
    await sql`
      INSERT INTO connector_versions (
        connector_key, version, organization_id, compiled_code, compiled_code_hash,
        compile_config_hash, source_code, source_path
      ) VALUES (
        ${metadata.key}, ${metadata.version}, NULL, ${record.compiledCode},
        ${record.compiledCodeHash}, ${record.compileConfigHash},
        ${record.sourceCode}, ${record.sourcePath}
      )
      ON CONFLICT (connector_key, version) WHERE organization_id IS NULL DO UPDATE
      SET compiled_code = CASE
            WHEN ${replaceVersionArtifact} THEN EXCLUDED.compiled_code
            WHEN connector_versions.source_path LIKE 'device-manifest://%'
              THEN EXCLUDED.compiled_code
            ELSE COALESCE(EXCLUDED.compiled_code, connector_versions.compiled_code)
          END,
          compiled_code_hash = CASE
            WHEN ${replaceVersionArtifact}
              OR connector_versions.source_path LIKE 'device-manifest://%'
              THEN EXCLUDED.compiled_code_hash
            ELSE COALESCE(EXCLUDED.compiled_code_hash, connector_versions.compiled_code_hash)
          END,
          -- The fingerprint rides with the artifact, never independently: when a
          -- reinstall REPLACES compiled_code, take the incoming fingerprint even
          -- when it is NULL (a pre-compiled upload replacing a pipeline-compiled
          -- artifact must not inherit the old row's "current" attestation).
          compile_config_hash = CASE
            WHEN ${replaceVersionArtifact} THEN EXCLUDED.compile_config_hash
            WHEN connector_versions.source_path LIKE 'device-manifest://%'
              THEN EXCLUDED.compile_config_hash
            WHEN EXCLUDED.compiled_code IS NOT NULL THEN EXCLUDED.compile_config_hash
            ELSE connector_versions.compile_config_hash
          END,
          source_code = CASE
            WHEN ${replaceVersionArtifact} THEN EXCLUDED.source_code
            WHEN connector_versions.source_path LIKE 'device-manifest://%'
              THEN EXCLUDED.source_code
            ELSE COALESCE(EXCLUDED.source_code, connector_versions.source_code)
          END,
          source_path = CASE
            WHEN ${replaceVersionArtifact}
              OR connector_versions.source_path LIKE 'device-manifest://%'
              THEN EXCLUDED.source_path
            ELSE COALESCE(EXCLUDED.source_path, connector_versions.source_path)
          END
    `;
    return { updated: wasActive };
  }

  // Org-supplied bytes land ONLY on the caller org's own row (#2045: a shared
  // row of custom code is a cross-org read/activate surface).
  const hasContent =
    replaceVersionArtifact ||
    record.compiledCode !== null ||
    record.sourceCode !== null ||
    record.sourcePath !== null;
  if (hasContent) {
    await sql`
      INSERT INTO connector_versions (
        connector_key, version, organization_id, compiled_code, compiled_code_hash,
        compile_config_hash, source_code, source_path
      ) VALUES (
        ${metadata.key}, ${metadata.version}, ${params.organizationId}, ${record.compiledCode},
        ${record.compiledCodeHash}, ${record.compileConfigHash},
        ${record.sourceCode}, ${record.sourcePath}
      )
      ON CONFLICT (organization_id, connector_key, version) WHERE organization_id IS NOT NULL
      DO UPDATE
      SET compiled_code = CASE
            WHEN ${replaceVersionArtifact} THEN EXCLUDED.compiled_code
            WHEN connector_versions.source_path LIKE 'device-manifest://%'
              THEN EXCLUDED.compiled_code
            ELSE COALESCE(EXCLUDED.compiled_code, connector_versions.compiled_code)
          END,
          compiled_code_hash = CASE
            WHEN ${replaceVersionArtifact}
              OR connector_versions.source_path LIKE 'device-manifest://%'
              THEN EXCLUDED.compiled_code_hash
            ELSE COALESCE(EXCLUDED.compiled_code_hash, connector_versions.compiled_code_hash)
          END,
          compile_config_hash = CASE
            WHEN ${replaceVersionArtifact} THEN EXCLUDED.compile_config_hash
            WHEN connector_versions.source_path LIKE 'device-manifest://%'
              THEN EXCLUDED.compile_config_hash
            WHEN EXCLUDED.compiled_code IS NOT NULL THEN EXCLUDED.compile_config_hash
            ELSE connector_versions.compile_config_hash
          END,
          source_code = CASE
            WHEN ${replaceVersionArtifact} THEN EXCLUDED.source_code
            WHEN connector_versions.source_path LIKE 'device-manifest://%'
              THEN EXCLUDED.source_code
            ELSE COALESCE(EXCLUDED.source_code, connector_versions.source_code)
          END,
          source_path = CASE
            WHEN ${replaceVersionArtifact}
              OR connector_versions.source_path LIKE 'device-manifest://%'
              THEN EXCLUDED.source_path
            ELSE COALESCE(EXCLUDED.source_path, connector_versions.source_path)
          END
    `;
  } else {
    // Content-empty preserve record (rollback shape). A rollback target always
    // exists (validated by the caller), so this only creates the marker row a
    // first metadata-only install needs — and never when ANY visible row
    // (this org's or shared) already holds the pair, so an empty org row
    // can never shadow a code-bearing row.
    await sql`
      INSERT INTO connector_versions (connector_key, version, organization_id)
      SELECT ${metadata.key}, ${metadata.version}, ${params.organizationId}
      WHERE NOT EXISTS (
        SELECT 1 FROM connector_versions
        WHERE connector_key = ${metadata.key} AND version = ${metadata.version}
          AND (organization_id = ${params.organizationId} OR organization_id IS NULL)
      )
      ON CONFLICT DO NOTHING
    `;
  }

  return { updated: wasActive };
}
