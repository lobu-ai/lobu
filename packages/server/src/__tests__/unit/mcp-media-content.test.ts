import { expect, test } from 'bun:test';
import { syntheticImage } from '../../../../../scripts/__tests__/fixtures/synthetic-image';
import { MAX_TOOL_IMAGE_BYTES, MAX_TOOL_IMAGES } from '@lobu/plugin-toolkit';
import { mcpImagesForResourceLinks, mcpResourceLinksForSdkReturnValue } from '../../mcp-media-resources';

function result(id = 42) {
  return { action: 'get_run', run: { id, output: { attachments: [{ artifact_id: 'synthetic-artifact', filename: 'shot.png', mime_type: 'image/png', size_bytes: 100 }] } } };
}
const links = () => mcpResourceLinksForSdkReturnValue(result());

test('recognizes direct, array and wrapped SDK results without duplicate resources', () => {
  const direct = result();
  expect(mcpResourceLinksForSdkReturnValue({ shots: [direct, { nested: direct }] })).toEqual(links());
  expect(mcpResourceLinksForSdkReturnValue({ action: 'execute', status: 'completed', run_id: 42, output: direct.run.output })).toEqual(links());
  expect(mcpResourceLinksForSdkReturnValue({ ...direct, action: 'unrelated' })).toEqual([]);
});

test('bounds wrapper traversal and accepts cycles without recursing forever', () => {
  const cyclic: Record<string, unknown> = { result: result() };
  cyclic.self = cyclic;
  expect(mcpResourceLinksForSdkReturnValue(cyclic)).toEqual(links());
  let deep: unknown = result();
  for (let i = 0; i < 10; i++) deep = { nested: deep };
  expect(mcpResourceLinksForSdkReturnValue(deep)).toEqual([]);
  expect(mcpResourceLinksForSdkReturnValue(Array.from({ length: 100 }, (_, i) => result(i + 1)))).toHaveLength(64);
});

test('resolves pixels with a bounded authorized reader, never a download URL', async () => {
  const data = syntheticImage().bytes.toString('base64');
  const asked: unknown[] = [];
  const content = await mcpImagesForResourceLinks(links(), async (uri, maxBytes) => {
    asked.push([uri, maxBytes]);
    return { contents: [{ mimeType: 'image/png', blob: data }] };
  });
  expect(asked).toEqual([['lobu://run/42/attachment/0', MAX_TOOL_IMAGE_BYTES]]);
  expect(content).toEqual([{ type: 'image', mimeType: 'image/png', data }]);
});

test.each(['missing', 'invalid', 'denied'])('reports %s images without retrying the operation', async kind => {
  const content = await mcpImagesForResourceLinks(links(), async () => {
    if (kind === 'denied') throw new Error('private error detail');
    return kind === 'missing' ? null : { contents: [{ mimeType: 'image/png', blob: 'YmFk' }] };
  });
  expect(content.some(part => part.type === 'image')).toBe(false);
  expect(JSON.stringify(content)).toContain('Image not delivered');
  expect(JSON.stringify(content)).not.toContain('private error detail');
});

test('does not read foreign URLs, oversize artifacts, duplicate links or unlimited failures', async () => {
  let reads = 0;
  const link = links()[0]!;
  await mcpImagesForResourceLinks([
    { ...link, uri: 'https://private.example.test/signed' },
    { ...link, size: MAX_TOOL_IMAGE_BYTES + 1 },
  ], async () => { reads++; return null; });
  expect(reads).toBe(0);
  await mcpImagesForResourceLinks([...links(), ...links()], async () => { reads++; return null; });
  expect(reads).toBe(1);
  reads = 0;
  await mcpImagesForResourceLinks(mcpResourceLinksForSdkReturnValue(Array.from({ length: 20 }, (_, i) => result(i + 1))), async () => { reads++; return null; });
  expect(reads).toBe(MAX_TOOL_IMAGES);
});
