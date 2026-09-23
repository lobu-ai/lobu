/**
 * Auto-install a bundled connector into an org on first use.
 *
 * Looks up connectors/{key}.ts on disk (dots in key become underscores),
 * compiles from the real file path so relative imports resolve, extracts
 * metadata, and installs the definition + version row.
 *
 * compiled_code is NOT stored — at runtime the source is compiled on demand
 * from source_path, so edits to .ts files take effect without reinstalling.
 */

import { COMPILE_CONFIG_HASH } from '@lobu/connector-worker/compile';
import { getDb } from '../db/client';
import {
  bundledConnectorSourcePath,
  compileConnectorForIsolateFromFile,
  findBundledConnectorFile,
} from './connector-catalog';
import {
  compileConnectorSource,
  extractConnectorMetadata,
  validateConnectorMetadata,
} from './connector-compiler';
import {
  type ConnectorInstallResult,
  upsertConnectorDefinitionRecords,
} from './connector-definition-install';
import { computeCodeHash } from './compiler-core';
import logger from './logger';
import { isCloudMode } from './cloud-mode';

/**
 * The `connector_versions` columns every executing reader must select and
 * hand to `resolveConnectorCode`. `compile_config_hash` is the fingerprint of
 * the compile configuration (EXTERNAL_RUNTIME_DEPS + pipeline version) that
 * produced `compiled_code`.
 */
export type StoredConnectorVersion = {
  /**
   * Primary key of the row the columns came from. (connector_key, version) no
   * longer identifies one row — an org-scoped copy may share the pair with
   * the shared bundled row — so the recompile-repersist path must address the
   * exact row it resolved. NULL when the reader's LEFT JOIN found no row.
   */
  id: number | null;
  organization_id: string | null;
  version: string | null;
  compiled_code: string | null;
  compile_config_hash: string | null;
};

/**
 * Resolve compiled connector code at runtime.
 *
 * Resolution order:
 * 1. Org-installed `compiled_code` from `connector_versions` (via
 *    `install_connector` / `source_url` / `source_code`) — an explicit
 *    per-org override must beat the bundled registry copy — but ONLY when its
 *    `compile_config_hash` matches the current compile configuration. An
 *    artifact compiled under a different externals list may bare-import a
 *    package the runtime image no longer ships (the pino outage), so a stale
 *    artifact is never executed: it is recompiled from the row's stored
 *    `source_code` and the fresh artifact is persisted (Postgres-mediated, so
 *    every replica converges after the first resolution).
 * 2. Bundled source on disk (recompiled on demand; mtime-cached — always
 *    reflects the current compile configuration since the compiler and the
 *    externals list ship in the same image).
 *
 * Bundled-only connectors never populate `compiled_code` on their version row
 * (`upsertBundledConnectorForOrg` stores `source_path` instead), so the
 * bundled path still runs for the default registry.
 */
export async function resolveConnectorCode(
  connectorKey: string,
  stored: StoredConnectorVersion | null
): Promise<string> {
  // Cloud prefers the running image's own bytes, but does not REFUSE a stored
  // artifact when the image ships no source for the key: the isolate is the
  // boundary that makes organization-supplied code runnable, so there is no
  // separate admission step to defer to.
  if (isCloudMode()) {
    // Image first, whatever the stored row's scope. An org-scoped row for a key
    // the image ships is the common shadow shape (readers select ORDER BY
    // organization_id NULLS LAST), and refusing it here turned an admitted run
    // into a failed claimed run. Compiling the image file honours the same
    // invariant the refusal did — organization-supplied bytes never execute —
    // while keeping the connector online.
    const imagePath = findBundledConnectorFile(connectorKey);
    if (imagePath) {
      // The substitution is otherwise invisible: the org's stored bytes are
      // discarded and the image file runs instead, with nothing in the run to
      // say so. This is the only place that knows it happened, so an org that
      // deliberately overrode a catalog key would see a connector that "works"
      // while executing code it did not install. The volume of this line is
      // also the measure of the shadow-row cleanup — it goes quiet when the
      // org-scoped rows for image-shipped keys are retired.
      //
      // `StoredConnectorVersion` carries no `source_code`, so a source-only
      // org row is superseded without a line here; every prod shadow row for
      // an image-shipped key carries `compiled_code`.
      if (stored?.organization_id != null && stored.compiled_code != null) {
        logger.warn(
          {
            connector_key: connectorKey,
            organization_id: stored.organization_id,
            version: stored.version,
            row_id: stored.id,
          },
          'Cloud superseded an organization-scoped connector artifact with the image file'
        );
      }
      return compileConnectorForIsolateFromFile(imagePath);
    }
    if (stored?.compiled_code && stored.compile_config_hash === COMPILE_CONFIG_HASH) {
      return stored.compiled_code;
    }
    // A stale artifact is NEVER returned, here or on the self-hosted path
    // below: `COMPILE_PIPELINE_VERSION` moved because every artifact built
    // before it is shaped for a module loader the isolate does not have, so
    // handing one back trades a clear error for an unloadable bundle.
    if (stored?.id != null) {
      const recompiled = await recompileStoredConnectorVersion(connectorKey, stored.id);
      if (recompiled) return recompiled;
    }
    throw new Error(
      stored?.compiled_code
        ? `Compiled artifact for '${connectorKey}' predates the current compile configuration and no source is available to recompile — reinstall the connector.`
        : `No bundled source or stored compiled code for '${connectorKey}'.`
    );
  }
  if (stored?.compiled_code) {
    if (stored.compile_config_hash === COMPILE_CONFIG_HASH) return stored.compiled_code;
    if (stored.id != null) {
      try {
        const recompiled = await recompileStoredConnectorVersion(connectorKey, stored.id);
        if (recompiled) return recompiled;
      } catch (err) {
        // The stored source no longer compiles under the current compile
        // configuration (e.g. a catalog snapshot taken before an import rule
        // tightened — the Gmail scraper-utils outage, #2042). When the same
        // key ships as bundled source in this image, the registry copy is the
        // known-good implementation — run it instead of hard-failing every
        // feed read. A key with no bundled counterpart is genuinely custom:
        // surface the compile error to the caller.
        if (findBundledConnectorFile(connectorKey)) {
          logger.error(
            { connector_key: connectorKey, version: stored.version, err },
            'Stored connector source failed to recompile — falling back to bundled catalog source'
          );
        } else {
          throw err;
        }
      }
    }
    // No stored source to recompile from (legacy row) — fall through to the
    // bundled on-disk source; the stale artifact itself must never execute.
  }
  const filePath = findBundledConnectorFile(connectorKey);
  if (filePath) return compileConnectorForIsolateFromFile(filePath);
  throw new Error(
    stored?.compiled_code
      ? `Compiled artifact for '${connectorKey}' predates the current compile configuration and no source is available to recompile — reinstall the connector.`
      : `No compiled code for '${connectorKey}' and source not found on disk.`
  );
}

/**
 * Fetch the stored artifact row for a connector. An explicit `version` resolves
 * that retained version; when omitted, the org's active connector definition
 * selects the version. Within that version, org-local code shadows shared code.
 * Shared by the pushdown / webhook / inline-operation paths, which don't carry
 * a version row of their own.
 */
export async function resolveConnectorCodeForKey(
  connectorKey: string,
  organizationId: string,
  version?: string | null
): Promise<string> {
  const sql = getDb();
  // Org-preferring resolution (#2045) is scoped to ONE version. An org-local
  // artifact shadows the shared bundled row only when both represent the same
  // version. Without an explicit historical version, the org's ACTIVE
  // connector_definitions.version is authoritative. Otherwise a retained stale
  // org artifact can shadow a newly-promoted shared version (e.g. Calendar
  // active=1.1.0 while an old org-local 1.0.0 row still exists).
  const rows = version
    ? await sql`
        SELECT id, organization_id, version, compiled_code, compile_config_hash FROM connector_versions
        WHERE connector_key = ${connectorKey} AND version = ${version}
          AND (organization_id = ${organizationId} OR organization_id IS NULL)
        ORDER BY organization_id NULLS LAST
        LIMIT 1
      `
    : await sql`
        SELECT cv.id, cv.organization_id, cv.version, cv.compiled_code, cv.compile_config_hash
        FROM connector_definitions cd
        JOIN connector_versions cv
          ON cv.connector_key = cd.key
         AND cv.version = cd.version
         AND (cv.organization_id = cd.organization_id OR cv.organization_id IS NULL)
        WHERE cd.organization_id = ${organizationId}
          AND cd.key = ${connectorKey}
          AND cd.status = 'active'
        ORDER BY cv.organization_id NULLS LAST
        LIMIT 1
      `;
  return resolveConnectorCode(connectorKey, (rows[0] as StoredConnectorVersion | undefined) ?? null);
}

/**
 * Recompile a stale org-installed artifact from its stored `source_code` and
 * persist the result with the current compile-config fingerprint. Returns
 * null when the row keeps no source (legacy bundled-era rows).
 */
async function recompileStoredConnectorVersion(
  connectorKey: string,
  rowId: number
): Promise<string | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT source_code, version FROM connector_versions
    WHERE id = ${rowId}
    LIMIT 1
  `;
  const row = rows[0] as { source_code: string | null; version: string } | undefined;
  const sourceCode = row?.source_code ?? null;
  if (!row || !sourceCode) return null;

  const { compiledCode, compiledCodeHash } = await compileConnectorSource(sourceCode);
  // By primary key, never (connector_key, version): that pair no longer
  // identifies one row — an org-scoped copy may share it with the shared row,
  // and the fresh artifact belongs only to the row whose source produced it.
  // Each row converges independently across replicas (Postgres-mediated),
  // exactly as the single shared row did before org scoping.
  await sql`
    UPDATE connector_versions
    SET compiled_code = ${compiledCode},
        compiled_code_hash = ${compiledCodeHash},
        compile_config_hash = ${COMPILE_CONFIG_HASH}
    WHERE id = ${rowId}
  `;
  logger.info(
    { connector_key: connectorKey, version: row.version, row_id: rowId },
    'Recompiled stale connector artifact (compile configuration changed)'
  );
  return compiledCode;
}

/**
 * Compile the bundled connector for `connectorKey` and upsert its definition for
 * one org from the on-disk registry: the single code→`connector_definitions`
 * write path. `ensureConnectorInstalled` calls it on first install;
 * `refreshConnectorDefinitions` calls it to re-sync an org's existing definition
 * across deploys. Both share THIS body — there is no second writer.
 *
 * Stores `source_path` (not `compiled_code`) so the runtime recompiles from
 * source on demand (`resolveConnectorCode`); the shared upsert preserves
 * org-specific config (`login_enabled`, `default_connection_config`).
 *
 * Returns null when the key has no bundled source on disk (a genuinely
 * user-uploaded connector — nothing to sync from). Throws on
 * compile/extract/validate/write failure; callers decide how to handle it.
 */
export async function upsertBundledConnectorForOrg(params: {
  organizationId: string;
  connectorKey: string;
}): Promise<ConnectorInstallResult | null> {
  const filePath = findBundledConnectorFile(params.connectorKey);
  if (!filePath) return null;

  // Compile to extract metadata (key, name, feeds, auth schema, etc.).
  const compiledCode = await compileConnectorForIsolateFromFile(filePath);
  const metadata = await extractConnectorMetadata(compiledCode);
  validateConnectorMetadata(metadata);

  const sourcePath = bundledConnectorSourcePath(filePath);
  const { updated } = await upsertConnectorDefinitionRecords({
    sql: getDb(),
    organizationId: params.organizationId,
    metadata,
    versionRecord: {
      compiledCode: null,
      compiledCodeHash: null,
      compileConfigHash: null,
      sourceCode: null,
      sourcePath,
    },
    // A source_path pointer at the bundled on-disk catalog — identical for
    // every org, deduped on the shared organization_id-IS-NULL row.
    versionScope: 'shared',
  });
  return {
    connectorKey: metadata.key,
    name: metadata.name,
    version: metadata.version,
    codeHash: computeCodeHash(compiledCode),
    updated,
    authSchema: metadata.authSchema ?? null,
    mcpConfig: metadata.mcpConfig ?? null,
    openapiConfig: metadata.openapiConfig ?? null,
  };
}

export async function ensureConnectorInstalled(params: {
  organizationId: string;
  connectorKey: string;
}): Promise<boolean> {
  const sql = getDb();
  const existing = await sql`
    SELECT 1 FROM connector_definitions
    WHERE key = ${params.connectorKey}
      AND organization_id = ${params.organizationId}
      AND status = 'active'
    LIMIT 1
  `;
  if (existing.length > 0) return true;

  try {
    const installed = await upsertBundledConnectorForOrg(params);
    if (!installed) return false;
    logger.info(
      {
        connector_key: params.connectorKey,
        organization_id: params.organizationId,
      },
      'Auto-installed bundled connector for org (source_path only, no compiled_code)'
    );
    return true;
  } catch (err) {
    logger.error(
      { connector_key: params.connectorKey, err },
      'Failed to auto-install bundled connector'
    );
    return false;
  }
}
