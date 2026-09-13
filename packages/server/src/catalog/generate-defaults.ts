import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	generateCatalogManifest,
	getDefaultConnectorCatalogDir,
} from "../utils/connector-catalog";
import type { CatalogEntry, CatalogManifest } from "./types";
import { CATALOG_MANIFEST_VERSION } from "./types";
import { AUTOMATION_CATALOG_TEMPLATES } from "./automation-templates";

function repoSkillsDir(): string {
	const here =
		import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url));
	const candidates = [
		resolve(here, "../../../../skills"),
		resolve(here, "../../../../../skills"),
		resolve(process.cwd(), "skills"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return candidates[0]!;
}

function parseSimpleFrontmatter(raw: string): {
	frontmatter: Record<string, unknown>;
	body: string;
} {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { frontmatter: {}, body: raw.trim() };

	const frontmatter: Record<string, unknown> = {};
	for (const line of match[1]!.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const colon = trimmed.indexOf(":");
		if (colon < 0) continue;
		const key = trimmed.slice(0, colon).trim();
		let value = trimmed.slice(colon + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		frontmatter[key] = value;
	}

	return { frontmatter, body: match[2]!.trim() };
}

export async function generateConnectorsManifest(): Promise<CatalogManifest> {
	const dirPath = getDefaultConnectorCatalogDir();
	const built = await generateCatalogManifest(dirPath);
	const entries: CatalogEntry[] = [];
	const seen = new Set<string>();

	for (const [sourcePath, metadata] of Object.entries(built.entries)) {
		if (!metadata || seen.has(metadata.key)) continue;
		seen.add(metadata.key);
		entries.push({
			id: metadata.key,
			name: metadata.name,
			version: metadata.version,
			description: metadata.description,
			detail: {
				// Runtime loading resolves this against the installed bundle. An
				// absolute URI here would capture the build machine's checkout.
				source_path: sourcePath,
				auth_schema: metadata.auth_schema,
				webhook: metadata.webhook,
				feeds_schema: metadata.feeds_schema,
				actions_schema: metadata.actions_schema,
				automation_events: metadata.automation_events,
				options_schema: metadata.options_schema,
				favicon_domain: metadata.favicon_domain,
				required_capability: metadata.required_capability,
				runtime: metadata.runtime,
				login_enabled: metadata.login_enabled,
			},
		});
	}

	entries.sort((a, b) => a.name.localeCompare(b.name));
	return { version: CATALOG_MANIFEST_VERSION, kind: "connectors", entries };
}

export async function generateSkillsManifest(): Promise<CatalogManifest> {
	const skillsDir = repoSkillsDir();
	const entries: CatalogEntry[] = [];

	if (!existsSync(skillsDir)) {
		return { version: CATALOG_MANIFEST_VERSION, kind: "skills", entries };
	}

	const { readdir } = await import("node:fs/promises");
	for (const name of await readdir(skillsDir)) {
		const skillMd = join(skillsDir, name, "SKILL.md");
		if (!existsSync(skillMd)) continue;
		const raw = await readFile(skillMd, "utf8");
		const { frontmatter, body } = parseSimpleFrontmatter(raw);
		const skillName =
			typeof frontmatter.name === "string" && frontmatter.name.trim()
				? frontmatter.name.trim()
				: name;
		const description =
			typeof frontmatter.description === "string"
				? frontmatter.description
				: undefined;
		entries.push({
			id: `bundled/${skillName}`,
			name: skillName,
			version: "1.0.0",
			description: description ?? null,
			detail: {
				instructions: body,
				hidden: name === "lobu-operator",
			},
		});
	}

	entries.sort((a, b) => a.name.localeCompare(b.name));
	return { version: CATALOG_MANIFEST_VERSION, kind: "skills", entries };
}

export function generateAutomationsManifest(): CatalogManifest {
	const entries = [...AUTOMATION_CATALOG_TEMPLATES].sort((a, b) =>
		a.name.localeCompare(b.name)
	);
	return { version: CATALOG_MANIFEST_VERSION, kind: "automations", entries };
}

export async function generateInMemoryManifests(): Promise<CatalogManifest[]> {
	return [
		await generateConnectorsManifest(),
		await generateSkillsManifest(),
		generateAutomationsManifest(),
	];
}
