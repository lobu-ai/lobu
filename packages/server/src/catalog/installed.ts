import type { GuardrailStage } from "@lobu/core";
import { resolveAutomationEventCatalog } from "../automations/connector-derived";
import { withPlatformAutomationEvents } from "../automations/platform-event-catalog";
import { getModelProviderModules } from "../gateway/modules/module-system";
import type { Env } from "../index";
import { getLobuCoreServices } from "../lobu/gateway";
import { createPostgresAgentConfigStore } from "../lobu/stores/postgres-stores";
import {
	EMPTY_SUMMARY,
	getOperationsSummaryBatch,
} from "../operations/connector-operations";
import { handleList } from "../tools/admin/manage_automations/list";
import type { ToolContext } from "../tools/registry";
import { connectorSourcePathToUri } from "../utils/connector-catalog";
import { listScopedConnectorDefinitions } from "./connector-definitions";
import { listCatalogEntries } from "./load";
import {
	mergeConnectorInstalledWithCatalog,
	mergeSkillInstalledWithCatalog,
} from "./merge";
import type {
	AgentInstalledKind,
	InstalledItem,
	InstalledListResponse,
	OrgInstalledKind,
} from "./types";

/** Installed UI metadata: merge platform Automation events into each connector. */
function automationEventsForUi(
	raw: Array<Record<string, unknown>> | null | undefined,
	feedsSchema?: unknown,
	bundled?: { automation_events?: unknown; feeds_schema?: unknown },
	useBundledFallback = false,
): Array<Record<string, unknown>> | undefined {
	// Same precedence as trigger validation (persisted > bundled legacy >
	// derived from eventKinds, gated on shared-version provenance) so the
	// picker can never advertise a value Automation creation rejects.
	const source = resolveAutomationEventCatalog({
		persistedEvents: raw,
		feedsSchema,
		bundled,
		useBundledFallback,
	});
	const merged = withPlatformAutomationEvents(source);
	return merged.length > 0 ? (merged as Array<Record<string, unknown>>) : undefined;
}

const configStore = createPostgresAgentConfigStore();

/** Only MCP routing fields are public catalog metadata; credentials never are. */
function publicMcpConfig(
	raw: Record<string, unknown> | null | undefined,
): Record<string, string> | null {
	if (!raw) return null;
	const upstreamUrl =
		typeof raw.upstream_url === "string"
			? raw.upstream_url
			: typeof raw.upstreamUrl === "string"
				? raw.upstreamUrl
				: null;
	if (!upstreamUrl) return null;
	let parsed: URL;
	try {
		parsed = new URL(upstreamUrl);
	} catch {
		return null;
	}
	// A portable route is HTTPS metadata, never a credential container. Query,
	// fragment, and userinfo values remain private to the credential-holding org.
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash
	) {
		return null;
	}
	const toolPrefix =
		typeof raw.tool_prefix === "string"
			? raw.tool_prefix
			: typeof raw.toolPrefix === "string"
				? raw.toolPrefix
				: null;
	return {
		upstream_url: parsed.toString(),
		...(toolPrefix ? { tool_prefix: toolPrefix } : {}),
	};
}

export type ListInstalledOptions = {
	includeCatalog?: boolean;
};

export async function listOrgInstalled(
	organizationId: string,
	kinds: OrgInstalledKind[],
	ctx: Pick<
		ToolContext,
		"organizationId" | "userId" | "memberRole" | "isAuthenticated"
	>,
	options: ListInstalledOptions = {}
): Promise<InstalledListResponse["installed"]> {
	const result: InstalledListResponse["installed"] = {};
	const wanted = new Set(kinds);

	if (wanted.has("connectors")) {
		const rows = await listScopedConnectorDefinitions({ organizationId });
		const summaries = await getOperationsSummaryBatch(
			organizationId,
			rows.map((row) => row.key)
		);
		// Bundled immutable catalog, for the persisted > bundled > derived
		// automation-event precedence shared with trigger validation. Loaded once
		// and reused by the merge below.
		const bundledConnectors = (await listCatalogEntries(["connectors"])).connectors;
		const bundledByKey = new Map(
			bundledConnectors.map((entry) => [entry.id, entry.detail])
		);
		const installedItems = rows.map((row) => {
			const operationsSummary = summaries.get(row.key) ?? {
				...EMPTY_SUMMARY,
			};
			return {
				id: row.key,
				name: row.name,
				detail: {
					version: row.version,
					description: row.description,
					// Persistent incarnation id (`connector_definitions.id`) — the
					// `owned` identity `lobu apply` uses for delete eligibility.
					connector_definition_id: row.id ?? null,
					status: row.status,
					login_enabled: Boolean(row.login_enabled),
					auth_schema: row.auth_schema,
					feeds_schema: row.feeds_schema,
					actions_schema: row.actions_schema,
					automation_events: automationEventsForUi(
						row.automation_events,
						row.feeds_schema,
						bundledByKey.get(row.key),
						row.source_org_id == null,
					),
					options_schema: row.options_schema,
					// Non-secret transport metadata lets a managed local install
					// reproduce an MCP definition without exporting OAuth credentials.
					mcp_config: publicMcpConfig(row.mcp_config),
					favicon_domain: row.favicon_domain,
					required_capability: row.required_capability,
					runtime: row.runtime,
					default_connection_config: row.default_connection_config,
					source_uri: connectorSourcePathToUri(row.source_path),
					operations_summary: operationsSummary,
					has_operations: operationsSummary.total > 0,
				},
			};
		});
		result.connectors = {
			kind: "connectors",
			items: options.includeCatalog
				? mergeConnectorInstalledWithCatalog(installedItems, bundledConnectors)
				: installedItems,
		};
	}

	if (wanted.has("automations")) {
		const toolCtx: ToolContext = {
			organizationId,
			userId: ctx.userId ?? null,
			memberRole: ctx.memberRole ?? null,
			isAuthenticated: ctx.isAuthenticated ?? false,
			clientId: null,
			tokenType: "session",
			scopedToOrg: true,
			allowCrossOrg: false,
			grantedOrganizationIds: null,
			directSearchFederation: false,
			requestUrl: "",
		};
		const listed = await handleList({ status: "active" }, {} as Env, toolCtx);
		const automations = Array.isArray(listed.automations) ? listed.automations : [];
		result.automations = {
			kind: "automations",
			items: automations.map((automation: Record<string, unknown>) => ({
				id: String(automation.automation_id ?? ""),
				name: String(automation.name ?? automation.automation_name ?? "Automation"),
				detail: {
					slug: automation.slug,
					status: automation.status,
					managed_agent_id: automation.managed_agent_id,
					entity_id: automation.entity_id,
					schedule: automation.schedule,
					version: automation.version,
				},
			})),
		};
	}

	return result;
}

export async function listAgentInstalled(
	agentId: string,
	kinds: AgentInstalledKind[],
	options: ListInstalledOptions = {}
): Promise<InstalledListResponse["installed"]> {
	const result: InstalledListResponse["installed"] = {};
	const wanted = new Set(kinds);

	const settings = await configStore.getSettings(agentId);
	if (!settings) return result;

	if (wanted.has("skills")) {
		const skills = settings.skillsConfig?.skills ?? [];
		const installedItems = skills.map((skill) => ({
			id: skill.repo,
			name: skill.name,
			detail: {
				enabled: skill.enabled,
				description: skill.description,
				system: skill.system,
			},
		}));
		result.skills = {
			kind: "skills",
			items: options.includeCatalog
				? mergeSkillInstalledWithCatalog(
						installedItems,
						(await listCatalogEntries(["skills"])).skills
					)
				: installedItems,
		};
	}

	if (wanted.has("providers")) {
		// "Installed" = the provider's slug appears as a `<slug>/` prefix in the
		// agent's `models` list.
		const installedSlugs = new Set<string>();
		for (const ref of settings.models ?? []) {
			const slash = ref.indexOf("/");
			if (slash > 0) installedSlugs.add(ref.slice(0, slash));
		}
		const modules = getModelProviderModules().filter(
			(module) => module.catalogVisible !== false
		);
		result.providers = {
			kind: "providers",
			items: modules.map((module) => ({
				id: module.providerId,
				name: module.providerDisplayName,
				detail: {
					icon_url: module.providerIconUrl ?? "",
					auth_type: module.authType ?? "api-key",
					supported_auth_types: module.supportedAuthTypes ?? [
						module.authType ?? "api-key",
					],
					api_key_instructions: module.apiKeyInstructions ?? "",
					api_key_placeholder: module.apiKeyPlaceholder ?? "",
					description: module.catalogDescription ?? "",
					system_available: module.hasSystemKey(),
					installed: installedSlugs.has(module.providerId),
				},
			})),
		};
	}

	if (wanted.has("guardrails")) {
		const enabled = new Set(settings.guardrails ?? []);
		const core = getLobuCoreServices();
		const registry = core?.getGuardrailRegistry?.();
		// The guardrail *name* is the unit of configuration — `settings.guardrails`
		// is a flat name list, so enabling a name arms it at every stage it is
		// registered for. A single name can be registered at multiple stages (the
		// built-in `pii-scan` runs at input/output/pre-tool), so the per-stage scan
		// below would otherwise emit the same name three times: duplicate `id`s
		// break the InstalledItem contract and the UI's name-keyed rows (React key
		// collision, inflated count, one toggle flipping every copy). Collapse by
		// name and carry the union of stages instead. Insertion order follows the
		// stage scan so each name lists its stages input→output→pre-tool.
		const byName = new Map<string, GuardrailStage[]>();
		if (registry) {
			const stages: GuardrailStage[] = ["input", "output", "pre-tool"];
			for (const stage of stages) {
				for (const guardrail of registry.list(stage)) {
					const existing = byName.get(guardrail.name);
					if (existing) existing.push(stage);
					else byName.set(guardrail.name, [stage]);
				}
			}
		}
		const items: InstalledItem[] = Array.from(byName, ([name, stages]) => ({
			id: name,
			name,
			detail: { stages, enabled: enabled.has(name) },
		}));
		result.guardrails = { kind: "guardrails", items };
	}

	return result;
}

export async function listInstalledConnectorIds(
	organizationId: string
): Promise<string[]> {
	const rows = await listScopedConnectorDefinitions({ organizationId });
	return rows.map((row) => row.key);
}

export function parseKindsParam<T extends string>(
	raw: string | undefined,
	allowed: readonly T[]
): T[] {
	if (!raw?.trim()) return [...allowed];
	const set = new Set(allowed);
	return raw
		.split(",")
		.map((part) => part.trim())
		.filter((part): part is T => set.has(part as T));
}
