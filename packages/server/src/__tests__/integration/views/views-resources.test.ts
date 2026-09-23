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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
		// Standard handshake + every delivery the loader accepts: the sandbox
		// push (Claude), the resource fetch for the tool-input key, and the
		// same-origin posted bundle.
		expect(html).toContain('ui/initialize');
		expect(html).toContain('resources/read');
		expect(html).toContain('ui/notifications/sandbox-resource-ready');
		expect(html).toContain('ui/notifications/tool-input');
		expect(html).toContain('lobu:views-bundle');
		// §10(a): the loader ships no ext-apps/React/framework bytes.
		expect(html).not.toContain('ext-apps');
		expect(html).not.toContain('react');
		expect(html.length).toBeLessThan(12288);
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
		// Unscoped, a view without a workspace attachment opens on its one type
		// tab. The view is the path and the query string is its declared params
		// alone — no host key.
		const url = new URL(result.structuredContent.url);
		expect(url.pathname).toBe('/views-org/company/-/views/board');
		expect(Object.fromEntries(url.searchParams)).toEqual({ by: 'stage' });
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

	it('open_view puts a type-scoped view under the type path', async () => {
		const result = await rpc('tools/call', {
			name: 'open_view',
			arguments: { key: 'board', scope: { type: 'company' } },
		});
		expect(new URL(result.structuredContent.url).pathname).toBe(
			'/views-org/company/-/views/board'
		);
	});

	it('open_view resolves entity scope through entities JOIN entity_types', async () => {
		const result = await rpc('tools/call', {
			name: 'open_view',
			arguments: { key: 'board', scope: { entity: entityId } },
		});
		expect(new URL(result.structuredContent.url).pathname).toMatch(
			/^\/views-org\/company\/[^/]+\/-\/views\/board$/
		);
		await expect(
			rpc('tools/call', {
				name: 'open_view',
				arguments: { key: 'board', scope: { entity: 999999 } },
			})
		).rejects.toThrow(/not found/);
	});

	/** Views that differ from `board` only in where they attach; removed after
	 *  each case so the listing tests below still see `board` alone. */
	const attachedViews: string[] = [];
	async function setAttachedView(key: string, attach: unknown[]) {
		attachedViews.push(key);
		await executeTool(
			'manage_views',
			{
				action: 'set',
				key,
				source_code: VIEW_SOURCE,
				attach,
				params: { by: { type: 'string', default: 'owner' } },
			},
			TEST_ENV,
			ownerCtx
		);
	}
	afterEach(async () => {
		for (const key of attachedViews.splice(0)) {
			await executeTool('manage_views', { action: 'remove', key }, TEST_ENV, ownerCtx);
		}
	});

	const openPath = async (args: Record<string, unknown>) =>
		new URL(
			(await rpc('tools/call', { name: 'open_view', arguments: args }))
				.structuredContent.url
		).pathname;

	it('open_view sends an unscoped workspace view to its Data hub tab', async () => {
		await setAttachedView('hub', [{ workspace: true }, { type: 'company', placement: 'tab' }]);
		expect(await openPath({ key: 'hub' })).toBe('/views-org/data/-/views/hub');
	});

	it('open_view refuses a link the host would render as a missing view', async () => {
		// A type page mounts only that type's tabs.
		await setAttachedView('deals', [{ type: 'deal', placement: 'tab' }]);
		await expect(
			openPath({ key: 'deals', scope: { type: 'company' } })
		).rejects.toThrow(/not a tab on type 'company'/);
		await expect(
			openPath({ key: 'deals', scope: { entity: entityId } })
		).rejects.toThrow(/not attached to entity/);
		// Two type tabs and no workspace attachment: there is no one page to pick.
		await setAttachedView('both', [
			{ type: 'company', placement: 'tab' },
			{ type: 'deal', placement: 'tab' },
		]);
		await expect(openPath({ key: 'both' })).rejects.toThrow(/pass scope.type/);
		// A record pin has no page of its own without the record.
		await setAttachedView('pinned', [{ entity: entityId, placement: 'tab' }]);
		await expect(openPath({ key: 'pinned' })).rejects.toThrow(/pass scope.entity/);
		expect(await openPath({ key: 'pinned', scope: { entity: entityId } })).toMatch(
			/^\/views-org\/company\/[^/]+\/-\/views\/pinned$/
		);
	});

	it('open_view opens an Overview card on the record page itself', async () => {
		await setAttachedView('card', [{ type: 'company', placement: 'overview' }]);
		// The card renders with its defaults, so the link carries no query.
		const card = await rpc('tools/call', {
			name: 'open_view',
			arguments: { key: 'card', scope: { entity: entityId } },
		});
		const url = new URL(card.structuredContent.url);
		expect(url.pathname).toMatch(/^\/views-org\/company\/[^/]+$/);
		expect(url.search).toBe('');
		expect(card.structuredContent.params).toEqual({ by: 'owner' });
		// Passing the default is the same card; any other value is not reproducible.
		expect(
			await openPath({ key: 'card', scope: { entity: entityId }, params: { by: 'owner' } })
		).toMatch(/^\/views-org\/company\/[^/]+$/);
		await expect(
			openPath({ key: 'card', scope: { entity: entityId }, params: { by: 'stage' } })
		).rejects.toThrow(/Overview card on that record, which takes no params \(by\)/);
		await expect(
			openPath({ key: 'card', scope: { type: 'company' } })
		).rejects.toThrow(/not a tab on type 'company'/);
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
		// Fetch-only data: text/plain plus nosniff so direct navigation can
		// never execute the authored bundle as application-origin script. The
		// web host fetches response.text() into its sandboxed srcdoc.
		expect(response.headers.get('content-type')).toContain('text/plain');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
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

	it('serves a CLI-supplied bundle verbatim in the shell', async () => {
		const sentinel = '/*lobu-pr2-shell-sentinel*/';
		await executeTool(
			'manage_views',
			{
				action: 'set',
				key: 'cli-bundle',
				source_code: 'export default function V() { return null; }\n',
				compiled_code: `${sentinel}console.log(1);`,
				attach: [],
			},
			TEST_ENV,
			ownerCtx
		);
		const response = await get(`/api/${org.slug}/views/cli-bundle/shell`, { token });
		expect(response.status).toBe(200);
		expect(await response.text()).toContain(sentinel);
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

	it('runs a camelCase action end to end over the web route', async () => {
		await executeTool(
			'manage_views',
			{
				action: 'set',
				key: 'pipeline2',
				source_code: VIEW_SOURCE,
				actions: { markWon: { emits: 'test.poked' } },
			},
			TEST_ENV,
			ownerCtx
		);
		const fired = await post(`/api/${org.slug}/views/pipeline2/actions/markWon`, {
			token,
			body: { value: { id: entityId }, interaction_id: 'web-markwon' },
		});
		expect(fired.status).toBe(200);
		const body = await fired.json();
		expect(body.event_type).toBe('test.poked');
		const sql = getTestDb();
		const rows = await sql`
      SELECT semantic_type, origin_type FROM events WHERE id = ${body.event_id}
    `;
		expect(rows[0]).toMatchObject({
			semantic_type: 'test.poked',
			origin_type: 'view_interaction',
		});
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

	it('signed-in OAuth nonmember cannot read per-view bundles on a public org', async () => {
		// A user who is a member only of a different workspace: admitted to
		// the public endpoint for discovery, but not a member of the target.
		const otherOrg = await createTestOrganization({
			name: 'Views Other Org',
			slug: 'views-other-org',
		});
		const outsider = await createTestUser({ email: 'views-outsider@test.com' });
		await addUserToOrganization(outsider.id, otherOrg.id, 'member');
		const outsiderClient = await createTestOAuthClient();
		const outsiderToken = (
			await createTestAccessToken(outsider.id, otherOrg.id, outsiderClient.client_id, {
				scope: 'mcp:read profile:read',
			})
		).token;
		const initRes = await post(`/mcp/${publicSlug}`, {
			body: {
				jsonrpc: '2.0',
				id: 'outsider-init',
				method: 'initialize',
				params: {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: 'outsider', version: '1.0' },
				},
			},
			token: outsiderToken,
		});
		const sessionId = initRes.headers.get('mcp-session-id');
		expect(sessionId).toBeTruthy();
		const readRes = await post(`/mcp/${publicSlug}`, {
			body: {
				jsonrpc: '2.0',
				id: 'outsider-read',
				method: 'resources/read',
				params: { uri: 'ui://lobu/views/board' },
			},
			headers: {
				'mcp-session-id': sessionId!,
				'mcp-protocol-version': MCP_PROTOCOL_VERSION,
			},
			token: outsiderToken,
		});
		const readJson = await readRes.json();
		expect(readJson.error?.message ?? '').toMatch(/membership|member/i);
		expect(JSON.stringify(readJson.result ?? null)).not.toContain('lobu-view');
		// Same caller is rejected by manage_views.get as well.
		const callRes = await post(`/mcp/${publicSlug}`, {
			body: {
				jsonrpc: '2.0',
				id: 'outsider-call',
				method: 'tools/call',
				params: { name: 'manage_views', arguments: { action: 'get', key: 'board' } },
			},
			headers: {
				'mcp-session-id': sessionId!,
				'mcp-protocol-version': MCP_PROTOCOL_VERSION,
			},
			token: outsiderToken,
		});
		const callJson = await callRes.json();
		expect(callJson.result?.isError ?? callJson.error).toBeTruthy();
		expect(JSON.stringify(callJson)).not.toContain('export default');
	});
});
