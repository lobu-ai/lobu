import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function normalizeCatalogUri(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;

	if (!trimmed.includes("://")) {
		return pathToFileURL(resolve(trimmed)).toString();
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return null;
	}

	if (parsed.protocol !== "file:") return null;
	return pathToFileURL(resolve(fileURLToPath(parsed))).toString();
}

export function resolveCatalogUri(uri: string): string | null {
	const normalized = normalizeCatalogUri(uri);
	if (!normalized) return null;
	return fileURLToPath(normalized);
}

export function getConfiguredCatalogUris(raw?: string): string[] {
	const configured = raw
		?.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);

	if (configured && configured.length > 0) {
		const normalized = new Set<string>();
		for (const entry of configured) {
			const uri = normalizeCatalogUri(entry);
			if (uri) normalized.add(uri);
		}
		return [...normalized];
	}

	return getDefaultCatalogUris();
}

export function getDefaultCatalogDir(): string {
	const here =
		import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url));
	const candidates = [
		// Published runtime: catalogs are siblings of server.bundle.mjs.
		resolve(here, "catalogs"),
		resolve(here, "../../dist/catalogs"),
		resolve(here, "../../../dist/catalogs"),
		resolve(process.cwd(), "packages/server/dist/catalogs"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return candidates[0]!;
}

export function getDefaultCatalogUris(): string[] {
	const dir = getDefaultCatalogDir();
	return ["connectors.json", "skills.json", "automations.json"].map((name) =>
		pathToFileURL(resolve(dir, name)).toString()
	);
}
