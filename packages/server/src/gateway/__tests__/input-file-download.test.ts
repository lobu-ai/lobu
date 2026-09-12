import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as egress from '@lobu/connector-worker/egress';
import { attachmentFromUrl, fetchInputFile, ingestInputFiles } from '../files/input-files';
import { createArtifactTestEnv, TEST_GATEWAY_URL, type ArtifactTestEnv } from './setup';

describe('host download adapter', () => {
  let env: ArtifactTestEnv;
  const fetch = spyOn(egress, 'fetchPublicUrl');
  afterAll(() => fetch.mockRestore());
  beforeEach(() => { env = createArtifactTestEnv(); });
  afterEach(async () => { fetch.mockReset(); await env.cleanup(); });

  test('imports an attachment when the host omits optional filename and MIME metadata', async () => {
    fetch.mockResolvedValueOnce(new Response('png', { headers: { 'content-type': 'image/png' } }));
    const files = await ingestInputFiles([
      attachmentFromUrl('https://files.example.test/photo?token=secret-test', {}),
    ], { isAuthenticated: true, organizationId: 'org-download-test', userId: 'user-download-test' }, env.artifactStore, TEST_GATEWAY_URL);
    expect(files[0]).toMatchObject({ filename: 'attachment-1.png', content_type: 'image/png', size_bytes: 3 });
    expect(JSON.stringify(files)).not.toContain('secret-test');
  });

  test('hides signed URLs on fetch and parsing errors', async () => {
    fetch.mockRejectedValueOnce(new Error('Failed https://files.example.test/?token=secret-test'));
    for (const url of ['https://files.example.test/?token=secret-test', 'invalid-secret-test']) {
      try { await fetchInputFile(url); throw new Error('expected failure'); }
      catch (error) { expect(String(error)).toContain('File download failed'); expect(String(error)).not.toContain('secret-test'); }
    }
  });

  test('rejects local and insecure URLs before attempting network access', async () => {
    for (const url of ['file:///tmp/photo.png', 'http://files.example.test/photo', 'https://user:password@files.example.test/photo']) {
      await expect(fetchInputFile(url)).rejects.toThrow('HTTPS URL without embedded credentials');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
