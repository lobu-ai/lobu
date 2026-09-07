/**
 * The isolate lane's attachment resolver.
 *
 * The property under test throughout: an attachment's BYTES only ever come out
 * of the gateway's own artifact store, keyed by the id the gateway minted for
 * the message. `downloadUrl` is inert — the resolver must never read it, and a
 * refused attachment must degrade the turn (its name still travels) rather
 * than fail it, which is what the subprocess lane does when an image is
 * oversized or unreadable.
 */
import { describe, expect, it } from 'bun:test';
import { AgentTurnPollPayloadSchema } from '@lobu/core/contracts/worker/protocol';
import { Value } from '@sinclair/typebox/value';
import {
  type AgentTurnArtifactReader,
  MAX_TURN_IMAGE_BYTES,
  MAX_TURN_IMAGE_BYTES_TOTAL,
  MAX_TURN_IMAGES,
  resolveTurnAttachments,
} from '../../gateway/orchestration/agent-turn-attachments';

const CONTEXT = { agentId: 'agent-under-test', messageId: 'msg-1' };

interface StoredFixture {
  contentType: string;
  bytes: Buffer;
  /** Reported instead of the real length, to fake an oversized artifact cheaply. */
  size?: number;
}

/**
 * An artifact store holding exactly the fixtures given, and recording every id
 * it was asked for — so a test can prove the resolver asked for the artifact id
 * and nothing else.
 */
function fakeArtifacts(fixtures: Record<string, StoredFixture>): AgentTurnArtifactReader & {
  asked: string[];
} {
  const asked: string[] = [];
  const metadataFor = (artifactId: string) => {
    const fixture = fixtures[artifactId];
    if (!fixture) return null;
    return {
      artifactId,
      filename: 'stored',
      contentType: fixture.contentType,
      size: fixture.size ?? fixture.bytes.length,
      createdAt: 0,
      sha256: '0'.repeat(64),
    };
  };
  return {
    asked,
    inspect: async (artifactId: string) => {
      asked.push(artifactId);
      return metadataFor(artifactId) as never;
    },
    read: async (artifactId: string, options?: { maxBytes?: number }) => {
      const fixture = fixtures[artifactId];
      const metadata = metadataFor(artifactId);
      if (!fixture || !metadata) return null;
      // The real store reports an over-cap artifact as simply absent.
      if (options?.maxBytes !== undefined && metadata.size > options.maxBytes) return null;
      return { metadata, bytes: fixture.bytes } as never;
    },
  };
}

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

describe('resolveTurnAttachments', () => {
  it('resolves an image out of the artifact store and never touches its download URL', async () => {
    const artifacts = fakeArtifacts({ 'art-1': { contentType: 'image/png', bytes: PNG } });
    const result = await resolveTurnAttachments(
      {
        files: [
          {
            id: 'art-1',
            name: 'shot.png',
            mimetype: 'image/png',
            size: PNG.length,
            downloadUrl: 'https://attacker.invalid/pwn.png',
          },
        ],
      },
      artifacts,
      CONTEXT
    );

    expect(result.images).toEqual([{ mime_type: 'image/png', data: PNG.toString('base64') }]);
    expect(result.files).toEqual([]);
    // Keyed by the artifact id the gateway minted; the URL is never a lookup key.
    expect(artifacts.asked).toEqual(['art-1']);
  });

  it('trusts the STORED content type, not the one the message claimed', async () => {
    const artifacts = fakeArtifacts({ 'art-1': { contentType: 'application/pdf', bytes: PNG } });
    const result = await resolveTurnAttachments(
      { files: [{ id: 'art-1', name: 'not-really.png', mimetype: 'image/png', size: PNG.length }] },
      artifacts,
      CONTEXT
    );

    expect(result.images).toEqual([]);
    expect(result.files).toEqual([{ name: 'not-really.png', mime_type: 'image/png', size: PNG.length }]);
  });

  it('carries a non-image attachment as its name and type only — no bytes, ever', async () => {
    const artifacts = fakeArtifacts({ 'art-1': { contentType: 'application/pdf', bytes: PNG } });
    const result = await resolveTurnAttachments(
      { files: [{ id: 'art-1', name: 'report.pdf', mimetype: 'application/pdf', size: 2048 }] },
      artifacts,
      CONTEXT
    );

    expect(result.images).toEqual([]);
    expect(result.files).toEqual([{ name: 'report.pdf', mime_type: 'application/pdf', size: 2048 }]);
    // Not even inspected: a non-image never needs its bytes on this lane.
    expect(artifacts.asked).toEqual([]);
  });

  it('skips an image this gateway does not hold, and keeps its name', async () => {
    const artifacts = fakeArtifacts({});
    const result = await resolveTurnAttachments(
      { files: [{ id: 'art-missing', name: 'gone.png', mimetype: 'image/png' }] },
      artifacts,
      CONTEXT
    );

    expect(result.images).toEqual([]);
    expect(result.files).toEqual([{ name: 'gone.png', mime_type: 'image/png' }]);
  });

  it('skips an image with no artifact id: a URL alone resolves to nothing', async () => {
    const artifacts = fakeArtifacts({ 'art-1': { contentType: 'image/png', bytes: PNG } });
    const result = await resolveTurnAttachments(
      { files: [{ name: 'remote.png', mimetype: 'image/png', downloadUrl: 'https://attacker.invalid/a.png' }] },
      artifacts,
      CONTEXT
    );

    expect(result.images).toEqual([]);
    expect(result.files).toEqual([{ name: 'remote.png', mime_type: 'image/png' }]);
    expect(artifacts.asked).toEqual([]);
  });

  it('skips an oversized image rather than truncating it', async () => {
    const artifacts = fakeArtifacts({
      'art-big': { contentType: 'image/png', bytes: PNG, size: MAX_TURN_IMAGE_BYTES + 1 },
    });
    const result = await resolveTurnAttachments(
      { files: [{ id: 'art-big', name: 'huge.png', mimetype: 'image/png' }] },
      artifacts,
      CONTEXT
    );

    expect(result.images).toEqual([]);
    expect(result.files).toEqual([{ name: 'huge.png', mime_type: 'image/png' }]);
  });

  it('stops at the turn total once the budget is spent, keeping the ones that fit', async () => {
    const half = Math.floor(MAX_TURN_IMAGE_BYTES_TOTAL / 2);
    const artifacts = fakeArtifacts({
      a: { contentType: 'image/png', bytes: PNG, size: half },
      b: { contentType: 'image/png', bytes: PNG, size: half },
      c: { contentType: 'image/png', bytes: PNG, size: half },
    });
    const result = await resolveTurnAttachments(
      {
        files: [
          { id: 'a', name: 'a.png', mimetype: 'image/png' },
          { id: 'b', name: 'b.png', mimetype: 'image/png' },
          { id: 'c', name: 'c.png', mimetype: 'image/png' },
        ],
      },
      artifacts,
      CONTEXT
    );

    // The budget counts the bytes actually read, so two half-budget artifacts
    // fit and the third is refused on the reported size of the pair before it.
    expect(result.images.length).toBe(2);
    expect(result.files).toEqual([{ name: 'c.png', mime_type: 'image/png' }]);
  });

  it('stops at the image count even when every image is tiny', async () => {
    const fixtures: Record<string, StoredFixture> = {};
    const files: unknown[] = [];
    for (let i = 0; i < MAX_TURN_IMAGES + 2; i += 1) {
      fixtures[`art-${i}`] = { contentType: 'image/png', bytes: PNG };
      files.push({ id: `art-${i}`, name: `s${i}.png`, mimetype: 'image/png' });
    }
    const result = await resolveTurnAttachments({ files }, fakeArtifacts(fixtures), CONTEXT);

    expect(result.images.length).toBe(MAX_TURN_IMAGES);
    expect(result.files.length).toBe(2);
  });

  it('degrades to names when the artifact store is not wired, instead of throwing', async () => {
    const result = await resolveTurnAttachments(
      { files: [{ id: 'art-1', name: 'shot.png', mimetype: 'image/png' }] },
      undefined,
      CONTEXT
    );

    expect(result.images).toEqual([]);
    expect(result.files).toEqual([{ name: 'shot.png', mime_type: 'image/png' }]);
  });

  it('keeps the turn alive when a read throws', async () => {
    const artifacts: AgentTurnArtifactReader = {
      inspect: async () => {
        throw new Error('storage unavailable');
      },
      read: async () => null,
    };
    const result = await resolveTurnAttachments(
      { files: [{ id: 'art-1', name: 'shot.png', mimetype: 'image/png' }] },
      artifacts,
      CONTEXT
    );

    expect(result.images).toEqual([]);
    expect(result.files).toEqual([{ name: 'shot.png', mime_type: 'image/png' }]);
  });

  /**
   * The wire contract must state the same limit the producer enforces.
   * Without this the schema would accept an envelope the producer would never
   * write, and a future change to one cap could silently outgrow the other —
   * the caps live in two packages precisely because the contract must not
   * import the server.
   */
  it("bounds the envelope by the same caps the producer enforces", () => {
    const imageField = AgentTurnPollPayloadSchema.properties.turn.properties.message_images;
    expect(imageField.maxItems).toBe(MAX_TURN_IMAGES);
    // The schema's base64 length is the byte cap in base64 units: 4 chars per
    // 3 bytes, padded. Derived here rather than copied, so a change to
    // MAX_TURN_IMAGE_BYTES that misses the schema fails this test.
    expect(imageField.items.properties.data.maxLength).toBe(
      Math.ceil(MAX_TURN_IMAGE_BYTES / 3) * 4
    );
    // The total budget cannot be exceeded by the per-image cap times the count
    // without the producer's own running total refusing first, which is the
    // invariant that makes the two caps coherent rather than contradictory.
    expect(MAX_TURN_IMAGE_BYTES).toBeLessThanOrEqual(MAX_TURN_IMAGE_BYTES_TOTAL);
  });

  /**
   * An envelope the producer actually built must satisfy the schema — the
   * bounds above are only meaningful if a real resolution passes them.
   */
  it('produces images that satisfy the wire schema', async () => {
    const artifacts = fakeArtifacts({
      'art-1': { contentType: 'image/png', bytes: Buffer.from('PNG!') },
    });
    const result = await resolveTurnAttachments(
      { files: [{ id: 'art-1', name: 'shot.png', mimetype: 'image/png' }] },
      artifacts,
      CONTEXT
    );

    const turn = {
      agent_id: 'a',
      conversation_id: 'c',
      message_id: 'm',
      message_text: '',
      message_images: result.images,
      system_prompt: '',
      messages: [],
      provider: { api: 'anthropic-messages', provider: 'anthropic', model_id: 'm', base_url: 'http://x' },
      allowed_hosts: [],
      reply: { channel_id: 'ch', message_id: 'm' },
      shadow: true,
    };
    expect(Value.Check(AgentTurnPollPayloadSchema, { turn })).toBe(true);
  });

  it('answers empty for a message with no attachments, and for a malformed list', async () => {
    const artifacts = fakeArtifacts({});
    expect(await resolveTurnAttachments(undefined, artifacts, CONTEXT)).toEqual({ images: [], files: [] });
    expect(await resolveTurnAttachments({}, artifacts, CONTEXT)).toEqual({ images: [], files: [] });
    expect(await resolveTurnAttachments({ files: 'nope' }, artifacts, CONTEXT)).toEqual({
      images: [],
      files: [],
    });
  });
});
