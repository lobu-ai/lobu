import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fileInputSchema } from '@lobu/connector-sdk';
import { executeCompiledConnector } from '@lobu/connector-worker/executor/runtime';
import * as egress from '@lobu/connector-worker/egress';
import { app, type Env } from '../../index';
import * as gateway from '../../lobu/gateway';
import { ArtifactStore } from '../../gateway/files/artifact-store';
import { inputArtifactId } from '../../gateway/files/input-files';
import { ingestMcpFiles } from '../../mcp-file-inputs';
import { manageOperations } from '../../tools/admin/manage_operations';
import type { ToolContext } from '../../tools/registry';
import { initWorkspaceProvider } from '../../workspace';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestConnection, createTestConnectorDefinition, createTestSession, seedOwnerContext } from '../setup/test-fixtures';
import { post } from '../setup/test-helpers';

const CONNECTOR = 'demo.file.handoff';

describe('multipart file → operation approval → connector execution', () => {
  let ctx: ToolContext;
  let orgSlug: string;
  let connectionId: number;
  let cookie: string;
  let directory: string;
  let store: ArtifactStore;
  let receiver: Server;
  let uploadUrl: string;

  beforeAll(async () => {
    vi.stubEnv('LOBU_CLOUD_MODE', 'false');
    vi.stubEnv('WORKER_API_TOKEN', '');
    await cleanupTestDatabase();
    await initWorkspaceProvider();
    const seeded = await seedOwnerContext({ orgName: 'File handoff test' });
    ctx = seeded.ctx;
    orgSlug = seeded.org.slug;
    cookie = (await createTestSession(ctx.userId!)).cookieHeader;
    directory = await mkdtemp(join(tmpdir(), 'lobu-file-handoff-test-'));
    store = new ArtifactStore(directory);
    vi.spyOn(gateway, 'getLobuCoreServices').mockReturnValue({ getArtifactStore: () => store });
    await createTestConnectorDefinition({ key: CONNECTOR, name: 'File handoff test', organization_id: ctx.organizationId });
    const sql = getTestDb();
    await sql`UPDATE connector_definitions SET actions_schema = ${sql.json({ upload: {
      name: 'Upload test image', kind: 'write', requiresApproval: true,
      input_schema: { type: 'object', properties: {
        image: fileInputSchema({ maxBytes: 5 * 1024 * 1024, contentTypes: ['image/png'] }),
        alt_text: { type: 'string' }, rank: { type: 'integer' },
      }, required: ['image'] },
    } })} WHERE organization_id = ${ctx.organizationId} AND key = ${CONNECTOR}`;
    await sql`UPDATE connector_versions SET compiled_code = ${`
      class ConnectorRuntime {
        async sync() { return { items: [] }; }
        async execute(ctx) {
          if (!ctx.config.uploadUrl) return { success: true, output: ctx.input };
          const { image, alt_text, rank } = ctx.input;
          const form = new FormData();
          form.append('image', new Blob([Buffer.from(image.base64, 'base64')], { type: image.content_type }), image.filename);
          form.append('alt_text', alt_text);
          form.append('rank', String(rank));
          const response = await fetch(ctx.config.uploadUrl, { method: 'POST', body: form });
          return { success: response.ok, output: await response.json() };
        }
      }
      module.exports = { ConnectorRuntime };
    `} WHERE connector_key = ${CONNECTOR}`;
    connectionId = (await createTestConnection({ organization_id: ctx.organizationId, connector_key: CONNECTOR, created_by: ctx.userId!, visibility: 'private' })).id;
    receiver = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': request.headers['content-type']! } }).formData();
        const file = form.get('image') as File;
        const bytes = Buffer.from(await file.arrayBuffer());
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ filename: file.name, content_type: file.type, size_bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'), alt_text: form.get('alt_text'), rank: form.get('rank') }));
      } catch {
        response.writeHead(500).end('{}');
      }
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const address = receiver.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP test receiver');
    uploadUrl = `http://127.0.0.1:${address.port}/image`;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (receiver) await new Promise<void>((resolve, reject) => receiver.close((error) => error ? reject(error) : resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function upload(authCookie = cookie, bytes: Uint8Array = new TextEncoder().encode('photo-bytes')) {
    const form = new FormData();
    form.append('files', new File([new Uint8Array(bytes)], 'photo.png', { type: 'image/png' }));
    return app.fetch(new Request(`http://localhost/api/${orgSlug}/files`, {
      method: 'POST', headers: { Cookie: authCookie }, body: form,
    }), { ENVIRONMENT: 'test', BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only', RATE_LIMIT_ENABLED: 'false' } as Env);
  }

  it('uploads once, queues reusable metadata, and resolves bytes only when a human approves', async () => {
    const response = await upload();
    expect(response.status).toBe(201);
    const { files } = await response.json() as { files: Record<string, unknown>[] };
    const args = { action: 'execute' as const, connection_id: connectionId, operation_key: 'upload', input: { image: files[0], alt_text: 'A test photograph', rank: 1 }, idempotency_key: 'file-handoff-test-once' };
    const queued = await manageOperations(args, {} as Env, ctx) as { run_id: number; status: string };
    expect(queued.status).toBe('pending_approval');
    const [pending] = await getTestDb()`SELECT action_input, run_metadata, status FROM runs WHERE id = ${queued.run_id}`;
    expect(pending.action_input.image).toEqual(files[0]);
    expect(pending.run_metadata.input_files).toHaveLength(1);
    expect(JSON.stringify(pending)).not.toContain('base64');
    const approval = await post(`/api/${orgSlug}/manage_operations`, {
      cookie, body: { action: 'approve', run_id: queued.run_id },
    });
    expect(approval.status).toBe(200);
    expect(await approval.json()).toMatchObject({ approved: true });
    const workerId = 'file-handoff-test-worker';
    const claim = await post('/api/workers/poll', { body: { worker_id: workerId, capabilities: {} } });
    expect(claim.status).toBe(200);
    const job = await claim.json();
    expect(job.run_id).toBe(queued.run_id);
    expect(job.action_input.image.base64).toBe(Buffer.from('photo-bytes').toString('base64'));
    const executed = await executeCompiledConnector({
      compiledCode: job.compiled_code,
      job: { mode: 'action', actionKey: job.action_key, actionInput: job.action_input, config: job.config ?? {}, env: {}, credentials: {} },
      allowedDomains: [],
    });
    expect(executed.mode).toBe('action');
    if (executed.mode !== 'action') throw new Error('Expected connector action');
    const completion = await post('/api/workers/complete-action', { body: {
      run_id: queued.run_id, worker_id: workerId, status: 'success', action_output: executed.output,
    } });
    expect(await completion.json()).toMatchObject({ success: true });
    const [completed] = await getTestDb()`SELECT status, action_output FROM runs WHERE id = ${queued.run_id}`;
    expect(completed.status).toBe('completed');
    expect(completed.action_output).toMatchObject({
      image: { base64: Buffer.from('photo-bytes').toString('base64'), filename: 'photo.png', content_type: 'image/png' },
      alt_text: 'A test photograph', rank: 1,
    });
    const replay = await manageOperations(args, {} as Env, ctx);
    expect(replay).toMatchObject({ run_id: queued.run_id, status: 'completed', output: completed.action_output });
    const [{ count }] = await getTestDb()`SELECT COUNT(*)::integer AS count FROM runs WHERE organization_id = ${ctx.organizationId} AND action_key = 'upload'`;
    expect(count).toBe(1);
  });

  it('refuses anonymous multipart uploads', async () => {
    const response = await upload('');
    expect([401, 403]).toContain(response.status);
  });

  it('accepts the current workspace slug and granted account targets without widening scoped access', async () => {
    const download = vi.spyOn(egress, 'fetchPublicUrl').mockImplementation(async () => new Response('photo-bytes', { headers: { 'content-type': 'image/png' } }));
    const attachments = [{ download_url: 'https://files.example.test/photo.png', file_id: 'file-handoff-fixture' }];
    try {
      for (const target of [orgSlug, ctx.organizationId]) {
        expect(await ingestMcpFiles(attachments, target, { ...ctx, allowCrossOrg: false })).toHaveLength(1);
      }
      expect(await ingestMcpFiles(attachments, orgSlug, { ...ctx, organizationId: null, memberRole: undefined, allowCrossOrg: true, grantedOrganizationIds: [ctx.organizationId] })).toHaveLength(1);
      const downloads = download.mock.calls.length;
      await expect(ingestMcpFiles(attachments, 'other-workspace-test', { ...ctx, allowCrossOrg: false })).rejects.toThrow('unavailable');
      await expect(ingestMcpFiles(attachments, orgSlug, { ...ctx, organizationId: null, allowCrossOrg: true, grantedOrganizationIds: [] })).rejects.toThrow('not available');
      expect(download).toHaveBeenCalledTimes(downloads);
    } finally { download.mockRestore(); }
  });

  it('delivers a 5 MiB photo and its metadata through the real isolate multipart transport', async () => {
    const bytes = randomBytes(5 * 1024 * 1024);
    const response = await upload(cookie, bytes);
    expect(response.status).toBe(201);
    const { files } = await response.json() as { files: Record<string, unknown>[] };
    const queued = await manageOperations({ action: 'execute', connection_id: connectionId, operation_key: 'upload',
      input: { image: files[0], alt_text: 'Full size test photograph', rank: 2 } }, {} as Env, ctx) as { run_id: number };
    const approval = await post(`/api/${orgSlug}/manage_operations`, { cookie, body: { action: 'approve', run_id: queued.run_id } });
    expect(await approval.json()).toMatchObject({ approved: true });
    const workerId = 'file-handoff-test-worker';
    const job = await (await post('/api/workers/poll', { body: { worker_id: workerId, capabilities: {} } })).json();
    expect(job.run_id).toBe(queued.run_id);
    const executed = await executeCompiledConnector({
      compiledCode: job.compiled_code,
      job: { mode: 'action', actionKey: job.action_key, actionInput: job.action_input, config: { uploadUrl }, env: {}, credentials: {} },
      allowedDomains: ['127.0.0.1'],
    });
    expect(executed).toMatchObject({ mode: 'action', output: {
      filename: 'photo.png', content_type: 'image/png', size_bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), alt_text: 'Full size test photograph', rank: '2',
    } });
    const completed = await post('/api/workers/complete-action', { body: {
      run_id: queued.run_id, worker_id: workerId, status: 'success', action_output: executed.mode === 'action' ? executed.output : {},
    } });
    expect(await completed.json()).toMatchObject({ success: true });
  });

  it.each(['missing', 'substituted', 'inline-replaced'])('fails a %s file before handing the approved run to a worker', async (condition) => {
    const { files } = await (await upload()).json() as { files: Record<string, unknown>[] };
    const queued = await manageOperations({ action: 'execute', connection_id: connectionId, operation_key: 'upload', input: { image: files[0] } }, {} as Env, ctx) as { run_id: number };
    let replacement: Record<string, unknown> | undefined;
    if (condition === 'missing') await store.delete(inputArtifactId(files[0])!);
    else if (condition === 'inline-replaced') replacement = {
      base64: Buffer.from('replacement').toString('base64'), filename: 'replacement.png', content_type: 'image/png',
    };
    else replacement = ((await (await upload()).json()) as { files: Record<string, unknown>[] }).files[0];
    const approval = await post(`/api/${orgSlug}/manage_operations`, {
      cookie, body: { action: 'approve', run_id: queued.run_id, ...(replacement ? { input: { image: replacement } } : {}) },
    });
    expect(await approval.json()).toMatchObject({ approved: true });
    const dispatch = await post('/api/workers/poll', { body: { worker_id: 'file-handoff-test-worker', capabilities: {} } });
    expect(await dispatch.json()).toMatchObject({ skipped_run_id: queued.run_id });
    const [run] = await getTestDb()`SELECT status, error_message FROM runs WHERE id = ${queued.run_id}`;
    expect(run.status).toBe('failed');
    expect(run.error_message).toContain(condition === 'missing' ? 'missing or changed' : 'changed after authorization');
  });
});
