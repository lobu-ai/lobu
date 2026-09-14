import { parseJsonObject } from '@lobu/core';

/** Reserved connection-config key written only by an explicit user delete. */
export const DEVICE_AUTOWIRE_SUPPRESSION_KEY =
	'__lobu_device_autowire_suppressed';

export const DEVICE_AUTOWIRE_SUPPRESSION_ERROR =
	'The device auto-wire suppression marker is reserved for connection deletion.';

/**
 * SQL fragment (no bound parameters) that resolves TRUE when the
 * `connector_definitions` row aliased `cd` selects a DEVICE artifact: an
 * org-scoped `device-manifest://` row (whatever bytes it may still be carrying
 * — those are stale, and a manifest write scrubs them), or a shared catalog
 * pointer that carries no compiled or source bytes of its own.
 *
 * {@link IS_DEVICE_CONNECTOR_SQL} and both `archiveVanishedDeviceConnectorDefinitions`
 * passes (`worker-api/device-reconcile.ts`) share this one definition, so the
 * three cannot drift: a device-manifest write REPLACES the whole artifact
 * family rather than merging into it (`replaceVersionArtifact` in
 * `utils/connector-definition-install.ts`), so a path that misjudges the shape
 * silently discards bytes an org installed with its own code.
 */
export const DEVICE_CONNECTOR_ARTIFACT_SQL = /* sql */ `COALESCE((
  SELECT CASE
    WHEN cv.organization_id IS NOT NULL
      THEN cv.source_path LIKE 'device-manifest://%'
    ELSE cv.source_path IS NOT NULL
      AND cv.compiled_code IS NULL
      AND cv.source_code IS NULL
  END
  FROM connector_versions cv
  WHERE cv.connector_key = cd.key
    AND cv.version = cd.version
    AND (cv.organization_id = cd.organization_id OR cv.organization_id IS NULL)
  ORDER BY cv.organization_id NULLS LAST
  LIMIT 1
), false)`;

/**
 * SQL fragment (no bound parameters) that resolves TRUE when the
 * `connector_definitions` row aliased `cd` selects an artifact the ORG installed
 * with its own code — the inverse ownership question to
 * {@link DEVICE_CONNECTOR_ARTIFACT_SQL}, and the one an UNATTENDED writer has to
 * ask before it acts.
 *
 * The split matters. `upsertConnectorDefinitionRecords` owns INTEGRITY — a write
 * that crosses the manifest boundary replaces every provenance field atomically,
 * in both directions, so a manifest hash can never attest compiled bytes. It
 * deliberately does NOT own AUTHORIZATION: it cannot tell a human installing a
 * device manifest from a device poll wandering in, and it has legitimate
 * manifest callers either way. So a caller that writes on nobody's behalf —
 * device reconciliation's wire path — gates itself with this.
 *
 * {@link IS_DEVICE_CONNECTOR_SQL} is NOT the negation of this: it is strictly
 * narrower (it also demands a `required_capability`), which is why the
 * pinned-org refresh can use it to SELECT repair candidates while the wire path
 * cannot — the wire path must still admit a first install, where the org has no
 * definition at all.
 *
 * Ownership is read off the org-scoped row: a `source_path` that is not a
 * `device-manifest://` identity, or — when the row has no path at all — the
 * presence of bytes. Both halves are load-bearing.
 * `resolveConnectorInstallSource` only derives a path from `source_uri` /
 * `source_url`, so the commonest custom install (pasted `source_code`) lands
 * bytes with `source_path` NULL and a path-only test would write straight over
 * them. Conversely bytes on a `device-manifest://` row are stale and scrubbing
 * them back is the integrity rule above, so that row is NOT org-installed. An
 * empty marker row (the rollback-preserve shape) and a shared bundled pointer
 * are likewise not org-installed code, and refusing them would freeze a
 * definition with no self-service repair.
 */
export const ORG_INSTALLED_CONNECTOR_ARTIFACT_SQL = /* sql */ `COALESCE((
  SELECT cv.organization_id IS NOT NULL
    AND (cv.source_path IS NULL OR cv.source_path NOT LIKE 'device-manifest://%')
    AND (cv.source_path IS NOT NULL
         OR cv.compiled_code IS NOT NULL
         OR cv.source_code IS NOT NULL)
  FROM connector_versions cv
  WHERE cv.connector_key = cd.key
    AND cv.version = cd.version
    AND (cv.organization_id = cd.organization_id OR cv.organization_id IS NULL)
  ORDER BY cv.organization_id NULLS LAST
  LIMIT 1
), false)`;

/**
 * SQL fragment (no bound parameters) that resolves TRUE when the `connections`
 * row aliased `c` belongs to an active device-connector definition: the
 * definition declares a `required_capability` and selects a device artifact
 * ({@link DEVICE_CONNECTOR_ARTIFACT_SQL}).
 */
export const IS_DEVICE_CONNECTOR_SQL = /* sql */ `COALESCE((
  SELECT cd.required_capability IS NOT NULL
    AND ${DEVICE_CONNECTOR_ARTIFACT_SQL}
  FROM connector_definitions cd
  WHERE cd.organization_id = c.organization_id
    AND cd.key = c.connector_key
    AND cd.status = 'active'
  LIMIT 1
), false)`;

export type DeviceAutowireIdentityRow = {
	auth_profile_id: number | string | null;
	app_auth_profile_id: number | string | null;
	/** Owner of the personal org this connection lives in, or null for a shared org. */
	autowire_user_id: string | null;
	is_device_connector: boolean;
};

/**
 * True when the row is exactly what `ensureDeviceConnectorWired` auto-creates:
 * a credential-free connection to an active device connector inside its owner's
 * personal org. A device pin is deliberately NOT required — multi-device
 * auto-wiring leaves the connection unpinned.
 */
export function isDeviceAutowireIdentity(
	row: DeviceAutowireIdentityRow,
): row is DeviceAutowireIdentityRow & { autowire_user_id: string } {
	return (
		row.auth_profile_id == null &&
		row.app_auth_profile_id == null &&
		row.autowire_user_id != null &&
		row.is_device_connector
	);
}

/** The marker patch a delete merges into the tombstoned row's config. */
export const DEVICE_AUTOWIRE_SUPPRESSION_PATCH: Record<string, unknown> = {
	[DEVICE_AUTOWIRE_SUPPRESSION_KEY]: true,
};

export function hasDeviceAutowireSuppressionMarker(config: unknown): boolean {
	return Object.hasOwn(
		parseJsonObject(config),
		DEVICE_AUTOWIRE_SUPPRESSION_KEY,
	);
}
