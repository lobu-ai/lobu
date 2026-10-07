import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

/**
 * Every place the gateway executes connector code IN-PROCESS (inline actions,
 * webhook registration, feed pushdown) must hand that code the same env
 * whitelist a fleet worker gets — `connectorRunEnv()` / `dbEgressConfig()` —
 * and never the gateway's own env. Handing over `process.env` (or the server
 * `Env`) would expose ENCRYPTION_KEY, DATABASE_URL and WORKER_API_TOKEN to
 * whatever code the run executes, which under Cloud is an organization's own
 * connector. Enumerating the callers keeps the guard class-wide: a new
 * execution site that reaches for `process.env` fails here, not in review.
 */
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		if (name === "__tests__" || name === "node_modules") continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
		else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(path);
	}
	return out;
}

describe("in-gateway connector execution never hands connector code the gateway env", () => {
	const callers = sourceFiles(SRC_ROOT).filter((path) =>
		readFileSync(path, "utf8").includes("executeCompiledConnector("),
	);

	it("enumerates the execution sites (the guard is only as wide as this list)", () => {
		expect(callers.map((path) => relative(SRC_ROOT, path)).sort()).toEqual([
			"connect/webhook-registration.ts",
			"lib/connector-pushdown.ts",
			"lib/feed-sync.ts",
			"runs/source-feed-listener.ts",
			"tools/admin/manage_operations/handlers/execute.ts",
		]);
	});

	it.each(callers.map((path) => [relative(SRC_ROOT, path), path]))(
		"%s sources job.env from the worker whitelist",
		(_label, path) => {
			const text = readFileSync(path, "utf8");
			expect(text).not.toMatch(/Object\.entries\((process\.env|env)\)/);
			expect(text).not.toMatch(/env:\s*(process\.env|env|envStrings\s*=\s*process\.env)\b/);
			expect(/connectorRunEnv\(|dbEgressConfig\(\)/.test(text)).toBe(true);
		},
	);
});
