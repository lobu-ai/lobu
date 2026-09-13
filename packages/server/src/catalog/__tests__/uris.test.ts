import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { getDefaultCatalogDir } from "../uris";

describe("catalog/uris", () => {
	it("finds precomputed catalogs beside the bundle after the artifact is moved", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "lobu-catalog-relocation-")));
		const original = join(root, "synthetic-builder");
		const installed = join(root, "installed-server");
		try {
			await mkdir(join(original, "dist/catalogs"), { recursive: true });
			await build({
				entryPoints: [fileURLToPath(new URL("../uris.ts", import.meta.url))],
				outfile: join(original, "dist/catalog-reader.mjs"),
				bundle: true,
				platform: "node",
				format: "esm",
			});
			await rename(original, installed);
			expect(existsSync(original)).toBe(false);
			const probe = `import { getDefaultCatalogDir } from ${JSON.stringify(pathToFileURL(join(installed, "dist/catalog-reader.mjs")).href)}; console.log(getDefaultCatalogDir());`;
			const result = execFileSync(process.execPath, ["--input-type=module", "--eval", probe], {
				cwd: root,
				encoding: "utf8",
			}).trim();
			expect(result).toBe(join(installed, "dist/catalogs"));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("getDefaultCatalogDir returns the first existing candidate", () => {
		// Mirror uris.ts candidate resolution from the catalog module dir, not
		// this test file's __tests__ location (vitest/bun cwd layouts differ).
		const catalogModuleDir = fileURLToPath(new URL("..", import.meta.url));
		const candidates = [
			resolve(catalogModuleDir, "catalogs"),
			resolve(catalogModuleDir, "../../dist/catalogs"),
			resolve(catalogModuleDir, "../../../dist/catalogs"),
			resolve(process.cwd(), "packages/server/dist/catalogs"),
		];
		const expected =
			candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
		const result = getDefaultCatalogDir();

		expect(result).toBe(expected);
		if (existsSync(result)) {
			expect(candidates).toContain(result);
		}
	});
});
