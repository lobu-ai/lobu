import { EXECUTION_BACKENDS } from '@lobu/core/contracts/worker/protocol';
import type { DbClient } from '../db/client';
import { pgTextArray } from '../db/client';
import { isCloudMode } from '../utils/cloud-mode';
import {
  delegatedBrowserAffinitySql,
  chromeNamespaceConnectorSql,
} from '../utils/connector-execution-placement';
import type { ManifestClaimAuthorization } from './device-manifests';

type SqlFragment = ReturnType<DbClient>;

/**
 * Connectors that open a raw tenant-supplied DB socket and depend on the worker
 * folding in the gateway's authoritative `db_egress_policy`. In cloud mode a
 * FLEET worker may CLAIM one of these runs only if it advertises the
 * `db_egress_hardening` capability, which closes the rolling-deploy gap where a
 * new gateway hands a claimed run to an old worker that would reopen
 * private-IP or plaintext egress. Self-hosted is unaffected.
 *
 * Lives here, next to its only consumer, rather than in a gate module: it is a
 * claim-eligibility rule, not an admission decision.
 */
export const DB_EGRESS_HARDENED_CONNECTOR_KEYS: ReadonlySet<string> = new Set([
  'postgres',
]);

export interface ConnectorClaimContext {
  isUserScopedWorker: boolean;
  deviceWorkerId: string | null;
  workerPlatform: string | null;
  authorizedCapabilities: string[];
  capabilityMatchSet: string[];
  /** Successfully reconciled winning manifest identities advertised by this exact device. */
  manifestClaimAuthorizations: ManifestClaimAuthorization[];
  /** Legacy clients without connector_manifests may claim only hashless, platform-matching artifacts. */
  allowLegacyManifestCapabilityClaims: boolean;
  orgScopeIds: string[];
  baseOrgScopeIds: string[];
  workerHardensDbEgress: boolean;
  /**
   * Capacity advertised for each execution backend by this worker. Required:
   * an omitted map reads as zero capacity for every backend, so the worker
   * claims nothing at all and nothing anywhere reports why.
   */
  backendCapacity: Record<string, number>;
}

/** A backend is claimable only when this poll explicitly advertises capacity. */
function hasPositiveBackendCapacity(
  capacity: Record<string, number>,
  backend: string
): boolean {
  const value = capacity[backend];
  return typeof value === 'number' && value > 0;
}

interface ConnectorClaimLaneRefs {
  connectorKey: SqlFragment;
  connectorVersion: SqlFragment;
  organizationId: SqlFragment;
  activationKind: SqlFragment;
  activatedAt: SqlFragment;
  connectionDeviceWorkerId: SqlFragment;
  runTargetDeviceWorkerId?: SqlFragment;
  pinPlatform: SqlFragment;
  runRequiredCapability: SqlFragment;
  runManifestBacked: SqlFragment;
  runManifestHash: SqlFragment;
  runRuntime: SqlFragment;
}

/**
 * Shared connector-run claim predicate. worker-api/poll.ts uses it to claim
 * queued connector work; check-due-feeds.ts applies the same predicate to a
 * prospective scheduled sync before creating its run. Keep every fleet,
 * capability, device-pin, browser-affinity, and DB-egress decision here so a
 * scheduler-admitted sync is claimable by the poller that materialized it.
 */
export function connectorClaimLaneSql(
  sql: DbClient,
  context: ConnectorClaimContext,
  refs: ConnectorClaimLaneRefs
): SqlFragment {
  const dbEgressHardenedKeys = pgTextArray([...DB_EGRESS_HARDENED_CONNECTOR_KEYS]);
  const pageActivated = sql`
    ${refs.activationKind} = 'page_visit'
    AND ${refs.activatedAt} IS NOT NULL
  `;
  // A device is authorized for the exact CONTRACT it advertises: key, version
  // and manifest hash. The hash covers every declared field, so matching it
  // means this endpoint declares precisely the artifact the run selected.
  //
  // Artifact provenance (`source_path`) deliberately is NOT compared. It
  // records which platform's poll first registered the definition, and a
  // contract shared by two endpoints is registered by whichever one polled
  // first — comparing it would authorize that endpoint and silently deny the
  // other, which is the whole failure this consolidation removes.
  const exactManifestAuthorization = sql`
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        ${sql.json(context.manifestClaimAuthorizations)}::jsonb
      ) auth_item
      WHERE auth_item->>'connectorKey' = ${refs.connectorKey}
        AND auth_item->>'connectorVersion' = ${refs.connectorVersion}
        AND auth_item->>'manifestHash' = ${refs.runManifestHash}
    )
  `;
  const legacyHashlessManifestAuthorization = sql`
    ${context.allowLegacyManifestCapabilityClaims}
    AND ${refs.runManifestHash} IS NULL
    AND ${refs.runRequiredCapability} IS NOT NULL
    AND ${refs.runRequiredCapability} = ANY(
      ${pgTextArray(context.authorizedCapabilities)}::text[]
    )
    -- No contract declares runtime.execution any more, but definitions
    -- registered before the endpoint consolidation still carry it: stored
    -- manifest JSON is preserved verbatim (normalizeManifest spreads runtime)
    -- so those artifact hashes stay valid. Keep failing closed for them --
    -- a legacy capability poll must not stand in for the exact retained
    -- manifest authorization those devices already hold above.
    AND COALESCE(${refs.runRuntime}->>'execution', '') <> 'bridge'
    AND (
      NOT COALESCE(${refs.runManifestBacked}, false)
      OR ${refs.runRuntime} IS NOT NULL
    )
    AND ${context.workerPlatform ?? ''}::text NOT IN ('headless', 'chrome-extension')
    AND COALESCE(
      ${refs.runRuntime}->'platforms' ? ${context.workerPlatform ?? ''}::text,
      false
    )
  `;
  const manifestAuthorization = sql`
    (${exactManifestAuthorization})
    OR (${legacyHashlessManifestAuthorization})
  `;
  const delegatedBrowserAffinity = delegatedBrowserAffinitySql(sql, {
    platform: refs.pinPlatform,
    connectorKey: refs.connectorKey,
  });
  // A worker may still implement its own connectors while its connector
  // compiler/SDK runtime is unavailable. Never let a compiled artifact enter
  // any claim lane unless that backend was explicitly advertised as ready.
  const compiledBackendReady = hasPositiveBackendCapacity(
    context.backendCapacity,
    EXECUTION_BACKENDS.compiledConnector
  );
  // A chrome-namespace execution runs inside the advertising extension, so it
  // needs no server-side backend at all.
  const chromeNamespaceExecution = chromeNamespaceConnectorSql(sql, {
    connectorKey: refs.connectorKey,
  });
  // Keep this guard outside the individual lanes: every lane must advertise the
  // backend the selected artifact actually needs. A manifest-backed artifact
  // carries no code and is implemented by the endpoint that advertised it, so
  // it needs no server-side backend at all — which is also what lets a device
  // whose connector compiler is broken keep serving its native connectors and
  // be recovered. Only a compiled artifact requires advertised capacity.
  const selectedBackendReady = sql`
    (
      ${chromeNamespaceExecution}
      OR COALESCE(${refs.runManifestBacked}, false)
      OR ${compiledBackendReady}
    )
  `;

  return sql`
    (
      ${selectedBackendReady}
      AND (
        -- Trusted/anonymous fleet worker. Execution-pinned connections stay on
        -- their exact device; browser-affinity parent runs stay on fleet.
        (
          ${!context.isUserScopedWorker}
          AND (
            COALESCE(${refs.runRequiredCapability}, '') = ANY(
              ${pgTextArray(context.capabilityMatchSet)}::text[]
            )
          )
          AND NOT COALESCE(${refs.runManifestBacked}, false)
          AND (
            ${!isCloudMode()}
            OR ${context.workerHardensDbEgress}
            OR NOT (${refs.connectorKey} = ANY(${dbEgressHardenedKeys}::text[]))
          )
          AND (
            (${pageActivated})
            OR ${refs.connectionDeviceWorkerId} IS NULL
            OR (
              ${delegatedBrowserAffinity}
            )
          )
        )
        -- User-scoped worker claiming an unpinned capability connector in its
        -- base org scope. Page-activated work is handled by the fleet parent.
        OR (
          ${context.isUserScopedWorker}
          -- Browser-local ids cannot move between eligible profiles. Existing
          -- unpinned rows also stay unclaimable during the gateway upgrade.
          AND NOT (${chromeNamespaceExecution})
          AND ${refs.connectionDeviceWorkerId} IS NULL
          AND (${refs.runTargetDeviceWorkerId ?? sql`NULL`}::uuid IS NULL)
          AND (
            (
              COALESCE(${refs.runManifestBacked}, false)
              AND (${manifestAuthorization})
            )
            OR (
              NOT COALESCE(${refs.runManifestBacked}, false)
              AND ${refs.runRequiredCapability} IS NOT NULL
              AND ${refs.runRequiredCapability} = ANY(
                ${pgTextArray(context.authorizedCapabilities)}::text[]
              )
            )
          )
          AND NOT COALESCE(${pageActivated}, false)
          AND ${refs.organizationId} = ANY(${pgTextArray(context.baseOrgScopeIds)}::text[])
        )
        -- Exact execution pin. A chrome-extension pin on a connector that does
        -- not execute natively in the extension is delegated browser affinity,
        -- so its parent connector work stays on fleet instead.
        OR (
          ${context.isUserScopedWorker}
          AND ${context.deviceWorkerId}::uuid IS NOT NULL
          AND COALESCE(${refs.runTargetDeviceWorkerId ?? sql`NULL`}::uuid, ${refs.connectionDeviceWorkerId}) = ${context.deviceWorkerId}::uuid
          AND (
            NOT COALESCE(${refs.runManifestBacked}, false)
            OR (${manifestAuthorization})
          )
          AND NOT COALESCE(${pageActivated}, false)
          AND (
            ${refs.runRequiredCapability} IS NULL
            OR ${refs.runRequiredCapability} = ANY(
              ${pgTextArray(context.authorizedCapabilities)}::text[]
            )
          )
          AND ${refs.organizationId} = ANY(${pgTextArray(context.orgScopeIds)}::text[])
          AND NOT (${delegatedBrowserAffinity})
        )
      )
    )
  `;
}
