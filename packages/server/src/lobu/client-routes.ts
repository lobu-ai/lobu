import { Hono } from "hono";
import { mcpAuth } from "../auth/middleware";
import { OAuthClientsStore } from "../auth/oauth/clients";
import { getDb, pgTextArray } from "../db/client";
import type { Env } from "../index";
import { revokeInMemoryMcpSessionsForClient } from "../mcp-handler";
import { orgContext } from "./stores/org-context";

const routes = new Hono<{ Bindings: Env }>();

type MessagingClientRecord = {
	id: string;
	kind: "messaging";
	title: string;
	identifier: string | null;
	platform: string;
	assignedAgentId: string;
	assignedAgentName: string;
	status: string;
	authState: string;
	lastSeenAt: number;
	userAgent: null;
	capabilities: null;
	externalUrl: string | null;
	linkedUserName: null;
	linkedUserEmail: null;
	linkedUserEntitySlug: null;
	details: {
		connectionId: string | null;
		description: string | null;
		connectionMetadata: Record<string, unknown> | null;
	};
};

function withOrg(c: any, fn: () => Promise<Response>): Promise<Response> {
	const organizationId = c.get("organizationId");
	if (!organizationId) {
		return Promise.resolve(c.json({ error: "Organization required" }, 401));
	}
	return orgContext.run({ organizationId }, fn);
}

function withOrgAdmin(c: any, fn: () => Promise<Response>): Promise<Response> {
	return withOrg(c, async () => {
		const role = c.get("memberRole");
		if (role !== "owner" && role !== "admin") {
			return c.json(
				{ error: "Revoking a connected client requires an owner or admin." },
				403,
			);
		}
		return fn();
	});
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asTimestamp(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	if (value instanceof Date) return value.getTime();
	return null;
}

function asNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

/**
 * Platforms that publish a person's chat identity as a web profile, mapped to
 * the builder for that link. Each one normalizes its own identifier shape —
 * Telegram a handle, WhatsApp a phone number — and returns null when the value
 * it was handed is not one, so a malformed identifier renders as plain text
 * rather than a broken link. Only the platforms listed get a link at all; a
 * Map, not an object, so a platform named `constructor` resolves nothing.
 */
const MESSAGING_PROFILE_URLS = new Map<
	string,
	(identifier: string) => string | null
>([
	[
		"telegram",
		(identifier) => {
			const handle = identifier.replace(/^@/, "").trim();
			return /^[a-zA-Z][a-zA-Z0-9_]{3,}$/.test(handle)
				? `https://t.me/${handle}`
				: null;
		},
	],
	[
		"whatsapp",
		(identifier) => {
			const digits = identifier.replace(/[^\d]/g, "");
			return digits ? `https://wa.me/${digits}` : null;
		},
	],
]);

function externalUrlForMessagingIdentity(
	platform: string,
	identifier?: string | null,
): string | null {
	if (!identifier) return null;
	return MESSAGING_PROFILE_URLS.get(platform)?.(identifier) ?? null;
}

/**
 * Messaging clients = rows in `agent_users` (one per platform user that has
 * messaged an agent). Each `(agent_id, platform, user_id)` is a single
 * messaging client visible to admins.
 */
async function listMessagingClients(options: {
	organizationId: string;
	agentId?: string | null;
}): Promise<MessagingClientRecord[]> {
	const sql = getDb();
	const rows = (await sql`
    SELECT
      au.agent_id,
      au.platform,
      au.user_id,
      au.created_at,
      a.name AS agent_name
    FROM agent_users au
    JOIN agents a
      ON a.organization_id = au.organization_id AND a.id = au.agent_id
    WHERE au.organization_id = ${options.organizationId}
      ${options.agentId ? sql`AND au.agent_id = ${options.agentId}` : sql``}
    ORDER BY au.created_at DESC
  `) as Array<{
		agent_id: string;
		platform: string;
		user_id: string;
		created_at: unknown;
		agent_name: string;
	}>;

	return rows.map((row) => {
		const lastSeenAt = asTimestamp(row.created_at) ?? Date.now();
		const platform = row.platform || "messaging";
		return {
			id: `${row.agent_id}:${row.platform}:${row.user_id}`,
			kind: "messaging" as const,
			title: row.user_id || `${platform} user`,
			identifier: row.user_id,
			platform,
			assignedAgentId: row.agent_id,
			assignedAgentName: row.agent_name,
			status: "linked",
			authState: "linked",
			lastSeenAt,
			userAgent: null,
			capabilities: null,
			externalUrl: externalUrlForMessagingIdentity(platform, row.user_id),
			linkedUserName: null,
			linkedUserEmail: null,
			linkedUserEntitySlug: null,
			details: {
				connectionId: null,
				description: null,
				connectionMetadata: null,
			},
		};
	});
}

export async function countRuntimeMessagingClientsByAgent(
	organizationId: string,
): Promise<Map<string, Set<string>>> {
	const clients = await listMessagingClients({ organizationId });
	const counts = new Map<string, Set<string>>();

	for (const client of clients) {
		let ids = counts.get(client.assignedAgentId);
		if (!ids) {
			ids = new Set<string>();
			counts.set(client.assignedAgentId, ids);
		}
		ids.add(client.id);
	}

	return counts;
}

routes.get("/", mcpAuth, async (c) => {
	return withOrg(c, async () => {
		const organizationId = c.get("organizationId") as string;
		const agentId = c.req.query("agentId")?.trim() || null;
		const sql = getDb();
		const oauthClientsStore = new OAuthClientsStore(sql);
		const oauthClients =
			await oauthClientsStore.listClientsByOrganization(organizationId);

		const memberEntitySlugs = new Map<string, string>();
		const ownerUserIds = [
			...new Set(
				oauthClients
					.map((client) => client.owner_user_id)
					.filter((userId): userId is string => Boolean(userId)),
			),
		];
		if (ownerUserIds.length > 0) {
			const rows = await sql`
        SELECT ei.identifier AS user_id, e.slug
        FROM entity_identities ei
        JOIN entities e
          ON e.id = ei.entity_id
         AND e.organization_id = ei.organization_id
         AND e.deleted_at IS NULL
        JOIN entity_types et
          ON et.id = e.entity_type_id
         AND et.organization_id = e.organization_id
         AND et.slug = '$member'
        WHERE ei.organization_id = ${organizationId}
          AND ei.namespace = 'auth_user_id'
          AND ei.scope_key IS NULL
          AND ei.source_connector = 'auth:signup'
          AND ei.deleted_at IS NULL
          AND ei.identifier = ANY(${pgTextArray(ownerUserIds)}::text[])
      `;
			for (const row of rows as Array<{ user_id: string; slug: string }>) {
				memberEntitySlugs.set(row.user_id, row.slug);
			}
		}

		// MCP registrations are Connected Apps, not agent assignments. An
		// agent-filtered inventory therefore contains messaging identities only.
		const mcpClients = (agentId ? [] : oauthClients)
			.map((client) => {
				const metadata = asRecord(client.metadata);
				const clientInfo = asRecord(metadata?.last_client_info);
				const capabilities = asRecord(metadata?.last_capabilities);
				const lastSeenAt =
					asTimestamp(metadata?.last_seen_at) ??
					client.client_id_issued_at * 1000;
				// Identity is what the client REGISTERED as. `clientInfo.name` is
				// rewritten on every MCP `initialize` and names the process
				// driving the connection, not the app — an Owletto Mac build
				// driven by the Claude Code SDK reports `claude-code`. Letting it
				// win renamed every row on prod (19/19 mismatched, 2026-07-30).
				// It stays available as `drivenBy`, which is a real question.
				const registeredName = asNonEmptyString(client.client_name);
				const drivenBy = asNonEmptyString(clientInfo?.name);
				const title = registeredName || drivenBy;
				const softwareId = asNonEmptyString(client.software_id);
				const linkedMemberSlug = client.owner_user_id
					? memberEntitySlugs.get(client.owner_user_id)
					: null;

				return {
					id: client.client_id,
					kind: "mcp" as const,
					title,
					drivenBy,
					registrationGroupKey:
						client.client_name && client.owner_user_id
							? JSON.stringify([
									client.client_name,
									client.owner_user_id,
									organizationId,
								])
							: client.client_id,
					identifier: client.client_id,
					platform: softwareId,
					status: client.active_token_count > 0 ? "connected" : "disconnected",
					authState: client.active_token_count > 0 ? "authorized" : "revoked",
					lastSeenAt,
					userAgent:
						typeof metadata?.last_user_agent === "string"
							? metadata.last_user_agent
							: null,
					capabilities,
					externalUrl:
						typeof client.client_uri === "string" &&
						client.client_uri.length > 0
							? client.client_uri
							: null,
					linkedUserName: client.user_name ?? null,
					linkedUserEmail: client.user_email ?? null,
					linkedUserEntitySlug: linkedMemberSlug ?? null,
					details: {
						softwareVersion: client.software_version ?? null,
						redirectUris: client.redirect_uris,
						activeTokenCount: client.active_token_count,
						clientInfo,
					},
				};
			});

		const messagingClients = await listMessagingClients({
			organizationId,
			agentId,
		});

		const clients = [...mcpClients, ...messagingClients].sort((a, b) => {
			const aSeen = a.lastSeenAt ?? 0;
			const bSeen = b.lastSeenAt ?? 0;
			return bSeen - aSeen;
		});

		return c.json({ clients });
	});
});

routes.delete("/mcp/:clientId", mcpAuth, async (c) => {
	return withOrgAdmin(c, async () => {
		const organizationId = c.get("organizationId") as string;
		const clientId = c.req.param("clientId");
		if (!clientId) {
			return c.json({ error: "Client ID is required" }, 400);
		}
		const sql = getDb();

		const rows = await sql`
	      SELECT
	        oc.id,
	        oc.client_name,
	        COALESCE(org_token.user_id, grant_code.user_id) AS owner_user_id
	      FROM oauth_clients oc
	      LEFT JOIN LATERAL (
	        SELECT ot.user_id
	        FROM oauth_tokens ot
	        WHERE ot.client_id = oc.id
	          AND (
	            ot.organization_id = ${organizationId}
	            OR ot.granted_organization_ids @> ${pgTextArray([organizationId])}::text[]
	          )
	        -- Keep this live-first ordering identical to the inventory query so
	        -- the displayed identity and revoked grant cannot diverge.
	        ORDER BY
	          (ot.revoked_at IS NULL AND ot.expires_at > NOW()) DESC,
	          ot.created_at DESC,
	          ot.id DESC
	        LIMIT 1
	      ) org_token ON true
	      LEFT JOIN LATERAL (
	        SELECT grant_row.user_id
	        FROM (
	          SELECT ac.user_id, ac.created_at, ac.code AS grant_id
	          FROM oauth_authorization_codes ac
	          WHERE ac.client_id = oc.id
	            AND ac.expires_at > NOW()
	            AND (
	              ac.organization_id = ${organizationId}
	              OR ac.granted_organization_ids @> ${pgTextArray([organizationId])}::text[]
	            )
	          UNION ALL
	          SELECT dc.user_id, dc.created_at, dc.device_code AS grant_id
	          FROM oauth_device_codes dc
	          WHERE dc.client_id = oc.id
	            AND dc.user_id IS NOT NULL
	            AND dc.status = 'approved'
	            AND dc.expires_at > NOW()
	            AND (
	              dc.organization_id = ${organizationId}
	              OR dc.granted_organization_ids @> ${pgTextArray([organizationId])}::text[]
	            )
	        ) grant_row
	        ORDER BY grant_row.created_at DESC, grant_row.grant_id DESC
	        LIMIT 1
	      ) grant_code ON true
	      WHERE oc.id = ${clientId}
	        AND (
	          oc.organization_id = ${organizationId}
	          OR org_token.user_id IS NOT NULL
	          OR grant_code.user_id IS NOT NULL
	        )
	      LIMIT 1
	    `;

		if (rows.length === 0) {
			return c.json({ error: "Client not found" }, 404);
		}

		const revokeAll = c.req.query("scope") === "all";
		let targetIds = [clientId];
		const target = rows[0] as {
			client_name: string | null;
			owner_user_id: string | null;
		};
		if (revokeAll && target.client_name && target.owner_user_id) {
			const siblings = await sql`
	        SELECT sibling.id
	        FROM oauth_clients sibling
	        LEFT JOIN LATERAL (
	          SELECT ot.user_id
	          FROM oauth_tokens ot
	          WHERE ot.client_id = sibling.id
	            AND (
	              ot.organization_id = ${organizationId}
	              OR ot.granted_organization_ids @> ${pgTextArray([organizationId])}::text[]
	            )
	          ORDER BY
	            (ot.revoked_at IS NULL AND ot.expires_at > NOW()) DESC,
	            ot.created_at DESC,
	            ot.id DESC
	          LIMIT 1
	        ) org_token ON true
	        LEFT JOIN LATERAL (
	          SELECT grant_row.user_id
	          FROM (
	            SELECT ac.user_id, ac.created_at, ac.code AS grant_id
	            FROM oauth_authorization_codes ac
	            WHERE ac.client_id = sibling.id
	              AND ac.expires_at > NOW()
	              AND (
	                ac.organization_id = ${organizationId}
	                OR ac.granted_organization_ids @> ${pgTextArray([organizationId])}::text[]
	              )
	            UNION ALL
	            SELECT dc.user_id, dc.created_at, dc.device_code AS grant_id
	            FROM oauth_device_codes dc
	            WHERE dc.client_id = sibling.id
	              AND dc.user_id IS NOT NULL
	              AND dc.status = 'approved'
	              AND dc.expires_at > NOW()
	              AND (
	                dc.organization_id = ${organizationId}
	                OR dc.granted_organization_ids @> ${pgTextArray([organizationId])}::text[]
	              )
	          ) grant_row
	          ORDER BY grant_row.created_at DESC, grant_row.grant_id DESC
	          LIMIT 1
	        ) grant_code ON true
	        WHERE sibling.client_name = ${target.client_name}
	          AND COALESCE(org_token.user_id, grant_code.user_id) = ${target.owner_user_id}
	          AND (
	            sibling.organization_id = ${organizationId}
	            OR org_token.user_id IS NOT NULL
	            OR grant_code.user_id IS NOT NULL
	          )
	        ORDER BY sibling.id
	      `;
			const ids = (siblings as Array<{ id: string }>).map((r) => r.id);
			if (ids.length > 0) targetIds = ids;
		}

		// A registration can carry grants for several people, so scope the
		// operation to the owner represented by this inventory row.
		const clientsStore = new OAuthClientsStore(sql);
		for (const id of targetIds) {
			await clientsStore.revokeClientForOrganization(
				id,
				organizationId,
				target.owner_user_id,
			);
			await revokeInMemoryMcpSessionsForClient(
				id,
				organizationId,
				target.owner_user_id,
			);
		}
		return c.json({ success: true, revokedClientIds: targetIds });
	});
});

export { routes as clientRoutes };
