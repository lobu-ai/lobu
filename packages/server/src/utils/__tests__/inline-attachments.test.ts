import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../gateway/files/artifact-store';
import * as lobuGateway from '../../lobu/gateway';
import {
  deleteMaterializedArtifacts,
  materializeActionOutputAttachments,
  materializeInlineAttachments,
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
