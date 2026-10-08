/**
 * Integration test: get_content render tail synthesizes a default render
 * template for metadata-only events from their event kind's metadataSchema.
 *
 * Mirrors the entity auto-default (resolve_path): an 'empty' event with
 * structured metadata but no authored payload_template renders its fields as a
 * schema-driven card instead of the generic metadata grid. Resolution rides the
 * cached event_kinds registry (entity_types.event_kinds), so this needs a real
 * DB-backed entity type with event_kinds — not a pure unit test.
 *
 * Runs against the pgvector DB via DATABASE_URL (CI integration job / local).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { buildContentItems } from '../../../tools/get_content/render';
import type { ContentRow } from '../../../tools/get_content/types';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const ROW_DEFAULTS = {
  platform: 'lobu',
  title: null,
  score: 0,
  classifications: null,
  created_at: new Date('2026-01-01T00:00:00Z').toISOString(),
} satisfies Partial<ContentRow>;

function row(over: Partial<ContentRow> & Pick<ContentRow, 'id' | 'semantic_type'>): ContentRow {
  return { ...ROW_DEFAULTS, entity_ids: [], metadata: null, ...over } as ContentRow;
}

describe('get_content render — event auto-default template', () => {
  let orgId: string;
  let dealEntityId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Event Render Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'event-render@example.com' });
    const sql = getTestDb();

    // A typed entity type whose event_kinds declares a kind WITH a metadataSchema
    // and another kind WITHOUT one.
    const [et] = await sql`
      INSERT INTO entity_types (organization_id, slug, name, event_kinds, created_at, updated_at)
      VALUES (
        ${orgId}, 'deal', 'Deal',
        ${sql.json({
          valuation: {
            description: 'A valuation snapshot',
            metadataSchema: {
              type: 'object',
              properties: {
                amount: { 'x-table-label': 'Amount', 'x-table-column': 1 },
                stage: { title: 'Stage', 'x-table-column': 2 },
              },
            },
          },
          decision: {
            description: 'An interactive decision',
            jsonTemplate: {
              type: 'button',
              props: { label: 'Choose A', onClick: '@choose', value: 'A' },
            },
            interactions: { choose: { emits: 'decision_cast' } },
          },
          decision_cast: { description: 'A verified decision' },
          note: { description: 'A free-form note' },
        })},
        NOW(), NOW()
      )
      RETURNING id
    `;
    const [entity] = await sql`
      INSERT INTO entities (organization_id, entity_type_id, slug, name, created_by, created_at, updated_at)
      VALUES (${orgId}, ${et.id}, 'acme-deal', 'Acme Deal', ${user.id}, NOW(), NOW())
      RETURNING id
    `;
    dealEntityId = Number(entity.id);
  });

  it('synthesizes a json_template for an empty metadata-only event of a schema-bearing kind', async () => {
    const [item] = await buildContentItems({
      sql: getTestDb(),
      organizationId: orgId,
      ownerSlug: null,
      baseUrl: undefined,
      excerptsMap: new Map(),
      rawContent: [
        row({
          id: 1,
          semantic_type: 'valuation',
          payload_type: 'empty',
          entity_ids: [dealEntityId],
          metadata: { amount: 50000, stage: 'negotiation' },
        }),
      ],
    });

    expect(item.payload_type).toBe('json_template');
    const tmpl = item.payload_template as { root?: { type?: string } } | null;
    expect(tmpl?.root?.type).toBe('card');
    const serialized = JSON.stringify(tmpl);
    expect(serialized).toContain('"path":"amount"');
    expect(serialized).toContain('"path":"stage"');
    // payload_data is the event metadata so the bindings resolve.
    expect(item.payload_data).toMatchObject({ amount: 50000, stage: 'negotiation' });
  });

  it('keeps structured event data separate from routing metadata', async () => {
    const data = { amount: 42, stage: 'review', approved: false };
    const [item] = await buildContentItems({
      sql: getTestDb(), organizationId: orgId, ownerSlug: null,
      baseUrl: undefined, includePrivateAttribution: false,
      rawContent: [row({
        id: 6, semantic_type: 'valuation', payload_type: 'empty',
        entity_ids: [dealEntityId], payload_data: data,
        metadata: { webhook_connection_id: 'synthetic-webhook' },
      })],
    });
    expect(item.payload_data).toEqual(data);
    expect(item.metadata).toEqual({ webhook_connection_id: 'synthetic-webhook' });
  });

  it('carries the resolved interaction registry with an authored event template', async () => {
    const [item] = await buildContentItems({
      sql: getTestDb(),
      organizationId: orgId,
      ownerSlug: null,
      baseUrl: undefined,
      excerptsMap: new Map(),
      rawContent: [
        row({
          id: 5,
          semantic_type: 'decision',
          payload_type: 'empty',
          entity_ids: [dealEntityId],
          metadata: { choice: null },
        }),
      ],
    });

    expect(item.payload_template).toMatchObject({
      root: { type: 'button' },
      interactions: { choose: { emits: 'decision_cast' } },
    });
  });

  it('leaves a kind without a metadataSchema as a plain empty event', async () => {
    const [item] = await buildContentItems({
      sql: getTestDb(),
      organizationId: orgId,
      ownerSlug: null,
      baseUrl: undefined,
      excerptsMap: new Map(),
      rawContent: [
        row({
          id: 2,
          semantic_type: 'note',
          payload_type: 'empty',
          entity_ids: [dealEntityId],
          metadata: { freeform: 'hello' },
        }),
      ],
    });
    expect(item.payload_type).toBe('empty');
    expect(item.payload_template).toBeNull();
  });

  it('does not touch an event that already has body content or a template', async () => {
    const [textItem, templated] = await buildContentItems({
      sql: getTestDb(),
      organizationId: orgId,
      ownerSlug: null,
      baseUrl: undefined,
      excerptsMap: new Map(),
      rawContent: [
        row({
          id: 3,
          semantic_type: 'valuation',
          payload_type: 'text',
          payload_text: 'a real body',
          entity_ids: [dealEntityId],
          metadata: { amount: 1 },
        }),
        row({
          id: 4,
          semantic_type: 'valuation',
          payload_type: 'empty',
          entity_ids: [dealEntityId],
          metadata: { amount: 1 },
          payload_template: { root: { type: 'markdown', content: 'authored' } },
        }),
      ],
    });
    expect(textItem.payload_type).toBe('text');
    expect(templated.payload_type).toBe('empty');
    expect((templated.payload_template as { root?: { content?: string } })?.root?.content).toBe(
      'authored'
    );
  });
});
