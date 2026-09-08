interface SqlTag<TFragment> {
  (strings: TemplateStringsArray, ...values: any[]): TFragment;
}

/**
 * `chrome` and `chrome.*` are the reserved namespace for connectors the Chrome
 * extension implements natively. Everything about placement follows from this
 * one predicate.
 *
 * The namespace is a two-way contract, and both halves are guarded:
 *   - a `chrome.*` key ships NO code — the gateway withholds the bundle,
 *     because the extension already has the implementation;
 *   - anything else ships its own code and the extension never sees the key
 *     (lobu-ai/owletto apps/chrome/connector-ownership.test.js).
 *
 * `whatsapp.local` used to be the one exception: an ordinary key that the
 * extension nonetheless implemented natively, which needed a legacy-key list
 * here plus an artifact-provenance check to tell that native build apart from a
 * compiled override. It has been retired — WhatsApp is now an ordinary
 * connector that ships its own code and drives the page through the generic
 * browser ops — so the exception, the list, and the provenance check are gone.
 */
export function isChromeNamespaceConnectorKey(connectorKey: string): boolean {
  return connectorKey === 'chrome' || connectorKey.startsWith('chrome.');
}

/**
 * A Chrome pin on any other connector delegates browser access to the
 * extension; it does not host the parent run.
 */
export function isDelegatedBrowserAffinityConnector(
  platform: string | null | undefined,
  connectorKey: string
): boolean {
  return platform === 'chrome-extension' && !isChromeNamespaceConnectorKey(connectorKey);
}

const DEVICE_MANIFEST_SOURCE_PREFIX = 'device-manifest://chrome-extension/';

/**
 * The reserved `chrome.*` namespace declares "the Owletto extension implements
 * this natively", so {@link isChromeNamespaceConnectorKey} alone decides native
 * execution. A key installed there with supplied code is therefore unreachable in
 * both directions: the gateway withholds `compiled_code` from a native
 * connector, and the extension has no handler for a key it does not implement,
 * so every run dies with
 *
 *   Owletto for Chrome: unknown dispatch (connector='chrome.whatsapp', ...)
 *
 * Reject it at install instead of at first run. A connector that needs its own
 * code delivered belongs on an ordinary key with a `chrome-extension` platform
 * pin, which routes it through {@link isDelegatedBrowserAffinityConnector}.
 *
 * The admit test is EXACT identity, not a prefix, and it independently requires
 * that no code was supplied. `resolveConnectorInstallSource` derives a
 * `source_url` install's path as `url.pathname.replace(/^\//, '')`, so a URL
 * whose pathname is `/device-manifest://chrome-extension/chrome.x` yields a
 * sourcePath that satisfies any prefix test — while the same install compiles
 * the caller's own source. Requiring the exact `<prefix><key>@<version>` form
 * closes that, and the code check makes
 * the guard state the real invariant rather than a proxy for it: a device
 * manifest carries an identity, never a payload.
 */
export function assertChromeNamespaceInstallIsDeviceManifest(facts: {
  connectorKey: string;
  connectorVersion: string;
  sourcePath: string | null | undefined;
  compiledCode?: string | null;
  sourceCode?: string | null;
}): void {
  if (!isChromeNamespaceConnectorKey(facts.connectorKey)) return;
  const carriesCode =
    (facts.compiledCode?.length ?? 0) > 0 || (facts.sourceCode?.length ?? 0) > 0;
  const isDeviceManifestIdentity =
    facts.sourcePath ===
    `${DEVICE_MANIFEST_SOURCE_PREFIX}${facts.connectorKey}@${facts.connectorVersion}`;
  if (isDeviceManifestIdentity && !carriesCode) return;
  throw new Error(
    `Connector key '${facts.connectorKey}' is in the reserved 'chrome.*' namespace, which is ` +
      'only installable from an Owletto device manifest. A connector that ships its own code ' +
      'cannot live there: the gateway withholds the bundle from a native connector and the ' +
      'extension cannot dispatch a key it does not implement. Use a key outside the namespace ' +
      'and pin the connection to a chrome-extension device for browser access.'
  );
}

/** SQL equivalent of {@link isChromeNamespaceConnectorKey}. */
export function chromeNamespaceConnectorSql<TFragment>(
  sql: SqlTag<TFragment>,
  refs: { connectorKey: TFragment }
): TFragment {
  return sql`
    (
      ${refs.connectorKey} = 'chrome'
      OR ${refs.connectorKey} LIKE 'chrome.%'
    )
  `;
}

/** SQL equivalent of {@link isDelegatedBrowserAffinityConnector}. */
export function delegatedBrowserAffinitySql<TFragment>(
  sql: SqlTag<TFragment>,
  refs: { platform: TFragment; connectorKey: TFragment }
): TFragment {
  return sql`
    ${refs.platform} = 'chrome-extension'
    AND NOT (${chromeNamespaceConnectorSql(sql, refs)})
  `;
}

/**
 * Resolve the selected artifact for an exact connector version. The
 * org-scoped artifact wins over the shared artifact,
 * matching connector execution resolution. The two partial unique indexes on
 * connector_versions bound this lookup to at most those two candidates.
 */
export function selectedConnectorVersionArtifactSql<TFragment>(
  sql: SqlTag<TFragment>,
  refs: { connectorKey: TFragment; version: TFragment; organizationId: TFragment }
): TFragment {
  return sql`
    SELECT
      cv.id AS artifact_row_id,
      cv.organization_id AS artifact_organization_id,
      COUNT(*) OVER ()::int AS artifact_row_count,
      (
        cv.source_path LIKE 'device-manifest://%'
        AND cv.compiled_code IS NULL
        AND cv.compile_config_hash IS NULL
        AND cv.source_code IS NULL
      ) AS manifest_backed,
      cv.compiled_code_hash AS artifact_hash,
      cv.source_path AS artifact_source_path,
      cv.compiled_code AS artifact_compiled_code,
      cv.compile_config_hash AS artifact_compile_config_hash,
      (cv.source_code IS NOT NULL) AS artifact_has_source_code
    FROM connector_versions cv
    WHERE cv.connector_key = ${refs.connectorKey}
      AND cv.version = ${refs.version}
      AND (
        cv.organization_id = ${refs.organizationId}
        OR cv.organization_id IS NULL
      )
    ORDER BY cv.organization_id NULLS LAST
    LIMIT 1
  `;
}

/** Hashless native artifacts defer final authorization to the capability claim lane. */
export function hashlessManifestArtifactMayBeClaimed(
  connectorKey: string,
  runtime: { platforms?: unknown; execution?: unknown } | null | undefined
): boolean {
  if (isChromeNamespaceConnectorKey(connectorKey) || runtime?.execution === 'bridge') return false;
  return Array.isArray(runtime?.platforms) && runtime.platforms.some(
    (platform) => typeof platform === 'string' && platform !== 'headless' && platform !== 'chrome-extension'
  );
}
