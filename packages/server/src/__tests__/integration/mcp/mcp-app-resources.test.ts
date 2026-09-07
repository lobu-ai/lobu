import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_PROTOCOL_VERSION } from '@lobu/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../../../auth/oauth/utils';
import { getDb } from '../../../db/client';
import type { Env } from '../../../index';
import { LOBU_INTERACTION_RESOURCE_URI } from '../../../mcp-app-resource-uris';
import { clearInMemoryMcpSessionsForTests } from '../../../mcp-handler';
import { buildClientSDK } from '../../../sandbox/client-sdk';
import type { ToolContext } from '../../../tools/registry';
import { insertEvent } from '../../../utils/insert-event';
import { mcpAppAssetVersion } from '../../../utils/mcp-app-bundle';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestAgent,
  createTestConnection,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { get, post } from '../../setup/test-helpers';

const STUB_EXTERNAL_HTML =
  '<!doctype html><html><head><link rel="stylesheet" href="./assets/app.css?v=css123"><script defer src="./assets/app.js?v=js123"></script></head><body data-test="mcp-app-external-stub">external</body></html>';

describe('MCP App resources — ui:// serving (host-authored view)', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let client: Awaited<ReturnType<typeof createTestOAuthClient>>;
  let actingAgent: Awaited<ReturnType<typeof createTestAgent>>;
  let token: string;
  let tmpRoot: string;
  const prevWebDist = process.env.WEB_DIST_DIR;

  beforeAll(async () => {
    // Serve a stub bundle from a temp dir so resources/read needs no real owletto
    // build. The resolver's first candidate is
    // `join(WEB_DIST_DIR, '..', 'dist-mcp-apps/interaction/index.html')`, so point
    // WEB_DIST_DIR at `<tmp>/dist` and write the stub under `<tmp>/dist-mcp-apps`.
    // `<tmp>/dist/index.html` deliberately does NOT exist, so the SPA dist
    // resolver in index.ts skips this WEB_DIST_DIR and is unaffected. Set this
    // BEFORE any resources/read — the bundle resolver caches misses per process.
    tmpRoot = mkdtempSync(join(tmpdir(), 'lobu-mcp-app-'));
    mkdirSync(join(tmpRoot, 'dist-mcp-apps', 'interaction'), {
      recursive: true,
    });
    mkdirSync(join(tmpRoot, 'dist-mcp-apps', 'interaction', 'assets'), {
      recursive: true,
    });
    writeFileSync(
      join(tmpRoot, 'dist-mcp-apps', 'interaction', 'index.html'),
      STUB_EXTERNAL_HTML
    );
    writeFileSync(
      join(tmpRoot, 'dist-mcp-apps', 'interaction', 'assets', 'app.js'),
      'document.body.dataset.mcpAppAsset = "loaded";'
    );
    writeFileSync(
      join(tmpRoot, 'dist-mcp-apps', 'interaction', 'assets', 'app.css'),
      '[data-mcp-app] { display: block; }'
    );
    process.env.WEB_DIST_DIR = join(tmpRoot, 'dist');

    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({
      name: 'MCP App Org',
      slug: 'mcp-app-org',
    });
    owner = await createTestUser({ email: 'mcp-app-owner@test.example.com' });
    await addUserToOrganization(owner.id, org.id, 'owner');
    actingAgent = await createTestAgent({
      organizationId: org.id,
      ownerUserId: owner.id,
      agentId: 'mcp-app-render-agent',
    });
    client = await createTestOAuthClient();
    token = (
      await createTestAccessToken(owner.id, org.id, client.client_id, {
        scope: 'mcp:admin mcp:write mcp:read profile:read',
      })
    ).token;
  });

  afterAll(() => {
    if (prevWebDist === undefined) delete process.env.WEB_DIST_DIR;
    else process.env.WEB_DIST_DIR = prevWebDist;
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function initSession(
    path: string,
    options: {
      sessionToken?: string;
      agentId?: string;
      advertiseMcpApps?: boolean;
      advertiseOpenAIVisibility?: boolean;
      headers?: Record<string, string>;
    } = {}
  ): Promise<string> {
    const sessionToken = options.sessionToken ?? token;
    const advertiseMcpApps = options.advertiseMcpApps ?? true;
    const advertiseOpenAIVisibility = options.advertiseOpenAIVisibility ?? true;
    const initResponse = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: '__test_init__',
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: advertiseMcpApps
            ? {
                extensions: {
                  'io.modelcontextprotocol/ui': {
                    mimeTypes: ['text/html;profile=mcp-app'],
                  },
                },
                ...(advertiseOpenAIVisibility
                  ? {
                      experimental: {
                        'openai/visibility': { enabled: true },
                      },
                    }
                  : {}),
              }
            : {},
          clientInfo: {
            name: 'lobu-test',
            version: '1.0',
            ...(options.agentId ? { agentId: options.agentId } : {}),
          },
        },
      },
      headers: options.headers,
      token: sessionToken,
    });
    const sessionId = initResponse.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await post(path, {
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      headers: {
        'mcp-session-id': sessionId!,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      token: sessionToken,
    });
    return sessionId!;
  }

  it('signals legacy fallback to a 2026 server/discover probe', async () => {
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'openai-mcp-discover',
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': {
              name: 'openai-mcp',
              version: '1.0.0',
            },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      },
      headers: {
        'mcp-method': 'server/discover',
        'mcp-protocol-version': '2026-07-28',
      },
      token,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32601, message: 'Method not found' },
      id: 'openai-mcp-discover',
    });

    // A modern client treats -32601 as proof of a legacy server, then opens a
    // normal 2025-era initialized session on the same endpoint.
    expect(await initSession(`/mcp/${org.slug}`)).toBeTruthy();
  });

  it('serves the external v44 interaction bundle over resources/read', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri: 'ui://lobu/interaction/v44.html' },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const content = body.result?.contents?.[0];
    expect(content?.uri).toBe('ui://lobu/interaction/v44.html');
    expect(content?.mimeType).toBe('text/html;profile=mcp-app');
    expect(content?.text).toContain('mcp-app-external-stub');
    // Absolute, not `./assets/…` behind a `<base>`: Claude serves the app
    // sandbox with `base-uri 'self'`, drops the element, and then resolves
    // every relative URL against its own origin — a blank widget.
    expect(content?.text).toContain(
      'src="http://localhost/mcp-apps/interaction/assets/app.js?v=js123"'
    );
    expect(content?.text).not.toContain('./assets/');
    expect(content?.text).not.toContain('<base');
    expect(content?._meta?.ui?.csp).toEqual({
      connectDomains: [],
      resourceDomains: ['https://t2.gstatic.com', 'http://localhost'],
      frameDomains: [],
    });
    expect(content?._meta?.ui?.permissions).toEqual({ clipboardWrite: {} });
    expect(content?._meta?.ui?.prefersBorder).toBe(true);
    expect(content?._meta?.ui?.domain).toBe('http://localhost');
    expect(content?._meta?.['openai/widgetDescription']).toBe(
      'Interactive Lobu cards rendered in a sandboxed iframe; actions use standard MCP tool calls or host-mediated external links.'
    );
  });

  it('serves the stamped external template and registered stable assets', async () => {
    const htmlResponse = await get('/mcp-apps/interaction/index.html');
    expect(htmlResponse.status).toBe(200);
    const html = await htmlResponse.text();
    expect(html).toContain('mcp-app-external-stub');
    expect(html).toContain('/mcp-apps/interaction/');
    expect(html).not.toContain('__LOBU_MCP_APP_ORIGIN__');

    // A request that does not name this replica's build must not be cacheable:
    // during a rolling deploy it can be an index.html from the *other* build
    // asking for bytes we do not have, and caching them under that build's URL
    // would pin the mismatch in the host's browser until the next deploy.
    const assetResponse = await get('/mcp-apps/interaction/assets/app.js');
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get('content-type')).toContain('text/javascript');
    expect(assetResponse.headers.get('cache-control')).toBe('no-store');
    expect(assetResponse.headers.get('access-control-allow-origin')).toBe('*');
    expect(assetResponse.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    const assetBody = await assetResponse.text();
    expect(assetBody).toContain('mcpAppAsset');

    const assetVersion = mcpAppAssetVersion(new TextEncoder().encode(assetBody));
    const stale = await get('/mcp-apps/interaction/assets/app.js?v=someotherbuild');
    expect(stale.headers.get('cache-control')).toBe('no-store');
    const fresh = await get(`/mcp-apps/interaction/assets/app.js?v=${assetVersion}`);
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable'
    );

    const styleResponse = await get('/mcp-apps/interaction/assets/app.css');
    expect(styleResponse.status).toBe(200);
    expect(styleResponse.headers.get('content-type')).toContain('text/css');
    expect(styleResponse.headers.get('cache-control')).toBe('no-store');
    expect(styleResponse.headers.get('access-control-allow-origin')).toBe('*');
    expect(styleResponse.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    const styleBody = await styleResponse.text();
    expect(styleBody).toContain('[data-mcp-app]');
    const styleVersion = mcpAppAssetVersion(new TextEncoder().encode(styleBody));
    expect(
      (
        await get(`/mcp-apps/interaction/assets/app.css?v=${styleVersion}`)
      ).headers.get('cache-control')
    ).toBe('public, max-age=31536000, immutable');

    expect((await get('/mcp-apps/interaction/assets/app.txt')).status).toBe(404);
    expect((await get('/mcp-apps/unknown/assets/app.js')).status).toBe(404);
  });

  it('serves the current template for a superseded interaction URI, and still refuses an unknown one', async () => {
    // A host reads the resource id once, from `resources/list` and the
    // tool-level `openai/outputTemplate` it captured at connect time, and
    // caches it for the life of that connection. So every already-connected
    // host asks for the PREVIOUS id the moment a bump lands. When that 404'd,
    // the card died for everyone until each user hit Refresh on the connector
    // (confirmed on prod: ChatGPT rendered `Failed to fetch template` with the
    // sandbox iframe at height 0; refreshing the plugin fixed it with no code
    // change). Every version resolves to the one shell we serve today.
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const currentVersion = Number(
      LOBU_INTERACTION_RESOURCE_URI.match(/\/v(\d+)\.html$/)?.[1]
    );
    expect(currentVersion).toBeGreaterThan(30);
    const superseded = [
      // The earliest ids predate the `.html` suffix.
      'ui://lobu/interaction/v1',
      'ui://lobu/interaction/v2',
      'ui://lobu/interaction/v7.html',
      'ui://lobu/interaction/v29.html',
      'ui://lobu/interaction/v30.html',
      `ui://lobu/interaction/v${currentVersion - 1}.html`,
    ];

    for (const uri of superseded) {
      const response = await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: uri,
          method: 'resources/read',
          params: { uri },
        },
        headers: { 'mcp-session-id': sessionId },
        token,
      });
      const body = await response.json();
      const content = body.result?.contents?.[0];
      // Echo back the id that was ASKED for, not the canonical one: that is
      // the key the host files the result under.
      expect(content?.uri).toBe(uri);
      expect(content?.mimeType).toBe('text/html;profile=mcp-app');
      // The same external shell the current id serves — not an empty render,
      // which a host would cache and never retry.
      expect(content?.text).toContain('mcp-app-external-stub');
      expect(content?.text).toContain(
        'src="http://localhost/mcp-apps/interaction/assets/app.js?v=js123"'
      );
      expect(content?._meta?.ui?.csp).toBeTruthy();
    }

    // Resolution is scoped to the interaction shell. Anything else is still an
    // error, so a typo or a foreign `ui://` id cannot silently render Lobu's.
    for (const uri of [
      'ui://lobu/interaction/vNext.html',
      'ui://lobu/interaction/v44.htm',
      'ui://lobu/interaction',
      'ui://lobu/dashboard/v1.html',
      'ui://other/interaction/v1.html',
    ]) {
      const response = await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: uri,
          method: 'resources/read',
          params: { uri },
        },
        headers: { 'mcp-session-id': sessionId },
        token,
      });
      const body = await response.json();
      expect(body.result).toBeUndefined();
      expect(JSON.stringify(body.error)).toContain(uri);
    }
  });

  it('advertises description, CSP, and the app domain on resources/list', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    // Recover from the persisted row rather than the live map, so this asserts
    // the negotiated flag survives a replica hop in the direction that emits
    // the field too — not only the direction that withholds it.
    clearInMemoryMcpSessionsForTests();
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/list',
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const resource = body.result?.resources?.find(
      (r: { uri: string }) => r.uri === 'ui://lobu/interaction/v44.html'
    );
    expect(resource).toBeDefined();
    expect(
      body.result?.resources?.filter((r: { uri?: string }) =>
        r.uri?.startsWith('ui://lobu/interaction/')
      )
    ).toHaveLength(1);
    // description is a typed resource field surfaced in client browsers.
    expect(typeof resource.description).toBe('string');
    expect(resource.description.length).toBeGreaterThan(0);
    // CSP and the sandbox `domain` ride the nested _meta.ui shape. `domain` is
    // this deployment's own origin; the host derives its sandbox hostname from
    // it, and it has to be on the *listed* template because that is the copy a
    // host captures at connect time.
    expect(resource.mimeType).toBe('text/html;profile=mcp-app');
    expect(resource._meta?.ui?.csp).toEqual({
      connectDomains: [],
      resourceDomains: ['https://t2.gstatic.com', 'http://localhost'],
      frameDomains: [],
    });
    expect(resource._meta?.ui?.prefersBorder).toBe(true);
    expect(resource._meta?.ui?.domain).toBe('http://localhost');
    // Same reason as `domain`: ChatGPT reads the component's model-facing
    // summary off the template it captured at connect time, so the key rides
    // the listing, not only `resources/read`.
    expect(resource._meta?.['openai/widgetDescription']).toBe(resource.description);
  });

  it('omits the app domain for a host that advertises Apps without OpenAI visibility', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`, {
      advertiseOpenAIVisibility: false,
    });
    const liveListResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'non-openai-resources-list',
        method: 'resources/list',
      },
      headers: {
        'mcp-session-id': sessionId,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      token,
    });
    expect(liveListResponse.status).toBe(200);
    const liveListBody = await liveListResponse.json();
    const liveResource = liveListBody.result?.resources?.find(
      (resource: { uri?: string }) => resource.uri === LOBU_INTERACTION_RESOURCE_URI
    );
    expect(liveResource?._meta?.ui?.domain).toBeUndefined();
    expect(liveResource?._meta?.ui?.csp).toBeTruthy();

    // Exercise persisted session-capability recovery across a replica-local
    // miss: the compatibility decision must not depend on process affinity.
    clearInMemoryMcpSessionsForTests();

    const toolsResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'non-openai-tools-list',
        method: 'tools/list',
      },
      headers: {
        'mcp-session-id': sessionId,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      token,
    });
    const toolsBody = await toolsResponse.json();
    expect(
      toolsBody.result?.tools?.some(
        (tool: { name?: string }) => tool.name === 'resolve_approval'
      )
    ).toBe(true);

    const readResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'non-openai-resources-read',
        method: 'resources/read',
        params: { uri: LOBU_INTERACTION_RESOURCE_URI },
      },
      headers: {
        'mcp-session-id': sessionId,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      token,
    });
    expect(readResponse.status).toBe(200);
    const readBody = await readResponse.json();
    expect(readBody.result?.contents?.[0]?._meta?.ui?.domain).toBeUndefined();
    expect(readBody.result?.contents?.[0]?._meta?.ui?.csp).toBeTruthy();
  });

  it('links direct saves and approval tools to the App resource', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const tool = body.result?.tools?.find(
      (entry: { name?: string }) => entry.name === 'get_approval'
    );
    expect(tool).toEqual(
      expect.objectContaining({
        annotations: expect.objectContaining({
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
          idempotentHint: false,
        }),
        securitySchemes: [{ type: 'oauth2', scopes: ['mcp:read'] }],
        _meta: expect.objectContaining({
          securitySchemes: [{ type: 'oauth2', scopes: ['mcp:read'] }],
          ui: expect.objectContaining({
            resourceUri: 'ui://lobu/interaction/v44.html',
            visibility: ['model', 'app'],
          }),
          'openai/outputTemplate': 'ui://lobu/interaction/v44.html',
          'openai/widgetAccessible': true,
        }),
      })
    );

    const saveMemory = body.result?.tools?.find(
      (entry: { name?: string }) => entry.name === 'save_memory'
    );
    expect(saveMemory).toEqual(
      expect.objectContaining({
        securitySchemes: [{ type: 'oauth2', scopes: ['mcp:write'] }],
        _meta: expect.objectContaining({
          securitySchemes: [{ type: 'oauth2', scopes: ['mcp:write'] }],
          ui: expect.objectContaining({
            resourceUri: 'ui://lobu/interaction/v44.html',
            visibility: ['model', 'app'],
          }),
          'openai/outputTemplate': 'ui://lobu/interaction/v44.html',
          'openai/widgetAccessible': true,
        }),
      })
    );

    // Reads and general SDK actions stay headless so multi-step work does not
    // mount an iframe for every intermediate call. save_memory is the narrow
    // exception: its one durable write is itself the final inspectable result.
    for (const name of [
      'search_memory',
      'search_sdk',
      'query_sdk',
      'query_sql',
      'run_sdk',
    ]) {
      const dataTool = body.result?.tools?.find(
        (entry: { name?: string }) => entry.name === name
      );
      expect(dataTool).toBeDefined();
      expect(dataTool?._meta?.ui).toBeUndefined();
      expect(dataTool?._meta?.['openai/outputTemplate']).toBeUndefined();
      expect(dataTool?.outputSchema).toEqual(expect.objectContaining({ type: 'object' }));
    }

    const resolveApproval = body.result?.tools?.find(
      (entry: { name?: string }) => entry.name === 'resolve_approval'
    );
    expect(resolveApproval).toEqual(
      expect.objectContaining({
        annotations: expect.objectContaining({
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: true,
          idempotentHint: false,
        }),
        outputSchema: expect.objectContaining({ type: 'object' }),
        securitySchemes: [{ type: 'oauth2', scopes: ['mcp:write'] }],
        _meta: expect.objectContaining({
          ui: {
            visibility: ['app'],
          },
        }),
      })
    );
    expect(resolveApproval?._meta?.['openai/outputTemplate']).toBeUndefined();
    expect(resolveApproval?._meta?.['openai/widgetAccessible']).toBeUndefined();
    for (const removed of [
      'render_lobu_view',
      'restore_lobu_app_result',
      'save_lobu_app_state',
    ]) {
      expect(
        body.result?.tools?.some((entry: { name?: string }) => entry.name === removed)
      ).toBe(false);
    }
    for (const listed of body.result?.tools ?? []) {
      expect(listed.securitySchemes?.[0]?.type).toBe('oauth2');
      expect(listed.annotations?.readOnlyHint).toEqual(expect.any(Boolean));
      expect(listed.annotations?.destructiveHint).toEqual(expect.any(Boolean));
      expect(listed.annotations?.openWorldHint).toEqual(expect.any(Boolean));
      expect(listed.annotations?.idempotentHint).toEqual(expect.any(Boolean));
      expect(listed.outputSchema).toEqual(expect.objectContaining({ type: 'object' }));
    }
  });

  it('preserves negotiated Apps metadata after cross-replica session recovery', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    clearInMemoryMcpSessionsForTests();

    const response = await post(`/mcp/${org.slug}`, {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      headers: {
        'mcp-session-id': sessionId,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const tool = body.result?.tools?.find(
      (entry: { name?: string }) => entry.name === 'get_approval'
    );
    expect(tool?._meta?.ui).toEqual(
      expect.objectContaining({
        resourceUri: 'ui://lobu/interaction/v44.html',
        visibility: ['model', 'app'],
      })
    );
    // The binding above ships regardless of negotiation; what proves the
    // negotiated flag survived recovery is the app-only tool staying listed.
    expect(
      body.result?.tools?.some(
        (entry: { name?: string }) => entry.name === 'resolve_approval'
      )
    ).toBe(true);
  });

  it('returns the exact saved event payload for the save_memory App card', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const payloadTemplate = {
      root: {
        type: 'bar-chart',
        data: '{{points}}',
        labelField: 'label',
        valueField: 'value',
      },
    };
    const payloadData = {
      points: [
        { label: 'Saved', value: 12 },
        { label: 'Rendered', value: 7 },
      ],
    };
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'save-memory-app-result',
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: {
            title: 'Saved chart',
            semantic_type: 'content',
            payload_type: 'json_template',
            payload_template: payloadTemplate,
            payload_data: payloadData,
            metadata: {},
            idempotency_key: 'mcp-app-save-memory-render-result',
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent).toEqual(
      expect.objectContaining({
        title: 'Saved chart',
        payload_type: 'json_template',
        payload_data: payloadData,
        payload_template: payloadTemplate,
        payload_text: null,
        attachments: [],
        source_url: null,
        view_url: expect.stringContaining('content_ids='),
      })
    );
    expect(body.result?.content?.[0]?.text).toContain('"title": "Saved chart"');
    expect(body.result?.content?.[0]?.text).not.toContain('payload_data');
    expect(body.result?.content?.[0]?.text).not.toContain('payload_template');
    expect(body.result?._meta?.['openai/outputTemplate']).toBe(
      'ui://lobu/interaction/v44.html'
    );
  });

  it('keeps oversized saved payloads out of the App response', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'save-memory-oversized-result',
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: {
            title: 'Large durable note',
            semantic_type: 'content',
            payload_type: 'json_template',
            payload_template: { root: { type: 'data', path: 'body' } },
            payload_data: { body: 'x'.repeat(600 * 1024) },
            metadata: {},
            idempotency_key: 'mcp-app-save-memory-oversized-result',
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent).toEqual(
      expect.objectContaining({
        title: 'Large durable note',
        view_url: expect.stringContaining('content_ids='),
        exact_read: expect.objectContaining({
          method: 'client.knowledge.read',
        }),
      })
    );
    for (const key of [
      'payload_type',
      'payload_text',
      'payload_data',
      'payload_template',
      'attachments',
      'source_url',
    ]) {
      expect(body.result?.structuredContent).not.toHaveProperty(key);
    }
    expect(body.result?.content?.[0]?.text.length).toBeLessThan(10_000);
  });

  it('still echoes the saved payload to a client that did not advertise MCP Apps', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`, {
      advertiseMcpApps: false,
    });
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'save-memory-no-app-result',
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: {
            title: 'Plain note',
            semantic_type: 'content',
            content: 'body-visible-only-to-app-hosts',
            metadata: {},
            idempotency_key: 'mcp-app-save-memory-no-app-result',
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    // The payload follows the binding. claude.ai renders the card while
    // declaring no Apps capability, so withholding the body here mounted a
    // widget with nothing in it (measured on prod 2026-08-20).
    expect(body.result?.structuredContent).toEqual(
      expect.objectContaining({
        title: 'Plain note',
        exact_read: expect.objectContaining({ method: 'client.knowledge.read' }),
        payload_type: 'text',
        payload_text: 'body-visible-only-to-app-hosts',
      })
    );
    expect(body.result?.content?.[0]?.text).not.toContain(
      'body-visible-only-to-app-hosts'
    );
  });

  it('keeps ClientSDK saves headless when their source session supports Apps', async () => {
    // run_sdk builds this same in-process SDK from the outer MCP session. The
    // direct SDK call keeps the boundary test independent of isolated-vm.
    await initWorkspaceProvider();
    const ctx: ToolContext = {
      organizationId: org.id,
      userId: owner.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
      scopedToOrg: true,
      allowCrossOrg: false,
      mcpAppsSupported: true,
    };
    const sdk = buildClientSDK(ctx, {
      ENVIRONMENT: 'test',
      DATABASE_URL: process.env.DATABASE_URL,
    } as Env);
    const receipt = await sdk.knowledge.save({
      title: 'Nested SDK save',
      semantic_type: 'content',
      content: 'nested-sdk-save-body-must-stay-headless',
      metadata: {},
      idempotency_key: 'mcp-app-nested-sdk-save-headless',
    });

    expect(receipt).toEqual(
      expect.objectContaining({
        title: 'Nested SDK save',
        exact_read: expect.objectContaining({ method: 'client.knowledge.read' }),
      })
    );
    for (const key of [
      'payload_type',
      'payload_text',
      'payload_data',
      'payload_template',
      'attachments',
      'source_url',
    ]) {
      expect(receipt).not.toHaveProperty(key);
    }
    expect(JSON.stringify(receipt)).not.toContain('nested-sdk-save-body-must-stay-headless');
  });

  it('returns tools/call as JSON when an Inspector-style client accepts JSON and SSE', async () => {
    const accept = 'application/json, text/event-stream';
    const sessionId = await initSession(`/mcp/${org.slug}`, {
      headers: { Accept: accept },
    });
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'inspector-get-approval',
        method: 'tools/call',
        params: {
          name: 'get_approval',
          arguments: { run_id: 999_999_999 },
        },
      },
      headers: {
        Accept: accept,
        'mcp-session-id': sessionId,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      token,
    });

    // Inspector keeps a standalone GET SSE channel for server notifications.
    // Ordinary POST request/response traffic must complete in-band as JSON;
    // a finite POST-SSE response leaves Inspector waiting out its request
    // timeout while a reconnecting GET stream collides with the SDK's
    // one-standalone-stream session guard (handleGetRequest → 409).
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = await response.json();
    expect(body.id).toBe('inspector-get-approval');
    expect(body.result?.isError).toBe(true);
    expect(body.result?._meta?.['lobu/member-role']).toBe('owner');
  });

  it('keeps the standalone GET SSE channel available when Accept is omitted', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await get(`/mcp/${org.slug}`, {
      headers: {
        'mcp-session-id': sessionId,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      token,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    await response.body?.cancel();
  });

  it('returns the viewer member role on every app-rendered result and nowhere else', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const call = async (
      name: string,
      args: Record<string, unknown>,
      callToken = token,
      session = sessionId
    ) => {
      const response = await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: `member-role-${name}`,
          method: 'tools/call',
          params: { name, arguments: args },
        },
        headers: { 'mcp-session-id': session },
        token: callToken,
      });
      return (await response.json()).result;
    };

    // The role rides on the explicit user-facing approval view, including its
    // error envelope when a requested approval does not exist.
    const viewResult = await call('get_approval', { run_id: 999_999_999 });
    expect(viewResult?.isError).toBe(true);
    expect(viewResult?._meta?.['lobu/member-role']).toBe('owner');

    // A headless data tool has no app view to gate, so it stays clean.
    const sqlResult = await call('query_sql', { sql: 'SELECT 1 AS row_number' });
    expect(sqlResult?.isError).not.toBe(true);
    expect(sqlResult?._meta?.['lobu/member-role']).toBeUndefined();

    // The role is the caller's own membership row, not a constant: a plain
    // member gets 'member' and the app hides the toggle for them.
    const memberUser = await createTestUser({
      email: 'mcp-app-member-role@test.example.com',
    });
    await addUserToOrganization(memberUser.id, org.id, 'member');
    const memberToken = (
      await createTestAccessToken(memberUser.id, org.id, client.client_id, {
        scope: 'mcp:read',
      })
    ).token;
    const memberSession = await initSession(`/mcp/${org.slug}`, {
      sessionToken: memberToken,
    });
    const memberResult = await call(
      'get_approval',
      { run_id: 999_999_999 },
      memberToken,
      memberSession
    );
    expect(memberResult?.isError).toBe(true);
    expect(memberResult?._meta?.['lobu/member-role']).toBe('member');
  });

  it('emits canonical null member role for a public-workspace reader with no membership', async () => {
    // An authenticated caller with NO membership row, reading a PUBLIC org over
    // `/mcp/{slug}`, is admitted by `allowPublicOrgWithoutMembership` with a
    // null role. The app's Debug (raw JSON) disclosure must stay closed for
    // them, so the key must be PRESENT with canonical null — never omitted.
    const publicOrg = await createTestOrganization({
      name: 'MCP App Public Org',
      slug: 'mcp-app-public-org',
      visibility: 'public',
    });
    const visitor = await createTestUser({
      email: 'mcp-app-public-reader@test.example.com',
    });
    // Token bound to the public org, but the user is deliberately NOT a member.
    const visitorToken = (
      await createTestAccessToken(visitor.id, publicOrg.id, client.client_id, {
        scope: 'mcp:read',
      })
    ).token;

    const sessionId = await initSession(`/mcp/${publicOrg.slug}`, {
      sessionToken: visitorToken,
    });
    const response = await post(`/mcp/${publicOrg.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'public-reader-app-render',
        method: 'tools/call',
        params: {
          name: 'get_approval',
          arguments: { run_id: 999_999_999 },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token: visitorToken,
    });
    const body = await response.json();
    expect(body.result?.isError).toBe(true);
    // Canonical null: the key is present and its value is null, so the app
    // resolves the explicit downgrade instead of falling back to an alternate
    // envelope that could carry a stale role.
    expect('lobu/member-role' in (body.result?._meta ?? {})).toBe(true);
    expect(body.result?._meta?.['lobu/member-role']).toBeNull();
    expect(body.result?.structuredContent).toBeUndefined();
  });

  it('emits no member role for a tool that declares no UI resource', async () => {
    // The role exists to tell the APP who is looking. `query_sql` is headless,
    // so there is no app to tell and the key must be
    // absent — not null. Absent and null mean different things to the host:
    // null is an explicit downgrade, absent means "unchanged".
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'no-ui-tool-role',
        method: 'tools/call',
        params: {
          name: 'query_sql',
          arguments: { sql: 'SELECT 1 AS row_number' },
        },
      },
      headers: { 'mcp-session-id': sessionId },
    });
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    expect('lobu/member-role' in (body.result?._meta ?? {})).toBe(false);
  });

  it('carries canonical null member role on a thrown app-UI error for a public reader', async () => {
    // Same public non-member caller, but the UI tool THROWS instead of
    // returning a result. The app keeps its previous member role whenever the
    // `lobu/member-role` key is ABSENT — so a thrown error after a downgrade
    // would otherwise leave stale owner/admin UI state. The catch path must
    // still emit the key with canonical null.
    const publicOrg = await createTestOrganization({
      name: 'MCP App Public Throws Org',
      slug: 'mcp-app-public-throws-org',
      visibility: 'public',
    });
    const visitor = await createTestUser({
      email: 'mcp-app-public-throws@test.example.com',
    });
    // Token bound to the public org, but the user is deliberately NOT a member.
    const visitorToken = (
      await createTestAccessToken(visitor.id, publicOrg.id, client.client_id, {
        scope: 'mcp:read',
      })
    ).token;

    const sessionId = await initSession(`/mcp/${publicOrg.slug}`, {
      sessionToken: visitorToken,
    });
    const response = await post(`/mcp/${publicOrg.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'public-reader-thrown-error',
        method: 'tools/call',
        params: {
          name: 'get_approval',
          // Approval details require workspace membership even when the
          // workspace itself is public, so access throws before the row read.
          arguments: { run_id: 999_999_999 },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token: visitorToken,
    });
    const body = await response.json();
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent).toBeUndefined();
    expect(body.result?.content?.[0]?.text).toMatch(/public workspace is read-only/i);
    // The key must be PRESENT with canonical null on the thrown error too.
    expect('lobu/member-role' in (body.result?._meta ?? {})).toBe(true);
    expect(body.result?._meta?.['lobu/member-role']).toBeNull();
    expect(body.result?._meta?.['mcp/www_authenticate']).toBeUndefined();
  });

  it('binds the app and completes an approval for a client that did not advertise MCP Apps, while keeping app-only tools hidden', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`, {
      advertiseMcpApps: false,
    });
    clearInMemoryMcpSessionsForTests();
    const response = await post(`/mcp/${org.slug}`, {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      headers: {
        'mcp-session-id': sessionId,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const tool = body.result?.tools?.find(
      (entry: { name?: string }) => entry.name === 'get_approval'
    );
    // The binding ships to every client: `resources/list` already advertises
    // the app unconditionally, and a host that renders apps without declaring
    // the extension (claude.ai) could otherwise see the app but never bind it.
    expect(tool?._meta?.ui).toEqual(
      expect.objectContaining({ resourceUri: LOBU_INTERACTION_RESOURCE_URI })
    );
    expect(tool?._meta?.['openai/outputTemplate']).toBe(LOBU_INTERACTION_RESOURCE_URI);
    // A client that ignores `_meta` is unaffected: the human-readable surface
    // is unchanged.
    expect(typeof tool?.description).toBe('string');
    // What stays gated is the tool filter: an app-only tool is still withheld
    // from a client that never negotiated (hidden, not disabled — `tools/call`
    // still dispatches it, so a rendered card can drive its own resolver).
    expect(
      body.result?.tools?.some(
        (entry: { name?: string }) => entry.name === 'resolve_approval'
      )
    ).toBe(false);

    const [run] = await getDb()<{ id: number }>`
      INSERT INTO runs (organization_id, run_type, status, approval_status)
      VALUES (${org.id}, 'action', 'pending', 'pending')
      RETURNING id
    `;
    const runId = Number(run.id);
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `mcp_app_non_app_approval_${runId}`,
      title: 'Non-App review — pending approval',
      content: 'This client must use the Lobu review page.',
      semanticType: 'operation',
      runId,
      interactionType: 'approval',
      interactionStatus: 'pending',
    });
    const renderResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'get_approval',
          arguments: { run_id: runId },
        },
      },
      headers: {
        'mcp-session-id': sessionId,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      token,
    });
    const renderBody = await renderResponse.json();
    expect(renderBody.result?.isError).not.toBe(true);
    expect(renderBody.result?._meta?.['openai/outputTemplate']).toBe(
      LOBU_INTERACTION_RESOURCE_URI
    );
    const capability = renderBody.result?._meta?.['lobu/approval-capability'];
    expect(typeof capability).toBe('string');
    expect(renderBody.result?._meta?.['lobu/member-role']).toBe('owner');
    expect(renderBody.result?.structuredContent?.actions).toEqual([
      expect.objectContaining({ id: 'approve', tool: 'resolve_approval' }),
      expect.objectContaining({ id: 'reject', tool: 'resolve_approval' }),
      expect.objectContaining({ id: 'review', href: expect.stringMatching(/^https?:\/\//) }),
    ]);
    const rejectResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'non-declaring-reject',
        method: 'tools/call',
        params: {
          name: 'resolve_approval',
          arguments: {
            run_id: runId,
            decision: 'reject',
            _meta: { 'lobu/approval-capability': capability },
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    expect((await rejectResponse.json()).result?.isError).not.toBe(true);

    const [settled] = await getDb()<{ approval_status: string }>`
      SELECT approval_status FROM runs
      WHERE id = ${runId} AND organization_id = ${org.id}
    `;
    expect(settled).toMatchObject({ approval_status: 'rejected' });
  });

  it('renders an explicitly targeted approval in the sole granted workspace', async () => {
    const sessionId = await initSession('/mcp');
    const [run] = await getDb()<{ id: number }>`
      INSERT INTO runs (organization_id, run_type, status, approval_status)
      VALUES (${org.id}, 'action', 'pending', 'pending')
      RETURNING id
    `;
    const runId = Number(run.id);
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `mcp_app_single_grant_approval_${runId}`,
      title: 'Single-grant review — pending approval',
      content: 'Review in the sole granted workspace.',
      semanticType: 'operation',
      runId,
      interactionType: 'approval',
      interactionStatus: 'pending',
    });

    const response = await post('/mcp', {
      body: {
        jsonrpc: '2.0',
        id: 'single-grant-get-approval',
        method: 'tools/call',
        params: {
          name: 'get_approval',
          arguments: { run_id: runId, organization: org.slug },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?._meta?.['lobu/member-role']).toBe('owner');
    expect(body.result?.structuredContent?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'approve' }),
        expect.objectContaining({ id: 'reject' }),
      ])
    );
  });

  it('renders and resolves a target-workspace approval through one unscoped OAuth session', async () => {
    const defaultOrg = await createTestOrganization({
      name: 'Approval Default Org',
      slug: 'approval-default-org',
    });
    const targetOrg = await createTestOrganization({
      name: 'Approval Target Org',
      slug: 'approval-target-org',
    });
    await addUserToOrganization(owner.id, defaultOrg.id, 'member');
    await addUserToOrganization(owner.id, targetOrg.id, 'owner');
    const crossOrgToken = (
      await createTestAccessToken(owner.id, defaultOrg.id, client.client_id, {
        scope: 'mcp:read mcp:write mcp:admin',
      })
    ).token;
    // Cross-workspace approval rendering now requires the target workspace in
    // the token's explicit consent snapshot; a legacy NULL grant stays pinned
    // to its anchor workspace.
    await getDb()`
      UPDATE oauth_tokens
      SET granted_organization_ids = ARRAY[${defaultOrg.id}, ${targetOrg.id}]::text[]
      WHERE token_hash = ${hashToken(crossOrgToken)}
    `;
    const sessionId = await initSession('/mcp', { sessionToken: crossOrgToken });

    const [run] = await getDb()<{ id: number }>`
      INSERT INTO runs (organization_id, run_type, status, approval_status)
      VALUES (${targetOrg.id}, 'action', 'pending', 'pending')
      RETURNING id
    `;
    const runId = Number(run.id);
    await insertEvent({
      entityIds: [],
      organizationId: targetOrg.id,
      originId: `mcp_app_cross_org_approval_${runId}`,
      title: 'Cross-org review — pending approval',
      content: 'Resolve this in the target workspace.',
      semanticType: 'operation',
      runId,
      interactionType: 'approval',
      interactionStatus: 'pending',
    });

    const renderResponse = await post('/mcp', {
      body: {
        jsonrpc: '2.0',
        id: 'cross-org-get-approval',
        method: 'tools/call',
        params: {
          name: 'get_approval',
          arguments: { run_id: runId, organization: targetOrg.slug },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token: crossOrgToken,
    });
    const renderBody = await renderResponse.json();
    expect(renderBody.result?.isError).not.toBe(true);
    expect(renderBody.result?._meta?.['lobu/member-role']).toBe('owner');
    const capability = renderBody.result?._meta?.['lobu/approval-capability'];
    expect(typeof capability).toBe('string');
    expect(renderBody.result?.structuredContent?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'approve', tool: 'resolve_approval' }),
        expect.objectContaining({ id: 'reject', tool: 'resolve_approval' }),
      ])
    );

    const rejectResponse = await post('/mcp', {
      body: {
        jsonrpc: '2.0',
        id: 'cross-org-resolve-approval',
        method: 'tools/call',
        params: {
          name: 'resolve_approval',
          arguments: {
            run_id: runId,
            decision: 'reject',
            reason: 'Cross-org callback verified',
            _meta: { 'lobu/approval-capability': capability },
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token: crossOrgToken,
    });
    const rejectBody = await rejectResponse.json();
    expect(rejectBody.result?.isError).not.toBe(true);
    expect(rejectBody.result?._meta?.['lobu/member-role']).toBe('owner');

    const [settled] = await getDb()<{
      organization_id: string;
      approval_status: string;
    }>`
      SELECT organization_id, approval_status
      FROM runs
      WHERE id = ${runId}
    `;
    expect(settled).toEqual({
      organization_id: targetOrg.id,
      approval_status: 'rejected',
    });

    const scopedSessionId = await initSession(`/mcp/${defaultOrg.slug}`, {
      sessionToken: crossOrgToken,
    });
    const scopedResponse = await post(`/mcp/${defaultOrg.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'scoped-cross-org-get-approval',
        method: 'tools/call',
        params: {
          name: 'get_approval',
          arguments: { run_id: runId, organization: targetOrg.slug },
        },
      },
      headers: { 'mcp-session-id': scopedSessionId },
      token: crossOrgToken,
    });
    const scopedBody = await scopedResponse.json();
    expect(scopedBody.result?.isError).toBe(true);
    expect(scopedBody.result?.content?.[0]?.text).toMatch(
      /cross-org access is not available/i
    );
  });

  it('keeps an approval mutation text-only and resolves it only with the hidden app capability', async () => {
    const creationSessionId = await initSession(`/mcp/${org.slug}`, {
      agentId: actingAgent.agentId,
    });
    const hostConversationId = 'chatgpt-approval-conversation';
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'manage_agents',
          arguments: {
            action: 'create',
            agent_id: 'mcp-app-approval-agent',
            name: 'MCP App Approval Agent',
          },
          _meta: { 'openai/session': hostConversationId },
        },
      },
      headers: { 'mcp-session-id': creationSessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    // The mutating tool is not coupled to UI. A separate read-only call authors
    // the review view, so text-only clients still receive the pending result.
    expect(body.result?._meta?.ui).toBeUndefined();
    expect(body.result?.structuredContent).toBeUndefined();
    expect(typeof body.result?.content?.[0]?.text).toBe('string');

    const [approval] = await getDb()<{ run_id: number }>`
      SELECT run_id
      FROM current_event_records
      WHERE organization_id = ${org.id}
        AND interaction_type = 'approval'
        AND run_id IS NOT NULL
      ORDER BY id DESC
      LIMIT 1
    `;
    const runId = Number(approval?.run_id);
    expect(runId).toBeGreaterThan(0);
    await getDb()`
      UPDATE mcp_client_conversations
      SET title = 'Release approval E2E'
      WHERE organization_id = ${org.id}
        AND client_id = ${client.client_id}
        AND conversation_id = ${hostConversationId}
    `;

    // Possessing a valid app capability does not replace the canonical human
    // authority check. A plain member can read the shared approval card but
    // cannot decide an admin-owned agent proposal.
    const unrelatedMember = await createTestUser({
      email: 'mcp-app-unrelated-member@test.example.com',
    });
    await addUserToOrganization(unrelatedMember.id, org.id, 'member');
    const memberWriteToken = (
      await createTestAccessToken(unrelatedMember.id, org.id, client.client_id, {
        scope: 'mcp:read mcp:write profile:read',
      })
    ).token;
    const memberSessionId = await initSession(`/mcp/${org.slug}`, {
      sessionToken: memberWriteToken,
    });
    const memberViewResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'member-get-approval',
        method: 'tools/call',
        params: { name: 'get_approval', arguments: { run_id: runId } },
      },
      headers: { 'mcp-session-id': memberSessionId },
      token: memberWriteToken,
    });
    const memberCapability = (await memberViewResponse.json()).result?._meta?.[
      'lobu/approval-capability'
    ];
    expect(typeof memberCapability).toBe('string');
    const unauthorizedDecision = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'member-resolve-approval',
        method: 'tools/call',
        params: {
          name: 'resolve_approval',
          arguments: { run_id: runId, decision: 'reject' },
          _meta: { 'lobu/approval-capability': memberCapability },
        },
      },
      headers: { 'mcp-session-id': memberSessionId },
      token: memberWriteToken,
    });
    const unauthorizedBody = await unauthorizedDecision.json();
    expect(unauthorizedBody.result?.isError).toBe(true);
    expect(unauthorizedBody.result?.content?.[0]?.text).toMatch(/admin or owner access/i);

    // Match the default grant used by ChatGPT and MCP Inspector. The hidden
    // capability narrows this write-scoped client to exactly one approval;
    // requiring mcp:admin here would render working controls that can never
    // resolve in those hosts.
    const writeToken = (
      await createTestAccessToken(owner.id, org.id, client.client_id, {
        scope: 'mcp:read mcp:write profile:read',
      })
    ).token;
    const sessionId = await initSession(`/mcp/${org.slug}`, {
      sessionToken: writeToken,
      agentId: actingAgent.agentId,
    });
    const renderResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'get_approval',
          arguments: { run_id: runId },
          _meta: { 'openai/session': hostConversationId },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token: writeToken,
    });
    const renderBody = await renderResponse.json();
    expect(renderBody.result?.isError).not.toBe(true);
    const view = renderBody.result?.structuredContent;
    expect(view?.version).toBe(1);
    expect(view?.icon).toBe('agent');
    expect(view?.impact).toEqual({ level: 'normal' });
    expect(view?.tone).toBe('default');
    expect(view?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'approve',
          label: 'Approve',
          tool: 'resolve_approval',
          args: { run_id: runId, decision: 'approve' },
        }),
        expect.objectContaining({
          id: 'reject',
          label: 'Reject',
          variant: 'outline',
          tool: 'resolve_approval',
          args: { run_id: runId, decision: 'reject' },
        }),
        expect.objectContaining({
          id: 'review',
          label: 'Review in Lobu',
          href: expect.stringMatching(/^https?:\/\//),
        }),
      ])
    );
    const capability = renderBody.result?._meta?.['lobu/approval-capability'];
    expect(typeof capability).toBe('string');
    expect(capability.length).toBeGreaterThan(40);
    expect(renderBody.result?._meta?.['lobu/member-role']).toBe('owner');
    expect(renderBody.result?._meta?.['openai/outputTemplate']).toBe(
      'ui://lobu/interaction/v44.html'
    );
    expect(JSON.stringify(view)).not.toContain(capability);
    expect(renderBody.result?.content?.[0]?.text).not.toContain(capability);

    const missingCapabilityResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: {
          name: 'resolve_approval',
          arguments: { run_id: runId, decision: 'reject' },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token: writeToken,
    });
    const missingCapabilityBody = await missingCapabilityResponse.json();
    expect(missingCapabilityBody.result?.isError).toBe(true);
    expect(missingCapabilityBody.result?.content?.[0]?.text).toMatch(/approval capability/i);
    expect(missingCapabilityBody.result?._meta?.['lobu/member-role']).toBe('owner');

    // ChatGPT keeps one host conversation but may broker every app-initiated
    // call through a fresh MCP transport. The signed capability must follow
    // that stable host boundary without becoming reusable in another chat.
    const foreignConversationSessionId = await initSession(`/mcp/${org.slug}`, {
      sessionToken: writeToken,
      agentId: actingAgent.agentId,
    });
    const foreignConversationResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'foreign-conversation-resolve-approval',
        method: 'tools/call',
        params: {
          name: 'resolve_approval',
          arguments: {
            run_id: runId,
            decision: 'reject',
            _meta: { 'lobu/approval-capability': capability },
          },
          _meta: { 'openai/session': 'another-chatgpt-conversation' },
        },
      },
      headers: { 'mcp-session-id': foreignConversationSessionId },
      token: writeToken,
    });
    const foreignConversationBody = await foreignConversationResponse.json();
    expect(foreignConversationBody.result?.isError).toBe(true);
    expect(foreignConversationBody.result?.content?.[0]?.text).toMatch(/stale|match/i);

    const resolutionSessionId = await initSession(`/mcp/${org.slug}`, {
      sessionToken: writeToken,
      agentId: actingAgent.agentId,
    });
    const rejectResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: {
          name: 'resolve_approval',
          arguments: {
            run_id: runId,
            decision: 'reject',
            reason: 'Not this time',
            _meta: { 'lobu/approval-capability': capability },
          },
          _meta: { 'openai/session': hostConversationId },
        },
      },
      headers: { 'mcp-session-id': resolutionSessionId },
      token: writeToken,
    });
    const rejectBody = await rejectResponse.json();
    expect(rejectBody.result?.isError).not.toBe(true);
    expect(rejectBody.result?._meta?.['lobu/member-role']).toBe('owner');
    expect(rejectBody.result?.structuredContent).toEqual(
      expect.objectContaining({
        title: expect.stringMatching(/rejected/i),
        actions: [],
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            label: 'Conversation',
            value: expect.stringContaining('Release approval E2E'),
          }),
          expect.objectContaining({
            type: 'text',
            label: 'Decision',
            value: expect.stringMatching(/^Rejected by .+ · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/),
          }),
        ]),
      })
    );

    const [settled] = await getDb()<{
      approval_status: string;
      status: string;
      error_message: string | null;
    }>`
      SELECT approval_status, status, error_message
      FROM runs
      WHERE id = ${runId} AND organization_id = ${org.id}
    `;
    expect(settled).toMatchObject({
      approval_status: 'rejected',
      status: 'cancelled',
      error_message: 'Not this time',
    });

    const replayResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 24,
        method: 'tools/call',
        params: {
          name: 'resolve_approval',
          arguments: { run_id: runId, decision: 'reject' },
          _meta: { 'lobu/approval-capability': capability },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token: writeToken,
    });
    const replayBody = await replayResponse.json();
    expect(replayBody.result?.isError).toBe(true);
    expect(replayBody.result?.content?.[0]?.text).toMatch(/stale|pending/i);
  });

  it('returns structured SQL rows for headless consumers', async () => {
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 25,
        method: 'tools/call',
        params: {
          name: 'query_sql',
          arguments: {
            sql: 'SELECT id, semantic_type AS name FROM events',
            sort_by: 'id',
            sort_order: 'desc',
            limit: 1,
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent).toEqual(
      expect.objectContaining({
        rows: [
          {
            id: expect.any(Number),
            name: expect.any(String),
          },
        ],
        columns: [
          { name: 'id', type: expect.any(String) },
          { name: 'name', type: expect.any(String) },
        ],
        total_count: expect.any(Number),
      })
    );
  });

  it('renders a completed approval once and preserves its submitted form values', async () => {
    const [automation] = await getDb()<{ id: number }>`
      INSERT INTO automations (
        organization_id, managed_agent_id, created_by, automation_group_id, name
      ) VALUES (
        ${org.id}, ${actingAgent.agentId}, ${owner.id}, 0, 'Hourly approval sweep'
      )
      RETURNING id
    `;
    const [run] = await getDb()<{ id: number }>`
      INSERT INTO runs (
        organization_id, run_type, status, approval_status, action_output, automation_id
      )
      VALUES (
        ${org.id},
        'internal',
        'completed',
        'approved',
        ${getDb().json({ answer: { reviewer_note: 'Looks good', release_window: 'Tomorrow' } })},
        ${automation.id}
      )
      RETURNING id
    `;
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `mcp_app_completed_approval_${run.id}`,
      title: 'Question: Release readiness — completed',
      content: 'Builder action completed: Release readiness',
      semanticType: 'operation',
      runId: Number(run.id),
      interactionType: 'approval',
      interactionStatus: 'completed',
      interactionInputSchema: {
        type: 'object',
        properties: {
          reviewer_note: { type: 'string' },
          release_window: { type: 'string', enum: ['Today', 'Tomorrow'] },
        },
        required: ['release_window'],
      },
      interactionInput: {
        reviewer_note: 'Initial note',
        release_window: 'Today',
      },
      interactionOutput: {
        answer: { reviewer_note: 'Looks good', release_window: 'Tomorrow' },
      },
      metadata: { reviewed_by_name: 'Legacy Reviewer' },
    });

    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'completed-approval-view',
        method: 'tools/call',
        params: {
          name: 'get_approval',
          arguments: { run_id: Number(run.id) },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent).toEqual(
      expect.objectContaining({
        title: 'Question: Release readiness · completed',
        actions: [],
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            label: 'Automation',
            value: 'Hourly approval sweep',
          }),
          expect.objectContaining({
            type: 'form',
            initialValues: { reviewer_note: 'Looks good', release_window: 'Tomorrow' },
          }),
          expect.objectContaining({
            type: 'text',
            label: 'Decision',
            value: expect.stringMatching(
              /^Completed by Legacy Reviewer · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/
            ),
          }),
        ]),
      })
    );
  });

  it('re-reads the current approval past the default exact-id supersede page', async () => {
    const [run] = await getDb()<{ id: number }>`
      INSERT INTO runs (organization_id, run_type, status, approval_status)
      VALUES (${org.id}, 'action', 'pending', 'pending')
      RETURNING id
    `;
    const runId = Number(run.id);
    let current = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `mcp_app_deep_approval_${runId}_0`,
      title: 'Deep approval 0 — pending approval',
      content: 'Initial approval version.',
      semanticType: 'operation',
      runId,
      interactionType: 'approval',
      interactionStatus: 'pending',
    });
    for (let index = 1; index <= 200; index += 1) {
      current = await insertEvent({
        entityIds: [],
        organizationId: org.id,
        originId: `mcp_app_deep_approval_${runId}_${index}`,
        title: `Deep approval ${index} — pending approval`,
        content: `Approval version ${index}.`,
        semanticType: 'operation',
        runId,
        interactionType: 'approval',
        interactionStatus: 'pending',
        supersedesEventId: Number(current.id),
      });
    }

    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'deep-approval-chain',
        method: 'tools/call',
        params: { name: 'get_approval', arguments: { run_id: runId } },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent?.title).toContain('Deep approval 200');
  });

  it('redacts approval secrets before key context is lost and enforces view limits', async () => {
    const [run] = await getDb()<{ id: number }>`
      INSERT INTO runs (organization_id, run_type, status, approval_status)
      VALUES (${org.id}, 'action', 'pending', 'pending')
      RETURNING id
    `;
    const proposal: Record<string, unknown> = {
      token: 'plaintext-top-token',
      apiKey: 'plaintext-top-api-key',
      settings: {
        authorization: 'plaintext-nested-authorization',
        endpoint: 'postgres://user:plaintext-uri-password@example.com/db',
      },
    };
    const current: Record<string, unknown> = {
      token: 'plaintext-old-token',
      apiKey: 'plaintext-old-api-key',
    };
    const interactionInputSchema = {
      type: 'object',
      properties: {
        api_key: {
          type: 'string',
          default: 'plaintext-schema-api-key',
          description: 'Credential used for the request',
        },
        comment: { type: 'string' },
      },
      required: ['api_key'],
    };
    const interactionInput = {
      api_key: 'plaintext-form-api-key',
      comment: 'Safe existing note',
    };
    for (let index = 0; index < 130; index += 1) {
      proposal[`field_${index}_${'x'.repeat(150)}`] = `value_${index}_${'y'.repeat(21_000)}`;
    }
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `mcp_app_secret_approval_${run.id}`,
      title: `${'Long approval title '.repeat(20)}— pending approval`,
      content: 'Review the bounded proposal.',
      semanticType: 'operation',
      runId: Number(run.id),
      interactionType: 'approval',
      interactionStatus: 'pending',
      interactionInputSchema,
      interactionInput,
      metadata: { proposal, current },
    });

    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 210,
        method: 'tools/call',
        params: {
          name: 'get_approval',
          arguments: { run_id: Number(run.id) },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    const view = body.result?.structuredContent;
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('plaintext-top-token');
    expect(serialized).not.toContain('plaintext-top-api-key');
    expect(serialized).not.toContain('plaintext-old-token');
    expect(serialized).not.toContain('plaintext-old-api-key');
    expect(serialized).not.toContain('plaintext-nested-authorization');
    expect(serialized).not.toContain('plaintext-uri-password');
    expect(serialized).not.toContain('plaintext-schema-api-key');
    expect(serialized).not.toContain('plaintext-form-api-key');
    expect(serialized).toContain('[redacted]');
    expect(view.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'diff',
          fields: expect.arrayContaining([
            expect.objectContaining({ label: expect.stringMatching(/^Field 0 /) }),
          ]),
        }),
      ])
    );
    expect(view.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Source', value: 'Direct request' }),
      ])
    );
    expect(view.title.length).toBeLessThanOrEqual(200);
    expect(view.blocks.length).toBeLessThanOrEqual(100);
    expect(view.actions.length).toBeLessThanOrEqual(10);
    const form = view.blocks.find((block: any) => block.type === 'form');
    expect(form).toEqual(
      expect.objectContaining({
        schema: expect.objectContaining({
          properties: expect.objectContaining({
            api_key: expect.objectContaining({
              type: 'string',
              format: 'password',
              description: 'Credential used for the request',
            }),
          }),
          required: ['api_key'],
        }),
        initialValues: { comment: 'Safe existing note' },
      })
    );
    expect(form.schema.properties.api_key.default).toBeUndefined();
    const diffFields = view.blocks.flatMap((block: any) => block.fields ?? []);
    expect(diffFields.length).toBeLessThanOrEqual(100);
    for (const field of diffFields) {
      expect(field.label.length).toBeLessThanOrEqual(120);
      expect(field.before?.length ?? 0).toBeLessThanOrEqual(20_000);
      expect(field.after.length).toBeLessThanOrEqual(20_000);
    }
  });

  it('redacts prefixed connector review credentials in the rendered approval view', async () => {
    const [run] = await getDb()<{ id: number }>`
      INSERT INTO runs (organization_id, run_type, status, approval_status)
      VALUES (${org.id}, 'action', 'pending', 'pending')
      RETURNING id
    `;
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `mcp_app_connector_secret_approval_${run.id}`,
      title: 'Connector operation — pending approval',
      content: 'Review the connector operation.',
      semanticType: 'operation',
      runId: Number(run.id),
      interactionType: 'approval',
      interactionStatus: 'pending',
      metadata: {
        approval_context: { kind: 'connector', impact: { level: 'normal' } },
        review_fields: [
          { key: 'input_authorization', value: 'Bearer plaintext-review-authorization' },
          { key: 'input_cookie', value: 'session=plaintext-review-cookie' },
          {
            key: 'input_database_url',
            value: 'postgres://user:plaintext-review-password@db.example/app',
          },
          { key: 'input_summary', value: 'Safe review summary' },
        ],
      },
    });

    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 211,
        method: 'tools/call',
        params: {
          name: 'get_approval',
          arguments: { run_id: Number(run.id) },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    const serialized = JSON.stringify(body.result?.structuredContent);
    expect(serialized).not.toContain('plaintext-review-authorization');
    expect(serialized).not.toContain('plaintext-review-cookie');
    expect(serialized).not.toContain('plaintext-review-password');
    expect(serialized).toContain('Safe review summary');
    expect(body.result?.structuredContent?.blocks?.[0]?.fields).toEqual([
      { label: 'Input authorization', after: '[redacted]' },
      { label: 'Input cookie', after: '[redacted]' },
      { label: 'Input database url', after: '[redacted]' },
      { label: 'Input summary', after: 'Safe review summary' },
    ]);
  });

  it('keeps explicit null distinct from an empty string in approval diffs', async () => {
    const [run] = await getDb()<{ id: number }>`
      INSERT INTO runs (
        organization_id, run_type, status, approval_status, connector_key, action_key
      ) VALUES (
        ${org.id}, 'action', 'pending', 'pending', 'github', 'update_issue'
      )
      RETURNING id
    `;
    const runId = Number(run.id);
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `mcp_app_null_approval_${runId}`,
      title: 'Update issue — pending approval',
      content: 'Review this issue update.',
      semanticType: 'operation',
      connectorKey: 'github',
      runId,
      interactionType: 'approval',
      interactionStatus: 'pending',
      interactionInput: { cleared: null, emptied: '' },
      metadata: {
        proposal: { cleared: null, emptied: '' },
        current: { cleared: 'before', emptied: 'before' },
      },
    });

    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 214,
        method: 'tools/call',
        params: {
          name: 'get_approval',
          arguments: { run_id: runId },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const body = await response.json();
    expect(body.result?.structuredContent?.blocks?.[0]?.fields).toEqual([
      { label: 'Cleared', before: 'before', after: 'null' },
      { label: 'Emptied', before: 'before', after: '' },
    ]);
    expect(body.result?.content?.[0]?.text).toContain('before → null');
    expect(body.result?.content?.[0]?.text).toContain('before → —');
  });

  it('includes the scoped connector identity used by the approval card', async () => {
    const connectorKey = 'github.approval-card';
    await getDb()`
      INSERT INTO connector_definitions (
        organization_id, key, name, favicon_domain, status
      ) VALUES (
        ${org.id}, ${connectorKey}, 'GitHub', 'github.com', 'active'
      )
    `;
    const [run] = await getDb()<{ id: number }>`
      INSERT INTO runs (
        organization_id, run_type, status, approval_status, connector_key, action_key
      ) VALUES (
        ${org.id}, 'action', 'pending', 'pending', ${connectorKey}, 'update_issue'
      )
      RETURNING id
    `;
    const runId = Number(run.id);
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `mcp_app_connector_identity_${runId}`,
      title: 'Update issue — pending approval',
      content: 'Review this issue update.',
      semanticType: 'operation',
      connectorKey,
      runId,
      interactionType: 'approval',
      interactionStatus: 'pending',
      metadata: {
        approval_context: { kind: 'connector', impact: { level: 'normal' } },
      },
    });

    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 215,
        method: 'tools/call',
        params: {
          name: 'get_approval',
          arguments: { run_id: runId },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const body = await response.json();
    expect(body.result?.structuredContent).toMatchObject({
      icon: 'connector',
      connector: {
        key: connectorKey,
        name: 'GitHub',
        favicon_domain: 'github.com',
      },
    });
  });

  it('uses the warning tone only for an elevated-impact pending action', async () => {
    const [run] = await getDb()<{ id: number }>`
      INSERT INTO runs (organization_id, run_type, status, approval_status)
      VALUES (${org.id}, 'internal', 'pending', 'pending')
      RETURNING id
    `;
    const runId = Number(run.id);
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `mcp_app_delete_approval_${runId}`,
      title: 'Delete entity type: Legacy customer — pending approval',
      content: 'Review this high-impact deletion.',
      semanticType: 'operation',
      runId,
      interactionType: 'approval',
      interactionStatus: 'pending',
      interactionInput: { slug: 'legacy-customer' },
      metadata: {
        action: 'delete',
        proposal: { slug: 'legacy-customer' },
        approval_context: {
          kind: 'entity-schema',
          impact: {
            level: 'high',
            reason: 'This removes the entity type contract.',
            consequences: ['Future writes can no longer use this type.'],
          },
        },
      },
    });

    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 216,
        method: 'tools/call',
        params: {
          name: 'get_approval',
          arguments: { run_id: runId },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const body = await response.json();
    expect(body.result?.structuredContent?.icon).toBe('entity-schema');
    expect(body.result?.structuredContent?.impact).toEqual({
      level: 'high',
      reason: 'This removes the entity type contract.',
      consequences: ['Future writes can no longer use this type.'],
    });
    expect(body.result?.structuredContent?.tone).toBe('warning');
    expect(body.result?.structuredContent?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'approve', variant: 'primary' }),
        expect.objectContaining({ id: 'reject', variant: 'outline' }),
        expect.objectContaining({ id: 'review', variant: 'outline' }),
      ])
    );
  });

  it('classifies an approval written before approval_context existed', async () => {
    const [run] = await getDb()<{ id: number }>`
      INSERT INTO runs (organization_id, run_type, status, approval_status)
      VALUES (${org.id}, 'internal', 'pending', 'pending')
      RETURNING id
    `;
    const runId = Number(run.id);
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `mcp_app_legacy_approval_${runId}`,
      title: 'Delete entity: Legacy contact — pending approval',
      content: 'Review this deletion.',
      semanticType: 'operation',
      runId,
      interactionType: 'approval',
      interactionStatus: 'pending',
      interactionInput: { entity_id: 42 },
      // A row already pending at rollout: the producer never stamped
      // `approval_context`, so kind comes from `tool` and impact from `action`.
      metadata: { tool: 'entity_change', action: 'delete' },
    });

    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 217,
        method: 'tools/call',
        params: { name: 'get_approval', arguments: { run_id: runId } },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const body = await response.json();
    expect(body.result?.structuredContent?.icon).toBe('entity');
    expect(body.result?.structuredContent?.impact).toEqual({
      level: 'high',
      reason: 'This action can remove or irreversibly change data.',
    });
    expect(body.result?.structuredContent?.tone).toBe('warning');
  });

  it('warns for a legacy connector approval whose impact cannot be reconstructed', async () => {
    const [run] = await getDb()<{ id: number }>`
      INSERT INTO runs (
        organization_id, run_type, status, approval_status, connector_key, action_key
      ) VALUES (
        ${org.id}, 'action', 'pending', 'pending', 'github', 'legacy_external_action'
      )
      RETURNING id
    `;
    const runId = Number(run.id);
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `mcp_app_legacy_connector_approval_${runId}`,
      title: 'Legacy connector action — pending approval',
      content: 'Review this connected-service change.',
      semanticType: 'operation',
      connectorKey: 'github',
      runId,
      interactionType: 'approval',
      interactionStatus: 'pending',
      interactionInput: { target: 'external-record-123' },
      metadata: { operation_key: 'legacy_external_action' },
    });

    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 218,
        method: 'tools/call',
        params: { name: 'get_approval', arguments: { run_id: runId } },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const body = await response.json();
    expect(body.result?.structuredContent?.icon).toBe('connector');
    expect(body.result?.structuredContent?.impact).toEqual({
      level: 'high',
      reason:
        'This connector approval predates impact metadata, so its external effect cannot be verified.',
      consequences: ['Review the connected-service change before approving.'],
    });
    expect(body.result?.structuredContent?.tone).toBe('warning');
  });

  it('bounds explicit approval impact metadata for the MCP view contract', async () => {
    const [run] = await getDb()<{ id: number }>`
      INSERT INTO runs (organization_id, run_type, status, approval_status)
      VALUES (${org.id}, 'internal', 'pending', 'pending')
      RETURNING id
    `;
    const runId = Number(run.id);
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `mcp_app_bounded_approval_impact_${runId}`,
      title: 'Bound approval impact — pending approval',
      content: 'Review this bounded impact metadata.',
      semanticType: 'operation',
      runId,
      interactionType: 'approval',
      interactionStatus: 'pending',
      metadata: {
        approval_context: {
          kind: 'entity-schema',
          impact: {
            level: 'high',
            reason: 'r'.repeat(501),
            consequences: [
              'c'.repeat(501),
              'two',
              'three',
              'four',
              'five',
              'six',
            ],
          },
        },
      },
    });

    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 218,
        method: 'tools/call',
        params: { name: 'get_approval', arguments: { run_id: runId } },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const body = await response.json();
    const impact = body.result?.structuredContent?.impact;
    expect(impact.reason).toHaveLength(500);
    expect(impact.reason.endsWith('…')).toBe(true);
    expect(impact.consequences).toHaveLength(5);
    expect(impact.consequences[0]).toHaveLength(500);
    expect(impact.consequences[0].endsWith('…')).toBe(true);
    expect(impact.consequences).not.toContain('six');
  });

  it('keeps user-authored envelope-shaped fields in an ordinary approval proposal', async () => {
    const [run] = await getDb()<{ id: number }>`
      INSERT INTO runs (organization_id, run_type, status, approval_status)
      VALUES (${org.id}, 'internal', 'pending', 'pending')
      RETURNING id
    `;
    const runId = Number(run.id);
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `mcp_app_user_args_approval_${runId}`,
      title: 'Create entity — pending approval',
      content: 'Review this entity proposal.',
      semanticType: 'operation',
      runId,
      interactionType: 'approval',
      interactionStatus: 'pending',
      interactionInput: { action: 'create' },
      metadata: {
        tool: 'entity_change',
        proposal: {
          args: { mode: 'careful' },
          title: 'Visible sibling field',
          schema_type: 'Visible user field',
          version: 'Visible user version',
        },
      },
    });

    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 215,
        method: 'tools/call',
        params: {
          name: 'get_approval',
          arguments: { run_id: runId },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const body = await response.json();
    const ordinaryFields = body.result?.structuredContent?.blocks?.[0]?.fields;
    expect(ordinaryFields).toHaveLength(4);
    expect(ordinaryFields).toEqual(
      expect.arrayContaining([
        {
          label: 'Args',
          after: '{\n  "mode": "careful"\n}',
          format: 'code',
        },
        { label: 'Title', after: 'Visible sibling field' },
        { label: 'Schema type', after: 'Visible user field' },
        { label: 'Version', after: 'Visible user version' },
      ]),
    );
  });

  it('does not render an approval from another member private connection', async () => {
    const member = await createTestUser({
      email: 'mcp-app-member@test.example.com',
    });
    await addUserToOrganization(member.id, org.id, 'member');
    const memberToken = (
      await createTestAccessToken(member.id, org.id, client.client_id, {
        scope: 'mcp:read profile:read',
      })
    ).token;
    const privateConnection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      created_by: owner.id,
      visibility: 'private',
      createDefaultFeed: false,
    });
    const [run] = await getDb()<{ id: number }>`
      INSERT INTO runs (
        organization_id, run_type, status, approval_status, connection_id,
        connector_key, action_key
      ) VALUES (
        ${org.id}, 'action', 'pending', 'pending', ${privateConnection.id},
        'github', 'create_issue'
      )
      RETURNING id
    `;
    const runId = Number(run.id);
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `mcp_app_private_approval_${runId}`,
      title: 'Private action — pending approval',
      content: 'This approval must remain private to the connection owner.',
      semanticType: 'operation',
      connectorKey: 'github',
      connectionId: privateConnection.id,
      runId,
      interactionType: 'approval',
      interactionStatus: 'pending',
    });

    const sessionId = await initSession(`/mcp/${org.slug}`, {
      sessionToken: memberToken,
    });
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 211,
        method: 'tools/call',
        params: {
          name: 'get_approval',
          arguments: { run_id: runId },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token: memberToken,
    });
    const body = await response.json();
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent).toBeUndefined();
    expect(body.result?.content?.[0]?.text).toBe(`Approval run ${runId} was not found`);
  });

  it('retains the initialized public resource URL in a later scope challenge', async () => {
    const readlessToken = (
      await createTestAccessToken(owner.id, org.id, client.client_id, {
        scope: 'profile:read',
      })
    ).token;
    const sessionId = await initSession(`/mcp/${org.slug}`, {
      sessionToken: readlessToken,
      headers: {
        host: 'internal.service:8787',
        'x-forwarded-host': 'mcp.public.example',
        'x-forwarded-proto': 'https',
      },
    });
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: {
          name: 'get_approval',
          arguments: { run_id: 999_999_999 },
        },
      },
      // Deliberately omit forwarded headers after initialize. The transport
      // must challenge against the canonical URL retained by the session.
      headers: { 'mcp-session-id': sessionId },
      token: readlessToken,
    });
    const body = await response.json();
    const challenge = body.result?._meta?.['mcp/www_authenticate']?.[0];
    expect(body.result?.isError).toBe(true);
    expect(challenge).toContain(
      `resource_metadata="https://mcp.public.example/.well-known/oauth-protected-resource/mcp/${org.slug}"`
    );
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="mcp:read"');
    expect(challenge).not.toContain('internal.service');
  });

  it('keeps the member role alongside the OAuth scope challenge on a thrown UI-tool error', async () => {
    // A scope-less OAuth token throws at the access check, and the catch path
    // emits the `mcp/www_authenticate` challenge. The viewer role must ride
    // along in the SAME `_meta`, merged rather than overwritten, so the app
    // never sees a role-less error result and falls back to a stale role.
    const readlessToken = (
      await createTestAccessToken(owner.id, org.id, client.client_id, {
        scope: 'profile:read',
      })
    ).token;
    const sessionId = await initSession(`/mcp/${org.slug}`, {
      sessionToken: readlessToken,
    });
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'scope-challenge-member-role',
        method: 'tools/call',
        params: {
          name: 'get_approval',
          arguments: { run_id: 999_999_999 },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token: readlessToken,
    });
    const body = await response.json();
    const challenge = body.result?._meta?.['mcp/www_authenticate']?.[0];
    expect(body.result?.isError).toBe(true);
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="mcp:read"');
    expect(body.result?._meta?.['lobu/member-role']).toBe('owner');
  });

  it('emits structuredContent for a tool that declares an outputSchema', async () => {
    // Contrast with the manage_agents case above: a tool WITH an outputSchema
    // returns matching structuredContent alongside its text content (MCP spec:
    // declaring outputSchema implies the result is structured). search_sdk is a
    // self-contained leaf, so its structuredContent shape is stable.
    const sessionId = await initSession(`/mcp/${org.slug}`);
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'search_sdk', arguments: { query: 'automations' } },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent).toEqual(
      expect.objectContaining({
        query: 'automations',
        match_count: expect.any(Number),
        results: expect.any(Array),
      })
    );
    const serializedDiscovery = JSON.stringify(body.result?.structuredContent).toLowerCase();
    for (const retiredTerm of [
      'wat' + 'cher',
      'behav' + 'ior',
      'behav' + 'iour',
    ]) {
      expect(serializedDiscovery).not.toContain(retiredTerm);
    }
    // The text content is still present (clients that ignore structuredContent
    // get the same data as text).
    expect(typeof body.result?.content?.[0]?.text).toBe('string');
  });

  it('keeps x-mcp-format isolated across concurrent MCP sessions', async () => {
    const jsonSessionId = await initSession(`/mcp/${org.slug}`);
    const markdownSessionId = await initSession(`/mcp/${org.slug}`);

    // Keep the JSON-formatted request inside its tool handler while a second
    // request enters the MCP boundary with the default markdown format. A
    // process-global format flag lets the second request overwrite the first.
    const jsonRequest = post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'query_sdk',
          arguments: {
            script:
              'export default async (ctx) => { await ctx.sleep(150); return { marker: "json-session" }; };',
          },
        },
      },
      headers: {
        'mcp-session-id': jsonSessionId,
        'x-mcp-format': 'json',
      },
      token,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    const markdownResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'search_sdk', arguments: { query: 'entities.list' } },
      },
      headers: { 'mcp-session-id': markdownSessionId },
      token,
    });

    expect(markdownResponse.status).toBe(200);
    const markdownBody = await markdownResponse.json();
    expect(markdownBody.result?.content?.[0]?.text).toMatch(/^```json/);

    const jsonResponse = await jsonRequest;
    expect(jsonResponse.status).toBe(200);
    const jsonBody = await jsonResponse.json();
    const jsonText = jsonBody.result?.content?.[0]?.text as string;
    expect(jsonText).toMatch(/^\{/);
    expect(JSON.parse(jsonText)).toMatchObject({
      success: true,
      return_value: { marker: 'json-session' },
    });
  });
});
