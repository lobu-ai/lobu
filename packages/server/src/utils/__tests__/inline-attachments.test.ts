import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ArtifactStore,
  runArtifactBinding,
} from '../../gateway/files/artifact-store';
import * as dbClient from '../../db/client';
import * as lobuGateway from '../../lobu/gateway';
import * as providerSecrets from '../../lobu/stores/provider-secrets';
import {
  deleteMaterializedArtifacts,
  materializeActionOutputAttachments,
  materializeInlineAttachments,
  transcribeOne,
  triggerAudioTranscriptions,
} from '../inline-attachments';

describe('materializeActionOutputAttachments', () => {
  let artifactsDir: string;
  let artifactStore: ArtifactStore;
  const previousEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'lobu-action-attachments-'));
    process.env.ENCRYPTION_KEY = Buffer.from(
      '12345678901234567890123456789012'
    ).toString('base64');
    artifactStore = new ArtifactStore(artifactsDir);
    vi.spyOn(lobuGateway, 'getLobuCoreServices').mockReturnValue({
      getArtifactStore: () => artifactStore,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('reuses connector attachment materialization for device action media', async () => {
    const bytes = Buffer.from('device-photo-bytes');
    const { output, publishedArtifactIds } = await materializeActionOutputAttachments(
      42,
      {
        asset_local_id: 'photo-123',
        attachments: [
          {
            kind: 'image',
            filename: 'photo.jpg',
            mime_type: 'image/jpeg',
            data: bytes.toString('base64'),
            size_bytes: bytes.length,
          },
        ],
      }
    );

    expect(output.asset_local_id).toBe('photo-123');
    expect(publishedArtifactIds).toHaveLength(1);
    const attachment = (output.attachments as Array<Record<string, unknown>>)[0];
    expect(attachment).toEqual(
      expect.objectContaining({
        kind: 'image',
        filename: 'photo.jpg',
        mime_type: 'image/jpeg',
        artifact_id: expect.any(String),
        download_url: expect.any(String),
        size_bytes: bytes.length,
      })
    );
    expect(attachment).not.toHaveProperty('data');

    const stored = await artifactStore.read(String(attachment.artifact_id), {
      binding: runArtifactBinding(42),
    });
    expect(stored).toBeTruthy();
    expect(stored!.bytes).toEqual(bytes);
  });

  it('deletes partial publishes when a later attachment publish fails', async () => {
    let publishCalls = 0;
    let firstArtifactId: string | undefined;
    const flakyStore = {
      publish: async (params: Parameters<ArtifactStore['publish']>[0]) => {
        publishCalls += 1;
        if (publishCalls === 2) throw new Error('second publish failed');
        const published = await artifactStore.publish(params);
        firstArtifactId = published.artifactId;
        return published;
      },
      delete: (artifactId: string) => artifactStore.delete(artifactId),
    };
    vi.mocked(lobuGateway.getLobuCoreServices).mockReturnValue({
      getArtifactStore: () => flakyStore,
    });

    await expect(
      materializeActionOutputAttachments(
        77,
        {
          attachments: [
            {
              kind: 'image',
              filename: 'first.jpg',
              mime_type: 'image/jpeg',
              data: Buffer.from('first').toString('base64'),
            },
            {
              kind: 'image',
              filename: 'second.jpg',
              mime_type: 'image/jpeg',
              data: Buffer.from('second').toString('base64'),
            },
          ],
        }
      )
    ).rejects.toThrow('second publish failed');

    expect(firstArtifactId).toBeTruthy();
    expect(await artifactStore.read(firstArtifactId!)).toBeNull();
  });

  it('materializes a screenshot-sized payload the old 2MB cap would have dropped', async () => {
    // Prod's largest Chrome screenshot decodes to ~3.1MB. Over the cap,
    // materializeInlineAttachments warns and CONTINUES — the attachment is
    // dropped, not rejected — so a too-low cap loses screenshots silently.
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 1024, 0x41);
    const { output, publishedArtifactIds } = await materializeActionOutputAttachments(99, {
      tab_id: 7,
      attachments: [
        {
          kind: 'image',
          filename: 'screenshot.png',
          mime_type: 'image/png',
          size_bytes: bytes.length,
          data: bytes.toString('base64'),
        },
      ],
    });

    expect(publishedArtifactIds).toHaveLength(1);
    const attachment = (output.attachments as Array<Record<string, unknown>>)[0];
    expect(attachment).not.toHaveProperty('data');
    expect(attachment.artifact_id).toEqual(expect.any(String));
    const stored = await artifactStore.read(String(attachment.artifact_id));
    expect(stored?.bytes.length).toBe(bytes.length);
  });

  it('reports an over-cap action attachment instead of dropping it silently', async () => {
    // The regression this guards: the drop was a logger.warn and nothing else,
    // so an action that asked for a file returned success with an empty
    // `attachments` array — indistinguishable from a source that had no file.
    // A caller must be able to tell "too big" from "there was nothing".
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 0x41);
    const { output, publishedArtifactIds } = await materializeActionOutputAttachments(
      101,
      {
        attachments: [
          {
            kind: 'file',
            filename: 'huge.pdf',
            mime_type: 'application/pdf',
            data: bytes.toString('base64'),
          },
        ],
      }
    );

    expect(publishedArtifactIds).toHaveLength(0);
    expect(output.attachments).toEqual([]);
    expect(output.attachments_rejected).toEqual([
      {
        item_id: 'action:101',
        filename: 'huge.pdf',
        reason: 'oversize',
        size_bytes: bytes.length,
        cap: 8 * 1024 * 1024,
      },
    ]);
  });

  it('reports an empty-decoding action attachment', async () => {
    const { output, publishedArtifactIds } = await materializeActionOutputAttachments(
      102,
      {
        attachments: [
          { kind: 'file', filename: 'junk.bin', mime_type: 'application/pdf', data: '!!!!' },
        ],
      }
    );

    expect(publishedArtifactIds).toHaveLength(0);
    expect(output.attachments_rejected).toEqual([
      { item_id: 'action:102', filename: 'junk.bin', reason: 'empty' },
    ]);
  });

  it('leaves a clean action output free of the rejected key', async () => {
    // The key must be ABSENT, not an empty array: every action output carries
    // attachments through this path, and a noise field on all of them would
    // reach the model verbatim.
    const { output } = await materializeActionOutputAttachments(103, {
      attachments: [
        {
          kind: 'image',
          filename: 'ok.jpg',
          mime_type: 'image/jpeg',
          data: Buffer.from('fine').toString('base64'),
        },
      ],
    });

    expect(output).not.toHaveProperty('attachments_rejected');
  });

  it('still publishes an oversize attachment’s siblings on the stream path', async () => {
    // Stream semantics are deliberately unchanged: one oversized image must not
    // fail the message carrying it, nor the good attachment beside it. The only
    // change is that the drop is now reported rather than swallowed.
    const huge = Buffer.alloc(8 * 1024 * 1024 + 1, 0x42);
    const { items, rejected, publishedArtifactIds } = await materializeInlineAttachments([
      {
        id: 'WA-9',
        attachments: [
          { kind: 'image', filename: 'big.jpg', mime_type: 'image/jpeg', data: huge.toString('base64') },
          {
            kind: 'image',
            filename: 'small.jpg',
            mime_type: 'image/jpeg',
            data: Buffer.from('ok').toString('base64'),
          },
        ],
      },
    ]);

    expect(publishedArtifactIds).toHaveLength(1);
    const attachments = items[0]?.attachments as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.filename).toBe('small.jpg');
    expect(rejected).toEqual([
      {
        item_id: 'WA-9',
        filename: 'big.jpg',
        reason: 'oversize',
        size_bytes: huge.length,
        cap: 8 * 1024 * 1024,
      },
    ]);
  });

  it('deletes materialized action artifacts when finalization is abandoned', async () => {
    const { publishedArtifactIds } = await materializeActionOutputAttachments(
      88,
      {
        attachments: [
          {
            kind: 'image',
            filename: 'abandoned.jpg',
            mime_type: 'image/jpeg',
            data: Buffer.from('abandoned').toString('base64'),
          },
        ],
      }
    );
    expect(publishedArtifactIds).toHaveLength(1);
    expect(await artifactStore.read(publishedArtifactIds[0])).toBeTruthy();

    await deleteMaterializedArtifacts(publishedArtifactIds);
    expect(await artifactStore.read(publishedArtifactIds[0])).toBeNull();
  });
});

describe('transcribeOne provider health', () => {
  let artifactsDir: string;
  let artifactStore: ArtifactStore;
  const previousEncryptionKey = process.env.ENCRYPTION_KEY;

  const publishAudio = async () => {
    const published = await artifactStore.publish({
      buffer: Buffer.from('ogg-bytes'),
      filename: 'voice.ogg',
      contentType: 'audio/ogg',
      publicGatewayUrl: 'https://gw.example',
    });
    return published.artifactId;
  };

  const job = (artifactId: string) => ({
    artifactId,
    originId: 'WA-ORIGIN-1',
    mimeType: 'audio/ogg',
    baseEventId: 1,
    connectionId: 361,
    title: null,
  });

  const withTranscribeResult = (result: unknown) => {
    vi.spyOn(lobuGateway, 'getLobuCoreServices').mockReturnValue({
      getArtifactStore: () => artifactStore,
      getTranscriptionService: () => ({ transcribe: async () => result }),
    });
  };

  beforeEach(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'lobu-stt-health-'));
    process.env.ENCRYPTION_KEY = Buffer.from(
      '12345678901234567890123456789012'
    ).toString('base64');
    artifactStore = new ArtifactStore(artifactsDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('marks the provider unhealthy and reports the account walled on a 429', async () => {
    // The prod outage this fixes: OpenAI returned 429
    // credit_balance_exhausted for weeks while the settings row still read
    // `active`, because this path reaches the provider directly instead of
    // through the LLM proxy that records health.
    const mark = vi
      .spyOn(providerSecrets, 'markInferenceProviderUnhealthy')
      .mockResolvedValue(undefined);
    withTranscribeResult({
      error: 'Transcription failed with all configured providers: OpenAI: 429',
      availableProviders: ['openai'],
      attempts: [{ providerSlug: 'openai', status: 429, message: 'no credits' }],
    });

    const outcome = await transcribeOne(
      job(await publishAudio()),
      'org-1',
      'agent-1'
    );

    expect(outcome).toBe('provider-unavailable');
    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark.mock.calls[0]?.[0]).toBe('org-1');
    expect(mark.mock.calls[0]?.[1]).toBe('openai');
    expect(String(mark.mock.calls[0]?.[2])).toContain('429');
  });

  it('leaves the provider healthy when the file itself is the problem', async () => {
    // A 400 is the caller's fault — an unsupported codec, say. Marking the
    // provider unhealthy here would label a working key broken in the UI,
    // which is why `classifyProviderHealthStatus` is deliberately narrow.
    const mark = vi
      .spyOn(providerSecrets, 'markInferenceProviderUnhealthy')
      .mockResolvedValue(undefined);
    withTranscribeResult({
      error: 'Transcription failed with all configured providers: OpenAI: 400',
      availableProviders: ['openai'],
      attempts: [
        { providerSlug: 'openai', status: 400, message: 'unsupported format' },
      ],
    });

    const outcome = await transcribeOne(
      job(await publishAudio()),
      'org-1',
      'agent-1'
    );

    expect(outcome).toBe('failed');
    expect(mark).not.toHaveBeenCalled();
  });

  it('does not mark a provider unhealthy when the call never reached it', async () => {
    // A timeout carries no verdict about the account.
    const mark = vi
      .spyOn(providerSecrets, 'markInferenceProviderUnhealthy')
      .mockResolvedValue(undefined);
    withTranscribeResult({
      error: 'Transcription failed with all configured providers: OpenAI: net',
      availableProviders: ['openai'],
      attempts: [{ providerSlug: 'openai', message: 'fetch failed' }],
    });

    const outcome = await transcribeOne(
      job(await publishAudio()),
      'org-1',
      'agent-1'
    );

    expect(outcome).toBe('failed');
    expect(mark).not.toHaveBeenCalled();
  });
});

describe('triggerAudioTranscriptions batch abandon', () => {
  let artifactsDir: string;
  let artifactStore: ArtifactStore;
  const previousEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'lobu-stt-batch-'));
    process.env.ENCRYPTION_KEY = Buffer.from(
      '12345678901234567890123456789012'
    ).toString('base64');
    artifactStore = new ArtifactStore(artifactsDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('stops after a walled provider instead of burning a call per remaining job', async () => {
    // The whole point of the outcome: 20 queued voice notes against an
    // out-of-credit account made 20 doomed upstream calls. One is enough.
    vi.spyOn(providerSecrets, 'markInferenceProviderUnhealthy').mockResolvedValue(
      undefined
    );
    // `pickTranscriptionAgent` reads the org's agents; this suite has no DB.
    const sql = (async () => [{ id: 'agent-1' }]) as unknown as ReturnType<
      typeof dbClient.getDb
    >;
    vi.spyOn(dbClient, 'getDb').mockReturnValue(sql);
    const transcribe = vi.fn(async () => ({
      error: 'Transcription failed with all configured providers: OpenAI: 429',
      availableProviders: ['openai'],
      attempts: [{ providerSlug: 'openai', status: 429, message: 'no credits' }],
    }));
    vi.spyOn(lobuGateway, 'getLobuCoreServices').mockReturnValue({
      getArtifactStore: () => artifactStore,
      getTranscriptionService: () => ({
        transcribe,
        getConfig: async () => ({ profileProviderId: 'openai' }),
      }),
    });

    const jobs = [];
    for (const originId of ['WA-1', 'WA-2', 'WA-3']) {
      const published = await artifactStore.publish({
        buffer: Buffer.from('ogg'),
        filename: 'v.ogg',
        contentType: 'audio/ogg',
        publicGatewayUrl: 'https://gw.example',
      });
      jobs.push({
        artifactId: published.artifactId,
        originId,
        mimeType: 'audio/ogg',
        baseEventId: 1,
        connectionId: 361,
        title: null,
      });
    }

    triggerAudioTranscriptions('org-1', jobs);
    // Fire-and-forget: let the detached orchestrator settle.
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));

    expect(transcribe).toHaveBeenCalledTimes(1);
  });
});
