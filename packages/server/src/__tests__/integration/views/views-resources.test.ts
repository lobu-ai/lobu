/**
 * Views over MCP + REST: the generic loader resource, per-view shells,
 * open_view both return shapes, invoke_view_action dispatch, and the
 * structured (non-text-only) reads views depend on.
 *
 * Covers §10(b) one tool binds one stable resource, §10(c) outputSchema on
 * read tools instead of query_sql/isolated-vm, §10(d) the authenticated shell
 * route with no public counterpart, and §10(h) entity URL resolution.
 */
import { MCP_PROTOCOL_VERSION } from '@lobu/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeTool, type AuthContext } from '../../../tools/execute';
import type { Env } from '../../../index';
import { primeMemberEventKinds } from '../../../utils/event-kind-validation';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { LOBU_VIEWS_RESOURCE_URI } from '../../../views/views';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
	addUserToOrganization,
	createTestAccessToken,
	createTestEntity,
	createTestOAuthClient,
	createTestOrganization,
	createTestUser,
} from '../../setup/test-fixtures';
import { get, post } from '../../setup/test-helpers';

const TEST_ENV: Env = {
	ENVIRONMENT: 'test',
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: 'test-jwt-secret-for-testing-only',
	BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
	MAX_CONSECUTIVE_FAILURES: '3',
	RATE_LIMIT_ENABLED: 'false',
};

const VIEW_SOURCE = `export default function Board() { return null; }
export const view = { attach: [{ type: "deal", placement: "tab" }], params: { by: { type: "string", default: "owner" } }, actions: { retry: { emits: "test.poked" } } };
`;

describe('views resources + open_view + invoke_view_action', () => {
	let org: Awaited<ReturnType<typeof createTestOrganization>>;
	let owner: Awaited<ReturnType<typeof createTestUser>>;
	let token: string;
	let readlessToken: string;
	let ownerCtx: AuthContext;
	let entityId: number;

	async function rpc(method: string, params: unknown, id: number | string = 1) {
		const sessionId = await initSession();
		const response = await post(`/mcp/${org.slug}`, {
			body: { jsonrpc: '2.0', id, method, params },
			headers: {
				'mcp-session-id': sessionId,
				'mcp-protocol-version': MCP_PROTOCOL_VERSION,
			},
			token,
		});
		const json = await response.json();
		if (json.error) {
			throw new Error(`MCP Error [${json.error.code}]: ${json.error.message}`);
		}
		// Tool-level failures arrive resolved with isError (same convention
		// as the shared mcpToolsCall helper).
		if (json.result?.isError) {
			throw new Error(json.result.content?.[0]?.text ?? 'Tool execution failed');
		}
		return json.result;
	}

	async function initSession(sessionToken: string = token): Promise<string> {
		const initResponse = await post(`/mcp/${org.slug}`, {
			body: {
				jsonrpc: '2.0',
				id: '__views_init__',
				method: 'initialize',
				params: {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: 'lobu-test', version: '1.0' },
				},
			},
			token: sessionToken,
		});
		const sessionId = initResponse.headers.get('mcp-session-id');
		expect(sessionId).toBeTruthy();
		await post(`/mcp/${org.slug}`, {
			body: { jsonrpc: '2.0', method: 'notifications/initialized' },
			headers: {
				'mcp-session-id': sessionId!,
				'mcp-protocol-version': MCP_PROTOCOL_VERSION,
			},
			token: sessionToken,
		});
		return sessionId!;
	}

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		org = await createTestOrganization({ name: 'Views Org', slug: 'views-org' });
		owner = await createTestUser({ email: 'views-mcp@test.com' });
		await addUserToOrganization(owner.id, org.id, 'owner');
		const client = await createTestOAuthClient();
		token = (
			await createTestAccessToken(owner.id, org.id, client.client_id, {
				scope: 'mcp:admin mcp:write mcp:read profile:read',
			})
		).token;
		readlessToken = (
			await createTestAccessToken(owner.id, org.id, client.client_id, {
				scope: 'profile:read',
			})
		).token;
		ownerCtx = {
			organizationId: org.id,
			tokenOrganizationId: org.id,
			userId: owner.id,
			memberRole: 'owner',
			agentId: null,
			requestedAgentId: null,
			isAuthenticated: true,
			clientId: null,
			scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
			tokenType: 'oauth',
			requestUrl: `http://localhost/api/${org.id}`,
			baseUrl: '',
			scopedToOrg: true,
			allowCrossOrg: false,
		};
		await ensureMemberEntityType(org.id);
		const viewKinds = { 'test.poked': { description: 'A view action fired' } };
		const sql = getTestDb();
		await sql`
      UPDATE entity_types SET event_kinds = ${sql.json(viewKinds)}
      WHERE slug = '$member' AND organization_id = ${org.id}
    `;
		primeMemberEventKinds(org.id, viewKinds);
		const entity = await createTestEntity({
			name: 'Acme',
			entity_type: 'company',
			organization_id: org.id,
			created_by: owner.id,
		});
		entityId = entity.id;
		await executeTool(
			'manage_views',
			{
				action: 'set',
				key: 'board',
				name: 'Board',
				description: 'A board view',
				source_code: VIEW_SOURCE,
				attach: [{ type: 'company', placement: 'tab' }],
				params: { by: { type: 'string', default: 'owner' } },
				actions: { retry: { emits: 'test.poked' } },
			},
			TEST_ENV,
			ownerCtx
		);
	});

	afterAll(async () => {
		await cleanupTestDatabase();
	});

	it('lists the single stable loader resource', async () => {
		const result = await rpc('resources/list', {});
		const uris = result.resources.map((r: { uri: string }) => r.uri);
		// The id is literal: hosts cache the listed id at connect time, so a
		// bump breaks already-connected users (same rule as the interaction
		// shell). Per-view bundles are NOT listed: the listed id must stay
		// stable while views come and go.
		expect(uris).toContain('ui://lobu/views');
		expect(uris).not.toContain('ui://lobu/views/board');
		const loader = result.resources.find(
			(r: { uri: string }) => r.uri === LOBU_VIEWS_RESOURCE_URI
		);
		expect(loader.mimeType).toBe('text/html;profile=mcp-app');
		expect(loader._meta.ui).toBeDefined();
	});

	it('reads the loader shell: hand-written, no guest SDK chain', async () => {
		const result = await rpc('resources/read', {
			uri: LOBU_VIEWS_RESOURCE_URI,
		});
		const html = result.contents[0].text as string;
		expect(result.contents[0].mimeType).toBe('text/html;profile=mcp-app');
		expect(html).toContain('lobu-views-loader');
		expect(html).toContain('lobu:views-loader-ready');
		// §10(a): the loader ships no ext-apps/React/framework bytes.
		expect(html).not.toContain('ext-apps');
		expect(html).not.toContain('react');
		expect(html.length).toBeLessThan(8192);
	});

	it('loader only accepts bundle messages from the host frame', async () => {
		const result = await rpc('resources/read', {
			uri: LOBU_VIEWS_RESOURCE_URI,
		});
		const html = result.contents[0].text as string;
		// Literal: the listener drops messages from any other source, so a
		// malicious frame cannot inject bundle HTML into the view.
		expect(html).toContain('event.source !== window.parent');
	});

	it('reads a per-view shell with the bundle inlined', async () => {
		const result = await rpc('resources/read', {
			uri: 'ui://lobu/views/board',
		});
		const html = result.contents[0].text as string;
		expect(html).toContain('name="lobu-view" content="board"');
		expect(html).toContain('name="lobu-view-hash"');
		expect(html).toContain('<div id="root"></div>');
		// The inlined bundle is view code plus the react allowlist only: no
		// server tool names may leak into a served shell.
		expect(html).not.toContain('invoke_view_action');
		expect(html).not.toContain('manage_view_templates');
		// No relative asset URLs and no <base href>: claude.ai hardcodes
		// base-uri 'self', so both would 404 there.
		expect(html).not.toMatch(/src="\.\//);
		expect(html).not.toContain('<base');
	});

	it('fails closed on a removed view resource', async () => {
		await expect(
			rpc('resources/read', { uri: 'ui://lobu/views/gone' })
		).rejects.toThrow(/Unknown resource/);
	});

	it('requires read scope for per-view bundle reads', async () => {
		const sessionId = await initSession(readlessToken);
		const response = await post(`/mcp/${org.slug}`, {
			body: {
				jsonrpc: '2.0',
				id: 'readless',
				method: 'resources/read',
				params: { uri: 'ui://lobu/views/board' },
			},
			headers: {
				'mcp-session-id': sessionId,
				'mcp-protocol-version': MCP_PROTOCOL_VERSION,
			},
			token: readlessToken,
		});
		const json = await response.json();
		expect(json.error?.message ?? '').toMatch(/read access/);
	});

	it('lists open_view bound to the loader with an outputSchema', async () => {
		const result = await rpc('tools/list', {});
		const openView = result.tools.find(
			(t: { name: string }) => t.name === 'open_view'
		);
		expect(openView).toBeDefined();
		// One tool binds ONE stable resource (literal: the binding is the
		// host's cache key, never a per-view uri).
		expect(openView._meta.ui.resourceUri).toBe('ui://lobu/views');
		expect(openView._meta['openai/outputTemplate']).toBe(
			LOBU_VIEWS_RESOURCE_URI
		);
		expect(openView.outputSchema).toBeDefined();
		// invoke_view_action stays app-only: hidden from the list, callable
		// by name from a rendered frame.
		expect(
			result.tools.some((t: { name: string }) => t.name === 'invoke_view_action')
		).toBe(false);
	});

	it('open_view returns the frame shape: per-view resource + canonical params', async () => {
		const result = await rpc('tools/call', {
			name: 'open_view',
			arguments: { key: 'board', params: { by: 'stage', extra: 'ignored' } },
		});
		expect(result.structuredContent.view).toBe('board');
		expect(result.structuredContent.resource).toBe('ui://lobu/views/board');
		// Declared params validate; unknown names are ignored.
		expect(result.structuredContent.params).toEqual({ by: 'stage' });
		expect(result.structuredContent.url).toContain('?view=board');
		expect(result.structuredContent.url).toContain('by=stage');
		expect(result.structuredContent.url).not.toContain('extra');
		// The result binds the stable loader id, not the per-view one.
		expect(result._meta['openai/outputTemplate']).toBe(
			LOBU_VIEWS_RESOURCE_URI
		);
	});

	it('open_view fills param defaults and rejects mistyped params', async () => {
		const result = await rpc('tools/call', {
			name: 'open_view',
			arguments: { key: 'board' },
		});
		expect(result.structuredContent.params).toEqual({ by: 'owner' });
		await expect(
			rpc('tools/call', {
				name: 'open_view',
				arguments: { key: 'board', params: { by: 42 } },
			})
		).rejects.toThrow(/must be a string/);
	});

	it('open_view resolves entity scope through entities JOIN entity_types', async () => {
		const result = await rpc('tools/call', {
			name: 'open_view',
			arguments: { key: 'board', scope: { entity: entityId } },
		});
		expect(result.structuredContent.url).toContain('/views-org/company/');
		expect(result.structuredContent.url).toContain('?view=board');
		await expect(
			rpc('tools/call', {
				name: 'open_view',
				arguments: { key: 'board', scope: { entity: 999999 } },
			})
		).rejects.toThrow(/not found/);
	});

	it('open_view 404s an unknown view', async () => {
		await expect(
			rpc('tools/call', { name: 'open_view', arguments: { key: 'gone' } })
		).rejects.toThrow(/Unknown view/);
	});

	it('manage_connections reads stay structured over MCP (no text-only fallback)', async () => {
		const list = await rpc('tools/call', {
			name: 'manage_connections',
			arguments: { action: 'list' },
		});
		expect(list.structuredContent).toBeDefined();
		const views = await rpc('tools/call', {
			name: 'manage_views',
			arguments: { action: 'list' },
		});
		expect(views.structuredContent.views).toHaveLength(1);
		expect(views.structuredContent.views[0].key).toBe('board');
	});

	it('invoke_view_action dispatches by name with structured content', async () => {
		const result = await rpc('tools/call', {
			name: 'invoke_view_action',
			arguments: { view: 'board', action: 'retry', interaction_id: 'mcp-9' },
		});
		expect(result.structuredContent.created).toBe(true);
		expect(result.structuredContent.event_type).toBe('test.poked');
		expect(result.structuredContent.event_id).toBeGreaterThan(0);
	});

	it('serves the shell over the authenticated route with hash headers', async () => {
		const response = await get(`/api/${org.slug}/views/board/shell`, { token });
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/html');
		expect(response.headers.get('x-lobu-view-hash')).toMatch(/^[0-9a-f]{16}$/);
		expect(Number(response.headers.get('x-lobu-view-bytes'))).toBeGreaterThan(0);
		const html = await response.text();
		expect(html).toContain('name="lobu-view" content="board"');

		const missing = await get(`/api/${org.slug}/views/gone/shell`, { token });
		expect(missing.status).toBe(404);
	});

	it('rejects the shell route without read scope', async () => {
		const denied = await get(`/api/${org.slug}/views/board/shell`, {
			token: readlessToken,
		});
		expect(denied.status).toBe(403);
	});

	it('fires actions over the web route and validates the body', async () => {
		const fired = await post(`/api/${org.slug}/views/board/actions/retry`, {
			token,
			body: { value: { id: entityId }, interaction_id: 'web-1' },
		});
		expect(fired.status).toBe(200);
		const body = await fired.json();
		expect(body.created).toBe(true);
		expect(body.event_type).toBe('test.poked');

		const sql = getTestDb();
		const rows = await sql`
      SELECT origin_type FROM events WHERE id = ${body.event_id}
    `;
		expect(rows[0].origin_type).toBe('view_interaction');

 	 const missingId = await post(`/api/${org.slug}/views/board/actions/retry`, {
			token,
			body: { value: null },
		});
		expect(missingId.status).toBe(400);
	});
});

describe('views on a public org stay signed-in-only', () => {
	let publicSlug: string;

	async function anonymousRpc(method: string, params: unknown) {
		const initRes = await post(`/mcp/${publicSlug}`, {
			body: {
				jsonrpc: '2.0',
				id: 'anon-init',
				method: 'initialize',
				params: {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: 'public-visitor', version: '1.0' },
				},
			},
		});
		const sessionId = initRes.headers.get('mcp-session-id');
		expect(sessionId).toBeTruthy();
		const res = await post(`/mcp/${publicSlug}`, {
			body: { jsonrpc: '2.0', id: 'anon-1', method, params },
			headers: { 'mcp-session-id': sessionId!, 'mcp-protocol-version': MCP_PROTOCOL_VERSION },
		});
		return res.json();
	}

	beforeAll(async () => {
		const publicOrg = await createTestOrganization({
			name: 'Views Public Org',
			slug: 'views-public-org',
			visibility: 'public',
		});
		publicSlug = publicOrg.slug;
		const pubOwner = await createTestUser({ email: 'views-public@test.com' });
		await addUserToOrganization(pubOwner.id, publicOrg.id, 'owner');
		const pubCtx: AuthContext = {
			organizationId: publicOrg.id,
			tokenOrganizationId: publicOrg.id,
			userId: pubOwner.id,
			memberRole: 'owner',
			agentId: null,
			requestedAgentId: null,
			isAuthenticated: true,
			clientId: null,
			scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
			tokenType: 'oauth',
			requestUrl: `http://localhost/api/${publicOrg.id}`,
			baseUrl: '',
			scopedToOrg: true,
			allowCrossOrg: false,
		};
		await executeTool(
			'manage_views',
			{
				action: 'set',
				key: 'board',
				source_code: VIEW_SOURCE,
				attach: [{ type: 'company', placement: 'tab' }],
				actions: { retry: { emits: 'test.poked' } },
			},
			TEST_ENV,
			pubCtx
		);
	});

	it('anonymous resources/read cannot retrieve the per-view bundle', async () => {
		const json = await anonymousRpc('resources/read', {
			uri: 'ui://lobu/views/board',
		});
		expect(json.error?.message ?? '').toMatch(/auth|sign|login/i);
		expect(JSON.stringify(json.result ?? null)).not.toContain('lobu-view');
	});

	it('anonymous tools/call cannot read view source via manage_views', async () => {
		const json = await anonymousRpc('tools/call', {
			name: 'manage_views',
			arguments: { action: 'get', key: 'board' },
		});
		expect(json.result?.isError ?? json.error).toBeTruthy();
		expect(JSON.stringify(json)).not.toContain('export default');
	});

	it('anonymous REST cannot read view source via manage_views', async () => {
		const res = await post(`/api/${publicSlug}/manage_views`, {
			body: { action: 'get', key: 'board' },
		});
		expect(res.status).not.toBe(200);
		expect(await res.text()).not.toContain('export default');
	});

	it('anonymous tools/list hides manage_views', async () => {
		const json = await anonymousRpc('tools/list', {});
		const names = (json.result?.tools as Array<{ name: string }>).map(
			(t) => t.name
		);
		expect(names).not.toContain('manage_views');
	});
});
