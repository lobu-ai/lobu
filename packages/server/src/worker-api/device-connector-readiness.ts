import type { DbClient } from '../db/client';
import { pinnedDeviceConnectorContractSql } from '../utils/connector-execution-placement';
import {
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
    `the device is not reporting the '${readiness.source.requiredCapability}' permission. ` +
    "Grant it in the paired device app's Permissions settings (on a Mac, Lobu's Settings → Permissions). " +
    'Some operating-system permissions only take effect after the app is quit and reopened. Then retry.'
  );
}

export const DEVICE_CONNECTOR_MANIFEST_UNAVAILABLE =
  'The selected connector manifest is not available on an eligible device. ' +
  'Update or reconnect your device, then retry.';

/**
 * Use the same registered artifact as preflight, then verify it against the
 * owner's validated inventory. Missing, stale or mismatched inventory returns
 * null so callers retain their ordinary selection and admission diagnostics.
 */
export async function resolvePinnedDeviceConnectorVersion(params: {
  sql: DbClient;
  organizationId: string;
  ownerUserId: string;
  connectorKey: string;
  deviceWorkerId: string;
}): Promise<string | null> {
  const [selected] = await params.sql.unsafe(pinnedDeviceConnectorContractSql({
    connectorKey: '$1::text',
    organizationId: '$2::text',
    deviceWorkerId: '$3::uuid',
    defaultVersion: 'NULL::text',
  }), [params.connectorKey, params.organizationId, params.deviceWorkerId]);
  if (!selected?.version) return null;
  const sources = await getDeviceManifestSourcesForUser({
    sql: params.sql,
    userId: params.ownerUserId,
    connectorKey: params.connectorKey,
    includeRetainedVersions: true,
  });
  const advertised = sources.some((source) =>
    source.metadata.version === selected.version &&
    (source.onlineManifestDeviceIds.includes(params.deviceWorkerId) ||
      source.advertiserDeviceIds.includes(params.deviceWorkerId))
  );
  return advertised ? selected.version : null;
}
