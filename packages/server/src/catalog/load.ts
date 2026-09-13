import { readFile, stat } from "node:fs/promises";
import { createLogger } from "@lobu/core";
import { connectorSourcePathToUri } from "../utils/connector-catalog";
import { generateInMemoryManifests } from "./generate-defaults";
import type { CatalogEntry, CatalogKind, CatalogManifest } from "./types";
import { CATALOG_KINDS, CATALOG_MANIFEST_VERSION } from "./types";
import { getConfiguredCatalogUris, resolveCatalogUri } from "./uris";

const logger = createLogger("catalog");

const manifestCache = new Map<
	string,
	{ mtimeMs: number; manifest: CatalogManifest }
>();

function parseManifest(raw: unknown, source: string): CatalogManifest | null {
	if (!raw || typeof raw !== "object") return null;
	const record = raw as Record<string, unknown>;
	if (record.version !== CATALOG_MANIFEST_VERSION) {
		logger.warn(
			{ source, version: record.version },
			"Ignoring catalog manifest with unsupported version",
		);
		return null;
	}
	const kind = record.kind;
	if (
		typeof kind !== "string" ||
		!(CATALOG_KINDS as readonly string[]).includes(kind)
	) {
		logger.warn(
			{ source, kind },
			"Ignoring catalog manifest with unknown kind",
		);
		return null;
	}
	if (!Array.isArray(record.entries)) {
		logger.warn({ source }, "Ignoring catalog manifest without entries array");
		return null;
	}

	const entries: CatalogEntry[] = [];
	for (const item of record.entries) {
		if (!item || typeof item !== "object") continue;
		const entry = item as Record<string, unknown>;
		const id = typeof entry.id === "string" ? entry.id.trim() : "";
		const name = typeof entry.name === "string" ? entry.name.trim() : "";
		if (!id || !name) continue;
		entries.push({
			id,
			name,
			version: typeof entry.version === "string" ? entry.version : undefined,
			description:
				typeof entry.description === "string"
					? entry.description
					: entry.description === null
						? null
						: undefined,
			detail:
				entry.detail &&
				typeof entry.detail === "object" &&
				!Array.isArray(entry.detail)
					? (entry.detail as Record<string, unknown>)
					: {},
		});
	}

	return { version: CATALOG_MANIFEST_VERSION, kind: kind as CatalogKind, entries };
}

async function loadManifestFile(uri: string): Promise<CatalogManifest | null> {
	const path = resolveCatalogUri(uri);
	if (!path) return null;

	let mtimeMs: number;
	try {
		mtimeMs = (await stat(path)).mtimeMs;
	} catch {
		return null;
	}

	const cached = manifestCache.get(path);
	if (cached && cached.mtimeMs === mtimeMs) return cached.manifest;

	try {
		const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
		const manifest = parseManifest(raw, path);
		if (!manifest) return null;
		manifestCache.set(path, { mtimeMs, manifest });
		return manifest;
	} catch (error) {
		logger.warn(
			{ path, error: error instanceof Error ? error.message : String(error) },
			"Failed to read catalog manifest",
		);
		return null;
	}
}

async function loadManifestsFromUris(): Promise<CatalogManifest[]> {
	const uris = getConfiguredCatalogUris(process.env.LOBU_CATALOG_URIS);
	const manifests: CatalogManifest[] = [];
	for (const uri of uris) {
		const manifest = await loadManifestFile(uri);
		if (manifest) manifests.push(manifest);
	}
	return manifests;
}

let inMemoryFallback: CatalogManifest[] | null = null;

async function allManifests(): Promise<CatalogManifest[]> {
	const fromDisk = await loadManifestsFromUris();
	if (fromDisk.length > 0) return fromDisk;

	if (!inMemoryFallback) {
		inMemoryFallback = await generateInMemoryManifests();
	}
	return inMemoryFallback;
}

export async function listCatalogEntries(
	kinds?: CatalogKind[],
): Promise<Record<CatalogKind, CatalogEntry[]>> {
	const wanted = new Set(kinds ?? (CATALOG_KINDS as readonly CatalogKind[]));
	const result = Object.fromEntries(
		CATALOG_KINDS.map((kind) => [kind, [] as CatalogEntry[]]),
	) as Record<CatalogKind, CatalogEntry[]>;

	const seen = Object.fromEntries(
		CATALOG_KINDS.map((kind) => [kind, new Set<string>()]),
	) as Record<CatalogKind, Set<string>>;

	for (const manifest of await allManifests()) {
		if (!wanted.has(manifest.kind)) continue;
		for (const entry of manifest.entries) {
			if (seen[manifest.kind].has(entry.id)) continue;
			seen[manifest.kind].add(entry.id);
			// Builtin artifacts store portable source_path values. Resolve them
			// only on the consuming machine; explicit custom URIs stay intact.
			const sourceUri = manifest.kind === "connectors" &&
				typeof entry.detail.source_uri !== "string" &&
				typeof entry.detail.source_path === "string"
				? connectorSourcePathToUri(entry.detail.source_path)
				: null;
			result[manifest.kind].push(sourceUri
				? { ...entry, detail: { ...entry.detail, source_uri: sourceUri } }
				: entry);
		}
	}

	for (const kind of wanted) {
		result[kind].sort((a, b) => a.name.localeCompare(b.name));
	}

	return result;
}

export function clearCatalogCacheForTests(): void {
	manifestCache.clear();
	inMemoryFallback = null;
}
