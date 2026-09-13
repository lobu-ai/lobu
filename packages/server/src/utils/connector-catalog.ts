import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createIsolateConnectorCompiler,
	findBundledConnectorFile as findInDirs,
} from "@lobu/connector-worker/compile";
import { getErrorMessage } from "@lobu/core";
import {
	extractConnectorMetadata,
	NO_CONNECTOR_RUNTIME_ERROR,
} from "./connector-compiler";
import type { ConnectorAgentTooling } from "@lobu/connector-sdk";
import logger from "./logger";

const DEFAULT_CONNECTOR_DIR_CANDIDATES = [
	// Published CLI runtime: packages/cli/scripts/build.cjs copies bundled
	// connector source files next to server.bundle.mjs at dist/connectors.
	resolve(import.meta.dirname ?? __dirname, "connectors"),
	// Local monorepo source and built-server layouts.
	resolve(import.meta.dirname ?? __dirname, "../../../connectors/src"),
	resolve(import.meta.dirname ?? __dirname, "../../connectors"),
	resolve(import.meta.dirname ?? __dirname, "../../../connectors"),
	resolve(import.meta.dirname ?? __dirname, "../../../../../connectors"),
	// Explicit project/runtime roots for dev and custom deployments.
	resolve(process.cwd(), "packages/connectors/src"),
	resolve(process.cwd(), "connectors"),
];

const connectorCompiler = createIsolateConnectorCompiler();

type CachedMetadata =
	| {
			mtimeMs: number;
			value: ExtractedConnectorCatalogMetadata | null;
	  }
	| undefined;

type ExtractedConnectorCatalogMetadata = {
	key: string;
	name: string;
	description: string | null;
	version: string;
	auth_schema: Record<string, unknown> | null;
	webhook: Record<string, unknown> | null;
	feeds_schema: Record<string, unknown> | null;
	actions_schema: Record<string, unknown> | null;
	automation_events: Array<Record<string, unknown>> | null;
	options_schema: Record<string, unknown> | null;
	mcp_config: Record<string, unknown> | null;
	openapi_config: Record<string, unknown> | null;
	favicon_domain: string | null;
	required_capability: string | null;
	runtime: Record<string, unknown> | null;
	login_enabled: boolean;
};

/** Metadata extracted from bundled connector manifests (global catalog only). */
interface CatalogConnectorDefinition {
	key: string;
	name: string;
	description: string | null;
	version: string;
	auth_schema: Record<string, unknown> | null;
	webhook: Record<string, unknown> | null;
	feeds_schema: Record<string, unknown> | null;
	actions_schema: Record<string, unknown> | null;
	automation_events: Array<Record<string, unknown>> | null;
	options_schema: Record<string, unknown> | null;
	favicon_domain: string | null;
	required_capability: string | null;
	runtime: Record<string, unknown> | null;
	login_enabled: boolean;
	source_path: string;
	source_uri: string;
}

const metadataCache = new Map<string, CachedMetadata>();

/**
 * One cache entry per (image file, selected version): compiling and
 * extracting is the expensive half, and the resolver asks once per connection
 * row on every agent turn.
 */
const bundledAttestationCache = new Map<
	string,
	{ mtimeMs: number; value: BundledAgentToolingMetadata | null }
>();
const MAX_BUNDLED_ATTESTATION_CACHE = 64;

export interface BundledAgentToolingMetadata {
	authSchema: Record<string, unknown> | null;
	agentTooling: ConnectorAgentTooling | null;
}

/**
 * Resolve only agent metadata from the trusted connector file in this image,
 * compiled once and kept only when it attests the exact selected key@version.
 * Returns null when the image carries no file for the key, or carries a
 * different key/version than the one selected.
 *
 * This is intentionally not part of the public catalog projection: Cloud
 * tooling must never trust connector_definitions JSON for a shared artifact.
 */
export async function resolveBundledAgentToolingMetadata(
	connectorKey: string,
	selectedVersion: string,
): Promise<BundledAgentToolingMetadata | null> {
	const filePath = findBundledConnectorFile(connectorKey);
	if (!filePath) return null;
	const fileStat = await stat(filePath);
	const cacheKey = `${filePath}\0${selectedVersion}`;
	const cached = bundledAttestationCache.get(cacheKey);
	if (cached?.mtimeMs === fileStat.mtimeMs) return cached.value;

	let value: BundledAgentToolingMetadata | null = null;
	try {
		const compiledCode = await compileConnectorForIsolateFromFile(filePath);
		const metadata = await extractConnectorMetadata(compiledCode);
		if (metadata.key === connectorKey && metadata.version === selectedVersion) {
			value = {
				authSchema: metadata.authSchema ?? null,
				agentTooling: metadata.agentTooling ?? null,
			};
		}
	} catch (error) {
		logger.warn(
			{ connector_key: connectorKey, version: selectedVersion, error: getErrorMessage(error) },
			"Bundled connector attestation failed",
		);
	}
	if (bundledAttestationCache.size >= MAX_BUNDLED_ATTESTATION_CACHE) {
		const oldest = bundledAttestationCache.keys().next().value;
		if (oldest) bundledAttestationCache.delete(oldest);
	}
	bundledAttestationCache.set(cacheKey, { mtimeMs: fileStat.mtimeMs, value });
	return value;
}

function normalizeLocalPath(pathValue: string): string {
	return resolve(pathValue);
}

export function getDefaultConnectorCatalogDir(): string {
	for (const candidate of DEFAULT_CONNECTOR_DIR_CANDIDATES) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return DEFAULT_CONNECTOR_DIR_CANDIDATES[0];
}

// Bundled connector files don't appear/disappear at runtime, and this is now
// consulted on every feed sync / worker poll — memoise the lookup.
const bundledFileCache = new Map<string, string | null>();

export function findBundledConnectorFile(key: string): string | null {
	const cached = bundledFileCache.get(key);
	if (cached !== undefined) return cached;
	const found = findInDirs(key, DEFAULT_CONNECTOR_DIR_CANDIDATES);
	bundledFileCache.set(key, found);
	return found;
}

export type CatalogConnectorInstallability =
	| { installable: true }
	| {
			installable: false;
			reason: "bundled_source_unavailable";
			message: string;
	  };

/**
 * The capability decision shared by catalog presentation and connector-id
 * installation. Catalog manifests are browse indexes and can outlive a bundled
 * source file, so presence in a manifest alone is not an install guarantee.
 */
export function getCatalogConnectorInstallability(
	connectorKey: string,
): CatalogConnectorInstallability {
	if (!findBundledConnectorFile(connectorKey)) {
		return {
			installable: false,
			reason: "bundled_source_unavailable",
			message: `Catalog connector '${connectorKey}' does not resolve to a bundled connector source in this environment.`,
		};
	}
	return { installable: true };
}

// Derive the persisted source_path (relative to the bundled-connectors
// catalog dir) for a file resolved by findBundledConnectorFile. Used by
// auto-install / device-reconcile so subdir-grouped connectors
// (`browser/evaluate.ts`) round-trip correctly through
// `connectorSourcePathToUri`. Falls back to basename if the file lives
// outside every known candidate (shouldn't happen in practice, but keeps
// the call site simple).
export function bundledConnectorSourcePath(filePath: string): string {
	for (const dir of DEFAULT_CONNECTOR_DIR_CANDIDATES) {
		if (filePath.startsWith(`${dir}/`)) {
			return relative(dir, filePath);
		}
	}
	return relative(resolve(filePath, ".."), filePath);
}

export function normalizeFileSourceUri(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;

	if (!trimmed.includes("://")) {
		return pathToFileURL(normalizeLocalPath(trimmed)).toString();
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return null;
	}

	if (parsed.protocol !== "file:") {
		return null;
	}

	return pathToFileURL(normalizeLocalPath(fileURLToPath(parsed))).toString();
}

export function resolveFileSourcePath(value: string): string | null {
	const normalized = normalizeFileSourceUri(value);
	if (!normalized) return null;
	return fileURLToPath(normalized);
}

export function connectorSourcePathToUri(sourcePath?: string | null): string | null {
	if (!sourcePath) return null;
	if (sourcePath.includes("://")) return normalizeFileSourceUri(sourcePath);
	if (isAbsolute(sourcePath) && existsSync(sourcePath)) {
		return pathToFileURL(sourcePath).toString();
	}
	const bundledSourcePath = resolve(getDefaultConnectorCatalogDir(), sourcePath);
	return existsSync(bundledSourcePath)
		? pathToFileURL(bundledSourcePath).toString()
		: null;
}

// `compileConnectorForIsolateFromFile` is owned by `@lobu/connector-worker/compile`
// (LRU-capped at 8 entries, keyed by file mtime — see lobu#771 for the cap
// rationale). Re-exported here so the gateway's candidate-dir configuration of
// the compiler is the single instance every server caller shares.
export const compileConnectorForIsolateFromFile =
	connectorCompiler.compileConnectorForIsolateFromFile;

async function extractConnectorCatalogMetadata(
	filePath: string,
): Promise<ExtractedConnectorCatalogMetadata | null> {
	const fileStat = await stat(filePath);
	const cached = metadataCache.get(filePath);

	if (cached && cached.mtimeMs === fileStat.mtimeMs) {
		return cached.value;
	}

	try {
		const compiledCode = await compileConnectorForIsolateFromFile(filePath);
		const metadata = await extractConnectorMetadata(compiledCode);

		if (!metadata.key || !metadata.name || !metadata.version) {
			metadataCache.set(filePath, { mtimeMs: fileStat.mtimeMs, value: null });
			return null;
		}

		const value = {
			key: metadata.key,
			name: metadata.name,
			description: metadata.description ?? null,
			version: metadata.version,
			auth_schema: metadata.authSchema ?? null,
			webhook: metadata.webhook ?? null,
			feeds_schema: metadata.feeds ?? null,
			actions_schema: metadata.actions ?? null,
			automation_events: metadata.automationEvents ?? null,
			options_schema: metadata.optionsSchema ?? null,
			mcp_config: metadata.mcpConfig ?? null,
			openapi_config: metadata.openapiConfig ?? null,
			favicon_domain: metadata.faviconDomain ?? null,
			required_capability: metadata.requiredCapability ?? null,
			runtime:
				(metadata.runtime as Record<string, unknown> | undefined) ?? null,
			login_enabled: false,
		} satisfies ExtractedConnectorCatalogMetadata;

		metadataCache.set(filePath, { mtimeMs: fileStat.mtimeMs, value });
		return value;
	} catch (error) {
		const message = getErrorMessage(error);
		// "No ConnectorRuntime class" is the expected outcome for the support
		// modules that live alongside connectors in the same directory (see
		// NO_CONNECTOR_RUNTIME_ERROR): the scan compiles every `.ts` it finds, so
		// discovering that a file is not a connector is normal control flow, and
		// warning on it made a first `lobu run` print seven "metadata extraction
		// failed" lines that read as a broken install. Real failures — a compile
		// error, a missing connector SDK — still warn, because those DO mean a
		// connector the user expects is missing.
		const notAConnector = message.includes(NO_CONNECTOR_RUNTIME_ERROR);
		if (notAConnector) {
			logger.debug(
				{ file_path: filePath },
				"Skipping catalog entry: file exports no ConnectorRuntime",
			);
		} else {
			logger.warn(
				{ file_path: filePath, error: message },
				"Skipping connector catalog entry after metadata extraction failed",
			);
		}
		metadataCache.set(filePath, { mtimeMs: fileStat.mtimeMs, value: null });
		return null;
	}
}

const CATALOG_MANIFEST_VERSION = 1;

interface CatalogManifest {
	version: number;
	// null = file carries no ConnectorRuntime class (utility/index file). Recorded
	// so the runtime doesn't recompile it just to rediscover it's not a connector.
	entries: Record<string, ExtractedConnectorCatalogMetadata | null>;
}

// Manifests are keyed by POSIX-relative path so a manifest built on Linux (CI)
// matches lookups on any runtime OS; mismatches simply fall back to compilation.
function toPosixRelative(dirPath: string, filePath: string): string {
	return relative(dirPath, filePath).split(sep).join("/");
}

/**
 * Two-level scan of a catalog directory for connector source files. Shared by
 * the runtime loader and the build-time manifest generator so the manifest
 * covers exactly the set the runtime would scan. One level deep so primitive
 * groupings like `browser/*.ts` are discovered alongside top-level service
 * connectors; connectors don't currently nest deeper.
 */
async function collectConnectorSourceFiles(dirPath: string): Promise<string[]> {
	const candidatePaths: string[] = [];
	const topEntries = await readdir(dirPath, { withFileTypes: true });
	for (const entry of topEntries.sort((a, b) => a.name.localeCompare(b.name))) {
		const entryPath = resolve(dirPath, entry.name);
		if (entry.isFile()) {
			if (extname(entry.name) !== ".ts" || entry.name.endsWith(".d.ts"))
				continue;
			candidatePaths.push(entryPath);
			continue;
		}
		if (entry.isDirectory()) {
			// Skip private / non-connector folders. `__tests__` ships test files that
			// import `bun:test`, which esbuild can't resolve; any leading-underscore
			// name is by convention not a connector grouping.
			if (entry.name === "__tests__" || entry.name.startsWith("_")) continue;
			try {
				const subEntries = await readdir(entryPath, { withFileTypes: true });
				for (const sub of subEntries.sort((a, b) =>
					a.name.localeCompare(b.name),
				)) {
					if (!sub.isFile()) continue;
					if (extname(sub.name) !== ".ts" || sub.name.endsWith(".d.ts"))
						continue;
					candidatePaths.push(resolve(entryPath, sub.name));
				}
			} catch {
				// Subdir unreadable — skip silently; don't fail the whole catalog.
			}
		}
	}
	return candidatePaths;
}

export async function listCatalogConnectorDefinitions(): Promise<
	CatalogConnectorDefinition[]
> {
	const { listCatalogEntries } = await import("../catalog/load.js");
	const entries = (await listCatalogEntries(["connectors"])).connectors;
	const definitions: CatalogConnectorDefinition[] = [];

	for (const entry of entries) {
		if (!getCatalogConnectorInstallability(entry.id).installable) continue;
		const detail = entry.detail;
		const sourcePath =
			typeof detail.source_path === "string" ? detail.source_path : entry.id;
		const sourceUri =
			typeof detail.source_uri === "string"
				? detail.source_uri
				: pathToFileURL(
						join(getDefaultConnectorCatalogDir(), sourcePath),
					).toString();
		definitions.push({
			key: entry.id,
			name: entry.name,
			description: entry.description ?? null,
			version: entry.version ?? "0.0.0",
			auth_schema:
				(detail.auth_schema as Record<string, unknown> | null) ?? null,
			webhook: (detail.webhook as Record<string, unknown> | null) ?? null,
			feeds_schema:
				(detail.feeds_schema as Record<string, unknown> | null) ?? null,
			actions_schema:
				(detail.actions_schema as Record<string, unknown> | null) ?? null,
			automation_events:
				(detail.automation_events as Array<Record<string, unknown>> | null) ??
				null,
			options_schema:
				(detail.options_schema as Record<string, unknown> | null) ?? null,
			favicon_domain: (detail.favicon_domain as string | null) ?? null,
			required_capability:
				(detail.required_capability as string | null) ?? null,
			runtime: (detail.runtime as Record<string, unknown> | null) ?? null,
			login_enabled: Boolean(detail.login_enabled),
			source_path: sourcePath,
			source_uri: sourceUri,
		});
	}

	return definitions.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build-time: compile every bundled connector once and capture its metadata so
 * the runtime serves the catalog without on-demand compilation. Non-connector
 * files are stored as `null` so they aren't recompiled at runtime. Invoked by
 * `scripts/build-catalog-manifests.ts` (output: `dist/catalogs/connectors.json`).
 */
export async function generateCatalogManifest(
	dirPath: string,
): Promise<CatalogManifest> {
	const entries: CatalogManifest["entries"] = {};
	for (const filePath of await collectConnectorSourceFiles(dirPath)) {
		entries[toPosixRelative(dirPath, filePath)] =
			await extractConnectorCatalogMetadata(filePath);
	}
	return { version: CATALOG_MANIFEST_VERSION, entries };
}

/** A bundled connector that runs on a device worker rather than the cloud fleet. */
export interface BundledDeviceConnector {
	/** Connector key, e.g. `apple.screen_time`. */
	key: string;
	/** Worker capability the device must advertise to run it, e.g. `screentime`. */
	requiredCapability: string;
	/** Feed keys declared by the bundled source. Used to heal partially-wired installs. */
	feedKeys: string[];
}

/**
 * Bundled connectors that are device-bound: they declare both a `runtime` block
 * and a `requiredCapability` gate, which together mean "only a device worker
 * advertising that capability can run me" (e.g. apple.screen_time on the Lobu
 * Lobu for Mac). The gateway auto-wires these into a user's personal org when a
 * device advertises the capability — nothing about which connectors those are
 * is hardcoded; it's derived from the connector definitions in the catalog.
 */
export async function getBundledDeviceConnectors(): Promise<
	BundledDeviceConnector[]
> {
	const defs = await listCatalogConnectorDefinitions();
	return defs
		.filter(
			(d) => d.runtime != null && typeof d.required_capability === "string",
		)
		.map((d) => ({
			key: d.key,
			requiredCapability: d.required_capability as string,
			// Exclude `userManaged` feeds — they require per-instance config the
			// auto-wire flow can't supply (e.g. local.directory.files needs a
			// folder_id from the Mac app). The Mac app creates them explicitly.
			feedKeys:
				d.feeds_schema &&
				typeof d.feeds_schema === "object" &&
				!Array.isArray(d.feeds_schema)
					? Object.entries(
							d.feeds_schema as Record<string, { userManaged?: boolean }>,
						)
							.filter(([, def]) => !def?.userManaged)
							.map(([key]) => key)
					: [],
		}));
}
