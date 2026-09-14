import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findBundledConnectorFile } from "../../utils/connector-catalog";
import { clearCatalogCacheForTests, listCatalogEntries } from "../load";

describe("catalog/load", () => {
	afterEach(() => {
		clearCatalogCacheForTests();
	});

	it("resolves portable source paths at runtime and preserves explicit custom URIs", async () => {
		const prev = process.env.LOBU_CATALOG_URIS;
		const dir = await mkdtemp(join(tmpdir(), "lobu-portable-catalog-"));
		const manifestPath = join(dir, "connectors.json");
		const customUri = "file:///synthetic-custom/connector.ts";
		try {
			await writeFile(manifestPath, JSON.stringify({
				version: 1,
				kind: "connectors",
				entries: [
					{ id: "hackernews", name: "Hacker News", detail: { source_path: "hackernews.ts" } },
					{ id: "synthetic-custom", name: "Custom", detail: { source_path: "hackernews.ts", source_uri: customUri } },
					{ id: "synthetic-missing", name: "Missing", detail: { source_path: "synthetic-missing.ts" } },
				],
			}));
			process.env.LOBU_CATALOG_URIS = manifestPath;
			clearCatalogCacheForTests();
			const entries = (await listCatalogEntries(["connectors"])).connectors;
			expect(entries.find((entry) => entry.id === "hackernews")?.detail.source_uri).toBe(
				pathToFileURL(findBundledConnectorFile("hackernews")!).href,
			);
			expect(entries.find((entry) => entry.id === "synthetic-custom")?.detail.source_uri).toBe(customUri);
			expect(entries.find((entry) => entry.id === "synthetic-missing")?.detail.source_uri).toBeUndefined();
		} finally {
			if (prev === undefined) delete process.env.LOBU_CATALOG_URIS;
			else process.env.LOBU_CATALOG_URIS = prev;
			clearCatalogCacheForTests();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("falls back to in-memory manifests when LOBU_CATALOG_URIS is unset", async () => {
		const prev = process.env.LOBU_CATALOG_URIS;
		delete process.env.LOBU_CATALOG_URIS;
		clearCatalogCacheForTests();

		const entries = await listCatalogEntries(["connectors", "skills"]);
		expect(entries.connectors.length).toBeGreaterThan(0);
		expect(entries.skills.length).toBeGreaterThanOrEqual(0);
		expect(entries.connectors[0]?.id).toBeTruthy();
		expect(entries.connectors[0]?.name).toBeTruthy();

		if (prev === undefined) delete process.env.LOBU_CATALOG_URIS;
		else process.env.LOBU_CATALOG_URIS = prev;
		clearCatalogCacheForTests();
	});

	it("includes EVERY bundled chat connector in the connectors catalog", async () => {
		// The connectors catalog is what `list_installed` with `include_catalog`
		// merges against, so a fresh org (no connector_definitions row, no
		// connection) can still reach a chat platform's install affordance. If a
		// chat connector drops out of the bundled catalog, its install entry point
		// becomes unreachable in the connectors picker.
		//
		// Enumerates the CLASS rather than naming platforms: a chat connector is
		// one whose options schema declares `x-lobu-chat-platform` — the same
		// marker the server already reads (tools/admin/manage_connections). This
		// used to assert over a hardcoded ["slack", "telegram"], which silently
		// covered neither Google Chat nor any platform added later.
		const anchor = findBundledConnectorFile("slack");
		expect(anchor, "bundled connector sources must resolve in this env").toBeTruthy();
		const connectorDir = dirname(anchor as string);
		const chatPlatforms: string[] = [];
		for (const file of await readdir(connectorDir)) {
			if (!file.endsWith(".ts") || file.endsWith(".d.ts")) continue;
			const src = await readFile(join(connectorDir, file), "utf8");
			const declared = /["']x-lobu-chat-platform["']\s*:\s*["']([^"']+)["']/.exec(
				src,
			);
			if (declared?.[1]) chatPlatforms.push(declared[1]);
		}
		// Guard the guard: if the scan finds nothing the assertion below is vacuous.
		expect(chatPlatforms.length).toBeGreaterThanOrEqual(6);

		const prev = process.env.LOBU_CATALOG_URIS;
		delete process.env.LOBU_CATALOG_URIS;
		clearCatalogCacheForTests();

		const entries = await listCatalogEntries(["connectors"]);
		const ids = new Set(entries.connectors.map((entry) => entry.id));
		for (const platform of chatPlatforms) {
			expect(ids.has(platform), `${platform} missing from bundled catalog`).toBe(
				true,
			);
		}

		if (prev === undefined) delete process.env.LOBU_CATALOG_URIS;
		else process.env.LOBU_CATALOG_URIS = prev;
		clearCatalogCacheForTests();
	});

	it("serves bundled Automation templates when LOBU_CATALOG_URIS is unset", async () => {
		const prev = process.env.LOBU_CATALOG_URIS;
		delete process.env.LOBU_CATALOG_URIS;
		clearCatalogCacheForTests();

		const entries = await listCatalogEntries(["automations"]);
		expect(entries.automations.length).toBeGreaterThan(0);
		const first = entries.automations[0];
		expect(first?.id).toBeTruthy();
		expect(first?.name).toBeTruthy();
		// detail mirrors manage_automations create fields (used for prefill)
		expect(first?.detail.prompt).toBeTruthy();
		expect(first?.detail.triggers).toBeTruthy();
		expect(first?.detail.schedule).toBeUndefined();

		if (prev === undefined) delete process.env.LOBU_CATALOG_URIS;
		else process.env.LOBU_CATALOG_URIS = prev;
		clearCatalogCacheForTests();
	});

	it("deduplicates catalog entries by id within a kind", async () => {
		const prev = process.env.LOBU_CATALOG_URIS;
		const dir = await mkdtemp(join(tmpdir(), "lobu-catalog-test-"));
		const manifestPath = join(dir, "connectors.json");
		await writeFile(
			manifestPath,
			JSON.stringify({
				version: 1,
				kind: "connectors",
				entries: [
					{ id: "acme", name: "Acme One", detail: {} },
					{ id: "acme", name: "Acme Duplicate", detail: {} },
					{ id: "beta", name: "Beta", detail: {} },
				],
			})
		);
		process.env.LOBU_CATALOG_URIS = manifestPath;
		clearCatalogCacheForTests();

		const entries = await listCatalogEntries(["connectors"]);
		expect(entries.connectors).toHaveLength(2);
		expect(entries.connectors.map((entry) => entry.id).sort()).toEqual([
			"acme",
			"beta",
		]);
		expect(entries.connectors.find((entry) => entry.id === "acme")?.name).toBe(
			"Acme One"
		);

		if (prev === undefined) delete process.env.LOBU_CATALOG_URIS;
		else process.env.LOBU_CATALOG_URIS = prev;
		clearCatalogCacheForTests();
	});
});
