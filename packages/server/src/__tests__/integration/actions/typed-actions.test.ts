/**
 * PostgreSQL contract tests for synchronous typed actions. Failure triggers run
 * inside the real event/task/entity writers to verify their shared transaction.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ActionApplyInput,
  ActionDefinition,
} from '@lobu/core/contracts/tools/manage-actions';
import { applyAction } from '../../../actions/executor';
import { compileEntityRule } from '../../../authz/entity-rule-executor';
import { upsertEntityApprovalPolicy } from '../../../authz/entity-policy';
import type { Env } from '../../../index';
import { invokeViewAction } from '../../../interactions/template-event-actions';
import { buildActionsNamespace } from '../../../sandbox/namespaces/actions';
import { checkStalledExecutions } from '../../../scheduled/check-stalled-executions';
import { WORKSPACE_EVENT_ACTIVATION_TASK } from '../../../scheduled/task-definitions';
import { manageActions } from '../../../tools/admin/manage_actions';
import type { ToolContext } from '../../../tools/registry';
import { resolveEventKindData } from '../../../utils/event-kind-validation';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { setView } from '../../../views/views';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestAgent,
  createTestEntity,
  createTestOAuthClient,
  createTestUser,
  seedOwnerContext,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';
import { TestApiClient, TestMcpClient } from '../../setup/test-mcp-client';

const ENV = { ENVIRONMENT: 'test' } as Env;
const ENTITY_TYPE = 'synthetic-action-asset';
const ACTION_KEY = 'synthetic-action-asset.set_stage';
const EVENT_KIND = 'synthetic-action-asset.stage_set';
const VIEW_KEY = 'synthetic-action-stage-map';

function stageDefinition(): ActionDefinition {
  return {
    params: {
      type: 'object',
      properties: {
        asset_id: { type: 'integer', minimum: 1 },
        stage: { type: 'string', enum: ['todo', 'doing', 'done'] },
        private_note: { type: 'string', maxLength: 200 },
      },
      required: ['asset_id', 'stage'],
      additionalProperties: false,
    },
    target: { entityType: ENTITY_TYPE, idParam: 'asset_id' },
    invokePermission: 'write',
    requiredExpected: ['stage_event_id'],
    set: {
      stage: { param: 'stage' },
      stage_at: { server: 'timestamp' },
      stage_event_id: { event: 'id' },
    },
    transition: {
      field: 'stage',
      param: 'stage',
      allowed: [
        { from: null, to: ['todo'] },
        { from: 'todo', to: ['doing', 'done'] },
        { from: 'doing', to: ['todo', 'done'] },
        { from: 'done', to: ['todo'] },
      ],
    },
    emits: {
      kind: EVENT_KIND,
      schemaVersion: 1,
      payload: {
        asset_id: { param: 'asset_id' },
        stage: { param: 'stage' },
        stage_at: { server: 'timestamp' },
      },
    },
  };
}

async function fixture(options: { subscribe?: boolean } = {}) {
  const sql = getTestDb();
  const seeded = await seedOwnerContext({ orgName: 'Synthetic typed actions' });
  const ctx: ToolContext = {
    ...seeded.ctx,
    tokenType: 'session',
    scopes: ['*'],
  };
  const api = await TestApiClient.for({
    organizationId: seeded.org.id,
    userId: seeded.user.id,
    memberRole: 'owner',
    tokenType: 'session',
    scopes: ['*'],
  });
  const asset = await createTestEntity({
    organization_id: seeded.org.id,
    created_by: seeded.user.id,
    entity_type: ENTITY_TYPE,
    name: 'Synthetic asset',
  });
  const kind = {
    description: 'A synthetic asset stage changed.',
    metadataSchema: {
      type: 'object',
      properties: {
        asset_id: { type: 'integer' },
        stage: { type: 'string', enum: ['todo', 'doing', 'done'] },
        stage_at: { type: 'string', format: 'date-time' },
      },
      required: ['asset_id', 'stage', 'stage_at'],
      additionalProperties: false,
    },
  };
  await sql.unsafe(
    'UPDATE entity_types SET metadata_schema = $1::jsonb, event_kinds = $2::jsonb, metrics_config = $3::jsonb WHERE organization_id = $4 AND slug = $5',
    [
      getTestDb().json({
        type: 'object',
        properties: {
          stage: { type: 'string', enum: ['todo', 'doing', 'done'] },
          stage_at: { type: 'string', format: 'date-time' },
          stage_event_id: { type: ['integer', 'null'] },
          owner_note: { type: 'string' },
          revision: { type: 'string' },
        },
        additionalProperties: false,
      }),
      getTestDb().json({ [EVENT_KIND]: kind }),
      getTestDb().json({
        segments: {
          in_progress: {
            on: 'entity',
            description: 'Synthetic assets in progress.',
            where: "metadata->>'stage' = 'doing'",
          },
        },
      }),
      seeded.org.id,
      ENTITY_TYPE,
    ],
  );
  await sql.unsafe(
    'UPDATE entities SET metadata = $1::jsonb WHERE id = $2',
    [getTestDb().json({ stage: 'todo', owner_note: 'Retain this unrelated private field.' }), asset.id],
  );
  await ensureMemberEntityType(seeded.org.id);
  await sql.unsafe(
    "UPDATE entity_types SET event_kinds = COALESCE(event_kinds, '{}'::jsonb) || $1::jsonb WHERE organization_id = $2 AND slug = '$member'",
    [getTestDb().json({ [EVENT_KIND]: kind }), seeded.org.id],
  );
  if (options.subscribe !== false) {
    const agent = await createTestAgent({
      organizationId: seeded.org.id,
      ownerUserId: seeded.user.id,
    });
    await api.automations.create({
      slug: 'synthetic-stage-consumer',
      prompt: 'Observe the synthetic stage change.',
      managed_agent_id: agent.agentId,
      triggers: [{
        kind: 'event',
        source: 'workspace',
        event_types: [EVENT_KIND],
        execution: 'window',
        active_run: 'queue',
      }],
    });
  }
  const definition = stageDefinition();
  const published = await manageActions({
    action: 'publish',
    key: ACTION_KEY,
    name: 'Set synthetic asset stage',
    definition,
  }, ENV, ctx);
  expect(published).toMatchObject({
    action: 'publish',
    action_type: { key: ACTION_KEY, enabled: true },
    version: { version: 1, definition },
  });
  return { ...seeded, ctx, api, asset, definition };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type CommittedAction = Extract<Awaited<ReturnType<typeof applyAction>>, { dry_run: false }>;

async function ownerAccessToken(f: Fixture): Promise<string> {
  const oauthClient = await createTestOAuthClient();
  const { token } = await createTestAccessToken(f.user.id, f.org.id, oauthClient.client_id, {
    scope: 'mcp:read mcp:write mcp:admin',
  });
  return token;
}

function invocation(f: Fixture, overrides: Partial<ActionApplyInput> = {}): ActionApplyInput {
  return {
    key: ACTION_KEY,
    version: 1,
    params: { asset_id: f.asset.id, stage: 'doing' },
    expected: { stage_event_id: null },
    idempotency_key: randomUUID(),
    ...overrides,
  };
}

async function apply(
  f: Fixture,
  input = invocation(f),
  ctx = f.ctx,
): Promise<CommittedAction> {
  const result = await applyAction(input, ENV, ctx);
  expect(result.dry_run).toBe(false);
  if (result.dry_run !== false) throw new Error('Expected a committed action result');
  return result;
}

async function assetState(f: Fixture) {
  const rows = await getTestDb().unsafe(
    'SELECT metadata, field_controls FROM entities WHERE id = $1',
    [f.asset.id],
  );
  return rows[0];
}

async function durableCounts(f: Fixture) {
  const [row] = await getTestDb().unsafe(
    'SELECT ' +
      '(SELECT count(*)::int FROM events WHERE organization_id = $1 AND semantic_type = $2) AS events, ' +
      '(SELECT count(*)::int FROM runs WHERE organization_id = $1 AND action_type_id IS NOT NULL) AS receipts, ' +
      "(SELECT count(*)::int FROM runs WHERE organization_id = $1 AND run_type = 'task' AND action_key = $3) AS activations, " +
      "(SELECT count(*)::int FROM runs WHERE organization_id = $1 AND approval_status = 'pending') AS approvals",
    [f.org.id, EVENT_KIND, WORKSPACE_EVENT_ACTIVATION_TASK],
  );
  return {
    events: Number(row.events),
    receipts: Number(row.receipts),
    activations: Number(row.activations),
    approvals: Number(row.approvals),
  };
}

async function expectNoActionWrites(f: Fixture, before: Awaited<ReturnType<typeof assetState>>) {
  expect(await assetState(f)).toEqual(before);
  expect(await durableCounts(f)).toEqual({
    events: 0, receipts: 0, activations: 0, approvals: 0,
  });
}

async function dropFailureTrigger() {
  const sql = getTestDb();
  await sql.unsafe('DROP TRIGGER IF EXISTS typed_action_test_abort ON entities');
  await sql.unsafe('DROP TRIGGER IF EXISTS typed_action_test_abort ON runs');
  await sql.unsafe('DROP FUNCTION IF EXISTS typed_action_test_abort()');
}

async function injectDatabaseFailure(point: 'enqueue' | 'entity') {
  const sql = getTestDb();
  const condition = point === 'enqueue'
    ? "NEW.run_type = 'task'"
    : "NEW.metadata ? 'stage_event_id'";
  await sql.unsafe([
    'CREATE FUNCTION typed_action_test_abort() RETURNS trigger LANGUAGE plpgsql AS $$',
    'BEGIN',
    '  IF ' + condition + ' THEN',
    "    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Injected typed action transaction failure';",
    '  END IF;',
    '  RETURN NEW;',
    'END;',
    '$$',
  ].join('\n'));
  await sql.unsafe(
    'CREATE TRIGGER typed_action_test_abort AFTER ' +
      (point === 'enqueue' ? 'INSERT ON runs' : 'UPDATE ON entities') +
      ' FOR EACH ROW EXECUTE FUNCTION typed_action_test_abort()',
  );
}

async function storeView(f: Fixture, version: number) {
  return setView(f.org.id, {
    key: VIEW_KEY,
    name: 'Synthetic stage map',
    description: 'Fixture for the published action binding.',
    source_code: 'export default function View() { return null; }',
    compiled_code: '(() => {})();',
    content_hash: 'synthetic-action-view-' + version,
    attach: [],
    params: {},
    actions: { set_stage: { action: { key: ACTION_KEY, version } } },
    last_writer: f.user.id,
  });
}

function viewInvocation(f: Fixture, overrides: Partial<Parameters<typeof invokeViewAction>[0]> = {}) {
  return {
    organizationId: f.org.id,
    viewKey: VIEW_KEY,
    action: 'set_stage',
    value: { asset_id: f.asset.id, stage: 'doing' },
    interactionId: randomUUID(),
    surface: 'web' as const,
    actor: { platform: 'lobu', platformUserId: f.user.id, userId: f.user.id },
    binding: { key: ACTION_KEY, version: 1 },
    expected: { stage_event_id: null },
    caller: { env: ENV, ctx: f.ctx },
    ...overrides,
  } satisfies Parameters<typeof invokeViewAction>[0];
}

describe('typed action transactions', () => {
  beforeEach(cleanupTestDatabase);
  afterEach(dropFailureTrigger);
  afterAll(cleanupTestDatabase);

  it('commits the entity, one domain event, a receipt, and a durable activation together', async () => {
    const f = await fixture();
    const input = invocation(f);
    const result = await apply(f, input);
    expect(result).toMatchObject({
      created: true,
      replayed: false,
      dry_run: false,
      action: { key: ACTION_KEY, version: 1 },
      event_type: EVENT_KIND,
      entity: { id: f.asset.id, metadata: { stage: 'doing', stage_event_id: result.event_id } },
    });
    expect(Number(result.event_id)).toBeGreaterThan(0);
    expect(Number(result.receipt_id)).toBeGreaterThan(0);
    const state = await assetState(f);
    expect(state.metadata).toMatchObject({
      ...result.entity.metadata,
      owner_note: 'Retain this unrelated private field.',
    });
    expect(Object.keys(result.entity.metadata).sort()).toEqual(['stage', 'stage_at', 'stage_event_id']);
    const [event] = await getTestDb().unsafe(
      'SELECT metadata, payload_data, run_id, created_by FROM events WHERE id = $1',
      [result.event_id],
    );
    expect(resolveEventKindData(event.payload_data, event.metadata)).toMatchObject({
      asset_id: f.asset.id,
      stage: 'doing',
      stage_at: result.entity.metadata.stage_at,
    });
    expect(Number(event.run_id)).toBe(Number(result.receipt_id));
    expect(event.created_by).toBe(f.user.id);
    const [receipt] = await getTestDb().unsafe(
      'SELECT status, approval_status, action_output, action_type_id, action_version_id FROM runs WHERE id = $1',
      [result.receipt_id],
    );
    expect(receipt).toMatchObject({ status: 'completed', approval_status: 'auto' });
    expect(receipt.action_type_id).not.toBeNull();
    expect(receipt.action_version_id).not.toBeNull();
    expect(receipt.action_output).toMatchObject({ event_id: result.event_id, entity: result.entity });
    const [task] = await getTestDb().unsafe(
      "SELECT action_input FROM runs WHERE organization_id = $1 AND run_type = 'task' AND action_key = $2",
      [f.org.id, WORKSPACE_EVENT_ACTIVATION_TASK],
    );
    expect(task.action_input).toMatchObject({
      name: WORKSPACE_EVENT_ACTIVATION_TASK,
      payload: { organizationId: f.org.id, eventId: result.event_id },
    });
    expect(await durableCounts(f)).toEqual({
      events: 1, receipts: 1, activations: 1, approvals: 0,
    });
    const filtered = await f.api.entities.list({
      entity_type: ENTITY_TYPE,
      segment: 'in_progress',
    }) as { entities: Array<{ id: number }> };
    expect(filtered.entities.map((entity) => Number(entity.id))).toEqual([f.asset.id]);
  });

  it('authenticates REST apply/replay and returns a structured HTTP 409 for stale state', async () => {
    const f = await fixture();
    const token = await ownerAccessToken(f);
    const path = '/api/' + f.org.slug + '/manage_actions';
    const request = invocation(f);
    const response = await post(path, { token, body: { action: 'apply', ...request } });
    expect(response.status).toBe(200);
    const committed = await response.json() as CommittedAction;
    expect(committed).toMatchObject({ created: true, replayed: false, dry_run: false });

    const replay = await post(path, { token, body: { action: 'apply', ...request } });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      created: false, replayed: true,
      receipt_id: committed.receipt_id, event_id: committed.event_id,
      entity: committed.entity,
    });

    const stale = await post(path, {
      token,
      body: { action: 'apply', ...request, idempotency_key: randomUUID() },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: 'PRECONDITION_FAILED',
      retryable: false,
      mismatched_fields: ['stage_event_id'],
    });
    expect(await durableCounts(f)).toEqual({ events: 1, receipts: 1, activations: 1, approvals: 0 });
  });

  it('discovers actions in query_sdk and preserves action conflicts through MCP and run_sdk', async (testCtx) => {
    // Match the existing sandbox wire harness: loading the wrong native ABI can
    // segfault, so unsupported local runtimes skip only this wire-level case.
    if (process.versions.modules !== '147' ||
        !existsSync(fileURLToPath(new URL('../../../../../../node_modules/isolated-vm', import.meta.url)))) {
      return testCtx.skip();
    }
    const f = await fixture();
    const token = await ownerAccessToken(f);
    const wire = new TestMcpClient({ token, orgSlug: f.org.slug });
    const queried = await wire.querySdk(
      'export default async (_ctx, client) => client.actions.get({ key: ' +
      JSON.stringify(ACTION_KEY) + ', version: 1 });',
    );
    expect(queried).toMatchObject({
      success: true,
      return_value: { action_type: { key: ACTION_KEY }, version: { version: 1 } },
    });

    const request = invocation(f);
    const script = 'export default async (_ctx, client) => client.actions.apply(' +
      JSON.stringify(request) + ');';
    const applied = await wire.runSdk<{ success: boolean; return_value: CommittedAction }>(script);
    expect(applied).toMatchObject({ success: true, return_value: { created: true, dry_run: false } });
    const committed = applied.return_value;
    expect(await wire.runSdk(script)).toMatchObject({
      success: true,
      return_value: { replayed: true, receipt_id: committed.receipt_id, event_id: committed.event_id },
    });

    const stale = { ...request, idempotency_key: randomUUID() };
    const expectedError = {
      code: 'PRECONDITION_FAILED',
      retryable: false,
      details: { mismatched_fields: ['stage_event_id'] },
    };
    const direct = await wire.raw<{ structuredContent: Record<string, unknown>; isError?: boolean }>('tools/call', {
      name: 'manage_actions',
      arguments: { action: 'apply', ...stale },
    });
    expect(direct.error).toBeUndefined();
    expect(direct.result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'PRECONDITION_FAILED',
          retryable: false,
          mismatched_fields: ['stage_event_id'],
        },
      },
    });

    const failedScript = await wire.raw<{ structuredContent: Record<string, unknown> }>('tools/call', {
      name: 'run_sdk',
      arguments: {
        script: 'export default async (_ctx, client) => client.actions.apply(' +
          JSON.stringify(stale) + ');',
      },
    });
    expect(failedScript.error).toBeUndefined();
    expect(failedScript.result.structuredContent).toMatchObject({
      success: false, error: expectedError,
    });
    expect(failedScript.result.structuredContent).not.toHaveProperty('return_value');
    expect(await durableCounts(f)).toEqual({ events: 1, receipts: 1, activations: 1, approvals: 0 });
  });

  it('routes the SDK namespace through the same contract and preserves structured conflicts', async () => {
    const f = await fixture();
    const actions = buildActionsNamespace(f.ctx, ENV);
    const request = invocation(f);
    expect(await actions.get({ key: ACTION_KEY, version: 1 })).toMatchObject({
      version: { version: 1, definition: f.definition },
    });
    expect(await actions.list()).toMatchObject({
      actions: expect.arrayContaining([expect.objectContaining({ key: ACTION_KEY })]),
    });
    const before = await assetState(f);
    expect(await actions.validate({
      key: request.key,
      version: request.version,
      params: request.params,
      expected: request.expected,
    })).toMatchObject({ dry_run: true, valid: true, target_id: f.asset.id });
    await expectNoActionWrites(f, before);

    const result = await actions.apply(request) as CommittedAction;
    expect(result).toMatchObject({ created: true, dry_run: false });
    expect(await actions.apply(request)).toMatchObject({
      created: false, replayed: true, event_id: result.event_id,
    });
    await expect(actions.apply({
      ...request,
      idempotency_key: randomUUID(),
    })).rejects.toMatchObject({
      httpStatus: 409,
      code: 'PRECONDITION_FAILED',
      retryable: false,
      details: { mismatched_fields: ['stage_event_id'] },
    });

    await actions.publish({
      key: ACTION_KEY,
      definition: {
        ...f.definition,
        set: { ...f.definition.set, revision: { literal: 'v2' } },
      },
    });
    expect(await actions.get({ key: ACTION_KEY })).toMatchObject({ version: { version: 2 } });
    expect(await actions.setEnabled({ key: ACTION_KEY, enabled: false })).toMatchObject({
      action_type: { key: ACTION_KEY, enabled: false },
    });
    expect(await actions.apply(request)).toMatchObject({
      replayed: true, event_id: result.event_id,
    });
    expect(await durableCounts(f)).toEqual({ events: 1, receipts: 1, activations: 1, approvals: 0 });
  });

  it('serializes concurrent matching requests through PostgreSQL and replays one receipt', async () => {
    const f = await fixture();
    const input = invocation(f);
    const results = await Promise.all(Array.from({ length: 4 }, () => apply(f, structuredClone(input))));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(3);
    expect(new Set(results.map((result) => Number(result.event_id))).size).toBe(1);
    expect(new Set(results.map((result) => Number(result.receipt_id))).size).toBe(1);
    expect(await durableCounts(f)).toEqual({
      events: 1, receipts: 1, activations: 1, approvals: 0,
    });
  });

  it('replays the original result before checking the now-changed entity', async () => {
    const f = await fixture();
    const firstInput = invocation(f);
    const first = await apply(f, firstInput);
    await apply(f, invocation(f, {
      params: { asset_id: f.asset.id, stage: 'done' },
      expected: { stage_event_id: first.event_id },
    }));
    const replay = await apply(f, firstInput);
    expect(replay).toMatchObject({
      created: false,
      replayed: true,
      receipt_id: first.receipt_id,
      event_id: first.event_id,
      entity: first.entity,
    });
    expect((await assetState(f)).metadata.stage).toBe('done');
    expect(await durableCounts(f)).toEqual({
      events: 2, receipts: 2, activations: 2, approvals: 0,
    });
  });

  it('canonicalizes property order while binding the full submitted request', async () => {
    const f = await fixture();
    const input = invocation(f, {
      params: { asset_id: f.asset.id, stage: 'doing', private_note: 'Synthetic private request' },
      expected: { stage: 'todo', stage_event_id: null },
    });
    const first = await apply(f, input);
    const replay = await apply(f, {
      ...input,
      params: { private_note: 'Synthetic private request', stage: 'doing', asset_id: f.asset.id },
      expected: { stage_event_id: null, stage: 'todo' },
    });
    expect(replay.event_id).toBe(first.event_id);
    expect(replay.replayed).toBe(true);
    for (const changed of [
      { ...input, params: { ...input.params, stage: 'done' } },
      { ...input, params: { ...input.params, private_note: 'Different request' } },
      { ...input, expected: { stage: 'todo', stage_event_id: first.event_id } },
    ]) {
      await expect(apply(f, changed)).rejects.toMatchObject({ httpStatus: 409, code: 'IDEMPOTENCY_CONFLICT' });
    }
    expect((await durableCounts(f)).events).toBe(1);
  });

  it('does not let another authorized actor claim an existing interaction key', async () => {
    const f = await fixture();
    const input = invocation(f);
    await apply(f, input);
    const other = await createTestUser();
    await addUserToOrganization(other.id, f.org.id, 'owner');
    await expect(apply(f, input, { ...f.ctx, userId: other.id }))
      .rejects.toMatchObject({ httpStatus: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect((await durableCounts(f)).events).toBe(1);
  });

  it('binds the idempotency key to the action identity and immutable revision', async () => {
    const f = await fixture();
    const input = invocation(f);
    await apply(f, input);
    await manageActions({
      action: 'publish', key: ACTION_KEY, definition: {
        ...f.definition,
        set: { ...f.definition.set, revision: { literal: 'v2' } },
      },
    }, ENV, f.ctx);
    await manageActions({
      action: 'publish', key: 'synthetic-action-asset.alternate', definition: f.definition,
    }, ENV, f.ctx);
    await expect(apply(f, { ...input, version: 2 })).rejects.toMatchObject({ httpStatus: 409, code: 'IDEMPOTENCY_CONFLICT' });
    await expect(apply(f, { ...input, key: 'synthetic-action-asset.alternate' }))
      .rejects.toMatchObject({ httpStatus: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect((await durableCounts(f)).events).toBe(1);
  });

  it('permits only one of two different interactions based on the same entity state', async () => {
    const f = await fixture();
    const attempts = await Promise.allSettled([
      apply(f, invocation(f)),
      apply(f, invocation(f, { params: { asset_id: f.asset.id, stage: 'done' } })),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({ httpStatus: 409, code: 'PRECONDITION_FAILED' });
    expect(await durableCounts(f)).toEqual({
      events: 1, receipts: 1, activations: 1, approvals: 0,
    });
  });

  it('rejects an ABA edit even when the visible stage has changed back', async () => {
    const f = await fixture();
    const stale = invocation(f, { expected: { stage: 'todo', stage_event_id: null } });
    const first = await apply(f);
    const second = await apply(f, invocation(f, {
      params: { asset_id: f.asset.id, stage: 'todo' },
      expected: { stage_event_id: first.event_id },
    }));
    expect((await assetState(f)).metadata).toMatchObject({
      stage: 'todo', stage_event_id: second.event_id,
    });
    await expect(apply(f, stale)).rejects.toMatchObject({
      httpStatus: 409, code: 'PRECONDITION_FAILED',
      details: { mismatched_fields: ['stage_event_id'] },
    });
    expect((await durableCounts(f)).events).toBe(2);
  });

  it.each(['absent', 'null'] as const)('matches a null expected marker when the saved marker is %s', async (initial) => {
    const f = await fixture();
    if (initial === 'null') {
      await getTestDb().unsafe(
        "UPDATE entities SET metadata = metadata || '{\"stage_event_id\":null}'::jsonb WHERE id = $1",
        [f.asset.id],
      );
    }
    const result = await apply(f);
    expect((await assetState(f)).metadata.stage_event_id).toBe(result.event_id);
  });

  it('requires the precondition marker even if the caller supplies other expected fields', async () => {
    const f = await fixture();
    const before = await assetState(f);
    await expect(apply(f, invocation(f, { expected: { stage: 'todo' } }))).rejects.toThrow();
    await expect(apply(f, invocation(f, { expected: undefined }))).rejects.toThrow();
    await expectNoActionWrites(f, before);
  });

  it.each(['enqueue', 'entity'] as const)('rolls back every durable component when the %s write fails', async (point) => {
    const f = await fixture();
    const before = await assetState(f);
    const input = invocation(f);
    await injectDatabaseFailure(point);
    await expect(apply(f, input)).rejects.toMatchObject({ code: 'P0001' });
    await expectNoActionWrites(f, before);
    await dropFailureTrigger();
    const retried = await apply(f, input);
    expect(retried.created).toBe(true);
    expect(await durableCounts(f)).toEqual({
      events: 1, receipts: 1, activations: 1, approvals: 0,
    });
  });

  it('dry-runs the actual validation path without consuming the interaction or persisting generated values', async () => {
    const f = await fixture();
    const input = invocation(f);
    const before = await assetState(f);
    const originalInput = structuredClone(input);
    const preview = await applyAction({ ...input, dry_run: true }, ENV, f.ctx);
    expect(preview).toMatchObject({
      dry_run: true, valid: true, action: { key: ACTION_KEY, version: 1 }, target_id: f.asset.id,
    });
    if (preview.dry_run !== true) throw new Error('Expected a dry-run preview');
    expect(preview).not.toHaveProperty('event_id');
    expect(preview).not.toHaveProperty('receipt_id');
    expect(input).toEqual(originalInput);
    await expectNoActionWrites(f, before);
    const validated = await manageActions({
      action: 'validate', key: input.key, version: input.version,
      params: input.params, expected: input.expected,
    }, ENV, f.ctx);
    expect(validated).toMatchObject({ dry_run: true, valid: true, target_id: f.asset.id });
    await expectNoActionWrites(f, before);
    const committed = await apply(f, input);
    expect(committed.created).toBe(true);
    expect(preview.changed_fields.slice().sort()).toEqual(Object.keys(committed.entity.metadata).sort());
  });

  it('rejects invalid params without coercing caller input and refuses invalid transitions', async () => {
    const f = await fixture();
    const before = await assetState(f);
    const input = invocation(f, { params: { asset_id: String(f.asset.id), stage: 'doing' } });
    const original = structuredClone(input);
    await expect(applyAction(input, ENV, f.ctx)).rejects.toThrow();
    expect(input).toEqual(original);
    await expect(apply(f, invocation(f, {
      params: { asset_id: f.asset.id, stage: 'todo' },
    }))).rejects.toThrow();
    await expect(apply(f, invocation(f, {
      params: { asset_id: f.asset.id, stage: 'doing', stage_event_id: 123 },
    }))).rejects.toThrow();
    await expectNoActionWrites(f, before);
  });

  it.each(['ownership', 'policy'] as const)('rejects the whole command when only stage needs approval through %s', async (gate) => {
    const f = await fixture();
    const agent = await createTestAgent({ organizationId: f.org.id, ownerUserId: f.user.id });
    if (gate === 'ownership') {
      await getTestDb().unsafe(
        'UPDATE entities SET field_controls = $1::jsonb WHERE id = $2',
        [getTestDb().json({ stage: { set_by: f.user.id, set_at: new Date().toISOString(), note: 'Human decision' } }), f.asset.id],
      );
    } else {
      await upsertEntityApprovalPolicy(f.org.id, {
        principalKind: 'agent', principalId: agent.agentId,
        entityTypeSlug: ENTITY_TYPE, fieldPath: 'stage', updateMode: 'approval',
      });
    }
    const before = await assetState(f);
    await expect(apply(f, invocation(f), { ...f.ctx, agentId: agent.agentId }))
      .rejects.toMatchObject({ httpStatus: 409, code: 'APPROVAL_REQUIRED' });
    await expectNoActionWrites(f, before);
  });

  it.each(['deny', 'escalate'] as const)('keeps declared entity write-rule %s checks inside the strict action', async (verdict) => {
    const f = await fixture();
    const compiled = await compileEntityRule(
      verdict === 'deny'
        ? "export default ({ changed, deny }) => { if (changed('stage')) deny('Synthetic stage rule'); };"
        : "export default ({ changed, escalate }) => { if (changed('stage')) escalate(['stage'], 'Synthetic stage rule'); };",
    );
    await getTestDb().unsafe(
      'UPDATE entity_types SET rules_compiled = $1 WHERE organization_id = $2 AND slug = $3',
      [compiled, f.org.id, ENTITY_TYPE],
    );
    const before = await assetState(f);
    const failure = verdict === 'deny'
      ? { name: 'EntityRowValidationError', verdict: { outcome: 'deny', reason: 'Synthetic stage rule' } }
      : { httpStatus: 409, code: 'APPROVAL_REQUIRED' };
    await expect(apply(f)).rejects.toMatchObject(failure);
    await expectNoActionWrites(f, before);
    const [beforeDryRun] = await getTestDb().unsafe(
      'SELECT count(*)::int AS count FROM events WHERE organization_id = $1',
      [f.org.id],
    );
    await expect(applyAction(invocation(f, { dry_run: true }), ENV, f.ctx)).rejects.toMatchObject(failure);
    const [afterDryRun] = await getTestDb().unsafe(
      'SELECT count(*)::int AS count FROM events WHERE organization_id = $1',
      [f.org.id],
    );
    expect(afterDryRun.count).toBe(beforeDryRun.count);
    await expectNoActionWrites(f, before);
  });

  it('preserves target scope, target type, and ordinary member write restrictions', async () => {
    const f = await fixture();
    const other = await fixture({ subscribe: false });
    const before = await assetState(f);
    await expect(apply(f, invocation(f, {
      params: { asset_id: other.asset.id, stage: 'doing' },
    }))).rejects.toThrow();
    const wrongType = await createTestEntity({
      organization_id: f.org.id, created_by: f.user.id,
      entity_type: 'synthetic-other-record', name: 'Wrong type',
    });
    await expect(apply(f, invocation(f, {
      params: { asset_id: wrongType.id, stage: 'doing' },
    }))).rejects.toThrow();
    const member = await createTestUser();
    await addUserToOrganization(member.id, f.org.id, 'member');
    const memberCtx = { ...f.ctx, userId: member.id, memberRole: 'member' };
    await expect(apply(f, invocation(f), memberCtx)).rejects.toThrow();
    await expect(manageActions({
      action: 'publish', key: 'synthetic-unauthorized-action', definition: f.definition,
    }, ENV, memberCtx)).rejects.toThrow();
    await expect(apply(f, invocation(f), {
      ...f.ctx, tokenType: 'oauth', scopes: ['mcp:read'],
    })).rejects.toThrow();
    await expectNoActionWrites(f, before);
    expect((await assetState(other)).metadata.stage).toBe('todo');
  });

  it('refuses missing or trashed targets without an accepted event or receipt', async () => {
    const f = await fixture();
    await expect(apply(f, invocation(f, {
      params: { asset_id: 2147483647, stage: 'doing' },
    }))).rejects.toThrow();
    await getTestDb().unsafe('UPDATE entities SET deleted_at = now() WHERE id = $1', [f.asset.id]);
    await expect(apply(f)).rejects.toThrow();
    expect(await durableCounts(f)).toEqual({
      events: 0, receipts: 0, activations: 0, approvals: 0,
    });
  });

  it('validates registered kinds and rejects reserved targets when publishing', async () => {
    const f = await fixture();
    for (const definition of [
      { ...f.definition, target: { entityType: '$member', idParam: 'asset_id' } },
      { ...f.definition, emits: { ...f.definition.emits, kind: 'synthetic-unregistered.changed' } },
      { ...f.definition, emits: { ...f.definition.emits, schemaVersion: 2 } },
    ]) {
      await expect(manageActions({
        action: 'publish', key: 'synthetic-invalid-action', definition,
      }, ENV, f.ctx)).rejects.toThrow();
    }
    const versions = await getTestDb().unsafe(
      'SELECT av.version FROM action_versions av JOIN action_types a ON a.id = av.action_type_id WHERE a.organization_id = $1',
      [f.org.id],
    );
    expect(versions).toHaveLength(1);
  });

  it.each(['removed', 'incompatible'] as const)('checks the current event registry when the published kind becomes %s', async (change) => {
    const f = await fixture();
    const before = await assetState(f);
    const kinds = change === 'removed' ? {} : {
      [EVENT_KIND]: {
        metadataSchema: {
          type: 'object',
          properties: { required_new_field: { type: 'string' } },
          required: ['required_new_field'],
          additionalProperties: false,
        },
      },
    };
    await getTestDb().unsafe(
      'UPDATE entity_types SET event_kinds = $1::jsonb WHERE organization_id = $2 AND slug IN ($3, $4)',
      [getTestDb().json(kinds), f.org.id, ENTITY_TYPE, '$member'],
    );
    await expect(apply(f)).rejects.toThrow();
    await expectNoActionWrites(f, before);
  });

  it('keeps prior versions invokable and refuses new invocations after disablement', async () => {
    const f = await fixture();
    const v2: ActionDefinition = {
      ...f.definition,
      set: { ...f.definition.set, revision: { literal: 'v2' } },
    };
    await manageActions({ action: 'publish', key: ACTION_KEY, definition: v2 }, ENV, f.ctx);
    expect(await manageActions({ action: 'get', key: ACTION_KEY, version: 1 }, ENV, f.ctx))
      .toMatchObject({ version: { version: 1, definition: f.definition } });
    const input = invocation(f);
    const first = await apply(f, input);
    expect(first.entity.metadata).not.toHaveProperty('revision');
    const second = await apply(f, invocation(f, {
      version: 2,
      params: { asset_id: f.asset.id, stage: 'done' },
      expected: { stage_event_id: first.event_id },
    }));
    expect(second.entity.metadata.revision).toBe('v2');
    await manageActions({ action: 'set_enabled', key: ACTION_KEY, enabled: false }, ENV, f.ctx);
    await expect(apply(f, invocation(f, {
      params: { asset_id: f.asset.id, stage: 'todo' },
      expected: { stage_event_id: second.event_id },
    }))).rejects.toThrow();
    expect((await apply(f, input)).event_id).toBe(first.event_id);
    expect((await durableCounts(f)).events).toBe(2);
  });

  it('keeps a published view on its pinned revision and replays a receipt after the view changes', async () => {
    const f = await fixture();
    await storeView(f, 1);
    await manageActions({
      action: 'publish', key: ACTION_KEY,
      definition: { ...f.definition, set: { ...f.definition.set, revision: { literal: 'v2' } } },
    }, ENV, f.ctx);
    const input = viewInvocation(f);
    const first = await invokeViewAction(input);
    expect(first).toMatchObject({ created: true, eventType: EVENT_KIND });
    expect((await assetState(f)).metadata).not.toHaveProperty('revision');
    await storeView(f, 2);
    await expect(invokeViewAction(viewInvocation(f, {
      expected: { stage_event_id: first.eventId },
      value: { asset_id: f.asset.id, stage: 'done' },
    }))).rejects.toMatchObject({ httpStatus: 409 });
    expect(await invokeViewAction(input)).toEqual({ ...first, created: false });
    await getTestDb().unsafe(
      'DELETE FROM views WHERE organization_id = $1 AND key = $2',
      [f.org.id, VIEW_KEY],
    );
    expect(await invokeViewAction(input)).toEqual({ ...first, created: false });
    expect((await durableCounts(f)).events).toBe(1);
  });

  it('does not expose typed receipt inputs through the generic operations surface', async () => {
    const f = await fixture();
    const result = await apply(f, invocation(f, {
      params: { asset_id: f.asset.id, stage: 'doing', private_note: 'Synthetic protected action request' },
    }));
    const member = await createTestUser();
    await addUserToOrganization(member.id, f.org.id, 'member');
    const memberApi = await TestApiClient.for({
      organizationId: f.org.id, userId: member.id, memberRole: 'member',
    });
    for (const api of [f.api, memberApi]) {
      await expect(api.operations.getRun(Number(result.receipt_id))).rejects.toThrow();
      const listed = await api.operations.listRuns() as { runs: Array<{ id: number }> };
      expect(listed.runs.some((run) => Number(run.id) === Number(result.receipt_id))).toBe(false);
      expect(JSON.stringify(listed)).not.toContain('Synthetic protected action request');
    }
  });

  it('retains replay receipts when housekeeping deletes ordinary completed runs after 30 days', async () => {
    const f = await fixture();
    const input = invocation(f);
    const result = await apply(f, input);
    const sql = getTestDb();
    await sql.unsafe(
      "UPDATE runs SET completed_at = now() - interval '40 days' WHERE id = $1",
      [result.receipt_id],
    );
    const [expired] = await sql.unsafe(
      "INSERT INTO runs (run_type, queue_name, action_key, status, approval_status, organization_id, completed_at) VALUES ('task', 'task', 'synthetic-retention-control', 'completed', 'auto', $1, now() - interval '40 days') RETURNING id",
      [f.org.id],
    );
    await checkStalledExecutions(ENV);
    expect(await sql.unsafe('SELECT id FROM runs WHERE id = $1', [expired.id])).toHaveLength(0);
    expect(await sql.unsafe('SELECT id FROM runs WHERE id = $1', [result.receipt_id])).toHaveLength(1);
    expect((await apply(f, input)).event_id).toBe(result.event_id);
    expect((await durableCounts(f)).events).toBe(1);
  });
});
