import {
	ListCatalogAction,
	ListInstalledAction,
	ManageCatalogResultSchema,
	ManageCatalogSchema,
	type ListCatalogArgs,
	type ListInstalledArgs,
	type ManageCatalogResult,
} from "@lobu/core/contracts/tools/manage-catalog";
import { listAgentInstalled, listOrgInstalled } from "../../catalog/installed";
import { listCatalogEntries } from "../../catalog/load";
import { buildCatalogListResponse } from "../../catalog/responses";
import {
	AGENT_INSTALLED_KINDS,
	type AgentInstalledKind,
	CATALOG_KINDS,
	ORG_INSTALLED_KINDS,
	type OrgInstalledKind,
} from "../../catalog/types";
import type { ToolContext } from "../registry";
import { action, defineActionTool } from "./action-tool";

async function handleListCatalog(args: ListCatalogArgs): Promise<ManageCatalogResult> {
	const kinds = args.kinds?.length ? args.kinds : [...CATALOG_KINDS];
	const all = await listCatalogEntries(kinds);
	return {
		action: "list_catalog",
		...buildCatalogListResponse(kinds, all),
	};
}

async function handleListInstalled(
	args: ListInstalledArgs,
	ctx: ToolContext,
): Promise<ManageCatalogResult> {
	const requestedKinds = args.kinds?.length ? args.kinds : undefined;
	const isAgentKind = (k: string): k is AgentInstalledKind =>
		(AGENT_INSTALLED_KINDS as readonly string[]).includes(k);
	const isOrgKind = (k: string): k is OrgInstalledKind =>
		(ORG_INSTALLED_KINDS as readonly string[]).includes(k);

	const agentKinds = (requestedKinds ?? []).filter(isAgentKind);
	const orgKinds = (requestedKinds ?? []).filter(isOrgKind);
	const unknownKinds = (requestedKinds ?? []).filter(
		(k) => !isAgentKind(k) && !isOrgKind(k),
	);
	if (unknownKinds.length > 0) {
		return {
			error: `Unsupported installed kind(s): ${unknownKinds.join(", ")}`,
		};
	}
	if (!args.agent_id && agentKinds.length > 0) {
		return {
			error: "`agent_id` is required for agent-scoped installed kinds.",
		};
	}

	const resolvedOrgKinds = requestedKinds
		? orgKinds
		: args.agent_id
			? []
			: (["connectors"] as OrgInstalledKind[]);
	const resolvedAgentKinds = requestedKinds
		? agentKinds
		: args.agent_id
			? (["skills", "providers", "guardrails"] as AgentInstalledKind[])
			: [];

	const installed: Record<string, unknown> = {};

	const listOptions = { includeCatalog: Boolean(args.include_catalog) };

	if (resolvedOrgKinds.length > 0) {
		Object.assign(
			installed,
			await listOrgInstalled(
				ctx.organizationId,
				resolvedOrgKinds,
				ctx,
				listOptions,
			),
		);
	}

	if (args.agent_id && resolvedAgentKinds.length > 0) {
		Object.assign(
			installed,
			await listAgentInstalled(args.agent_id, resolvedAgentKinds, ctx, listOptions),
		);
	}

	return { action: "list_installed", installed };
}

const manageCatalogTool = defineActionTool("manage_catalog", {
	list_catalog: action(ListCatalogAction, (args) =>
		handleListCatalog(args as ListCatalogArgs),
	),
	list_installed: action(ListInstalledAction, (args, ctx) =>
		handleListInstalled(args as ListInstalledArgs, ctx),
	),
});

export { ManageCatalogResultSchema, ManageCatalogSchema };
export const manageCatalog = manageCatalogTool.run;
