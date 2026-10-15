import type { DbClient } from '../db/client';
import { CHAT_SENDER_NAMESPACES } from '../lobu/stores/chat-identity-sources';

type ConnectorIdentityScopeShape = {
  scope: 'organization' | 'tenant';
  scopeKeyPath: string | null;
};

type ConnectorIdentityScopeDeclaration = ConnectorIdentityScopeShape & {
  namespace: string;
  declaration: string;
};

type ConnectorIdentityMetadata = {
  key: string;
  feeds: Record<string, unknown> | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sameShape(
  left: ConnectorIdentityScopeShape,
  right: ConnectorIdentityScopeShape
): boolean {
  return left.scope === right.scope && left.scopeKeyPath === right.scopeKeyPath;
}

function renderShape(shape: ConnectorIdentityScopeShape): string {
  return shape.scope === 'tenant'
    ? `{ scope: 'tenant', scopeKeyPath: '${shape.scopeKeyPath}' }`
    : `{ scope: 'organization' }`;
}

/** Read and validate one canonical declaration shape per connector namespace. */
export function connectorIdentityScopeDeclarations(
  metadata: ConnectorIdentityMetadata
): Map<string, ConnectorIdentityScopeDeclaration> {
  const declarations = new Map<string, ConnectorIdentityScopeDeclaration>();
  for (const [feedKey, rawFeed] of Object.entries(metadata.feeds ?? {})) {
    const eventKinds = asRecord(asRecord(rawFeed)?.eventKinds);
    if (!eventKinds) continue;
    for (const [eventKind, rawEventKind] of Object.entries(eventKinds)) {
      const attributions = asRecord(rawEventKind)?.attributions;
      if (!Array.isArray(attributions)) continue;
      attributions.forEach((rawAttribution, attributionIndex) => {
        const identities = asRecord(asRecord(rawAttribution)?.target)?.identities;
        if (!Array.isArray(identities)) return;
        identities.forEach((rawIdentity, identityIndex) => {
          const identity = asRecord(rawIdentity);
          if (!identity) return;
          const namespace =
            typeof identity.namespace === 'string' ? identity.namespace.trim() : '';
          if (!namespace) return;
          if (namespace.includes('\0')) {
            throw new Error('Identity namespace must not contain NUL.');
          }
          const declaration =
            `feed '${feedKey}', event kind '${eventKind}', attribution #${attributionIndex + 1}, ` +
            `identity #${identityIndex + 1}`;
          const rawScope = identity.scope;
          if (
            rawScope !== undefined &&
            rawScope !== 'organization' &&
            rawScope !== 'tenant'
          ) {
            throw new Error(
              `Identity namespace '${namespace}' in ${declaration} uses unsupported scope ` +
                `'${String(rawScope)}'. Use 'organization' or 'tenant'.`
            );
          }
          const scope = rawScope === 'tenant' ? 'tenant' : 'organization';
          const hasScopeKeyPath = Object.hasOwn(identity, 'scopeKeyPath');
          const scopeKeyPath =
            typeof identity.scopeKeyPath === 'string'
              ? identity.scopeKeyPath.trim()
              : null;
          if (scopeKeyPath?.includes('\0')) {
            throw new Error(
              `Identity namespace '${namespace}' in ${declaration} has a scopeKeyPath that must not contain NUL.`
            );
          }
          if (scope === 'tenant' && !scopeKeyPath) {
            throw new Error(
              `Identity namespace '${namespace}' in ${declaration} requires a non-empty scopeKeyPath for tenant scope.`
            );
          }
          if (scope === 'organization' && hasScopeKeyPath) {
            throw new Error(
              `Identity namespace '${namespace}' in ${declaration} has scopeKeyPath, but organization scope requires it to be omitted.`
            );
          }
          const next: ConnectorIdentityScopeDeclaration = {
            namespace,
            scope,
            scopeKeyPath,
            declaration,
          };
          const prior = declarations.get(namespace);
          if (prior && !sameShape(prior, next)) {
            throw new Error(
              `Identity namespace '${namespace}' has conflicting scope declarations: ` +
                `${prior.declaration} declares ${renderShape(prior)}, while ` +
                `${next.declaration} declares ${renderShape(next)}.`
            );
          }
          declarations.set(namespace, prior ?? next);
        });
      });
    }
  }
  return declarations;
}

/**
 * Persist the active declaration shape and reject implicit re-keying.
 *
 * Shape changes with live identities are an operational boundary: quiesce
 * ingestion, migrate `entity_identities` and this registry together, then retry
 * apply. The runtime deliberately has no online re-key state machine.
 */
export async function reconcileConnectorIdentityScopeRegistry(params: {
  sql: DbClient;
  organizationId: string;
  metadata: ConnectorIdentityMetadata;
}): Promise<void> {
  const declarations = connectorIdentityScopeDeclarations(params.metadata);
  // Connector-declared attribution must not claim the identity slots used by
  // chat senders. Guard the shared writer so installs and upgrades, including
  // paths that skip compilation, reject these declarations before activation.
  for (const declaration of declarations.values()) {
    if (CHAT_SENDER_NAMESPACES.has(declaration.namespace)) {
      throw new Error(
        `Identity namespace '${declaration.namespace}' in ${declaration.declaration} of connector ` +
          `'${params.metadata.key}' is a chat sender namespace. Connector attribution rules may not ` +
          'use it; declare a connector-owned namespace for this attribution instead.'
      );
    }
  }
  if (declarations.size === 0) return;

  const sortedDeclarations = [...declarations.values()].sort((left, right) =>
    left.namespace.localeCompare(right.namespace)
  );
  // Lock every namespace in a stable order before reading peer definitions so
  // concurrent connector applies cannot both validate stale registry state.
  for (const declaration of sortedDeclarations) {
    await params.sql`
      SELECT pg_advisory_xact_lock(
        hashtext('lobu:connector-identity-scope'),
        hashtext(${`${params.organizationId}:${declaration.namespace}`})
      )
    `;
  }

  const activeDefinitionRows = await params.sql<{
    key: string;
    status: string;
    feeds_schema: Record<string, unknown> | null;
  }>`
    SELECT key, status, feeds_schema
    FROM connector_definitions
    WHERE organization_id = ${params.organizationId}
      AND (status = 'active' OR key = ${params.metadata.key})
    ORDER BY key
  `;
  const definitionDeclarations = activeDefinitionRows.map((row) => ({
    connectorKey: row.key,
    status: row.status,
    declarations: connectorIdentityScopeDeclarations({
      key: row.key,
      feeds: asRecord(row.feeds_schema),
    }),
  }));
  const currentDefinition = definitionDeclarations.find(
    ({ connectorKey }) => connectorKey === params.metadata.key
  );
  const activeDeclarations = definitionDeclarations.filter(
    ({ connectorKey, status }) => connectorKey !== params.metadata.key && status === 'active'
  );

  for (const declaration of sortedDeclarations) {
    const incompatible = activeDeclarations.find(({ declarations: peerDeclarations }) => {
      const peer = peerDeclarations.get(declaration.namespace);
      return peer !== undefined && peer.scope !== declaration.scope;
    });
    if (incompatible) {
      const peer = incompatible.declarations.get(declaration.namespace)!;
      throw new Error(
        `Identity namespace '${declaration.namespace}' cannot be registered as ` +
          `${renderShape(declaration)} for connector '${params.metadata.key}' because connector ` +
          `'${incompatible.connectorKey}' already uses ${renderShape(peer)}. ` +
          'Connectors sharing an identity namespace must declare the same organization/tenant scope; their payload paths may differ.'
      );
    }
    const compatiblePeer = activeDeclarations.find(({ declarations: peerDeclarations }) => {
      const peer = peerDeclarations.get(declaration.namespace);
      return peer !== undefined && peer.scope === declaration.scope;
    });

    const rows = await params.sql<{
      scope: 'organization' | 'tenant';
      scope_key_path: string | null;
    }>`
      SELECT scope, scope_key_path
      FROM connector_identity_scope_registry
      WHERE organization_id = ${params.organizationId}
        AND connector_key = ${params.metadata.key}
        AND namespace = ${declaration.namespace}
      FOR UPDATE
    `;
    const current = rows[0];
    const currentShape = current
      ? { scope: current.scope, scopeKeyPath: current.scope_key_path }
      : null;
    if (currentShape && sameShape(currentShape, declaration)) continue;

    const counts = await params.sql<{
      count: number | string;
      tenant_count: number | string;
    }>`
      SELECT count(*)::bigint AS count,
             count(*) FILTER (WHERE scope_key IS NOT NULL)::bigint AS tenant_count
      FROM entity_identities
      WHERE organization_id = ${params.organizationId}
        AND namespace = ${declaration.namespace}
        AND deleted_at IS NULL
    `;
    const liveCount = Number(counts[0]?.count ?? 0);
    const tenantCount = Number(counts[0]?.tenant_count ?? 0);
    const missingRegistryIsSafeOrganizationAdoption =
      currentShape === null && declaration.scope === 'organization' && tenantCount === 0;
    const priorDeclaration = currentDefinition?.declarations.get(declaration.namespace);
    const missingRegistryIsSafePeerAdoption =
      currentShape === null &&
      compatiblePeer !== undefined &&
      (currentDefinition === undefined ||
        (priorDeclaration !== undefined && priorDeclaration.scope === declaration.scope));
    if (
      liveCount > 0 &&
      !missingRegistryIsSafeOrganizationAdoption &&
      !missingRegistryIsSafePeerAdoption
    ) {
      const oldShape = currentShape ?? { scope: 'organization' as const, scopeKeyPath: null };
      throw new Error(
        `Identity namespace '${declaration.namespace}' cannot change scope for connector ` +
          `'${params.metadata.key}' while ${liveCount} live identity row${liveCount === 1 ? '' : 's'} exist. ` +
          `Old shape: ${renderShape(oldShape)}. New shape: ${renderShape(declaration)}. ` +
          'Quiesce ingestion and migrate the identity rows plus connector_identity_scope_registry together before retrying apply.'
      );
    }

    await params.sql`
      INSERT INTO connector_identity_scope_registry (
        organization_id, connector_key, namespace, scope, scope_key_path
      ) VALUES (
        ${params.organizationId}, ${params.metadata.key}, ${declaration.namespace},
        ${declaration.scope}, ${declaration.scopeKeyPath}
      )
      ON CONFLICT (organization_id, connector_key, namespace)
      DO UPDATE SET scope = EXCLUDED.scope,
                    scope_key_path = EXCLUDED.scope_key_path,
                    updated_at = now()
    `;
  }
}
