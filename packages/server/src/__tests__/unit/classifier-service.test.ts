import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Env } from '../../index';
import { classifyViaService } from '../../utils/classifier-service';

const env = { CLASSIFIER_SERVICE_URL: 'https://classifier.example' } as Env;

afterEach(() => mock.restore());

describe('classifier service response and request bounds', () => {
  it('rejects omitted confidence but accepts explicit unscored results', async () => {
    const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ results: [{ label: 'a', scores: null }] })
    );
    await expect(classifyViaService(['x'], ['a', 'b'], undefined, env)).rejects.toThrow(
      'invalid result'
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({ results: [{ label: 'a', confidence: null, scores: null }] })
    );
    expect(await classifyViaService(['x'], ['a', 'b'], undefined, env)).toEqual([
      { label: 'a', confidence: null, scores: null, model: null },
    ]);
  });

  it('batches by UTF-8 body size including JSON escaping and the rubric', async () => {
    const received: string[] = [];
    const instructions = 'Rubric: '.repeat(500);
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const raw = String(init?.body);
      expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(1_000_000);
      const body = JSON.parse(raw) as { inputs: string[]; instructions: string };
      expect(body.instructions).toBe(instructions);
      received.push(...body.inputs);
      return Response.json({
        results: body.inputs.map(() => ({ label: 'a', confidence: 0.9, scores: null })),
      });
    });
    const inputs = Array.from({ length: 40 }, (_, i) => `${i}: ${'界"\\'.repeat(10_000)}`);
    expect(await classifyViaService(inputs, ['a', 'b'], instructions, env)).toHaveLength(40);
    expect(received).toEqual(inputs);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('rejects an input and rubric that cannot fit in a single request', async () => {
    const fetchMock = spyOn(globalThis, 'fetch');
    await expect(
      classifyViaService(['x'], ['a', 'b'], 'r'.repeat(1_000_000), env)
    ).rejects.toThrow('1 MB request limit');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retains the input-count limit for short texts', async () => {
    const lengths: number[] = [];
    spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const { inputs } = JSON.parse(String(init?.body)) as { inputs: string[] };
      lengths.push(inputs.length);
      return Response.json({
        results: inputs.map(() => ({ label: 'b', confidence: 0.8, scores: null })),
      });
    });
    expect(
      await classifyViaService(new Array(150).fill('x'), ['a', 'b'], undefined, env)
    ).toHaveLength(150);
    expect(lengths).toEqual([100, 50]);
  });
});
