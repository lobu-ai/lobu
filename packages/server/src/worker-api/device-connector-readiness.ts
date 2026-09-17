import type { DbClient } from '../db/client';
import {
  compareSemverish,
  type DeviceConnectorSource,
  getDeviceManifestSourcesForUser,
} from './device-manifests';

/**
 * One derived readiness model for manifest-backed device connectors.
 *
 * Nothing here is persisted. The worker's latest manifest, capabilities and
 * heartbeat remain the only facts; feeds, operations and source reads consume
 * this same projection so a permission change cannot produce three different
 * answers.
 */
export type DeviceConnectorReadinessState =
  | 'ready'
  | 'setup_required'
  | 'device_offline';

export interface DeviceConnectorReadiness {
  state: DeviceConnectorReadinessState;
  source: DeviceConnectorSource;
}

export interface DeviceConnectorReadinessTarget {
  ownerUserId: string | null;
  connectorKey: string;
  /** Exact artifact selected by the operation or feed. */
  connectorVersion: string | null;
  manifestHash?: string | null;
  /** Exact execution pin. Null/absent means any device in the owner's fleet. */
  deviceWorkerId?: string | null;
}

export type DeviceConnectorReadinessIndex = Map<
  string,
  DeviceConnectorReadiness
>;

function readinessKey(
  ownerUserId: string,
  connectorKey: string,
  connectorVersion: string,
  manifestHash?: string | null,
  deviceWorkerId?: string | null
): string {
  return `${ownerUserId}\u0000${connectorKey}\u0000${connectorVersion}\u0000${manifestHash ?? ''}\u0000${deviceWorkerId ?? ''}`;
}

export function classifyDeviceConnectorReadiness(
  source: DeviceConnectorSource,
  deviceWorkerId?: string | null
): DeviceConnectorReadiness {
  if (deviceWorkerId) {
    if (source.onlineAdvertiserDeviceIds.includes(deviceWorkerId)) {
      return { state: 'ready', source };
    }
    if (source.onlineManifestDeviceIds.includes(deviceWorkerId)) {
      return { state: 'setup_required', source };
    }
    return { state: 'device_offline', source };
  }
  if (source.onlineAdvertiserDeviceIds.length > 0) {
    return { state: 'ready', source };
  }
  if (source.onlineManifestDeviceIds.length > 0) {
    return { state: 'setup_required', source };
  }
  return { state: 'device_offline', source };
}

/** Load each owner's manifest inventory once, then index the requested targets. */
export async function loadDeviceConnectorReadiness(params: {
  sql: DbClient;
  targets: readonly DeviceConnectorReadinessTarget[];
}): Promise<DeviceConnectorReadinessIndex> {
  const targets = params.targets.filter(
    (
      target,
    ): target is DeviceConnectorReadinessTarget & {
      ownerUserId: string;
      connectorVersion: string;
    } =>
      typeof target.ownerUserId === 'string' &&
      target.ownerUserId.length > 0 &&
      typeof target.connectorVersion === 'string' &&
      target.connectorVersion.length > 0,
  );
  const ownerUserIds = [
    ...new Set(targets.map((target) => target.ownerUserId)),
  ];
  const sourcesByOwner = await Promise.all(
    ownerUserIds.map(async (ownerUserId) => ({
      ownerUserId,
      sources: await getDeviceManifestSourcesForUser({
        sql: params.sql,
        userId: ownerUserId,
        includeRetainedVersions: true,
      }),
    })),
  );

  const readiness = new Map<string, DeviceConnectorReadiness>();
  for (const { ownerUserId, sources } of sourcesByOwner) {
    for (const source of sources) {
      for (const target of targets) {
        if (
          target.ownerUserId !== ownerUserId ||
          target.connectorKey !== source.key ||
          target.connectorVersion !== source.metadata.version ||
          (target.manifestHash != null && target.manifestHash !== source.manifestHash)
        ) {
          continue;
        }
        const key = readinessKey(
          ownerUserId,
          source.key,
          target.connectorVersion,
          target.manifestHash,
          target.deviceWorkerId
        );
        readiness.set(
          key,
          classifyDeviceConnectorReadiness(source, target.deviceWorkerId)
        );
      }
    }
  }
  return readiness;
}

export function findDeviceConnectorReadiness(
  index: DeviceConnectorReadinessIndex,
  target: DeviceConnectorReadinessTarget,
): DeviceConnectorReadiness | undefined {
  if (!target.ownerUserId || !target.connectorVersion) return undefined;
  return index.get(
    readinessKey(
      target.ownerUserId,
      target.connectorKey,
      target.connectorVersion,
      target.manifestHash,
      target.deviceWorkerId
    )
  );
}

export function describeDeviceConnectorSetupRequired(
  readiness: DeviceConnectorReadiness,
): string {
  return (
    `${readiness.source.metadata.name} is available on an online device, but setup is incomplete: ` +
    `'${readiness.source.requiredCapability}' has not been granted. ` +
    'Open the paired device app, finish setup, then retry.'
  );
}

export const DEVICE_CONNECTOR_MANIFEST_UNAVAILABLE =
  'The selected connector manifest is not available on an eligible device. ' +
  'Update or reconnect your device, then retry.';

/**
 * The connector version a pinned endpoint can actually execute.
 *
 * The org keeps ONE active `connector_definitions` row per key, elected across
 * the whole fleet. A connection pinned to an exact device is a different
 * question: that endpoint executes the contract IT advertises, and every
 * advertised artifact is already retained as its own `connector_versions` row.
 * Resolving the run's version from the fleet-elected definition instead makes a
 * healthy pinned endpoint unrunnable whenever a SIBLING endpoint advertises a
 * different version — the run is created against an artifact the target never
 * claimed, the admission gate finds no readiness for that pair, and the
 * connection goes dark for a reason that has nothing to do with its device.
 *
 * Returns null when this device advertises nothing for the key, so the caller
 * keeps the fleet-elected version and its existing failure mode (offline pin,
 * setup incomplete, connector uninstalled) rather than inventing a version.
 *
 * Also returns null for a version this organization has no manifest-backed
 * `connector_versions` row for. Only an artifact reconcile actually registered
 * is a contract the platform can admit a run against; an endpoint advertising
 * a version nobody registered is the mismatch the admission gate exists to
 * fail closed on, and redirecting the run onto it would dissolve that check
 * rather than satisfy it.
 *
 * Prefers the newest contract the device can execute now (capability granted
 * and online), falling back to the newest it merely advertises so an
 * incomplete-setup endpoint still reports `setup_required` instead of
 * vanishing — the same precedence {@link getDeviceManifestSourcesForUser}
 * applies fleet-wide.
 */
export async function resolvePinnedDeviceConnectorVersion(params: {
  sql: DbClient;
  organizationId: string;
  ownerUserId: string;
  connectorKey: string;
  deviceWorkerId: string;
}): Promise<string | null> {
  const sources = await getDeviceManifestSourcesForUser({
    sql: params.sql,
    userId: params.ownerUserId,
    connectorKey: params.connectorKey,
    includeRetainedVersions: true,
  });
  let executable: DeviceConnectorSource | null = null;
  let advertised: DeviceConnectorSource | null = null;
  for (const source of sources) {
    if (source.key !== params.connectorKey) continue;
    if (source.onlineAdvertiserDeviceIds.includes(params.deviceWorkerId)) {
      if (!executable || compareConnectorVersions(source, executable) > 0) executable = source;
    }
    if (
      source.onlineManifestDeviceIds.includes(params.deviceWorkerId) ||
      source.advertiserDeviceIds.includes(params.deviceWorkerId)
    ) {
      if (!advertised || compareConnectorVersions(source, advertised) > 0) advertised = source;
    }
  }
  const version = (executable ?? advertised)?.metadata.version ?? null;
  if (version == null) return null;
  const registered = await params.sql`
    SELECT 1
    FROM connector_versions cv
    WHERE cv.connector_key = ${params.connectorKey}
      AND cv.version = ${version}
      AND (cv.organization_id = ${params.organizationId} OR cv.organization_id IS NULL)
      AND cv.source_path LIKE 'device-manifest://%'
      AND cv.compiled_code IS NULL
      AND cv.compile_config_hash IS NULL
      AND cv.source_code IS NULL
    LIMIT 1
  `;
  return registered.length > 0 ? version : null;
}

/**
 * Newest-first ordering over two artifacts of the same key: the version
 * precedence `compareManifestWinner` applies fleet-wide, tie-breaking on the
 * manifest hash so two contracts sharing a version resolve deterministically
 * instead of depending on device row order.
 */
function compareConnectorVersions(
  a: DeviceConnectorSource,
  b: DeviceConnectorSource
): number {
  return (
    compareSemverish(a.metadata.version, b.metadata.version) ||
    a.manifestHash.localeCompare(b.manifestHash)
  );
}
