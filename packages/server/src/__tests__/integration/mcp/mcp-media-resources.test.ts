import { mkdtempSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { agentGuestBundle } from '@lobu/connector-worker/agent-turn';
import { IsolateExecutor } from '@lobu/connector-worker/executor/isolate';
import { MCP_PROTOCOL_VERSION } from '@lobu/core';
import type { Context } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../../db/client';
import {
  ArtifactStore,
  eventArtifactBinding,
  runArtifactBinding,
} from '../../../gateway/files/artifact-store';
import type { Env } from '../../../index';
import * as lobuGateway from '../../../lobu/gateway';
import { clearInMemoryMcpSessionsForTests } from '../../../mcp-handler';
import { insertEvent } from '../../../utils/insert-event';
import { completeActionRun, streamContent } from '../../../worker-api';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';
import { syntheticImage } from '../../../../../../scripts/__tests__/fixtures/synthetic-image';
import { materializeActionOutputAttachments } from '../../../utils/inline-attachments';

function mockWorkerCtx(body: unknown): {
  ctx: Context<{ Bindings: Env }>;
  result: () => { body: unknown; status: number };
} {
  let captured: { body: unknown; status: number } = { body: undefined, status: 200 };
  const ctx = {
    req: { json: async () => body },
    var: {},
    json: (responseBody: unknown, status?: number) => {
      captured = { body: responseBody, status: status ?? 200 };
      return captured as unknown as Response;
    },
  } as unknown as Context<{ Bindings: Env }>;
  return { ctx, result: () => captured };
}

/** The actual MCP result crosses the isolate and provider serializer as bytes. */
async function modelRequestAfterObservation(toolResult: unknown): Promise<string> {
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    if (req.url === '/mcp/synthetic/tools/observe') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(toolResult)); return;
    }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    requests.push(body);
    const choice = requests.length === 1
      ? { index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'observe-call', type: 'function', function: { name: 'observe', arguments: '{}' } }] }, finish_reason: 'tool_calls' }
      : { index: 0, delta: { role: 'assistant', content: 'Observed.' }, finish_reason: 'stop' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [choice] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const executor = new IsolateExecutor({ timeoutMs: 30_000, allowedDomains: ['127.0.0.1'] });
    const result = await executor.execute(await agentGuestBundle(), {
      mode: 'agent_turn', config: {}, credentials: { provider: 'openai', accessToken: 'synthetic-key' }, sessionState: null, env: {},
      turn: { provider: { api: 'openai-completions', provider: 'openai', modelId: 'synthetic', baseUrl: `${origin}/v1`, input: ['text', 'image'] },
        systemPrompt: 'Observe once.', userMessage: 'Inspect the screenshot.', sessionJsonl: '',
        tools: { gatewayUrl: origin, definitions: [{ mcpId: 'synthetic', name: 'observe', description: 'Observe a synthetic screenshot', inputSchema: { type: 'object', properties: {} } }] } },
    }, {});
    expect(result.mode).toBe('agent_turn');
    expect(requests).toHaveLength(2);
    return requests[1];
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

describe('MCP media resources', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let token: string;
  let bareToken: string;
  let ownerId: string;
  let artifactStore: ArtifactStore;
  let artifactsDir: string;
  let restoreCoreServices: (() => void) | undefined;
  const previousArtifactsDir = process.env.LOBU_ARTIFACTS_DIR;
  const previousEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeAll(async () => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'lobu-mcp-media-'));
    process.env.LOBU_ARTIFACTS_DIR = artifactsDir;
    process.env.ENCRYPTION_KEY = Buffer.from(
      '12345678901234567890123456789012'
    ).toString('base64');
    artifactStore = new ArtifactStore();
    const coreServices = vi
      .spyOn(lobuGateway, 'getLobuCoreServices')
      .mockReturnValue({ getArtifactStore: () => artifactStore });
    restoreCoreServices = () => coreServices.mockRestore();

    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({
      name: 'MCP Media Org',
      slug: 'mcp-media-org',
    });
    const owner = await createTestUser({ email: 'mcp-media-owner@test.example.com' });
    ownerId = owner.id;
    await addUserToOrganization(owner.id, org.id, 'owner');
    const client = await createTestOAuthClient();
    token = (
      await createTestAccessToken(owner.id, org.id, client.client_id, {
        scope: 'mcp:admin mcp:write mcp:read profile:read',
      })
    ).token;
    bareToken = (await createTestAccessToken(owner.id, org.id, client.client_id, {
      scope: 'mcp:admin mcp:write mcp:read profile:read', resource: 'http://localhost/mcp',
    })).token;
    // Current account OAuth grants have no implicit default workspace.
    await getDb()`UPDATE oauth_tokens SET organization_id = NULL WHERE client_id = ${client.client_id} AND resource = 'http://localhost/mcp'`;
    clearInMemoryMcpSessionsForTests();
  });

  afterAll(() => {
    restoreCoreServices?.();
    if (previousArtifactsDir === undefined) delete process.env.LOBU_ARTIFACTS_DIR;
    else process.env.LOBU_ARTIFACTS_DIR = previousArtifactsDir;
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
    if (artifactsDir) rmSync(artifactsDir, { recursive: true, force: true });
  });

  async function initSession(path = `/mcp/${org.slug}`): Promise<string> {
    const initResponse = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: '__test_init__',
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'lobu-mcp-media-test', version: '1.0' },
        },
      },
      token: path === '/mcp' ? bareToken : token,
    });
    expect(initResponse.status, JSON.stringify(await initResponse.json())).toBe(200);
    const sessionId = initResponse.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await post(path, {
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      headers: {
        'mcp-session-id': sessionId!,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      token: path === '/mcp' ? bareToken : token,
    });
    return sessionId!;
  }

  it('materializes streamed media with connection-over-feed binding and reads its resource', async () => {
    const imageBytes = Buffer.from('durable-event-image');
    const sql = getDb();
    const [connection] = await sql`
      INSERT INTO connections (
        organization_id, connector_key, status, visibility, slug, created_at, updated_at
      ) VALUES (
        ${org.id}, 'rss', 'active', 'org', 'mcp-media-stream', NOW(), NOW()
      )
      RETURNING id
    `;
    const connectionId = Number(connection!.id);
    const [feed] = await sql`
      INSERT INTO feeds (
        organization_id, connection_id, feed_key, status, created_at, updated_at
      ) VALUES (
        ${org.id}, ${connectionId}, 'items', 'active', NOW(), NOW()
      )
      RETURNING id
    `;
    const feedId = Number(feed!.id);
    const [run] = await sql`
      INSERT INTO runs (
        organization_id, run_type, feed_id, connection_id, connector_key,
        connector_version, status, claimed_by, created_at
      ) VALUES (
        ${org.id}, 'sync', ${feedId}, ${connectionId}, 'rss', '1.0.0',
        'running', 'worker-mcp-media', NOW()
      )
      RETURNING id
    `;
    const runId = Number(run!.id);
    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: 'worker-mcp-media',
      items: [
        {
          id: 'mcp-media-event',
          title: 'Memory photo',
          payload_text: 'A streamed photo',
          payload_type: 'media',
          occurred_at: new Date().toISOString(),
          attachments: [
            {
              kind: 'image',
              filename: 'memory-photo.webp',
              mime_type: 'image/webp',
              data: imageBytes.toString('base64'),
            },
          ],
        },
      ],
    });
    await streamContent(ctx);
    expect(result()).toMatchObject({ status: 200, body: { total_items: 1 } });

    const [event] = await sql`
      SELECT id, attachments
      FROM events
      WHERE organization_id = ${org.id}
        AND origin_id = 'mcp-media-event'
      ORDER BY id DESC
      LIMIT 1
    `;
    const eventId = Number(event!.id);
    const attachment = (event!.attachments as Array<Record<string, unknown>>)[0]!;
    const artifactId = String(attachment.artifact_id);
    expect(
      await artifactStore.read(artifactId, {
        binding: eventArtifactBinding({
          organizationId: org.id,
          connectionId,
          feedId,
          originId: 'mcp-media-event',
        }),
      })
    ).toBeTruthy();
    expect(
      await artifactStore.read(artifactId, {
        binding: eventArtifactBinding({
          organizationId: org.id,
          feedId,
          originId: 'mcp-media-event',
        }),
      })
    ).toBeNull();

    const sessionId = await initSession();
    const path = `/mcp/${org.slug}`;
    const response = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: 'event-media',
        method: 'tools/call',
        params: {
          name: 'run_sdk',
          arguments: {
            script: `export default async (_ctx, client) => client.knowledge.read({ content_ids: [${eventId}] });`,
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const resource = body.result?.content?.find(
      (item: { type?: string }) => item.type === 'resource_link'
    );
    expect(resource).toEqual(
      expect.objectContaining({
        type: 'resource_link',
        uri: `lobu://event/${eventId}/attachment/0`,
        name: 'memory-photo.webp',
        mimeType: 'image/webp',
        size: imageBytes.length,
      })
    );

    const readResponse = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: 'read-event-media',
        method: 'resources/read',
        params: { uri: resource.uri },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const readBody = await readResponse.json();
    expect(readBody.result?.contents?.[0]).toEqual({
      uri: resource.uri,
      mimeType: 'image/webp',
      blob: imageBytes.toString('base64'),
    });

    const artifactsBeforeFailedInsert = (await readdir(artifactsDir)).sort();
    const failedInsert = mockWorkerCtx({
      run_id: runId,
      worker_id: 'worker-mcp-media',
      items: [
        {
          id: 'mcp-media-invalid-event',
          title: 'Invalid streamed photo',
          payload_text: 'This insert must fail',
          payload_type: 'media',
          occurred_at: 'not-a-timestamp',
          attachments: [
            {
              kind: 'image',
              filename: 'invalid.webp',
              mime_type: 'image/webp',
              data: Buffer.from('must-be-cleaned').toString('base64'),
            },
          ],
        },
      ],
    });
    await streamContent(failedInsert.ctx);
    expect(failedInsert.result().status).toBe(500);
    expect((await readdir(artifactsDir)).sort()).toEqual(artifactsBeforeFailedInsert);
  });

  it.each(['bound', 'bare'])('does not let a resource URI bypass workspace authorization (%s)', async mode => {
    const otherOrg = await createTestOrganization({
      name: 'Other MCP Media Org',
      slug: `other-mcp-media-org-${mode}`,
    });
    // Membership alone cannot widen an account OAuth grant snapshot.
    if (mode === 'bare') await addUserToOrganization(ownerId, otherOrg.id, 'owner');
    const bytes = Buffer.from('other-workspace-image');
    const artifact = await artifactStore.publish({
      buffer: bytes,
      filename: 'private.jpg',
      contentType: 'image/jpeg',
      publicGatewayUrl: 'http://localhost',
      binding: eventArtifactBinding({
        organizationId: otherOrg.id,
        originId: `other-mcp-media-event-${mode}`,
      }),
    });
    const event = await insertEvent({
      entityIds: [],
      organizationId: otherOrg.id,
      originId: `other-mcp-media-event-${mode}`,
      title: 'Other workspace photo',
      payloadType: 'media',
      content: '',
      semanticType: 'photo',
      attachments: [
        {
          kind: 'image',
          filename: 'private.jpg',
          mime_type: 'image/jpeg',
          artifact_id: artifact.artifactId,
          size_bytes: bytes.length,
        },
      ],
    });

    const path = mode === 'bare' ? '/mcp' : `/mcp/${org.slug}`;
    const sessionId = await initSession(path);
    const response = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: 'cross-org-media',
        method: 'resources/read',
        params: { uri: `lobu://event/${event.id}/attachment/0` },
      },
      headers: { 'mcp-session-id': sessionId },
      token: mode === 'bare' ? bareToken : token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toBeUndefined();
    expect(body.error?.message).toContain('Unknown resource');
  });

  it('fails safely for invalid, missing, and oversized resources', async () => {
    // One byte past the 20 MB inline cap this endpoint has always served.
    const oversizedBytes = Buffer.alloc(20 * 1024 * 1024 + 1, 1);
    const artifact = await artifactStore.publish({
      buffer: oversizedBytes,
      filename: 'oversized.bin',
      contentType: 'application/octet-stream',
      publicGatewayUrl: 'http://localhost',
      binding: eventArtifactBinding({
        organizationId: org.id,
        originId: 'oversized-mcp-media-event',
      }),
    });
    const event = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'oversized-mcp-media-event',
      title: 'Oversized attachment',
      payloadType: 'media',
      content: '',
      semanticType: 'file',
      attachments: [
        {
          kind: 'file',
          filename: 'oversized.bin',
          mime_type: 'application/octet-stream',
          artifact_id: artifact.artifactId,
          size_bytes: oversizedBytes.length,
        },
      ],
    });
    const sessionId = await initSession();
    const path = `/mcp/${org.slug}`;

    for (const uri of [
      'lobu://event/not-a-number/attachment/0',
      `lobu://event/${event.id}/attachment/99`,
    ]) {
      const response = await post(path, {
        body: {
          jsonrpc: '2.0',
          id: `invalid-${uri}`,
          method: 'resources/read',
          params: { uri },
        },
        headers: { 'mcp-session-id': sessionId },
        token,
      });
      const body = await response.json();
      expect(body.result).toBeUndefined();
      expect(body.error?.message).toContain('Unknown resource');
    }

    const oversizedResponse = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: 'oversized-resource',
        method: 'resources/read',
        params: { uri: `lobu://event/${event.id}/attachment/0` },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const oversizedBody = await oversizedResponse.json();
    expect(oversizedBody.result).toBeUndefined();
    // Distinguishable from an absent resource: the payload exists, it just
    // cannot be inlined. A bounded read alone would report it as "Unknown".
    expect(oversizedBody.error?.message).toContain('too large to inline');
    expect(oversizedBody.error?.message).toContain(
      String(oversizedBytes.length)
    );
  });

  it('cleans action artifacts when finalization rolls back or commits zero rows', async () => {
    const sql = getDb();
    const [rollbackRun, finalizedRun] = await Promise.all([
      sql`
        INSERT INTO runs (
          organization_id, run_type, status, approval_status, claimed_by, action_key
        ) VALUES (
          ${org.id}, 'action', 'running', 'approved', 'worker-media-cleanup', 'capture'
        )
        RETURNING id
      `.then((rows) => rows[0]),
      sql`
        INSERT INTO runs (
          organization_id, run_type, status, approval_status, claimed_by, action_key
        ) VALUES (
          ${org.id}, 'action', 'completed', 'auto', 'worker-media-cleanup', 'capture'
        )
        RETURNING id
      `.then((rows) => rows[0]),
    ]);
    const artifactsBefore = (await readdir(artifactsDir)).sort();
    const rollback = mockWorkerCtx({
        run_id: Number(rollbackRun!.id),
        worker_id: 'worker-media-cleanup',
        status: 'success',
        action_output: {
          attachments: [
            {
              filename: 'rollback.jpg',
              mime_type: 'image/jpeg',
              data: Buffer.from('rollback-artifact').toString('base64'),
            },
          ],
        },
      });
    await completeActionRun(rollback.ctx);
    expect(rollback.result().status).toBe(500);
    expect((rollback.result().body as { error?: string }).error).toContain(
      'approval card is missing'
    );

    const zeroRows = mockWorkerCtx({
        run_id: Number(finalizedRun!.id),
        worker_id: 'worker-media-cleanup',
        status: 'success',
        action_output: {
          attachments: [
            {
              filename: 'already-finalized.jpg',
              mime_type: 'image/jpeg',
              data: Buffer.from('zero-row-artifact').toString('base64'),
            },
          ],
        },
      });
    await completeActionRun(zeroRows.ctx);
    expect(zeroRows.result()).toMatchObject({
      status: 200,
      body: { success: false, reason: 'already_finalized' },
    });

    expect((await readdir(artifactsDir)).sort()).toEqual(artifactsBefore);
    const [runAfterRollback] = await sql`
      SELECT status FROM runs WHERE id = ${Number(rollbackRun!.id)}
    `;
    expect(runAfterRollback!.status).toBe('running');
  });

  it('rejects an artifact grafted from another authorized resource', async () => {
    const otherOrg = await createTestOrganization({
      name: 'Foreign Artifact Org',
      slug: 'foreign-artifact-org',
    });
    const sql = getDb();
    const [foreignRun, localRun] = await Promise.all([
      sql`
        INSERT INTO runs (organization_id, run_type, status, approval_status)
        VALUES (${otherOrg.id}, 'action', 'completed', 'auto')
        RETURNING id
      `.then((rows) => rows[0]),
      sql`
        INSERT INTO runs (organization_id, run_type, status, approval_status)
        VALUES (${org.id}, 'action', 'completed', 'auto')
        RETURNING id
      `.then((rows) => rows[0]),
    ]);
    const foreignRunId = Number(foreignRun!.id);
    const localRunId = Number(localRun!.id);
    const foreignBytes = Buffer.from('foreign-artifact-bytes');
    const foreignArtifact = await artifactStore.publish({
      buffer: foreignBytes,
      filename: 'foreign.jpg',
      contentType: 'image/jpeg',
      publicGatewayUrl: 'http://localhost',
      binding: runArtifactBinding(foreignRunId),
    });
    await sql`
      UPDATE runs
      SET action_output = ${sql.json({
        attachments: [
          {
            kind: 'image',
            filename: 'foreign.jpg',
            mime_type: 'image/jpeg',
            artifact_id: foreignArtifact.artifactId,
            size_bytes: foreignBytes.length,
          },
        ],
      })}
      WHERE id = ${localRunId}
    `;

    const sessionId = await initSession();
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'grafted-media',
        method: 'resources/read',
        params: { uri: `lobu://run/${localRunId}/attachment/0` },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toBeUndefined();
    expect(body.error?.message).toContain('Unknown resource');
  });

  it.each(['child', 'unrelated', 'foreign', 'unlisted', 'unfinished', 'unbound', 'noncanonical'])('preserves only authorized completed child artifacts: %s', async (kind) => {
    const sql = getDb();
    const [parent] = await sql`
      INSERT INTO runs (organization_id, run_type, status, approval_status)
      VALUES (${org.id}, 'action', 'running', 'auto') RETURNING id
    `;
    const parentId = Number(parent!.id);
    const otherOrg = kind === 'foreign' ? await createTestOrganization({ name: 'Other Child Org', slug: 'other-child-org' }) : org;
    const [child] = await sql`
      INSERT INTO runs (organization_id, parent_run_id, run_type, status, approval_status)
      VALUES (${otherOrg.id}, ${kind === 'unrelated' ? null : parentId}, 'action', ${kind === 'unfinished' ? 'running' : 'completed'}, 'auto') RETURNING id
    `;
    const childId = Number(child!.id);
    const bytes = syntheticImage().bytes;
    const binding = kind === 'unbound' ? undefined : kind === 'noncanonical' ? `run:0${childId}` : runArtifactBinding(childId);
    const artifact = await artifactStore.publish({ buffer: bytes, filename: 'child.png', contentType: 'image/png', publicGatewayUrl: 'http://localhost', binding });
    const attachment = { kind: 'image', filename: 'child.png', mime_type: 'image/png', artifact_id: artifact.artifactId, size_bytes: bytes.length };
    if (kind !== 'unlisted') await sql`UPDATE runs SET action_output = ${sql.json({ attachments: [attachment] })} WHERE id = ${childId}`;
    const materialized = await materializeActionOutputAttachments(parentId, { attachments: [attachment] });
    const returned = (materialized.output.attachments as Array<{ artifact_id: string }>)[0]!;
    const parentArtifact = await artifactStore.read(returned.artifact_id, { binding: runArtifactBinding(parentId) });
    if (kind === 'child') {
      expect(parentArtifact?.bytes).toEqual(bytes);
      expect(materialized.publishedArtifactIds).toEqual([returned.artifact_id]);
    } else {
      expect(parentArtifact).toBeNull();
      expect(materialized.publishedArtifactIds).toEqual([]);
    }
    // Delegation must not mutate the child's artifact or loosen its binding.
    expect((await artifactStore.read(artifact.artifactId, { binding }))?.bytes).toEqual(bytes);
  });

  it.each(['direct', 'wrapped', 'bare'])('returns %s operation attachments as pixels and stable resource links', async (shape) => {
    const imageBytes = syntheticImage().bytes;
    const sql = getDb();
    const [run] = await sql`
      INSERT INTO runs (
        organization_id, run_type, status, approval_status
      ) VALUES (
        ${org.id}, 'action', 'completed', 'auto'
      )
      RETURNING id
    `;
    const runId = Number(run!.id);
    const artifact = await artifactStore.publish({
      buffer: imageBytes,
      filename: 'candidate.png',
      contentType: 'image/png',
      publicGatewayUrl: 'http://localhost',
      ttlMs: -1,
      binding: runArtifactBinding(runId),
    });
    const expiredToken = new URL(artifact.downloadUrl).searchParams.get('token');
    expect(expiredToken).toBeTruthy();
    expect(artifactStore.validateDownloadToken(expiredToken!, artifact.artifactId).valid).toBe(
      false
    );
    await sql`
      UPDATE runs
      SET action_output = ${sql.json({
        attachments: [
          {
            kind: 'image',
            filename: 'candidate.png',
            mime_type: 'image/png',
            artifact_id: artifact.artifactId,
            download_url: artifact.downloadUrl,
            size_bytes: imageBytes.length,
          },
        ],
      })}
      WHERE id = ${runId}
    `;

    const path = shape === 'bare' ? '/mcp' : `/mcp/${org.slug}`;
    const sessionId = await initSession(path);
    const response = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: 'operation-media',
        method: 'tools/call',
        params: {
          name: 'run_sdk',
          arguments: {
            script: shape === 'bare'
              ? `export default async (_ctx, client) => ({ shots: [await (await client.org('${org.slug}')).operations.getRun(${runId})] });`
              : shape === 'direct'
              ? `export default async (_ctx, client) => client.operations.getRun(${runId});`
              : `export default async (_ctx, client) => ({ shots: [await client.operations.getRun(${runId})] });`,
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token: shape === 'bare' ? bareToken : token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result?.isError).not.toBe(true);
    const resource = body.result?.content?.find(
      (item: { type?: string }) => item.type === 'resource_link'
    );
    expect(resource).toEqual(
      expect.objectContaining({
        type: 'resource_link',
        uri: `lobu://run/${runId}/attachment/0`,
        name: 'candidate.png',
        mimeType: 'image/png',
        size: imageBytes.length,
      })
    );
    expect(body.result?.content).toContainEqual({
      type: 'image', mimeType: 'image/png', data: imageBytes.toString('base64'),
    });
    expect(JSON.stringify(body.result?.structuredContent)).not.toContain(imageBytes.toString('base64'));
    expect(await modelRequestAfterObservation(body.result)).toContain(`data:image/png;base64,${imageBytes.toString('base64')}`);
    if (shape === 'wrapped') {
      // A transport that delivers only links must never invent visible pixels.
      const linksOnly = { ...body.result, content: body.result.content.filter((item: { type: string }) => item.type !== 'image') };
      expect(await modelRequestAfterObservation(linksOnly)).not.toContain(imageBytes.toString('base64'));
    }

    const readResponse = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: 'read-operation-media',
        method: 'resources/read',
        params: { uri: resource.uri },
      },
      headers: { 'mcp-session-id': sessionId },
      token: shape === 'bare' ? bareToken : token,
    });
    expect(readResponse.status).toBe(200);
    const readBody = await readResponse.json();
    expect(readBody.result?.contents?.[0]).toEqual({
      uri: resource.uri,
      mimeType: 'image/png',
      blob: imageBytes.toString('base64'),
    });
  });
});
