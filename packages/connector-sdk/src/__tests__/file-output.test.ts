import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_INLINE_CONTENT_BYTES,
  downloadSizeError,
  fileDownloadOutput,
  inlineContentBudget,
  inlineMaxBytesSchema,
  inlineText,
  isTextualMimeType,
  MAX_CONNECTOR_DOWNLOAD_BYTES,
  MAX_INLINE_CONTENT_BYTES,
} from '../file-output.js';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('isTextualMimeType', () => {
  test('accepts text/* regardless of parameters or case', () => {
    expect(isTextualMimeType('text/csv')).toBe(true);
    expect(isTextualMimeType('TEXT/Plain; charset=UTF-8')).toBe(true);
  });

  test('accepts the non-text/* media types that are still text', () => {
    for (const mime of ['application/json', 'application/xml', 'image/svg+xml']) {
      expect(isTextualMimeType(mime)).toBe(true);
    }
  });

  test('rejects binary and unknown', () => {
    expect(isTextualMimeType('image/png')).toBe(false);
    expect(isTextualMimeType(undefined)).toBe(false);
    expect(isTextualMimeType('')).toBe(false);
  });
});

describe('inlineContentBudget', () => {
  test('falls back to the default for a missing or invalid request', () => {
    expect(inlineContentBudget(undefined)).toBe(DEFAULT_INLINE_CONTENT_BYTES);
    expect(inlineContentBudget('1000')).toBe(DEFAULT_INLINE_CONTENT_BYTES);
    expect(inlineContentBudget(Number.NaN)).toBe(DEFAULT_INLINE_CONTENT_BYTES);
    expect(inlineContentBudget(-1)).toBe(DEFAULT_INLINE_CONTENT_BYTES);
  });

  // 0 is a real instruction ("do not inline"), not an absent value — a `??`
  // would silently turn it into the default and inline anyway.
  test('honours 0 as "do not inline"', () => {
    expect(inlineContentBudget(0)).toBe(0);
  });

  test('clamps to the ceiling', () => {
    expect(inlineContentBudget(MAX_INLINE_CONTENT_BYTES * 4)).toBe(MAX_INLINE_CONTENT_BYTES);
  });
});

describe('downloadSizeError', () => {
  test('passes an unknown or in-budget size', () => {
    expect(downloadSizeError(undefined, 'f')).toBeNull();
    expect(downloadSizeError(MAX_CONNECTOR_DOWNLOAD_BYTES, 'f')).toBeNull();
  });

  test('refuses above the ceiling and names the file and both numbers', () => {
    const error = downloadSizeError(MAX_CONNECTOR_DOWNLOAD_BYTES + 1, 'huge.zip');
    expect(error).toContain('huge.zip');
    expect(error).toContain(String(MAX_CONNECTOR_DOWNLOAD_BYTES + 1));
    expect(error).toContain(String(MAX_CONNECTOR_DOWNLOAD_BYTES));
  });
});

describe('inlineText', () => {
  test('returns the whole text untouched when it fits', () => {
    expect(inlineText(utf8('hello'), 100)).toEqual({ content: 'hello', truncated: false });
  });

  // A naive slice(0, 4) here would cut the 3-byte '€' in half and the decoder
  // would hand back 'a' + U+FFFD — a character that was never in the file.
  test('never manufactures a U+FFFD when the cut lands mid-character', () => {
    const { content, truncated } = inlineText(utf8('a€b'), 3);
    expect(truncated).toBe(true);
    expect(content).toBe('a');
    expect(content).not.toContain('�');
  });

  test('preserves a U+FFFD that is genuinely in the source', () => {
    expect(inlineText(utf8('a�b'), 100).content).toBe('a�b');
  });

  // Bytes that are not valid UTF-8 must still inline as their lossy decoding,
  // not as an empty string — an empty string reads as "the file was empty".
  test('inlines non-UTF-8 bytes lossily rather than dropping them', () => {
    const { content } = inlineText(new Uint8Array([0x68, 0x69, 0xff]), 100);
    expect(content.startsWith('hi')).toBe(true);
    expect(content.length).toBeGreaterThan(2);
  });
});

describe('fileDownloadOutput', () => {
  test('always publishes the WHOLE file as one attachment', () => {
    const bytes = utf8('id,name\n1,a\n');
    const out = fileDownloadOutput({ bytes, filename: 'r.csv', mimeType: 'text/csv' });

    expect(out.size_bytes).toBe(bytes.length);
    const attachments = out.attachments as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toEqual({
      filename: 'r.csv',
      mime_type: 'text/csv',
      data: Buffer.from(bytes).toString('base64'),
      size_bytes: bytes.length,
    });
    // `kind` is the gateway's call (inferKindFromMime); two rules could disagree.
    expect(attachments[0]).not.toHaveProperty('kind');
  });

  test('inlines text with a line count', () => {
    const out = fileDownloadOutput({
      bytes: utf8('a\nb\nc'),
      filename: 'x.txt',
      mimeType: 'text/plain',
    });
    expect(out.content).toBe('a\nb\nc');
    expect(out.content_truncated).toBe(false);
    expect(out.line_count).toBe(3);
  });

  test('truncates rather than withholds oversized text', () => {
    const out = fileDownloadOutput({
      bytes: utf8('x'.repeat(100)),
      filename: 'x.txt',
      mimeType: 'text/plain',
      inlineMaxBytes: 10,
    });
    expect(out.content).toBe('x'.repeat(10));
    expect(out.content_truncated).toBe(true);
  });

  test('omits binary content but still ships the bytes', () => {
    const out = fileDownloadOutput({
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      filename: 'a.png',
      mimeType: 'image/png',
    });
    expect(out).not.toHaveProperty('content');
    expect(out.content_omitted_reason).toContain('download_url');
    expect(out.attachments).toHaveLength(1);
  });

  test('a 0 budget disables inlining without dropping the attachment', () => {
    const out = fileDownloadOutput({
      bytes: utf8('hello'),
      filename: 'x.txt',
      mimeType: 'text/plain',
      inlineMaxBytes: 0,
    });
    expect(out).not.toHaveProperty('content');
    expect(out.content_omitted_reason).toBe('inlining disabled');
    expect(out.attachments).toHaveLength(1);
  });

  // Drive's Apps Script export is `application/vnd.google-apps.script+json`:
  // text the caller wants inline, under a media type no generic rule can read.
  test('an explicit textual override beats the media type', () => {
    const out = fileDownloadOutput({
      bytes: utf8('{"a":1}'),
      filename: 's.json',
      mimeType: 'application/vnd.google-apps.script+json',
      textual: true,
    });
    expect(out.content).toBe('{"a":1}');
  });
});

test('inlineMaxBytesSchema states the same budget it enforces', () => {
  const schema = inlineMaxBytesSchema();
  expect(schema.minimum).toBe(0);
  expect(schema.maximum).toBe(MAX_INLINE_CONTENT_BYTES);
  expect(String(schema.description)).toContain(String(DEFAULT_INLINE_CONTENT_BYTES));
});
