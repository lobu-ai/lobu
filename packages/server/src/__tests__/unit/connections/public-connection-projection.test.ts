import { describe, expect, it } from "bun:test";
import { projectConnectionForReader } from "../../../tools/admin/manage_connections/public-projection";
import type { ToolContext } from "../../../tools/registry";

const FULL_ROW: Record<string, unknown> = {
	id: 42,
	slug: "capterra-main",
	display_name: "Capterra",
	connector_key: "capterra",
	connector_name: "Capterra",
	status: "active",
	visibility: "org",
	created_at: "2026-05-01T00:00:00Z",
	updated_at: "2026-05-02T00:00:00Z",
	feed_count: 3,
	data_feed_count: 2,
	entity_ids: [1, 2],
	entity_names: "Acme, Globex",
	declares_chat: false,
	has_feeds_schema: true,
	has_operations: true,
	operations_summary: { total: 2 },
	facets: { data: true },
	connect_token: "ct_live_abc123",
	credentials: { token: "secret" },
	credential_mode: "byo",
	effective_credential_mode: "byo",
	config: { host: "internal.example" },
	created_by: "synthetic-owner",
	created_by_username: "synthetic-owner",
	account_id: "acct_9",
	external_tenant_id: "T0192",
	agent_id: "atlas-curator",
	auth_profile_id: 7,
	auth_profile_slug: "gh-main",
	auth_profile_name: "GitHub main",
	auth_profile_status: "active",
	auth_profile_kind: "oauth",
	app_auth_profile_id: 8,
	app_auth_profile_slug: "gh-app",
	app_auth_profile_name: "GitHub app",
	app_auth_profile_status: "active",
	app_auth_profile_kind: "app",
	device_label: "Synthetic Mac",
	device_platform: "darwin",
	device_worker_id: "dw_5",
	device_worker_handle: "worker-5",
	device_last_seen_at: "2026-07-30T00:00:00Z",
	device_online: true,
	device_status: null,
	error_message: "connection refused to 10.1.2.3",
	unhealthy_alerted_at: null,
	deleted_at: null,
	organization_id: "org_synthetic_projection",
};

const PUBLIC_ROW = {
	id: 42,
	slug: "capterra-main",
	display_name: "Capterra",
	connector_key: "capterra",
	connector_name: "Capterra",
	status: "active",
	visibility: "org",
	created_at: "2026-05-01T00:00:00Z",
	updated_at: "2026-05-02T00:00:00Z",
	feed_count: 3,
	data_feed_count: 2,
	entity_ids: [1, 2],
	entity_names: "Acme, Globex",
	declares_chat: false,
	has_feeds_schema: true,
	has_operations: true,
	operations_summary: { total: 2 },
	facets: { data: true },
};

function ctxWith(memberRole: string | null): ToolContext {
	return {
		organizationId: "org_synthetic_projection",
		userId: memberRole ? "synthetic-owner" : null,
		memberRole,
		isAuthenticated: !!memberRole,
	} as ToolContext;
}

describe("public connection projection", () => {
	it("returns only discovery metadata to an anonymous reader", () => {
		expect(projectConnectionForReader(FULL_ROW, ctxWith(null))).toEqual(
			PUBLIC_ROW
		);
	});

	it("withholds a live connect token specifically", () => {
		const projected = projectConnectionForReader(FULL_ROW, ctxWith(null));

		expect(projected.connect_token).toBeUndefined();
		expect(Object.values(projected)).not.toContain("ct_live_abc123");
	});

	it("applies the same projection to an authenticated non-member", () => {
		const projected = projectConnectionForReader(FULL_ROW, {
			...ctxWith(null),
			userId: "u_outsider",
			isAuthenticated: true,
		} as ToolContext);

		expect(projected).toEqual(PUBLIC_ROW);
	});

	it("leaves a member's row untouched", () => {
		for (const role of ["owner", "admin", "member"]) {
			expect(projectConnectionForReader(FULL_ROW, ctxWith(role))).toBe(FULL_ROW);
		}
	});

	it("keeps system metadata without exposing a human authorization link", () => {
		// An automation reaction: userId null, isAuthenticated true, tokenType
		// 'session' (automations/reaction-executor.ts). It reads credential_mode /
		// error_message / device fields, so narrowing it would break reactions.
		const systemCtx = {
			...ctxWith(null),
			isAuthenticated: true,
			tokenType: "session",
		} as ToolContext;

		const { connect_token: _token, ...metadata } = FULL_ROW;
		expect(projectConnectionForReader(FULL_ROW, systemCtx)).toEqual(metadata);
	});

	it.each(["owner", "admin", "member"])("withholds another owner's connect token from a %s", (role) => {
		const result = projectConnectionForReader(FULL_ROW, { ...ctxWith(role), userId: "synthetic-other-user" });
		expect(result.connect_token).toBeUndefined();
		expect(result.created_by).toBe("synthetic-owner");
	});

	it("does not treat a userId-less TOKEN as a system caller", () => {
		// `multi-tenant.ts` builds token auth as `userId: tokenData.userId ||
		// undefined`, so a token minted without a user presents the same
		// (isAuthenticated, userId:null, memberRole:null) shape a reaction does.
		// On a public org such a token could reach this handler as a non-member;
		// it must NOT collect a live connect_token.
		for (const tokenType of ["pat", "access_token", "Bearer", "anonymous"]) {
			const tokenCtx = {
				...ctxWith(null),
				isAuthenticated: true,
				tokenType,
				clientId: "cli_external",
			} as unknown as ToolContext;

			expect(projectConnectionForReader(FULL_ROW, tokenCtx)).toEqual(PUBLIC_ROW);
		}
	});

	it("is an allow-list, so an unknown future column is withheld by default", () => {
		const projected = projectConnectionForReader(
			{ ...FULL_ROW, some_future_secret: "leak" },
			ctxWith(null)
		);

		expect(projected).not.toHaveProperty("some_future_secret");
		expect(projected).toEqual(PUBLIC_ROW);
	});
});
