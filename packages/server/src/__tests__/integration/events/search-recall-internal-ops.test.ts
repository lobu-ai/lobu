/**
 * Integration test: recall (`search_memory`) must not surface internal
 * operational rows.
 *
 * QA repro (ISSUE 21): one Automation create produced TWO search_memory hits
 * with near-identical titles (single- vs double-quoted), and an unrelated
 * query surfaced "query_sql completed". Root cause: every Automation action
 * dual-writes a lifecycle row (metadata.category='lifecycle', feeds
 * metric_series dashboards) and a config row (category='config', feeds the
 * Events page's Configuration filter), both stored as `events` with semantic_type 'change';
 * tool invocations add semantic_type 'audit' + origin_type 'tool_invocation'
 * rows. All three carry no body text and no embedding, so recall can only
 * title-match them into noise.
 *
 * Fix: `exclude_internal_ops` on ContentSearchOptions, set by the recall path
 * (fetchContentSnippets) and honoured by both retrieval paths. Rows are
 * matched by the shape their writers persist, never by `metadata.category`
 * alone — `category` is caller-written through save_memory, so a member's note
 * tagged `category: 'config'` stays recallable. Explicit semantic_type filters
 * override the exclusion. get_content also sets the flag for non-owner/admin
 * default list/search reads; query_sql / dashboards never consult it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { search } from '../../../tools/search';
import type { ToolContext } from '../../../tools/registry';
import { searchContentByText } from '../../../utils/content-search';
import { insertConnectionlessAuditEvent } from '../../../utils/insert-event';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
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

    // The config dual-write (single-quoted title, configuration audit source).
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

/**
 * Run bookkeeping is not memory, but its titles name the entities it touched.
 * On a workspace whose records are source-backed, `search_memory "Genentech
 * renewal risk"` returned only "Entity updated: band, health, top_risks…" rows
 * and `"Shanti Oppenheimer accounts"` only "Review task field: Draft" rows.
 * Those were the platform change log (`insertConnectionlessAuditEvent`) and
 * approval notifications — neither an interactive card. Fixtures below use
 * the shapes those writers persist; the change-log row goes through the real
 * writer. Recall hides them, plus interactive cards and Automation receipts;
 * an explicit semantic_type filter still returns them, as it does for audit.
 */
describe('search_memory > run bookkeeping', () => {
  const QUERY = 'Genentech renewal risk';
  const env = {} as Env;
  let orgId: string;
  let ctx: ToolContext;
  let noteId: number;
  let unstampedChangeId: number;
  let forgedStampId: number;
  let changeLogId: number;
  let notificationId: number;
  let receiptId: number;
  let cardId: number;

  const event = async (input: Parameters<typeof createTestEvent>[0]): Promise<number> =>
    Number((await createTestEvent({ organization_id: orgId, content: '', ...input })).id);

  beforeAll(async () => {
    await initWorkspaceProvider();
    const org = await createTestOrganization({ name: 'Recall Bookkeeping Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'recall-bookkeeping@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    ctx = {
      organizationId: org.id,
      userId: user.id,
      tokenType: 'session',
      memberRole: 'owner',
    } as ToolContext;
    const account = await createTestEntity({ name: 'Genentech', organization_id: orgId });

    // Memory recall must keep returning.
    noteId = await event({
      title: 'Genentech renewal risk review',
      content: 'Genentech renewal risk is high: the champion left in Q3.',
      semantic_type: 'note',
    });
    // A `change` row the change-log writer did not write (no event-type stamp).
    unstampedChangeId = await event({
      title: 'Genentech renewal risk change noted',
      content: 'Renewal moved to the risk list after the QBR.',
      semantic_type: 'change',
    });
    // Automation output keeps caller `_lobu_` keys except the idempotency key,
    // which it overwrites with its own; the stamp alone must not hide it.
    forgedStampId = await event({
      title: 'Genentech renewal risk signal',
      content: 'Usage dropped 40% month over month.',
      semantic_type: 'note',
      metadata: {
        _lobu_event_type: 'entity.updated',
        _lobu_idempotency_key: 'automation:1:output:signals:key:genentech',
      },
    });

    // Platform change log, through the writer that produces it in prod.
    changeLogId = Number(
      (
        await insertConnectionlessAuditEvent(
          {
            entityIds: [account.id],
            organizationId: orgId,
            originId: `change_${crypto.randomUUID()}`,
            title: 'Entity updated: Genentech renewal risk band, health, top_risks',
            content: '',
            semanticType: 'change',
            metadata: { changes: { band: { from: 'green', to: 'red' } } },
          },
          { subject: 'entity', op: 'updated' }
        )
      ).id
    );
    // Approval notification: interaction_type stays 'none'.
    notificationId = await event({
      title: 'Review Genentech renewal risk field: Draft',
      semantic_type: 'entity_change_approval',
      metadata: { notification_type: 'action_approval_needed' },
    });
    // Automation receipt.
    receiptId = await event({
      title: 'Automation applied 0 new + 1 updated',
      content: 'This run updated Genentech renewal risk.',
      semantic_type: 'change_set',
      metadata: { kind: 'automation_change_set' },
    });
    // Interactive card. Only system writers set interaction_type, so the
    // fixture has no knob for it.
    cardId = await event({
      title: 'Run: refresh Genentech renewal risk',
      semantic_type: 'change',
    });
    await getTestDb()`
      UPDATE events SET interaction_type = 'approval', interaction_status = 'pending'
      WHERE id = ${cardId}
    `;
  });

  const kept = () => [noteId, unstampedChangeId, forgedStampId];
  const hidden = () => [changeLogId, notificationId, receiptId, cardId];

  it('search_memory leaves run bookkeeping out of recall', async () => {
    const result = await search({ query: QUERY, include_content: true, content_limit: 20 }, env, ctx);
    const ids = (result.content ?? []).map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(kept()));
    for (const id of hidden()) expect(ids).not.toContain(id);
  });

  it('hides it on the list path too', async () => {
    const result = await searchContentByText(null, {
      organization_id: orgId,
      exclude_recall_bookkeeping: true,
    });
    const ids = result.content.map((r) => Number(r.id));
    expect(ids).toEqual(expect.arrayContaining(kept()));
    for (const id of hidden()) expect(ids).not.toContain(id);
  });

  it('an explicit semantic_type filter still returns it on both paths', async () => {
    for (const query of [QUERY, null]) {
      const result = await searchContentByText(query, {
        organization_id: orgId,
        exclude_recall_bookkeeping: true,
        semantic_type: ['change', 'entity_change_approval', 'change_set'],
      });
      const ids = result.content.map((r) => Number(r.id));
      expect(ids).toEqual(expect.arrayContaining(hidden()));
      expect(ids).not.toContain(noteId);
    }
  });
});
