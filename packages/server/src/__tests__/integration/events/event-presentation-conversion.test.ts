import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyEventPresentation,
  previewEventPresentation,
  snapshotTemplate,
} from '../../../../scripts/convert-event-presentation';
import { createAutomationRun } from '../../../runs/queue-service';
import { encodeExternalAutomationClaimOwner } from '../../../tools/admin/manage_automations/claim-next-window';
import { getDb } from '../../../db/client';
import { insertEvent } from '../../../utils/insert-event';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestConnection, createTestEntity, createTestOrganization, createTestUser } from '../../setup/test-fixtures';

import { TestWorkspace } from '../../setup/test-mcp-client';

const template = {
  root: {
    type: 'card',
    children: [
      { type: 'card-title', children: [{ type: 'text', content: 'Report' }] },
      { type: 'table', props: { data: '{{rows}}', columns: ['label', 'value'] } },
      { type: 'data', path: 'enabled' },
    ],
  },
};

describe('historical event presentation conversion', () => {
  beforeEach(async () => { await cleanupTestDatabase(); });

  it('snapshots tables, charts, conditions and loops through the shared walker', () => {
    const body = snapshotTemplate({
      root: { type: 'card', children: [
        template.root,
        { type: 'if', condition: 'enabled', then: { type: 'text', content: 'hidden' },
          else: { type: 'text', content: 'Disabled' } },
        { type: 'bar-chart', props: { data: '{{rows}}', xLabel: 'Name', yLabel: 'Count' } },
        { type: 'each', items: 'rows', as: 'row', render: { type: 'data', path: 'row.label' } },
      ] },
    }, { rows: [{ label: 'Zero | value', value: 0 }], enabled: false });
    expect(body).toContain('Report');
    expect(body).toContain('| Zero \\| value | 0 |');
    expect(body).toContain('| Name | Count |');
    expect(body).toContain('No');
    expect(body).toContain('Disabled');
    expect(body).not.toContain('hidden');
  });

  it.each([
    { root: { type: 'unknown-widget' } },
    { root: { type: 'text', props: { value: 'must not disappear' } } },
    { root: { type: 'button', props: { onClick: '@vote', value: 'yes' } } },
    { root: { type: 'if', condition: 'missing', then: { type: 'button' } } },
    { root: { type: 'each', items: 'rows', as: 'r',
      render: { type: 'each', items: 'rows', as: 'r2', render: 'nested' } } },
  ])('refuses unsupported, malformed and interactive templates %#', (value) => {
    expect(() => snapshotTemplate(value, {})).toThrow();
  });

  it('bounds input and output work', () => {
    expect(() => snapshotTemplate({ root: { type: 'text', content: 'a'.repeat(300_000) } }, {})).toThrow();
    expect(() => snapshotTemplate({ root: { type: 'each', items: 'rows', as: 'r',
      render: 'a'.repeat(5000) } }, { rows: Array(100).fill('x') })).toThrow();
  });

  it('preserves literal text, bound values and table cells as literal Markdown', () => {
    const literal = '<customer> &copy; *required* [label](url) `code` ~~removed~~ \\path';
    const escaped = '\\<customer\\> &amp;copy; \\*required\\* \\[label\\]\\(url\\) \\`code\\` \\~\\~removed\\~\\~ \\\\path';
    const body = snapshotTemplate({ root: { type: 'card', children: [
      { type: 'text', content: literal },
      { type: 'data', path: 'literal' },
      { type: 'metric', props: { label: literal, value: literal } },
      { type: 'table', props: { data: '{{rows}}', columns: ['value'] } },
      { type: 'markdown', props: { content: '**Authored Markdown**' } },
    ] } }, { literal, rows: [{ value: literal }] });
    expect(body.split(escaped)).toHaveLength(6);
    expect(body).toContain('**Authored Markdown**');
  });

  async function fixture() {
    const org = await createTestOrganization();
    const entity = await createTestEntity({ name: 'Synthetic report owner', entity_type: 'synthetic-report-owner', organization_id: org.id });
    const row = await insertEvent({
      entityIds: [entity.id], organizationId: org.id, originId: 'synthetic-report',
      title: 'Synthetic report', payloadType: 'json_template', payloadTemplate: template,
      content: 'Original introduction', payloadData: { rows: [{ label: 'Count', value: 0 }], enabled: false },
      metadata: { custom: { preserved: true }, _lobu_idempotency_key: 'synthetic-conversion-key' },
      attachments: [{ type: 'link', url: 'https://example.com/report' }],
      authorName: 'Synthetic author', sourceUrl: 'https://example.com/source',
      occurredAt: '2025-01-02T03:04:05.000Z', semanticType: 'synthetic_report',
    });
    return { org, entity, id: Number(row.id) };
  }

  async function stored(id: number) {
    const [row] = await getDb()`SELECT to_jsonb(e) AS event FROM events e WHERE id = ${id}`;
    return row.event;
  }

  it('previews without writes and appends a preserved version without business side effects', async () => {
    const { org, id } = await fixture();
    const before = await stored(id);
    const manifest = await previewEventPresentation(getDb(), org.id, [id]);
    expect(manifest.entries[0].status).toBe('ready');
    expect(manifest.entries[0].markdown).toContain('Original introduction');
    expect(await stored(id)).toEqual(before);
    const [{ events: eventCount, runs: runCount, targets: targetCount }] = await getDb()`
      SELECT (SELECT count(*) FROM events) AS events,
        (SELECT count(*) FROM runs) AS runs, (SELECT count(*) FROM notification_targets) AS targets
    `;
    const [result] = await applyEventPresentation(getDb(), manifest);
    expect(result.status).toBe('converted');
    const after = await stored(result.eventId);
    expect(await stored(id)).toEqual({ ...before, superseded_by: result.eventId });
    for (const field of ['organization_id', 'entity_ids', 'origin_id', 'title', 'payload_data',
      'attachments', 'author_name', 'source_url', 'occurred_at', 'semantic_type', 'created_by',
      'client_id', 'connector_key', 'connection_id', 'feed_id', 'run_id',
      'automation_id', 'automation_version_id', 'identity_ns', 'identity_key']) {
      expect(after[field], field).toEqual(before[field]);
    }
    expect(after.metadata.custom).toEqual(before.metadata.custom);
    expect(after.metadata._lobu_idempotency_key).toBeUndefined();
    expect(after.payload_type).toBe('markdown');
    expect(after.payload_template).toBeNull();
    expect(after.supersedes_event_id).toBe(id);
    const [counts] = await getDb()`
      SELECT (SELECT count(*) FROM events) AS events,
        (SELECT count(*) FROM runs) AS runs, (SELECT count(*) FROM notification_targets) AS targets
    `;
    expect(Number(counts.events)).toBe(Number(eventCount) + 1);
    expect(counts.runs).toBe(runCount);
    expect(counts.targets).toBe(targetCount);
    expect(await applyEventPresentation(getDb(), manifest)).toEqual([
      { sourceEventId: id, eventId: result.eventId, status: 'already_converted' },
    ]);
  });

  it('serializes concurrent applications into one successor', async () => {
    const { org, id } = await fixture();
    const manifest = await previewEventPresentation(getDb(), org.id, [id]);
    const results = await Promise.all([
      applyEventPresentation(getDb(), manifest), applyEventPresentation(getDb(), manifest),
    ]);
    expect(results.map(([r]) => r.status).sort()).toEqual(['already_converted', 'converted']);
    expect(results[0][0].eventId).toBe(results[1][0].eventId);
  });

  it('rejects changed sources and tampered previews atomically', async () => {
    const { org, id } = await fixture();
    const manifest = await previewEventPresentation(getDb(), org.id, [id]);
    const edited = structuredClone(manifest);
    edited.entries[0].markdown = 'Changed after review';
    await expect(applyEventPresentation(getDb(), edited)).rejects.toThrow(/changed|match/i);
    await getDb()`UPDATE events SET metadata = '{"changed":true}'::jsonb WHERE id = ${id}`;
    await expect(applyEventPresentation(getDb(), manifest)).rejects.toThrow(/changed|match/i);
    expect((await stored(id)).superseded_by).toBeNull();
  });

  it('rejects a stale head and foreign-tenant or duplicate inputs', async () => {
    const { org, id } = await fixture();
    const manifest = await previewEventPresentation(getDb(), org.id, [id]);
    const other = await createTestOrganization();
    await expect(previewEventPresentation(getDb(), other.id, [id])).rejects.toThrow(/not found/i);
    await expect(previewEventPresentation(getDb(), org.id, [id, id])).rejects.toThrow(/unique/i);
    await insertEvent({ entityIds: [], organizationId: org.id, originId: 'synthetic-report',
      semanticType: 'synthetic_report', content: 'Human correction', supersedesEventId: id });
    await expect(applyEventPresentation(getDb(), manifest)).rejects.toThrow(/superseded/i);
    expect((await previewEventPresentation(getDb(), org.id, [id])).entries[0].status).toBe('historical');
  });

  it('uses fresh kind definitions and rejects a changed kind after preview', async () => {
    const { org, entity, id } = await fixture();
    const sql = getDb();
    await sql`UPDATE events SET payload_template = NULL, payload_type = 'empty' WHERE id = ${id}`;
    const kind = { synthetic_report: { jsonTemplate: template.root } };
    await sql`UPDATE entity_types SET event_kinds = ${sql.json(kind)}
      WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${entity.id})`;
    const manifest = await previewEventPresentation(sql, org.id, [id]);
    expect(manifest.entries[0].markdown).toContain('Count');
    await sql`UPDATE entity_types SET event_kinds = ${sql.json({
      synthetic_report: { jsonTemplate: { type: 'text', content: 'New presentation' } },
    })} WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${entity.id})`;
    await expect(applyEventPresentation(sql, manifest)).rejects.toThrow(/changed|match/i);
  });

  it.each(['text', 'markdown'])('leaves %s content without a stored template unchanged', async (payloadType) => {
    const { org, entity, id } = await fixture();
    const sql = getDb();
    await sql`UPDATE events SET payload_template = NULL, payload_type = ${payloadType} WHERE id = ${id}`;
    await sql`UPDATE entity_types SET event_kinds = ${sql.json({
      synthetic_report: { jsonTemplate: template.root },
    })} WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${entity.id})`;
    const before = await stored(id);
    const manifest = await previewEventPresentation(sql, org.id, [id]);
    expect(manifest.entries[0].status).toBe('unchanged');
    expect(await applyEventPresentation(sql, manifest)).toEqual([]);
    expect(await stored(id)).toEqual(before);
  });

  it('rolls back when ingestion changes the reviewed markdown', async () => {
    const { org, id } = await fixture();
    const sql = getDb();
    // Model a historical row predating browser ingestion containment.
    await sql`UPDATE events SET connector_key = 'chrome',
      payload_text = 'https://example.com/callback?code=synthetic-value' WHERE id = ${id}`;
    const before = await stored(id);
    const manifest = await previewEventPresentation(sql, org.id, [id]);
    expect(manifest.entries[0].status).toBe('ready');
    await expect(applyEventPresentation(sql, manifest)).rejects.toThrow(/presentation/i);
    expect(await stored(id)).toEqual(before);
    const [successors] = await sql`SELECT count(*) AS count FROM events WHERE supersedes_event_id = ${id}`;
    expect(Number(successors.count)).toBe(0);
  });

  it('keeps native controls and declared custom interactions out of the converter', async () => {
    const { org, entity, id } = await fixture();
    const sql = getDb();
    await sql`UPDATE events SET interaction_type = 'approval', interaction_status = 'pending' WHERE id = ${id}`;
    expect((await previewEventPresentation(sql, org.id, [id])).entries[0]).toMatchObject({
      status: 'blocked', reason: expect.stringMatching(/interaction/i),
    });
    await sql`UPDATE events SET interaction_type = 'none', interaction_status = NULL WHERE id = ${id}`;
    await sql`UPDATE entity_types SET event_kinds = ${sql.json({
      synthetic_report: { interactions: { choose: { emits: 'synthetic_choice' } } },
    })} WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${entity.id})`;
    const blocked = await previewEventPresentation(sql, org.id, [id]);
    expect(blocked.entries[0].status).toBe('blocked');
    await expect(applyEventPresentation(sql, blocked)).rejects.toThrow(/blocked/i);
  });

  it('keeps structured data readable when no authored template exists', async () => {
    const { org, id } = await fixture();
    await getDb()`UPDATE events SET payload_template = NULL WHERE id = ${id}`;
    const manifest = await previewEventPresentation(getDb(), org.id, [id]);
    expect(manifest.entries[0].markdown).toContain('"enabled": false');
    expect(manifest.entries[0].markdown).toContain('"value": 0');
  });
  it('keeps old event links readable through the real knowledge API', async () => {
    const workspace = await TestWorkspace.create({ name: 'Conversion read fixture' });
    const row = await insertEvent({
      entityIds: [], organizationId: workspace.org.id, originId: 'synthetic-linked-report',
      title: 'Linked report', payloadType: 'json_template', payloadTemplate: template,
      payloadData: { rows: [{ label: 'Preserved', value: 42 }] }, semanticType: 'synthetic_report',
      occurredAt: '2025-01-02T03:04:05.000Z', createdBy: workspace.users.owner.id,
    });
    const manifest = await previewEventPresentation(getDb(), workspace.org.id, [Number(row.id)]);
    const [result] = await applyEventPresentation(getDb(), manifest);
    const read = await workspace.owner.knowledge.read({ content_ids: [Number(row.id)] });
    expect(read.content.some((event) => Number(event.id) === result.eventId &&
      event.payload_type === 'markdown' && event.payload_text?.includes('Preserved'))).toBe(true);
    const other = await TestWorkspace.create({ name: 'Conversion foreign workspace' });
    expect((await other.owner.knowledge.read({ content_ids: [Number(row.id)] })).content).toEqual([]);
  });

  it('blocks delivery receipts introduced after preview', async () => {
    const { org, id } = await fixture();
    const user = await createTestUser();
    const manifest = await previewEventPresentation(getDb(), org.id, [id]);
    await getDb()`INSERT INTO notification_targets (event_id, user_id) VALUES (${id}, ${user.id})`;
    await expect(applyEventPresentation(getDb(), manifest)).rejects.toThrow(/changed|match/i);
    expect((await previewEventPresentation(getDb(), org.id, [id])).entries[0]).toMatchObject({
      status: 'blocked', reason: expect.stringMatching(/delivery manifest/),
    });
    expect((await stored(id)).superseded_by).toBeNull();
  });

  it('rolls back an entire batch when a later preview is stale', async () => {
    const { org, id } = await fixture();
    const later = await insertEvent({
      entityIds: [], organizationId: org.id, originId: 'synthetic-later-report',
      payloadType: 'json_template', payloadTemplate: { root: { type: 'text', content: 'Later' } },
      semanticType: 'synthetic_report',
    });
    const manifest = await previewEventPresentation(getDb(), org.id, [id, Number(later.id)]);
    await getDb()`UPDATE events SET title = 'Changed' WHERE id = ${later.id}`;
    await expect(applyEventPresentation(getDb(), manifest)).rejects.toThrow(/changed|match/i);
    expect((await stored(id)).superseded_by).toBeNull();
    expect((await stored(Number(later.id))).superseded_by).toBeNull();
  });

  it('preserves connector, feed, producer and stable identity on a converted version', async () => {
    const { org, id } = await fixture();
    const sql = getDb();
    const user = await createTestUser();
    const connection = await createTestConnection({ organization_id: org.id, connector_key: 'synthetic-source' });
    const [feed] = await sql`INSERT INTO feeds (organization_id, connection_id, feed_key, status)
      VALUES (${org.id}, ${connection.id}, 'synthetic-feed', 'active') RETURNING id`;
    const [automation] = await sql`INSERT INTO automations
      (organization_id, created_by, automation_group_id, name, slug, managed_agent_id)
      VALUES (${org.id}, ${user.id}, 0, 'Synthetic producer', 'synthetic-producer', 'synthetic-agent') RETURNING id`;
    await sql`UPDATE automations SET automation_group_id = ${automation.id} WHERE id = ${automation.id}`;
    const [version] = await sql`INSERT INTO automation_versions (automation_id, version, name, created_by, prompt)
      VALUES (${automation.id}, 1, 'Synthetic producer', ${user.id}, 'Synthetic prompt') RETURNING id`;
    const [run] = await sql`INSERT INTO runs (organization_id, run_type, status, approval_status, action_key)
      VALUES (${org.id}, 'action', 'pending', 'pending', 'synthetic-operation') RETURNING id`;
    await sql`UPDATE events SET connection_id = ${connection.id}, connector_key = 'synthetic-source',
      feed_id = ${feed.id}, feed_key = 'synthetic-feed', run_id = ${run.id},
      automation_id = ${automation.id}, automation_version_id = ${version.id},
      identity_ns = 'synthetic-identity', identity_key = 'stable-report',
      origin_parent_id = 'synthetic-parent' WHERE id = ${id}`;
    const before = await stored(id);
    const [result] = await applyEventPresentation(sql, await previewEventPresentation(sql, org.id, [id]));
    const after = await stored(result.eventId);
    for (const key of ['connection_id', 'connector_key', 'feed_id', 'feed_key', 'run_id',
      'automation_id', 'automation_version_id', 'identity_ns', 'identity_key', 'origin_parent_id']) {
      expect(after[key], key).toEqual(before[key]);
    }
  });

  it('blocks historical chat receipts even when the current version has none', async () => {
    const { org, id } = await fixture();
    const sql = getDb();
    await sql`UPDATE events SET metadata = metadata || ${sql.json({
      delivery: [{ connectionId: 'synthetic-chat', threadId: 'synthetic-thread', messageId: 'synthetic-message' }],
      card: { type: 'card', children: [] },
    })}::jsonb WHERE id = ${id}`;
    const successor = await insertEvent({
      entityIds: [], organizationId: org.id, originId: 'synthetic-report',
      payloadType: 'json_template', payloadTemplate: { root: { type: 'text', content: 'Closed' } },
      semanticType: 'synthetic_report', supersedesEventId: id,
    });
    const manifest = await previewEventPresentation(sql, org.id, [Number(successor.id)]);
    expect(manifest.entries[0]).toMatchObject({
      status: 'blocked', reason: expect.stringMatching(/delivery manifest/),
    });
    await expect(applyEventPresentation(sql, manifest)).rejects.toThrow(/blocked/);
  });

  it('does not introduce a historical presentation into a later Automation arrival window', async () => {
    const workspace = await TestWorkspace.create({ name: 'Presentation arrival window' });
    const sql = getDb();
    const source = await insertEvent({
      entityIds: [], organizationId: workspace.org.id, originId: 'synthetic-old-arrival',
      payloadType: 'json_template', payloadTemplate: { root: { type: 'text', content: 'Old report' } },
      semanticType: 'synthetic_report', occurredAt: '2025-01-02T03:04:05.000Z',
    });
    await sql`UPDATE events SET created_at = '2025-01-02T03:04:05.123456Z', occurred_at = '2025-01-02T03:04:05.123456Z' WHERE id = ${source.id}`;
    const automation = await workspace.owner.automations.create({
      slug: 'synthetic-arrival-reader', name: 'Synthetic arrival reader', prompt: 'Read new reports',
      managed_agent_id: null,
      sources: [{ name: 'reports', query: "SELECT id, payload_text, occurred_at FROM events WHERE semantic_type = 'synthetic_report'" }],
    });
    const windowStart = new Date(Date.now() - 60_000).toISOString();
    const windowEnd = new Date(Date.now() + 60_000).toISOString();
    const [conversion] = await applyEventPresentation(sql, await previewEventPresentation(sql, workspace.org.id, [Number(source.id)]));
    const fresh = await insertEvent({
      entityIds: [], organizationId: workspace.org.id, originId: 'synthetic-fresh-arrival',
      content: 'New business report', semanticType: 'synthetic_report',
    });
    const run = await createAutomationRun({ organizationId: workspace.org.id,
      automationId: Number(automation.automation_id), windowStart, windowEnd, dispatchSource: 'manual' });
    await sql`UPDATE runs SET status = 'running', claimed_at = NOW(),
      claimed_by = ${encodeExternalAutomationClaimOwner({ userId: workspace.users.owner.id })}
      WHERE id = ${run.runId}`;
    const read = await workspace.owner.knowledge.read({
      automation_id: Number(automation.automation_id), run_id: run.runId,
    });
    expect(read.content.map((event) => Number(event.id))).toContain(Number(fresh.id));
    expect(read.content.map((event) => Number(event.id))).not.toContain(conversion.eventId);
    expect((await stored(conversion.eventId)).created_at).toEqual((await stored(Number(source.id))).created_at);
    expect((await stored(conversion.eventId)).occurred_at).toEqual((await stored(Number(source.id))).occurred_at);
  });

  it('accepts nullable historical empty organization projections without widening access', async () => {
    const { org, id } = await fixture();
    await getDb()`UPDATE events SET linked_org_ids = NULL WHERE id = ${id}`;
    const [result] = await applyEventPresentation(getDb(), await previewEventPresentation(getDb(), org.id, [id]));
    expect((await stored(result.eventId)).linked_org_ids).toEqual([]);
    expect((await stored(id)).linked_org_ids).toBeNull();
  });

  it('runs CLI preview, apply and retry against the isolated test database', async () => {
    const { org, id } = await fixture();
    const directory = mkdtempSync(join(tmpdir(), 'event-conversion-cli-'));
    const manifestPath = join(directory, 'preview.json');
    const script = fileURLToPath(new URL('../../../../scripts/convert-event-presentation.ts', import.meta.url));
    const cli = (...args: string[]) => {
      const result = spawnSync('bun', [script, '--org', org.id, ...args], {
        env: process.env, encoding: 'utf8', timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    try {
      cli('--ids', String(id), '--out', manifestPath);
      expect(JSON.parse(readFileSync(manifestPath, 'utf8')).entries[0].status).toBe('ready');
      expect((await stored(id)).superseded_by).toBeNull();
      expect(cli('--apply', manifestPath)).toContain('"converted"');
      const successor = (await stored(id)).superseded_by;
      expect((await stored(successor)).payload_type).toBe('markdown');
      expect(cli('--apply', manifestPath)).toContain('"already_converted"');
      expect((await stored(id)).superseded_by).toBe(successor);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

});
