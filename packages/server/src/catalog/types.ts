/**
 * Unified catalog model:
 *
 * - **Global catalog** (`list_catalog` / GET /catalog): manifest files only
 *   (`LOBU_CATALOG_URIS`). Kinds: `connectors`, `skills`, `automations`. No DB.
 *   Automation entries are reusable templates browsed via the "From catalog"
 *   create flow; their `detail` mirrors the Automation create form fields.
 *
 * - **Installed overlay** (`list_installed` / GET /installed): org or agent
 *   state layered on top of catalog browse. Pass `include=catalog` (HTTP) or
 *   `include_catalog: true` (MCP) to merge manifest entries in one response.
 *
 *   | Kind        | Installed source                                      | Catalog DB? |
 *   |-------------|-------------------------------------------------------|-------------|
 *   | connectors  | `connector_definitions` (+ versions) per org          | yes         |
 *   | automations   | Automation inventory rows                               | yes (rows)  |
 *   | skills      | workspace skill library rows that apply to the agent  | no          |
 *   | providers   | agent `models` slug prefixes + module registry metadata | no        |
 *
 * Only connector *definitions* are persisted as installable catalog entries in
 * Postgres. Everything else is manifest/registry + settings overlay.
 */
export const CATALOG_MANIFEST_VERSION = 1;

export const CATALOG_KINDS = ['connectors', 'skills', 'automations'] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

export const ORG_INSTALLED_KINDS = ['connectors', 'automations'] as const;
export type OrgInstalledKind = (typeof ORG_INSTALLED_KINDS)[number];

export const AGENT_INSTALLED_KINDS = ['skills', 'providers'] as const;
export type AgentInstalledKind = (typeof AGENT_INSTALLED_KINDS)[number];

export interface CatalogEntry {
	id: string;
	name: string;
	version?: string;
	description?: string | null;
	detail: Record<string, unknown>;
}

export interface CatalogManifest {
	version: number;
	kind: CatalogKind;
	entries: CatalogEntry[];
}

export interface CatalogListResponse {
	catalogs: Partial<Record<CatalogKind, { kind: CatalogKind; entries: CatalogEntry[] }>>;
}

export interface InstalledItem {
	id: string;
	name: string;
	detail: Record<string, unknown>;
}

export interface InstalledListResponse {
	installed: Partial<
		Record<OrgInstalledKind | AgentInstalledKind, { kind: string; items: InstalledItem[] }>
	>;
}
