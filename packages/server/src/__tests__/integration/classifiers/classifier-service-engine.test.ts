/**
 * `engine: 'service'` classifiers: `apply` sends event text to whatever server
 * CLASSIFIER_SERVICE_URL points at (POST /v1/classify) and stores its answer
 * with the provider's own confidences. The stub below plays that server, so the
 * test drives the real tool, real Postgres, and a real HTTP round-trip.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { manageClassifiers } from '../../../tools/admin/manage_classifiers';
import type { ToolContext } from '../../../tools/registry';
import { executeClassificationQuery } from '../../../utils/classification-query';
import { classifyViaService } from '../../../utils/classifier-service';
import { getConfiguredEmbeddingModel } from '../../../utils/embeddings';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

interface ClassifyRequest {
  inputs: string[];
  labels: string[];
  instructions?: string;
}

type Answer = (text: string, labels: string[]) => unknown;

let server: Server;
let baseUrl: string;
let requests: Array<{ body: ClassifyRequest; authorization: string | undefined }> = [];
let status = 200;
let answer: Answer = () => ({});

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/classify') {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await readBody(req)) as ClassifyRequest;
    requests.push({ body, authorization: req.headers.authorization });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        status === 200
          ? { model: 'stub-model', results: body.inputs.map((text) => answer(text, body.labels)) }
          : { error: 'unavailable', code: 'inference_unavailable' }
      )
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests = [];
  status = 200;
  answer = () => ({});
});

/** request 0.95 for texts mentioning "help", announcement 0.9 for "shipped", else request at 0.55. */
const byKeyword: Answer = (text) => {
  if (text.includes('help')) {
    return { label: 'request', confidence: 0.95, scores: { request: 0.95, announcement: 0.05 } };
  }
  if (text.includes('shipped')) {
    return {
      label: 'announcement',
      confidence: 0.9,
      scores: { request: 0.1, announcement: 0.9 },
    };
  }
  return { label: 'request', confidence: 0.55, scores: { request: 0.55, announcement: 0.45 } };
};

function env(): Env {
  return { CLASSIFIER_SERVICE_URL: `${baseUrl}/`, CLASSIFIER_SERVICE_TOKEN: 'test-token' } as Env;
}

async function setup() {
  await cleanupTestDatabase();
  const org = await createTestOrganization({ name: 'Service Engine Org' });
  const other = await createTestOrganization({ name: 'Service Engine Other Org' });
  const user = await createTestUser({ email: 'service-engine@test.com' });
  const ctx = {
    organizationId: org.id,
    userId: user.id,
    memberRole: 'owner',
    isAuthenticated: true,
    tokenType: 'oauth',
    scopedToOrg: false,
    scopes: ['mcp:admin'],
  } as ToolContext;

  // No EMBEDDINGS_SERVICE_URL: a service classifier must not need one.
  const created = await manageClassifiers(
    {
      action: 'create',
      slug: 'post-intent',
      name: 'Post intent',
      description: 'What the author of a social post wants.',
      attribute_key: 'post-intent',
      engine: 'service',
      attribute_values: {
        request: { description: 'Asks for help or a recommendation', examples: ['Any good CRM?'] },
        announcement: { description: 'Reports a launch or release', examples: [] },
      },
    } as never,
    env(),
    ctx
  );
  expect(created.success).toBe(true);
  const classifierId = Number((created.data as { classifier_id: number }).classifier_id);
  return { org, other, user, ctx, classifierId };
}

async function rowsFor(eventIds: number[]) {
  const sql = getTestDb();
  return (await sql`
    SELECT event_id, "values", confidences, source, is_manual, met_threshold, reasoning
    FROM event_classifications
    WHERE event_id = ANY(${`{${eventIds.join(',')}}`}::bigint[])
    ORDER BY event_id, source
  `) as unknown as Array<{
    event_id: number;
    values: string[] | string;
    confidences: Record<string, number>;
    source: string;
    is_manual: boolean;
    met_threshold: boolean | null;
    reasoning: string | null;
  }>;
}

describe('classifier service engine', () => {
  it('creates without embeddings and labels content through the service', async () => {
    const { org, other, ctx, classifierId } = await setup();
    const sql = getTestDb();

    const stored = (await sql`
      SELECT engine, attribute_values FROM classify_facet WHERE id = ${classifierId}
    `) as unknown as Array<{ engine: string; attribute_values: Record<string, { embedding?: unknown }> }>;
    expect(stored[0].engine).toBe('service');
    expect(stored[0].attribute_values.request.embedding).toBeUndefined();

    answer = byKeyword;
    const helpPost = await createTestEvent({
      organization_id: org.id,
      title: 'CRM question',
      content: 'Can anyone help me pick a CRM?',
    });
    const launch = await createTestEvent({
      organization_id: org.id,
      content: 'We shipped v2 today',
    });
    const unsure = await createTestEvent({ organization_id: org.id, content: 'hmm, interesting' });
    const empty = await createTestEvent({ organization_id: org.id, content: 'placeholder' });
    await sql`UPDATE events SET payload_text = E' \\n\\t ', title = NULL WHERE id = ${empty.id}`;
    const superseded = await createTestEvent({ organization_id: org.id, content: 'help old' });
    const replacement = await createTestEvent({ organization_id: org.id, content: 'help new' });
    await sql`UPDATE events SET superseded_by = ${replacement.id} WHERE id = ${superseded.id}`;
    const foreign = await createTestEvent({ organization_id: other.id, content: 'help foreign' });

    const ids = [helpPost, launch, unsure, empty, superseded, foreign].map((e) => Number(e.id));
    const result = await manageClassifiers(
      { action: 'apply', classifier_slug: 'post-intent', content_ids: ids } as never,
      env(),
      ctx
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      requested: 6,
      classified: 2,
      skipped: { not_in_organization: 1, superseded: 1, no_text: 1, below_threshold: 1 },
    });

    // One request, live-with-text events only, in request order, with the rubric built
    // from the classifier's own description, label descriptions and examples.
    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBe('Bearer test-token');
    expect(requests[0].body.inputs).toEqual([
      'CRM question\n\nCan anyone help me pick a CRM?',
      'We shipped v2 today',
      'hmm, interesting',
    ]);
    expect(requests[0].body.labels).toEqual(['request', 'announcement']);
    expect(requests[0].body.instructions).toBe(
      [
        'What the author of a social post wants.',
        '',
        'Labels:',
        '- request: Asks for help or a recommendation',
        '  Examples: "Any good CRM?"',
        '- announcement: Reports a launch or release',
      ].join('\n')
    );

    const rows = await rowsFor(ids);
    expect(rows.map((r) => [Number(r.event_id), r.source, r.is_manual, r.met_threshold])).toEqual([
      [Number(helpPost.id), 'service', false, true],
      [Number(launch.id), 'service', false, true],
    ]);
    expect(rows[0].confidences).toEqual({ request: 0.95, announcement: 0.05 });
    expect(JSON.parse(rows[1].reasoning ?? '{}')).toMatchObject({
      engine: 'service',
      model: 'stub-model',
      label: 'announcement',
      confidence: 0.9,
    });
    expect(String(rows[0].values)).toContain('request');
  });

  it('re-labels on re-run, leaves manual labels alone, and writes nothing on a service failure', async () => {
    const { org, ctx } = await setup();
    answer = byKeyword;
    const post = await createTestEvent({ organization_id: org.id, content: 'please help' });
    const manual = await createTestEvent({ organization_id: org.id, content: 'help me too' });
    const ids = [Number(post.id), Number(manual.id)];

    const apply = () =>
      manageClassifiers(
        { action: 'apply', classifier_slug: 'post-intent', content_ids: ids } as never,
        env(),
        ctx
      );
    expect((await apply()).data).toMatchObject({ classified: 2 });
    const overridden = await manageClassifiers(
      {
        action: 'classify',
        classifier_slug: 'post-intent',
        content_id: Number(manual.id),
        value: 'announcement',
      } as never,
      env(),
      ctx
    );
    expect(overridden.success).toBe(true);

    // The service now answers below threshold: the stale service label goes,
    // the manual one stays.
    answer = () => ({ label: 'request', confidence: 0.4, scores: null });
    expect((await apply()).data).toMatchObject({ classified: 0, skipped: { below_threshold: 2 } });
    let rows = await rowsFor(ids);
    expect(rows.map((r) => [Number(r.event_id), r.source])).toEqual([
      [Number(manual.id), 'user'],
    ]);

    answer = byKeyword;
    await apply();
    status = 503;
    const failed = await apply();
    expect(failed.success).toBe(false);
    expect(failed.message).toContain('HTTP 503');
    rows = await rowsFor(ids);
    expect(rows.filter((r) => r.source === 'service')).toHaveLength(2);
  });

  it('rejects malformed service output instead of applying part of it', async () => {
    const { org, ctx } = await setup();
    const post = await createTestEvent({ organization_id: org.id, content: 'help' });
    answer = () => ({ label: 'invented', confidence: 0.99, scores: null });
    const result = await manageClassifiers(
      { action: 'apply', classifier_slug: 'post-intent', content_ids: [Number(post.id)] } as never,
      env(),
      ctx
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain('invalid result at index 0');
    expect(await rowsFor([Number(post.id)])).toEqual([]);
  });

  it('rejects missing confidence without replacing existing labels', async () => {
    const { org, ctx } = await setup();
    const post = await createTestEvent({ organization_id: org.id, content: 'help' });
    const apply = () => manageClassifiers(
      { action: 'apply', classifier_slug: 'post-intent', content_ids: [Number(post.id)] } as never,
      env(),
      ctx
    );
    answer = byKeyword;
    expect((await apply()).success).toBe(true);
    answer = () => ({ label: 'request', scores: null });
    expect((await apply()).success).toBe(false);
    expect(await rowsFor([Number(post.id)])).toHaveLength(1);
  });

  it('uses the fallback value for low-confidence and unscored answers', async () => {
    const { org, ctx, classifierId } = await setup();
    await getTestDb()`UPDATE classify_facet SET fallback_value = 'announcement' WHERE id = ${classifierId}`;
    const post = await createTestEvent({ organization_id: org.id, content: 'something' });
    answer = () => ({ label: 'request', confidence: null, scores: null, unscored: 'escalated' });
    const result = await manageClassifiers(
      { action: 'apply', classifier_slug: 'post-intent', content_ids: [Number(post.id)] } as never,
      env(),
      ctx
    );
    expect(result.data).toMatchObject({ classified: 1 });
    const [row] = await rowsFor([Number(post.id)]);
    expect(String(row.values)).toContain('announcement');
    expect(row.met_threshold).toBe(false);
  });

  it('is invisible to the embedding engine and has no embeddings to regenerate', async () => {
    const { org, ctx, classifierId } = await setup();
    // `create` accepts caller-supplied label vectors even for a service
    // classifier. Give it one that matches the event exactly, so only the
    // engine filter stands between it and an embedding-engine label.
    const vector = new Array<number>(768).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    const labelVector = { embedding: vector, embedding_model: getConfiguredEmbeddingModel() };
    await getTestDb()`
      UPDATE classify_facet
      SET attribute_values = ${getTestDb().json({ request: labelVector, announcement: labelVector } as never)}
      WHERE id = ${classifierId}
    `;
    const embedded = await createTestEvent({
      organization_id: org.id,
      content: 'embedded event',
      embedding: vector,
    });
    const results = await executeClassificationQuery({
      mode: 'content_ids',
      organizationId: org.id,
      content_ids: [Number(embedded.id)],
      enabledClassifiers: ['post-intent'],
    });
    expect(results).toEqual([]);

    const regen = await manageClassifiers(
      { action: 'generate_embeddings', classifier_id: classifierId } as never,
      env(),
      ctx
    );
    expect(regen.success).toBe(false);
    expect(regen.message).toContain('classification service');
  });

  it('batches large inputs and fails clearly when unconfigured', async () => {
    answer = (text) => ({ label: text.endsWith('odd') ? 'b' : 'a', confidence: 0.8, scores: null });
    const inputs = Array.from({ length: 150 }, (_, i) => `text ${i} ${i % 2 ? 'odd' : 'even'}`);
    const predictions = await classifyViaService(inputs, ['a', 'b'], undefined, env());
    expect(requests.map((r) => r.body.inputs.length)).toEqual([100, 50]);
    expect(requests[0].body).not.toHaveProperty('instructions');
    expect(predictions.map((p) => p.label)).toEqual(inputs.map((t) => (t.endsWith('odd') ? 'b' : 'a')));
    expect(predictions[0].model).toBe('stub-model');

    await expect(classifyViaService(['x'], ['a', 'b'], undefined, {} as Env)).rejects.toThrow(
      'CLASSIFIER_SERVICE_URL is not configured'
    );
  });
});
