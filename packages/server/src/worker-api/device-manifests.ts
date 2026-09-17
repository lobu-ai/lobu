import { authorizeCapabilities, isKnownPlatform } from '@lobu/core';
import {
  sortDeviceManifestJson,
  type DeviceConnectorManifest,
} from '@lobu/connector-sdk';
import { deviceManifestHash } from '@lobu/connector-sdk/device-manifest-hash';
import type { DbClient } from '../db/client';
import type { ConnectorMetadata } from '../utils/connector-compiler';
import {
  isChromeNamespaceConnectorKey,
} from '../utils/connector-execution-placement';
import { DEVICE_ONLINE_WINDOW_SECONDS } from '../utils/device-liveness';
import logger from '../utils/logger';

const MAX_MANIFESTS_PER_POLL = 32;
const MAX_MANIFEST_BYTES = 256 * 1024;

export type { DeviceConnectorManifest } from '@lobu/connector-sdk';
export { deviceManifestHash };

export interface StoredDeviceManifest {
  manifest_hash: string;
  received_at: string;
  manifest: DeviceConnectorManifest;
}

export interface DeviceConnectorSource {
  key: string;
  requiredCapability: string;
  /** Retained, capable devices advertising the exact manifest selected for this key. */
  advertiserDeviceIds: string[];
  /** Online devices advertising the selected manifest, whether setup is complete or not. */
  onlineManifestDeviceIds: string[];
  /** Online devices advertising the selected manifest and its required capability. */
  onlineAdvertiserDeviceIds: string[];
  feedKeys: string[];
  metadata: ConnectorMetadata;
  sourcePath: string;
  manifestHash: string;
  definitionManifestHash: string;
}

export interface ManifestClaimAuthorization {
  connectorKey: string;
  connectorVersion: string;
  manifestHash: string;
  /** Hash of the canonical definition projected from this artifact. */
  definitionManifestHash?: string;
  /** Exact artifact provenance; present for manifest-backed claims. */
  sourcePath?: string;
}

export interface DeviceManifestClaimAuthorization extends ManifestClaimAuthorization {
  /** The platform recorded on the device that actually advertised this manifest. */
  sourcePath: string;
}

interface DeviceManifestValidationResult {
  manifests: StoredDeviceManifest[];
  accepted: boolean;
}

export function deviceManifestToConnectorMetadata(manifest: DeviceConnectorManifest): ConnectorMetadata {
  return {
    key: manifest.key,
    name: manifest.name,
    description: manifest.description ?? undefined,
    version: manifest.version,
    kind: 'data',
    authSchema: manifest.auth_schema ?? { methods: [{ type: 'none' }] },
    webhook: null,
    feeds: manifestFeedsForMetadata(manifest),
    actions: manifest.actions_schema ?? null,
    automationEvents: null,
    optionsSchema: manifest.options_schema ?? null,
    faviconDomain: manifest.favicon_domain ?? null,
    mcpConfig: null,
    openapiConfig: null,
    requiredCapability: manifest.required_capability,
    runtime: manifest.runtime as ConnectorMetadata['runtime'],
    // Device connectors execute on the paired device. A manifest that declares
    // actions is asserting it implements them there, so support tracks the
    // presence of an actions schema (#2033 item 2). Device-online is a separate
    // readiness axis handled elsewhere.
    supportsExecute: manifest.actions_schema != null,
  };
}

export function manifestFeedKeys(manifest: DeviceConnectorManifest): string[] {
  const feeds = manifest.feeds_schema ?? {};
  return Object.entries(feeds)
    .filter(([, def]) => !(isRecord(def) && def.userManaged === true))
    .map(([key]) => key);
}

export function validateDeviceConnectorManifests(params: {
  platform: string | null;
  capabilities: readonly string[];
  manifests: unknown;
}): DeviceManifestValidationResult {
  return validateDeviceConnectorManifestsInternal(params, false);
}

function validateDeviceConnectorManifestsInternal(
  params: {
    platform: string | null;
    capabilities: readonly string[];
    manifests: unknown;
  },
  allowLegacyMissingOperations: boolean
): DeviceManifestValidationResult {
  const { platform, manifests } = params;
  if (!Array.isArray(manifests)) return { manifests: [], accepted: false };
  if (!platform || !isKnownPlatform(platform)) return { manifests: [], accepted: false };
  if (manifests.length > MAX_MANIFESTS_PER_POLL) {
    logger.warn({ platform, count: manifests.length }, '[device-manifests] too many manifests; dropping payload');
    return { manifests: [], accepted: false };
  }
  const encodedBytes = Buffer.byteLength(JSON.stringify(manifests), 'utf8');
  if (encodedBytes > MAX_MANIFEST_BYTES) {
    logger.warn({ platform, encodedBytes }, '[device-manifests] manifest payload too large; dropping payload');
    return { manifests: [], accepted: false };
  }

  const seen = new Set<string>();
  const valid: StoredDeviceManifest[] = [];
  let accepted = true;
  for (const raw of manifests) {
    try {
      const manifest = normalizeManifest(raw, allowLegacyMissingOperations);
      if (seen.has(manifest.key)) continue;
      seen.add(manifest.key);

      if (!connectorKeyAllowedForPlatform(platform, manifest.key)) {
        throw new Error(`connector key '${manifest.key}' is not allowed for platform '${platform}'`);
      }
      if (!manifest.runtime.platforms.includes(platform)) {
        throw new Error(`runtime.platforms must include '${platform}'`);
      }
      const capAuth = authorizeCapabilities(platform, [manifest.required_capability]);
      if (!capAuth.authorized.includes(manifest.required_capability)) {
        throw new Error(`required_capability '${manifest.required_capability}' is not allowed for '${platform}'`);
      }
      if (manifest.auth_schema && !isNoneAuthSchema(manifest.auth_schema)) {
        throw new Error('device manifests may only declare auth_schema.methods=[{type:"none"}]');
      }
      const computedHash = deviceManifestHash(manifest);
      if (manifest.manifest_hash && manifest.manifest_hash !== computedHash) {
        throw new Error('manifest_hash mismatch');
      }
      manifest.manifest_hash = computedHash;
      valid.push({
        manifest_hash: computedHash,
        received_at: new Date().toISOString(),
        manifest,
      });
    } catch (err) {
      accepted = false;
      logger.warn(
        { platform, err: err instanceof Error ? err.message : String(err) },
        '[device-manifests] dropped invalid manifest'
      );
    }
  }
  return { manifests: valid, accepted };
}

export async function getDeviceManifestSourcesForUser(params: {
  sql: DbClient;
  userId: string;
  connectorKey?: string;
  /** Include every retained exact artifact instead of only one winner per key. */
  includeRetainedVersions?: boolean;
}): Promise<DeviceConnectorSource[]> {
  const rows = (await params.sql`
    SELECT id, platform, capabilities, connector_manifests,
           last_seen_at > now() - make_interval(secs => ${DEVICE_ONLINE_WINDOW_SECONDS}) AS online
    FROM device_workers
    WHERE user_id = ${params.userId}
      AND last_seen_at > now() - '7 days'::interval
      AND (
        ${params.connectorKey == null}
        OR connector_manifests ? ${params.connectorKey ?? ''}
      )
  `) as unknown as Array<{
    id: string;
    platform: string | null;
    capabilities: unknown;
    connector_manifests: unknown;
    online: boolean;
  }>;

  type ManifestCandidate = {
    stored: StoredDeviceManifest;
    deviceId: string;
    platform: string | null;
    online: boolean;
  };
  const candidates: ManifestCandidate[] = [];
  const liveCapabilities = new Map<string, Set<string>>();
  for (const row of rows) {
    liveCapabilities.set(
      row.id,
      new Set(Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [])
    );
    const map = isRecord(row.connector_manifests) ? row.connector_manifests : {};
    for (const value of Object.values(map)) {
      const stored = parseStoredManifest(value);
      if (!stored) continue;
      candidates.push({ stored, deviceId: row.id, platform: row.platform, online: row.online });
    }
  }

  // Prefer the newest manifest that at least one online device can execute.
  // A newer inventory-only manifest represents incomplete setup; it must not
  // shadow an older capable advertiser and pause a working feed. When no
  // capable version exists, keep the newest inventory manifest so readiness
  // can still surface setup_required instead of making the connector vanish.
  const retainedManifests = new Map<string, StoredDeviceManifest>();
  const inventoryWinners = new Map<string, StoredDeviceManifest>();
  const capableWinners = new Map<string, StoredDeviceManifest>();
  for (const candidate of candidates) {
    const { stored } = candidate;
    retainedManifests.set(
      `${stored.manifest.key}\u0000${stored.manifest.version}\u0000${stored.manifest_hash}`,
      stored
    );
    const inventoryWinner = inventoryWinners.get(stored.manifest.key);
    if (!inventoryWinner || compareManifestWinner(stored, inventoryWinner) > 0) {
      inventoryWinners.set(stored.manifest.key, stored);
    }
    if (
      candidate.online &&
      liveCapabilities.get(candidate.deviceId)?.has(stored.manifest.required_capability) === true
    ) {
      const capableWinner = capableWinners.get(stored.manifest.key);
      if (!capableWinner || compareManifestWinner(stored, capableWinner) > 0) {
        capableWinners.set(stored.manifest.key, stored);
      }
    }
  }
  const winners = new Map(inventoryWinners);
  for (const [key, winner] of capableWinners) winners.set(key, winner);
  const selectedManifests = [
    ...(params.includeRetainedVersions ? retainedManifests : winners).values(),
  ].sort(
    (a, b) =>
      a.manifest.key.localeCompare(b.manifest.key) || compareManifestWinner(a, b)
  );

  return selectedManifests.flatMap((stored) => {
    const exactCandidates = candidates.filter(
      (candidate) =>
        candidate.stored.manifest.key === stored.manifest.key &&
        candidate.stored.manifest.version === stored.manifest.version &&
        candidate.stored.manifest_hash === stored.manifest_hash
    );
    const advertiserCandidates = exactCandidates.filter(
      (candidate) =>
        liveCapabilities.get(candidate.deviceId)?.has(stored.manifest.required_capability) === true
    );
    const onlineManifestCandidates = exactCandidates.filter((candidate) => candidate.online);
    const onlineAdvertiserCandidates = advertiserCandidates.filter((candidate) => candidate.online);
    // Provenance must describe the platform that actually validated and
    // advertised this manifest. `runtime.platforms` is a compatibility set, not
    // an ordered ownership declaration; using element zero can misroute a valid
    // Chrome manifest whose Chrome entry appears later in the array. Prefer a
    // currently capable advertiser, then fall back to an exact stored advertiser
    // so inventory remains stable while a permission is temporarily revoked.
    const sourceCandidate = (
      advertiserCandidates.length > 0 ? advertiserCandidates : exactCandidates
    )
      .filter(
        (candidate): candidate is ManifestCandidate & { platform: string } =>
          typeof candidate.platform === 'string' &&
          stored.manifest.runtime.platforms.includes(candidate.platform)
      )
      .sort(
        (a, b) => a.platform.localeCompare(b.platform) || a.deviceId.localeCompare(b.deviceId)
      )[0];
    if (!sourceCandidate) {
      logger.warn(
        { connectorKey: stored.manifest.key, connectorVersion: stored.manifest.version },
        '[device-manifests] exact manifest has no valid advertising platform'
      );
      return [];
    }

    return [
      {
        key: stored.manifest.key,
        requiredCapability: stored.manifest.required_capability,
        advertiserDeviceIds: advertiserCandidates
          .map((candidate) => candidate.deviceId)
          .sort(),
        onlineManifestDeviceIds: onlineManifestCandidates
          .map((candidate) => candidate.deviceId)
          .sort(),
        onlineAdvertiserDeviceIds: onlineAdvertiserCandidates
          .map((candidate) => candidate.deviceId)
          .sort(),
        feedKeys: manifestFeedKeys(stored.manifest),
        metadata: deviceManifestToConnectorMetadata(stored.manifest),
        sourcePath: `device-manifest://${sourceCandidate.platform}/${stored.manifest.key}@${stored.manifest.version}`,
        manifestHash: stored.manifest_hash,
        definitionManifestHash: projectedDefinitionManifestHash(stored.manifest),
      },
    ];
  });
}

/**
 * Return every validated manifest identity advertised by one exact device.
 * This deliberately does not apply winner selection: a device may retain a
 * historical version while another device advertises the current winner.
 */
export async function getDeviceManifestClaimAuthorizationsForDevice(params: {
  sql: DbClient;
  userId: string;
  deviceId: string;
}): Promise<DeviceManifestClaimAuthorization[]> {
  const rows = (await params.sql`
    SELECT platform, capabilities, connector_manifests
    FROM device_workers
    WHERE id = ${params.deviceId}::uuid
      AND user_id = ${params.userId}
      AND last_seen_at > now() - '7 days'::interval
    LIMIT 1
  `) as unknown as Array<{
    platform: string | null;
    capabilities: unknown;
    connector_manifests: unknown;
  }>;
  const row = rows[0];
  if (!row || !row.platform || !isKnownPlatform(row.platform)) return [];

  const capabilities = Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [];
  const map = isRecord(row.connector_manifests) ? row.connector_manifests : {};
  const authorizations = new Map<string, DeviceManifestClaimAuthorization>();
  for (const value of Object.values(map)) {
    const stored = parseStoredManifest(value);
    if (!stored || !capabilities.includes(stored.manifest.required_capability)) continue;

    // Revalidate the persisted payload before using it as claim authority. The
    // row may predate manifest hashes, and connector_manifests is durable input
    // rather than an authorization primitive by itself.
    const validation = validateDeviceConnectorManifestsInternal(
      {
        platform: row.platform,
        capabilities,
        manifests: [stored.manifest],
      },
      // Legacy feed schemas without `operations` stay acceptable here (#3132):
      // this path revalidates an ALREADY-STORED manifest, and a device that
      // registered before operations existed must keep its claim authorization.
      // A field a device could not have known to send when it registered is
      // never a reason to revoke its claim.
      true
    );
    const validated = validation.manifests[0];
    if (!validation.accepted || !validated || validated.manifest_hash !== stored.manifest_hash) {
      continue;
    }

    const authorization: DeviceManifestClaimAuthorization = {
      connectorKey: validated.manifest.key,
      connectorVersion: validated.manifest.version,
      manifestHash: validated.manifest_hash,
      definitionManifestHash: projectedDefinitionManifestHash(validated.manifest),
      sourcePath: `device-manifest://${row.platform}/${validated.manifest.key}@${validated.manifest.version}`,
    };
    authorizations.set(
      `${authorization.connectorKey}\u0000${authorization.connectorVersion}\u0000${authorization.manifestHash}`,
      authorization
    );
  }
  return [...authorizations.values()];
}

/**
 * Lazily attest pre-hash manifest artifacts only from a validated manifest
 * currently advertised by the authorized device. Shared hashless artifacts
 * are intentionally not mutated: an org-scoped exact row must exist before a
 * retained artifact can become claimable.
 */
export async function attestDeviceManifestArtifacts(params: {
  sql: DbClient;
  organizationId: string;
  authorizations: DeviceManifestClaimAuthorization[];
}): Promise<void> {
  for (const authorization of params.authorizations) {
    await params.sql`
      UPDATE connector_versions
      SET compiled_code_hash = ${authorization.manifestHash}
      WHERE organization_id = ${params.organizationId}
        AND connector_key = ${authorization.connectorKey}
        AND version = ${authorization.connectorVersion}
        AND compiled_code_hash IS NULL
        AND compiled_code IS NULL
        AND compile_config_hash IS NULL
        AND source_code IS NULL
        AND source_path = ${authorization.sourcePath}
    `;
  }
}

export function storedManifestMap(valid: StoredDeviceManifest[]): Record<string, StoredDeviceManifest> {
  return Object.fromEntries(valid.map((entry) => [entry.manifest.key, entry]));
}

function normalizeManifest(raw: unknown, allowLegacyMissingOperations = false): DeviceConnectorManifest {
  if (!isRecord(raw)) throw new Error('manifest must be an object');
  const key = stringField(raw, 'key');
  const version = stringField(raw, 'version');
  const name = stringField(raw, 'name');
  const requiredCapability = stringField(raw, 'required_capability');
  const runtime = raw.runtime;
  if (!isRecord(runtime) || !Array.isArray(runtime.platforms)) {
    throw new Error('runtime.platforms is required');
  }
  const platforms = runtime.platforms.filter((v): v is string => typeof v === 'string');
  if (platforms.length === 0) throw new Error('runtime.platforms cannot be empty');
  const feedsSchema = optionalRecord(raw, 'feeds_schema') ?? {};
  validateFeedOperations(feedsSchema, allowLegacyMissingOperations);
  rejectRemovedEntityLinks(feedsSchema);
  const actionsSchema = optionalRecord(raw, 'actions_schema');
  rejectReservedActionKeys(actionsSchema);
  return {
    key,
    version,
    name,
    description: optionalStringField(raw, 'description'),
    favicon_domain: optionalStringField(raw, 'favicon_domain'),
    required_capability: requiredCapability,
    runtime: {
      ...runtime,
      platforms,
    } as DeviceConnectorManifest['runtime'],
    auth_schema: optionalRecord(raw, 'auth_schema'),
    feeds_schema: feedsSchema,
    actions_schema: actionsSchema,
    options_schema: optionalRecord(raw, 'options_schema'),
    manifest_hash: optionalStringField(raw, 'manifest_hash'),
  };
}

function validateFeedOperations(
  feedsSchema: Record<string, unknown>,
  allowLegacyMissingOperations: boolean
): void {
  for (const [feedKey, feedDefinition] of Object.entries(feedsSchema)) {
    if (!isRecord(feedDefinition)) throw new Error(`feeds_schema.${feedKey} must be an object`);
    const operations = feedDefinition.operations;
    // Manifests persisted before feed operations became required carried the
    // capability in `virtual` instead. Keep their original JSON shape so the
    // artifact hash stays valid — `manifestFeedsForMetadata` projects them onto
    // operations. New poll payloads still use the strict public validator.
    if (operations === undefined && allowLegacyMissingOperations) continue;
    if (
      !Array.isArray(operations) ||
      operations.length === 0 ||
      !operations.every((operation) => operation === 'sync' || operation === 'read') ||
      new Set(operations).size !== operations.length
    ) {
      throw new Error(`feeds_schema.${feedKey}.operations must contain unique sync/read values`);
    }
  }
}

/**
 * Namespace the gateway reserves for its own device-protocol action keys (e.g.
 * a source read). A manifest may not claim one: the server
 * dispatches these keys itself, so a connector declaring the same string would
 * shadow a protocol seam with a public operation.
 */
export const RESERVED_ACTION_KEY_PREFIX = '__lobu_';

function rejectReservedActionKeys(actionsSchema: Record<string, unknown> | null): void {
  if (!actionsSchema) return;
  for (const actionKey of Object.keys(actionsSchema)) {
    if (actionKey.startsWith(RESERVED_ACTION_KEY_PREFIX)) {
      throw new Error(
        `actions_schema key '${actionKey}' uses the reserved '${RESERVED_ACTION_KEY_PREFIX}' prefix`
      );
    }
  }
}

function rejectRemovedEntityLinks(feedsSchema: Record<string, unknown>): void {
  for (const [feedKey, feedDefinition] of Object.entries(feedsSchema)) {
    if (!isRecord(feedDefinition) || !isRecord(feedDefinition.eventKinds)) continue;
    for (const [eventKind, eventDefinition] of Object.entries(feedDefinition.eventKinds)) {
      if (isRecord(eventDefinition) && Object.hasOwn(eventDefinition, 'entityLinks')) {
        throw new Error(
          `feeds_schema.${feedKey}.eventKinds.${eventKind}.entityLinks was removed; use attributions`
        );
      }
    }
  }
}

function parseStoredManifest(raw: unknown): StoredDeviceManifest | null {
  if (!isRecord(raw) || !isRecord(raw.manifest)) return null;
  if (typeof raw.manifest_hash !== 'string' || typeof raw.received_at !== 'string') return null;
  try {
    const manifest = normalizeManifest(raw.manifest, true);
    if (deviceManifestHash(manifest) !== raw.manifest_hash) return null;
    manifest.manifest_hash = raw.manifest_hash;
    return { manifest_hash: raw.manifest_hash, received_at: raw.received_at, manifest };
  } catch {
    return null;
  }
}

function manifestFeedsForMetadata(manifest: DeviceConnectorManifest): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(manifest.feeds_schema ?? {}).map(([feedKey, feedDefinition]) => {
      if (isRecord(feedDefinition) && feedDefinition.operations === undefined) {
        return [
          feedKey,
          {
            ...feedDefinition,
            operations: feedDefinition.virtual === true ? ['read'] : ['sync'],
          },
        ];
      }
      return [feedKey, feedDefinition];
    })
  );
}

function projectedDefinitionManifestHash(manifest: DeviceConnectorManifest): string {
  return deviceManifestHash({
    ...manifest,
    feeds_schema: manifestFeedsForMetadata(manifest),
  });
}

function compareManifestWinner(a: StoredDeviceManifest, b: StoredDeviceManifest): number {
  const versionCmp = compareSemverish(a.manifest.version, b.manifest.version);
  if (versionCmp !== 0) return versionCmp;
  return a.manifest_hash.localeCompare(b.manifest_hash);
}

/**
 * Newest-first ordering over two connector version strings. Shared with the
 * pinned-device artifact selection in `device-connector-readiness.ts` so a
 * device's "newest advertised contract" is the same order the fleet winner uses.
 */
export function compareSemverish(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((p) => Number.parseInt(p, 10));
  const pb = b.split(/[.-]/).map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = Number.isFinite(pa[i]) ? pa[i]! : 0;
    const db = Number.isFinite(pb[i]) ? pb[i]! : 0;
    if (da !== db) return da - db;
  }
  return a.localeCompare(b);
}

// Device-connector keys the platform's bridge is allowed to register. A key
// outside this list rejects the WHOLE poll payload (see `accepted` above), so a
// new on-device connector must land here in the same change that ships its
// manifest — `os.shell` is the Mac shell connector (owletto#669), whose
// `os.shell` capability is already allowlisted in `@lobu/core`.
function connectorKeyAllowedForPlatform(platform: string, key: string): boolean {
  if (platform === 'macos') {
    return (
      key.startsWith('apple.') ||
      key === 'local.directory' ||
      key === 'os.shell'
    );
  }
  if (platform === 'chrome-extension') {
    // The reserved namespace is the whole allowlist: the extension implements
    // these itself and ships no bundle for them. A connector that needs its own
    // code is an ordinary key that the extension never sees — it drives the page
    // through the generic browser ops instead.
    return isChromeNamespaceConnectorKey(key);
  }
  // Headless devices (servers/VMs/pods) serve the shell connector: `os.shell`
  // executes `bash --noprofile --norc -c` and returns structured output.
  // Keep this list tight - nothing browser/OS-UI based.
  if (platform === 'headless') {
    return key === 'os.shell';
  }
  return false;
}

function isNoneAuthSchema(value: Record<string, unknown>): boolean {
  const methods = value.methods;
  return Array.isArray(methods) && methods.every((m) => isRecord(m) && m.type === 'none');
}

// Exported for callers needing the same canonical form the manifest hash uses
// (device-reconcile compares stored vs incoming definition metadata with it).
export const sortJson = sortDeviceManifestJson;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string {
  const v = value[key];
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${key} is required`);
  return v.trim();
}

function optionalStringField(value: Record<string, unknown>, key: string): string | null {
  const v = value[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function optionalRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const v = value[key];
  return isRecord(v) ? v : null;
}
