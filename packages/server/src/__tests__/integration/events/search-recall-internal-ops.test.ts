/**
 * Integration test: recall (`search_memory`) must not surface internal
 * operational rows.
 *
 * QA repro (ISSUE 21): one Automation create produced TWO search_memory hits
 * with near-identical titles (single- vs double-quoted), and an unrelated
 * query surfaced "query_sql completed". Root cause: every Automation action
 * dual-writes a lifecycle row (metadata.category='lifecycle', feeds
 * metric_series dashboards) and a config row (category='config', feeds the
 * Deployments feed), both stored as `events` with semantic_type 'change';
 * tool invocations add semantic_type 'audit' + origin_type 'tool_invocation'
 * rows. All three carry no body text and no embedding, so recall can only
 * title-match them into noise.
 *
 * Fix: `exclude_internal_ops` on ContentSearchOptions, set by the recall path
 * (fetchContentSnippets) and honoured by both retrieval paths. Rows are
 * matched by the shape their writers persist, never by `metadata.category`
 * alone — `category` is caller-written through save_memory, so a member's note
 * tagged `category: 'config'` stays recallable. Explicit semantic_type filters
 * override the exclusion; get_content / query_sql / dashboards are unaffected
 * because they never set the flag.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { searchContentByText } from '../../../utils/content-search';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const QUERY = 'Nightly sync';

describe('searchContentByText > exclude_internal_ops', () => {
  let orgId: string;
  let normalContentId: string;
  let lifecycleRowId: string;
  let configRowId: string;
  let auditRowId: string;
  let memberNoteId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    const org = await createTestOrganization({ name: 'Internal Ops Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'ops-org@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    // The real content row a recall should return.
    normalContentId = String(
      (
        await createTestEvent({
          organization_id: orgId,
          title: 'Nightly sync Automation created',
          content: 'Created the nightly warehouse sync automation.',
          semantic_type: 'content',
        })
      ).id
    );

    // The lifecycle dual-write (double-quoted title, metric_series source).
    lifecycleRowId = String(
      (
        await createTestEvent({
          organization_id: orgId,
          title: 'Nightly sync Automation "created"',
          content: '',
          semantic_type: 'change',
          origin_type: 'automation_created',
          metadata: { category: 'lifecycle', entity_type: 'automation' },
        })
      ).id
    );

    // The config dual-write (single-quoted title, Deployments feed source).
    configRowId = String(
      (
        await createTestEvent({
          organization_id: orgId,
          title: "Nightly sync Automation 'created'",
          content: '',
          semantic_type: 'change',
          origin_type: 'config_automation_created',
          metadata: { category: 'config', resource_kind: 'automation' },
        })
      ).id
    );

    // A tool-invocation audit row, as tools/audit.ts writes it.
    auditRowId = String(
      (
        await createTestEvent({
          organization_id: orgId,
          title: 'Nightly sync tool run completed',
          content: '',
          semantic_type: 'audit',
          origin_type: 'tool_invocation',
          metadata: { category: 'audit', tool_name: 'query_sql' },
        })
      ).id
    );

    // A member-saved memory that happens to use 'config' as its own category
    // label. save_content sets no origin_type, so the ops filter must keep it.
    memberNoteId = String(
      (
        await createTestEvent({
          organization_id: orgId,
          title: 'Nightly sync config notes',
          content: 'The warehouse sync runs at 02:00 UTC.',
          semantic_type: 'note',
          metadata: { category: 'config' },
        })
      ).id
    );
  });

  it('default search still returns the ops rows (pre-fix result pinned)', async () => {
    const result = await searchContentByText(QUERY, {
      organization_id: orgId,
    });
    const ids = result.content.map((r) => String(r.id));
    expect(ids).toContain(normalContentId);
    expect(ids).toContain(lifecycleRowId);
    expect(ids).toContain(configRowId);
    expect(ids).toContain(auditRowId);
  });

  it('exclude_internal_ops hides lifecycle, config and audit rows', async () => {
    const result = await searchContentByText(QUERY, {
      organization_id: orgId,
      exclude_internal_ops: true,
    });
    const ids = result.content.map((r) => String(r.id));
    expect(ids).toContain(normalContentId);
    expect(ids).not.toContain(lifecycleRowId);
    expect(ids).not.toContain(configRowId);
    expect(ids).not.toContain(auditRowId);
  });

  it("keeps a member's own note that uses a colliding category label", async () => {
    const result = await searchContentByText(QUERY, {
      organization_id: orgId,
      exclude_internal_ops: true,
    });
    const ids = result.content.map((r) => String(r.id));
    expect(ids).toContain(memberNoteId);
  });

  it('explicit semantic_type filter overrides the exclusion', async () => {
    const auditOnly = await searchContentByText(QUERY, {
      organization_id: orgId,
      exclude_internal_ops: true,
      semantic_type: ['audit'],
    });
    const auditIds = auditOnly.content.map((r) => String(r.id));
    expect(auditIds).toContain(auditRowId);
    expect(auditIds).not.toContain(normalContentId);

    const changes = await searchContentByText(QUERY, {
      organization_id: orgId,
      exclude_internal_ops: true,
      semantic_type: ['change'],
    });
    const changeIds = changes.content.map((r) => String(r.id));
    expect(changeIds).toContain(lifecycleRowId);
    expect(changeIds).toContain(configRowId);
  });

  it('workspace-audit rows are unaffected by exclude_internal_ops', async () => {
    const wsRowId = String(
      (
        await createTestEvent({
          organization_id: orgId,
          title: 'Nightly sync member invited',
          content: '',
          semantic_type: 'change',
          origin_type: 'workspace_member_created',
          metadata: {
            category: 'workspace',
            _lobu_workspace_audit: true,
          },
        })
      ).id
    );
    const result = await searchContentByText(QUERY, {
      organization_id: orgId,
      exclude_internal_ops: true,
    });
    const ids = result.content.map((r) => String(r.id));
    expect(ids).toContain(wsRowId);
  });

  // Recall lands on the LIST path, not the search path, whenever its query is
  // under three characters and carries no embedding — `search_memory({ query:
  // 'Q3' })` on a workspace-scoped connection is the live case, since
  // searchContentByText routes on that length. The flag has to hold there too,
  // or every row the search path hides comes back through the other door.
  it('hides the same rows on the list path', async () => {
    const result = await searchContentByText(null, {
      organization_id: orgId,
      exclude_internal_ops: true,
    });
    const ids = result.content.map((r) => String(r.id));
    expect(ids).toContain(normalContentId);
    expect(ids).toContain(memberNoteId);
    expect(ids).not.toContain(lifecycleRowId);
    expect(ids).not.toContain(configRowId);
    expect(ids).not.toContain(auditRowId);
  });

  it('the list path still returns the ops rows without the flag', async () => {
    const result = await searchContentByText(null, {
      organization_id: orgId,
    });
    const ids = result.content.map((r) => String(r.id));
    expect(ids).toContain(lifecycleRowId);
    expect(ids).toContain(configRowId);
    expect(ids).toContain(auditRowId);
  });

  it('an explicit semantic_type still overrides the exclusion on the list path', async () => {
    const auditOnly = await searchContentByText(null, {
      organization_id: orgId,
      exclude_internal_ops: true,
      semantic_type: ['audit'],
    });
    const auditIds = auditOnly.content.map((r) => String(r.id));
    expect(auditIds).toContain(auditRowId);
    expect(auditIds).not.toContain(normalContentId);
  });
});
