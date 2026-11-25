import { Hono } from "hono";
import { mcpAuth } from "../auth/middleware";
import { extractAuthContext, toToolContext } from "../tools/execute";
import type { Env } from "../index";
import { orgContext } from "../lobu/stores/org-context";
import { restErrorResponse } from "../rest-api";
import {
	listAgentInstalled,
	listOrgInstalled,
	parseKindsParam,
} from "./installed";
import { listCatalogEntries } from "./load";
import { parseIncludeCatalog } from "./merge";
import { buildCatalogListResponse } from "./responses";
import {
	AGENT_INSTALLED_KINDS,
	type AgentInstalledKind,
	CATALOG_KINDS,
	type CatalogKind,
	ORG_INSTALLED_KINDS,
	type OrgInstalledKind,
} from "./types";

// A handler's error is answered as every REST route answers it: a caller's
// ToolUserError (such as a policy denial) at its own status, anything
// else as a reported 500.
const globalCatalogRoutes = new Hono<{ Bindings: Env }>();
globalCatalogRoutes.onError((error, c) => restErrorResponse(c, error));

globalCatalogRoutes.get("/", async (c) => {
	const kinds = parseKindsParam(c.req.query("kinds"), CATALOG_KINDS);
	const all = await listCatalogEntries(kinds as CatalogKind[]);
	return c.json(buildCatalogListResponse(kinds as CatalogKind[], all));
});

const orgInstalledRoutes = new Hono<{ Bindings: Env }>();
orgInstalledRoutes.onError((error, c) => restErrorResponse(c, error));

orgInstalledRoutes.use("*", mcpAuth);
orgInstalledRoutes.use("*", async (c, next) => {
	const orgId = c.get("organizationId");
	if (!orgId) return c.json({ error: "Organization required" }, 401);
	return orgContext.run({ organizationId: orgId }, next);
});

orgInstalledRoutes.get("/", async (c) => {
	const kinds = parseKindsParam(c.req.query("kinds"), ORG_INSTALLED_KINDS);
	const includeCatalog = parseIncludeCatalog(c.req.query("include"));
	const installed = await listOrgInstalled(
		c.get("organizationId")!,
		kinds as OrgInstalledKind[],
		{
			organizationId: c.get("organizationId")!,
			userId: c.get("user")?.id ?? null,
			memberRole: c.get("memberRole") ?? null,
			isAuthenticated: Boolean(c.get("user")),
		},
		{ includeCatalog },
	);
	return c.json({ installed });
});

orgInstalledRoutes.get("/agents/:agentId/installed", async (c) => {
	const kinds = parseKindsParam(c.req.query("kinds"), AGENT_INSTALLED_KINDS);
	const { agentId } = c.req.param();
	const includeCatalog = parseIncludeCatalog(c.req.query("include"));
	const installed = await listAgentInstalled(
		agentId,
		kinds as AgentInstalledKind[],
		toToolContext(extractAuthContext(c)),
		{ includeCatalog },
	);
	return c.json({ installed });
});

export { globalCatalogRoutes, orgInstalledRoutes };
