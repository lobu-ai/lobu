import type { CatalogEntry, InstalledItem } from "./types";
import { withConnectorInstallability } from "./responses";

function actionCountsFromSchema(actionsSchema: unknown): { reads: number; writes: number; chatTransport: number } {
	if (!actionsSchema || typeof actionsSchema !== "object") return { reads: 0, writes: 0, chatTransport: 0 };
	let reads = 0;
	let writes = 0;
	let chatTransport = 0;
	for (const action of Object.values(actionsSchema)) {
		const def = action as { kind?: unknown; delivery?: unknown; annotations?: { readOnlyHint?: unknown } };
		if (def?.kind === "read" || def?.annotations?.readOnlyHint === true) reads += 1;
		else writes += 1;
		if (def?.delivery === "chat_transport") chatTransport += 1;
	}
	return { reads, writes, chatTransport };
}

function sortConnectorItems(items: InstalledItem[]): InstalledItem[] {
	return [...items].sort((a, b) => {
		const aInstalled = Boolean(a.detail.installed);
		const bInstalled = Boolean(b.detail.installed);
		if (aInstalled && !bInstalled) return -1;
		if (!aInstalled && bInstalled) return 1;
		return a.name.localeCompare(b.name);
	});
}

export function mergeConnectorInstalledWithCatalog(
	installed: InstalledItem[],
	catalog: CatalogEntry[],
): InstalledItem[] {
	const merged = new Map<string, InstalledItem>();

	for (const item of installed) {
		merged.set(item.id, {
			...item,
			detail: {
				...item.detail,
				installed: true,
				installable: false,
				catalog_origin: "org",
			},
		});
	}

	for (const entry of catalog) {
		const installedItem = merged.get(entry.id);
		if (installedItem) {
			if (
				installedItem.detail.automation_events === undefined &&
				entry.detail.automation_events !== undefined
			) {
				installedItem.detail.automation_events = entry.detail.automation_events;
			}
			continue;
		}
		const availableEntry = withConnectorInstallability(entry);
		const detail = availableEntry.detail;
		const actionCounts = actionCountsFromSchema(detail.actions_schema);
		const actionCount = actionCounts.reads + actionCounts.writes;
		merged.set(entry.id, {
			id: entry.id,
			name: entry.name,
			detail: {
				...detail,
				version: entry.version ?? "0.0.0",
				description: entry.description ?? null,
				status: "active",
				installed: false,
				catalog_origin: "catalog",
				operations_summary: {
					total: actionCount,
					reads: actionCounts.reads,
					writes: actionCounts.writes,
					local_action: actionCount - actionCounts.chatTransport,
					chat_transport: actionCounts.chatTransport,
					mcp_tool: 0,
					http_operation: 0,
				},
				has_operations: actionCount > 0,
			},
		});
	}

	return sortConnectorItems([...merged.values()]);
}

export function mergeSkillInstalledWithCatalog(
	installed: InstalledItem[],
	catalog: CatalogEntry[],
): InstalledItem[] {
	const merged = new Map<string, InstalledItem>();

	for (const item of installed) {
		merged.set(item.id, {
			...item,
			detail: {
				...item.detail,
				installed: true,
			},
		});
	}

	for (const entry of catalog) {
		if (entry.detail?.hidden) continue;
		if (merged.has(entry.id)) continue;
		merged.set(entry.id, {
			id: entry.id,
			name: entry.name,
			detail: {
				...entry.detail,
				description: entry.description ?? undefined,
				installed: false,
			},
		});
	}

	return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function parseIncludeCatalog(raw: string | undefined): boolean {
	if (!raw?.trim()) return false;
	return raw
		.split(",")
		.map((part) => part.trim())
		.includes("catalog");
}
