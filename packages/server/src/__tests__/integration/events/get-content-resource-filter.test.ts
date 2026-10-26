import { beforeAll, describe, expect, it } from 'vitest';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { addUserToOrganization, createTestOrganization, createTestUser, createTestConnection, createTestEntity, seedSystemEntityTypes } from '../../setup/test-fixtures';

describe('Events resource filters intersect every stored read', () => {
  let ctx: ToolContext;
  const ids: number[] = [];
  let entityId: number;
  let username: string;
  const filter = { semantic_type: 'change', event_category: 'config', resource_kind: 'automation', resource_id: 'synthetic-workflow' };
  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({ name: 'Resource filter test' });
    const user = await createTestUser({ email: 'resource-filter@example.test' });
    await addUserToOrganization(user.id, org.id, 'owner');
    username = user.username;
    ctx = { organizationId: org.id, userId: user.id, memberRole: 'owner', isAuthenticated: true, tokenType: 'oauth', scopedToOrg: false, allowCrossOrg: true, scopes: ['mcp:read'] } as ToolContext;
    entityId = (await createTestEntity({ name: "Config subject", organization_id: org.id })).id;
    const connection = await createTestConnection({ organization_id: org.id, connector_key: "test.resource", entity_ids: [entityId], created_by: user.id });
    const sql = getTestDb();
    for (const [category, kind, resourceId] of [
      ['config', 'automation', 'synthetic-workflow'],
      ['config', 'automation', 'other-workflow'],
      ['config', 'connection', 'synthetic-workflow'],
      ['deployment', 'automation', 'synthetic-workflow'],
    ]) {
      const [row] = await sql`INSERT INTO events (organization_id, connection_id, entity_ids, origin_id, title, payload_type, payload_text, semantic_type, metadata, created_by, occurred_at)
        VALUES (${org.id}, ${connection.id}, ${`{${entityId}}`}::bigint[], ${`resource-filter-${ids.length}`}, 'Configuration needle', 'text', 'Configuration needle', 'change', ${sql.json({ category, resource_kind: kind, resource_id: resourceId })}, ${user.id}, NOW()) RETURNING id`;
      ids.push(Number(row.id));
    }
    const [facet] = await sql`INSERT INTO classify_facet (organization_id, slug, name, attribute_key, status, created_by) VALUES (${org.id}, 'resource-test', 'Resource test', 'resource_test', 'active', ${user.id}) RETURNING id`;
    for (const id of ids) await sql`INSERT INTO event_classifications (event_id, classifier_id, "values", source, is_manual) VALUES (${id}, ${facet.id}, ARRAY['matched']::text[], 'user', true)`;
    const other = await createTestOrganization({ name: 'Foreign resource' });
    await sql`INSERT INTO events (organization_id, origin_id, title, payload_type, semantic_type, metadata) VALUES (${other.id}, 'foreign-resource', 'Forbidden', 'empty', 'change', ${sql.json({ category: 'config', resource_kind: 'automation', resource_id: 'synthetic-workflow' })})`;

  });
  const read = (args: Record<string, unknown>) => getContent(args as never, {} as never, ctx);
  it.each([
    ['date', {}],
    ['text search', { query: 'needle' }],
  ])('%s keeps the exact category and resource pair', async (_name, extra) => {
    const result = await read({ ...filter, ...extra, limit: 10 });
    expect(result.content.map((event) => Number(event.id))).toEqual([ids[0]]);
    expect(result.content[0].author_name).toBe(username);
  });
  it('exact IDs apply resource filters to results and counts', async () => {
    const result = await read({ ...filter, content_ids: ids, include_total: true });
    expect(result.content.map((event) => Number(event.id))).toEqual([ids[0]]);
    expect(result.content[0].author_name).toBe(username);
    expect(result.total).toBe(1);
  });
  it('superseded listings keep the same resource scope', async () => {
    const result = await read({ ...filter, entity_id: entityId, include_superseded: true, sort_by: 'date', sort_order: 'desc' });
    expect(result.content.map((event) => Number(event.id))).toEqual([ids[0]]);
    expect(result.content[0].author_name).toBe(username);
  });

  it('score rows and count retain the resource scope', async () => {
    const result = await read({ ...filter, entity_id: entityId, sort_by: 'score', include_total: true });
    expect(result.content.map((event) => Number(event.id))).toEqual([ids[0]]);
    expect(result.content[0].author_name).toBe(username);
    expect(result.total).toBe(1);
  });
  it('classification-filtered pages and statistics stay inside the resource', async () => {
    const result = await read({ ...filter, classification_filters: { 'resource-test': ['matched'] }, include_classification: 'summary', sort_by: 'date' });
    expect(result.content.map((event) => Number(event.id))).toEqual([ids[0]]);
    expect(result.content[0].author_name).toBe(username);
    expect(result.classification_stats).toEqual({ 'resource-test': { matched: 1 } });
    const next = await read({ ...filter, classification_filters: { 'resource-test': ['matched'] }, sort_by: 'date', before_occurred_at: result.content[0].occurred_at, before_id: ids[0] });
    expect(next.content).toEqual([]);
  });
  it('preserves recorded authors and does not expose creator identities to anonymous reads', async () => {
    const sql = getTestDb();
    const { buildContentItems } = await import('../../../tools/get_content/render');
    const [row] = await sql`SELECT * FROM events WHERE id = ${ids[0]}`;
    const render = (raw: typeof row, privateAttribution: boolean) => buildContentItems({ sql, rawContent: [raw as never], organizationId: ctx.organizationId, ownerSlug: null, baseUrl: undefined, includePrivateAttribution: privateAttribution });
    expect((await render(row, false))[0].author_name).toBeNull();
    expect((await render({ ...row, author_name: 'Recorded actor' }, true))[0].author_name).toBe('Recorded actor');
    await sql`UPDATE events SET created_by = NULL WHERE id = ${ids[0]}`;
    try { expect((await render(row, true))[0].author_name).toBeNull(); }
    finally { await sql`UPDATE events SET created_by = ${ctx.userId} WHERE id = ${ids[0]}`; }
  });
  it('category alone remains useful', async () => {
    const result = await read({ semantic_type: 'change', event_category: 'deployment' });
    expect(result.content.map((event) => Number(event.id))).toEqual([ids[3]]);
  });
  it('omitting filters preserves existing results', async () => {
    const result = await read({ semantic_type: 'change' });
    expect(result.content).toHaveLength(4);
  });
  it.each([
    { resource_kind: 'automation' },
    { resource_id: 'synthetic-workflow' },
    { ...filter, view: 'changes', record: 'company/test' },
    { ...filter, automation_id: 123 },
  ])('rejects incomplete or unsupported scope %j', async (args) => {
    await expect(read(args)).rejects.toMatchObject({ httpStatus: 400 });
  });
});
