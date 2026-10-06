import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { fileInputSchema, MAX_CONNECTOR_FILE_BYTES } from '@lobu/connector-sdk';
import GoogleDriveConnector from '@lobu/connectors/google_drive';
import { prepareOperationFiles, resolveOperationFiles } from '../../operations/file-inputs';
import { ArtifactStore } from '../files/artifact-store';
import { ingestInputFiles, inputArtifactId } from '../files/input-files';
import type { ToolContext } from '../../tools/registry';
import { createArtifactTestEnv, TEST_GATEWAY_URL, type ArtifactTestEnv } from './setup';

const owner = { isAuthenticated: true, organizationId: 'org-operation-file-test', userId: 'user-file-test', memberRole: 'owner' } as ToolContext;
const schema = { type: 'object', properties: { images: { type: 'array', items: fileInputSchema({ maxBytes: 20, contentTypes: ['image/png'] }) } } };

describe('connector file authorization and resolution', () => {
  let env: ArtifactTestEnv;
  beforeEach(() => { env = createArtifactTestEnv(); });
  afterEach(() => env.cleanup());
  const upload = (data = 'photo') => ingestInputFiles([{ name: 'photo.png', mimeType: 'image/png', data: Buffer.from(data) }], owner, env.artifactStore, TEST_GATEWAY_URL);

  test('stores references for approval, then resolves exact bytes on every execution attempt', async () => {
    const [file] = await upload();
    const prepared = await prepareOperationFiles({ images: [{ ...file, filename: 'invented.png' }] }, schema, owner, env.artifactStore);
    expect(prepared.input).toEqual({ images: [file] });
    expect(JSON.stringify(prepared)).not.toContain('base64');
    const metadata = JSON.parse(JSON.stringify({ input_files: prepared.claims }));
    const anotherReplica = new ArtifactStore(env.artifactsDir);
    // A later execution needs only durable metadata and the shared artifact directory.
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await resolveOperationFiles(prepared.input, metadata, anotherReplica)).toEqual({ images: [{ base64: Buffer.from('photo').toString('base64'), filename: 'photo.png', content_type: 'image/png' }] });
    }
  });

  test('denies other users, workspaces, and bound agents before queuing', async () => {
    const [file] = await upload();
    for (const other of [
      { ...owner, userId: 'other-user-test' },
      { ...owner, organizationId: 'other-org-test' },
      { ...owner, agentId: 'other-agent-test' },
      { ...owner, scopes: ['device_worker:run', 'mcp:write'] },
    ]) {
      await expect(prepareOperationFiles({ images: [file] }, schema, other, env.artifactStore)).rejects.toThrow('outside this caller');
    }
  });

  test('denies undeclared fields, missing authorization, and substitution after approval', async () => {
    const [file] = await upload();
    const [replacement] = await upload('replacement');
    const prepared = await prepareOperationFiles({ images: [file] }, schema, owner, env.artifactStore);
    await expect(prepareOperationFiles({ image: file }, {}, owner, env.artifactStore)).rejects.toThrow('must declare');
    await expect(resolveOperationFiles(prepared.input, {}, env.artifactStore)).rejects.toThrow('changed after authorization');
    await expect(resolveOperationFiles({ images: [] }, { input_files: prepared.claims }, env.artifactStore)).rejects.toThrow('changed after authorization');
    const pair = await prepareOperationFiles({ images: [file, replacement] }, schema, owner, env.artifactStore);
    await expect(resolveOperationFiles({ images: [file] }, { input_files: pair.claims }, env.artifactStore)).rejects.toThrow('changed after authorization');
    await expect(resolveOperationFiles({ images: [replacement] }, { input_files: prepared.claims }, env.artifactStore)).rejects.toThrow('changed after authorization');
    await expect(resolveOperationFiles(
      { images: [{
        base64: Buffer.from('replacement').toString('base64'),
        filename: 'replacement.png',
        content_type: 'image/png',
      }] },
      { input_files: prepared.claims },
      env.artifactStore,
    )).rejects.toThrow('changed after authorization');
    await env.artifactStore.delete(inputArtifactId(file)!);
    await expect(resolveOperationFiles(prepared.input, { input_files: prepared.claims }, env.artifactStore)).rejects.toThrow('missing or changed');
  });

  test('enforces connector byte/type limits for stored and inline files', async () => {
    const [large] = await upload('x'.repeat(21));
    await expect(prepareOperationFiles({ images: [large] }, schema, owner, env.artifactStore)).rejects.toThrow('exceeds the connector limit');
    for (const input of [
      { base64: Buffer.from('x'.repeat(21)).toString('base64'), filename: 'large.png', content_type: 'image/png' },
      { base64: Buffer.from('x').toString('base64'), filename: 'wrong.txt', content_type: 'text/plain' },
    ]) await expect(prepareOperationFiles({ images: [input] }, schema, owner, env.artifactStore)).rejects.toThrow();
  });

  test('rejects file inputs that cannot fit the execution bridge before queuing', async () => {
    expect(() => fileInputSchema({ maxBytes: MAX_CONNECTOR_FILE_BYTES + 1 })).toThrow('maxBytes must be between');
    const [file] = await upload('x'.repeat(MAX_CONNECTOR_FILE_BYTES));
    const [extra] = await upload('x');
    const largeSchema = { properties: { images: { type: 'array', items: fileInputSchema({ maxBytes: MAX_CONNECTOR_FILE_BYTES }) } } };
    await expect(prepareOperationFiles({ images: [file, extra] }, largeSchema, owner, env.artifactStore)).rejects.toThrow('12 MiB connector execution limit');
  });

  test('a Discovery-compiled Google upload sends the approved file byte for byte', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x2d, 0x2d, 0x89, 0x50, 0x4e, 0x47]);
    const [file] = await ingestInputFiles([{ name: 'pixel.png', mimeType: 'image/png', data: bytes }], owner, env.artifactStore, TEST_GATEWAY_URL);
    const drive = new GoogleDriveConnector();
    const schema = drive.definition.actions.files_create.inputSchema as Record<string, unknown>;
    const prepared = await prepareOperationFiles({ body: { name: 'pixel.png' }, media: file }, schema, owner, env.artifactStore);
    expect(prepared.claims.map((claim) => claim.path)).toEqual([['media']]);
    const input = await resolveOperationFiles(prepared.input, { input_files: prepared.claims }, env.artifactStore);

    const sent: Array<{ url: string; body: Uint8Array; contentType: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: init.body as Uint8Array, contentType: new Headers(init.headers).get('content-type') ?? '' });
      return new Response(JSON.stringify({ id: 'F1', name: 'pixel.png' }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const result = await drive.execute({ actionKey: 'files_create', input, credentials: { accessToken: 'token' }, config: {} } as never);
      expect(result).toEqual({ success: true, output: { id: 'F1', name: 'pixel.png' } });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(sent[0].url).toStartWith('https://www.googleapis.com/upload/drive/v3/files?');
    const boundary = sent[0].contentType.split('boundary=')[1];
    const media = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: image/png\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--`)]);
    expect(Buffer.from(sent[0].body).includes(media)).toBe(true);
  });
});
