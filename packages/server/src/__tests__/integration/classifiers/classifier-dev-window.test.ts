import { readFile } from 'node:fs/promises';
import type { AutomationClaimNextWindowResult } from '@lobu/core/contracts/tools/manage-automations';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePgTextArray } from '../../../db/client';
import { compileConnectorSource, extractConnectorMetadata } from '../../../utils/connector-compiler';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestConnection, createTestConnectorDefinition, createTestEntity, createTestEvent, seedOwnerContext } from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

const LABELS = ['request', 'announcement', 'uncertain'];
const POSTS = [
  'Reddit: Does anyone know a CRM that handles follow-ups?',
  'Hacker News: Show HN: We shipped a new open-source database.',
  'LinkedIn: Proud to announce our product launch today.',
  'X: https://example.test/post',
];
type Prediction = { label: string; confidence: number | null; scores: Record<string, number> | null; model: string };

describe('classifier.dev through an external Automation window', () => {
  let api: TestApiClient;
  let connectionId: number;
  let automationId: string;
  let eventIds: number[];
  let compiled: Awaited<ReturnType<typeof compileConnectorSource>>;
  let metadata: Awaited<ReturnType<typeof extractConnectorMetadata>>;

  beforeAll(async () => {
    const source = await readFile(new URL('../../../../../connectors/src/classifier_dev.ts', import.meta.url), 'utf8');
    compiled = await compileConnectorSource(source);
    metadata = await extractConnectorMetadata(compiled.compiledCode);
    expect(metadata.supportsExecute).toBe(true);
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    const { org, user } = await seedOwnerContext();
    api = await TestApiClient.for({ organizationId: org.id, userId: user.id, memberRole: 'owner' });
    await createTestConnectorDefinition({ key: metadata.key, name: metadata.name, organization_id: org.id, auth_schema: metadata.authSchema!, feeds_schema: {} });
    const sql = getTestDb();
    await sql`UPDATE connector_definitions SET actions_schema = ${sql.json(metadata.actions!)}, supports_execute = true WHERE key = ${metadata.key} AND organization_id = ${org.id}`;
    await sql`UPDATE connector_versions SET compiled_code = ${compiled.compiledCode} WHERE connector_key = ${metadata.key}`;
    connectionId = (await createTestConnection({ organization_id: org.id, connector_key: metadata.key, created_by: user.id })).id;
    const entity = await createTestEntity({ organization_id: org.id, created_by: user.id, name: 'Synthetic social posts' });
    const created = await api.automations.create({
      entity_id: entity.id, slug: 'social-classification', name: 'Social classification',
      prompt: 'Classify stored social posts.',
      sources: [{ name: 'posts', query: "SELECT id, occurred_at, payload_text FROM events WHERE semantic_type = 'content' ORDER BY occurred_at DESC, id DESC" }],
      outputs: { signals: { event: 'observation' } },
    }) as { automation_id: string };
    automationId = created.automation_id;
    // Fixture vectors avoid an unrelated embedding-service call. Inference is
    // the compiled connector's HTTP action, not the embedding engine.
    await api.classifiers.create({ slug: 'social-intent', name: 'Social intent', attribute_key: 'social_intent',
      attribute_values: Object.fromEntries(LABELS.map((label, slot) => [label, { description: label, examples: [label], embedding: Array.from({ length: 768 }, (_, i) => Number(i === slot)) }])) });
    eventIds = [];
    for (const content of POSTS) {
      const event = await createTestEvent({ organization_id: org.id, entity_id: entity.id, content });
      eventIds.push(Number(event.id));
    }
  });
  afterEach(() => vi.restoreAllMocks());

  function provider(status = 200) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://classifier.dev/v1/classify');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      const input = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as { inputs: string[]; labels: string[] };
      expect(input.labels).toEqual(LABELS);
      if (status !== 200) return Response.json({ error: 'temporarily unavailable', code: 'upstream_error' }, { status });
      return Response.json({ model: 'fixture-model', tier: 'fast', results: input.inputs.map(text => ({
        label: text.startsWith('Reddit') ? 'request' : 'announcement',
        confidence: text.startsWith('X:') ? 0.2 : 0.9,
        scores: { request: 0.1, announcement: 0.8, uncertain: 0.1 }, model: 'fixture-model',
      })) });
    });
  }

  async function processPage(claim: AutomationClaimNextWindowResult, invalidEvent = false) {
    const rows = claim.context.sources?.posts as Array<{ id: number; payload_text: string }>;
    if (rows.length === 0) return;
    const operation = await api.operations.execute({
      connection_id: connectionId, operation_key: 'classify',
      idempotency_key: `classify:${claim.run_id}:${rows.map(row => row.id).join(',')}`,
      input: { inputs: rows.map(row => row.payload_text), labels: LABELS, instructions: 'Choose uncertain for missing context.' },
    }) as { status: string; output: { results: Prediction[] } };
    if (operation.status !== 'completed') throw new Error(`Operation ${operation.status}`);
    const written = await api.classifiers.classify({
      classifier_slug: 'social-intent', source: 'llm',
      classifications: operation.output.results.map((result, i) => ({
        content_id: invalidEvent && i === 0 ? -1 : Number(rows[i].id),
        value: result.confidence !== null && result.confidence >= 0.7 ? result.label : 'uncertain',
        reasoning: JSON.stringify({ provider: 'classifier.dev', ...result, rubric_version: 'fixture-v1' }),
      })),
    }) as { data: { updated: number; failed: number } };
    if (written.data.failed !== 0 || written.data.updated !== rows.length) throw new Error('Incomplete label writes');
  }

  it('runs the compiled action, stores labels and provenance, replays without inference, then advances the window', async () => {
    const http = provider();
    const claim = await api.automations.claimNextWindow({ automation_id: automationId, limit: 100 }) as AutomationClaimNextWindowResult;
    expect(claim.context.sources?.posts).toHaveLength(4);
    await processPage(claim);
    await processPage(claim);
    expect(http).toHaveBeenCalledTimes(1);
    const rows = await getTestDb()`SELECT event_id, "values", confidences, reasoning, source FROM event_classifications ORDER BY event_id`;
    expect(rows.map(row => Number(row.event_id))).toEqual(eventIds);
    expect(rows.map(row => parsePgTextArray(row.values)[0])).toEqual(['request', 'announcement', 'announcement', 'uncertain']);
    for (const row of rows) {
      expect(row.source).toBe('llm');
      expect(JSON.parse(row.reasoning)).toMatchObject({ provider: 'classifier.dev', model: 'fixture-model', rubric_version: 'fixture-v1' });
      // classifiers.classify's native confidence is a write override, not the
      // provider probability; that probability lives in reasoning above.
      expect(row.confidences[parsePgTextArray(row.values)[0]]).toBe(1);
    }
    await api.automations.completeWindow({ automation_id: automationId, run_id: claim.run_id, window_token: claim.context.window_token, extracted_data: { signals: [] } });
    const [after] = await getTestDb()`SELECT next_window_start FROM automations WHERE id = ${Number(automationId)}`;
    expect(new Date(after.next_window_start).toISOString()).toBe(claim.context.window_end);
  });

  it.each(['provider', 'partial writes'] as const)('keeps the arrival mark when %s fail', async failure => {
    const http = provider(failure === 'provider' ? 503 : 200);
    const claim = await api.automations.claimNextWindow({ automation_id: automationId }) as AutomationClaimNextWindowResult;
    const [before] = await getTestDb()`SELECT next_window_start FROM automations WHERE id = ${Number(automationId)}`;
    await expect(processPage(claim, failure === 'partial writes')).rejects.toThrow(failure === 'provider' ? '503' : 'Incomplete label writes');
    expect(http).toHaveBeenCalledTimes(1);
    const [after] = await getTestDb()`SELECT next_window_start FROM automations WHERE id = ${Number(automationId)}`;
    expect(after.next_window_start).toEqual(before.next_window_start);
    const [run] = await getTestDb()`SELECT status FROM runs WHERE id = ${claim.run_id}`;
    expect(run.status).not.toBe('completed');
  });
});
