import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getDefaultCatalogUris } from "../../catalog/uris";
import {
	connectorSourcePathToUri,
	findBundledConnectorFile,
	normalizeFileSourceUri,
} from "../connector-catalog";

describe("connector-catalog helpers", () => {
	it("defaults LOBU catalog URIs to dist/catalogs manifests or bundled connectors", () => {
		const uris = getDefaultCatalogUris();

		expect(uris.length).toBe(3);
		for (const uri of uris) {
			expect(uri.startsWith("file://")).toBe(true);
		}
		const connectorsManifest = fileURLToPath(uris[0]!);
		const skillsManifest = fileURLToPath(uris[1]!);
		const automationsManifest = fileURLToPath(uris[2]!);
		expect(connectorsManifest.endsWith("/connectors.json")).toBe(true);
		expect(skillsManifest.endsWith("/skills.json")).toBe(true);
		expect(automationsManifest.endsWith("/automations.json")).toBe(true);
		expect(existsSync(findBundledConnectorFile("google.gmail")!)).toBe(true);
	});

	it("normalizes both bare paths and file URIs", () => {
		const cwdPath = `${process.cwd()}/connectors`;
		const normalizedPath = normalizeFileSourceUri(cwdPath);
		const normalizedUri = normalizeFileSourceUri(`file://${cwdPath}`);

		expect(normalizedPath).toBeTruthy();
		expect(normalizedUri).toBeTruthy();
		expect(normalizedPath).toBe(normalizedUri);
	});

	it("derives a file source_uri for bundled connector source paths", () => {
		const bundledConnectorFile = findBundledConnectorFile("google.gmail");

		expect(bundledConnectorFile).toBeTruthy();
		expect(connectorSourcePathToUri("google_gmail.ts")).toBe(
			normalizeFileSourceUri(bundledConnectorFile!)
		);
	});

	it("returns null for non-local source paths that cannot be resolved", () => {
		expect(
			connectorSourcePathToUri("github.com/example/connector.ts")
		).toBeNull();
	});
});
