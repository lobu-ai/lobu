import { listCatalogEntries } from './load';

export type ConnectorGroupDisplayFields = {
  connector_key: string;
  connector_name: string | null;
  favicon_domain: string | null;
};

function catalogFaviconDomain(
  detail: Record<string, unknown> | undefined,
): string | null {
  return typeof detail?.favicon_domain === 'string' ? detail.favicon_domain : null;
}

/**
 * Fill connector group display fields from the bundled catalog when org
 * connector_definitions are missing. Installed defs are the primary source
 * (joined in SQL); catalog is the documented overlay per catalog/types.ts.
 */
export async function enrichConnectorGroupsWithCatalogDisplay<
  T extends ConnectorGroupDisplayFields,
>(groups: T[]): Promise<T[]> {
  const catalogByKey = new Map(
    (await listCatalogEntries(['connectors'])).connectors.map((entry) => [
      entry.id,
      entry,
    ]),
  );

  return groups
    .map((group) => {
      const catalog = catalogByKey.get(group.connector_key);
      return {
        ...group,
        connector_name: group.connector_name ?? catalog?.name ?? null,
        favicon_domain:
          group.favicon_domain ?? catalogFaviconDomain(catalog?.detail),
      };
    })
    .sort((a, b) =>
      (a.connector_name ?? a.connector_key).localeCompare(
        b.connector_name ?? b.connector_key,
      ),
    );
}

/**
 * One connector's human name for a page: the org's installed definition name
 * when the caller has one, else the bundled catalog entry, else the key.
 */
export async function connectorDisplayName(
  connectorKey: string,
  installedName: string | null = null,
): Promise<string> {
  const [display] = await enrichConnectorGroupsWithCatalogDisplay([
    { connector_key: connectorKey, connector_name: installedName, favicon_domain: null },
  ]);
  return display?.connector_name || connectorKey;
}
